/**
 * Text to speech: turns text you paste in into a book on the shelf.
 *
 * The only provider wired up is Google Cloud Text-to-Speech, chosen because its
 * free tier is large enough that a personal shelf never leaves it: 4 million
 * characters a month on Standard/WaveNet, 1 million on Neural2 and Chirp 3 HD.
 * A provider is just a function from text to MP3 bytes, so swapping in another
 * one later means writing that function and nothing else.
 *
 * The shape of a job:
 *   clean the text -> split into chapters -> split each chapter into chunks
 *   small enough for one request -> synthesise each chunk to its own file ->
 *   stitch each chapter's chunks into one MP3 -> tag it -> let the scanner in.
 *
 * Chunk files are kept on disk until the job finishes, and a retry reuses the
 * ones already there. Characters cost money; paying twice for the same sentence
 * because chunk 340 of 400 timed out would be the main way this feature could
 * waste someone's allowance.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createSign, createHash } from 'node:crypto';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { HttpError } from './http.js';
import { checkTools } from './audible.js';

const now = () => Date.now();

/** One generation at a time: these are long, sequential and paid for per character. */
export const ttsState = {
  running: false,
  generationId: null,
  title: null,
  progress: 0,
  chunk: 0,
  chunks: 0,
  startedAt: null,
  message: null,
  cancel: false,
};

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------
/**
 * Google's published rates, verified against cloud.google.com/text-to-speech/pricing
 * in September 2026. Voices that share a billing SKU share one free allowance,
 * which is why Standard and WaveNet are one bucket and Neural2 and Polyglot are
 * another - spending Standard characters really does eat into WaveNet's free
 * tier. Rates move; AUDIOSHELF_TTS_RATES can override the whole table.
 */
export const PRICING = {
  'standard-wavenet': { label: 'Standard / WaveNet', freePerMonth: 4_000_000, perMillion: 4 },
  neural2: { label: 'Neural2 / Polyglot', freePerMonth: 1_000_000, perMillion: 16 },
  'chirp3-hd': { label: 'Chirp 3: HD', freePerMonth: 1_000_000, perMillion: 30 },
  studio: { label: 'Studio', freePerMonth: 1_000_000, perMillion: 160 },
  other: { label: 'Other', freePerMonth: 0, perMillion: 16 },
};

/** Which billing bucket a voice name falls into, e.g. en-US-Chirp3-HD-Charon. */
export function voiceTier(name) {
  const voice = String(name || '');
  if (/chirp3?-?hd/i.test(voice) || /chirp/i.test(voice)) return 'chirp3-hd';
  if (/-studio-/i.test(voice)) return 'studio';
  if (/-neural2-/i.test(voice) || /-polyglot-/i.test(voice)) return 'neural2';
  if (/-wavenet-/i.test(voice) || /-standard-/i.test(voice)) return 'standard-wavenet';
  return 'other';
}

export const DEFAULT_VOICE = process.env.AUDIOSHELF_TTS_VOICE || 'en-US-Chirp3-HD-Charon';

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
export const GOOGLE_KEY = 'tts.google.api_key';
export const GOOGLE_SERVICE_ACCOUNT = 'tts.google.service_account';

const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;

const setSetting = (key, value) =>
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value), now());

const clearSetting = (key) => db.prepare('DELETE FROM settings WHERE key = ?').run(key);

/**
 * Either an API key (paste one string, done) or a service-account JSON, for
 * organisations that disable API keys. Environment variables win, so a hosted
 * deployment can inject credentials without touching the database.
 */
export function credentials() {
  const apiKey = process.env.AUDIOSHELF_GOOGLE_TTS_KEY || getSetting(GOOGLE_KEY);
  if (apiKey) return { kind: 'api-key', apiKey };
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON || getSetting(GOOGLE_SERVICE_ACCOUNT);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.client_email || !parsed.private_key) return null;
    return { kind: 'service-account', account: parsed };
  } catch {
    return null;
  }
}

export function saveApiKey(value) {
  const key = String(value || '').trim();
  // Google's browser keys all look like AIza..., but keys from other consoles
  // do not, so only obviously-empty input is rejected here. A wrong key fails
  // loudly on the first request with Google's own message, which is clearer
  // than anything a format guess could say.
  if (key.length < 10) throw new HttpError(400, 'That does not look like an API key.');
  clearSetting(GOOGLE_SERVICE_ACCOUNT);
  setSetting(GOOGLE_KEY, key);
}

export function saveServiceAccount(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'That is not valid JSON - paste the whole service-account key file.');
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new HttpError(400, 'That JSON has no client_email and private_key - it is not a service-account key.');
  }
  clearSetting(GOOGLE_KEY);
  setSetting(GOOGLE_SERVICE_ACCOUNT, raw);
}

export function clearCredentials() {
  clearSetting(GOOGLE_KEY);
  clearSetting(GOOGLE_SERVICE_ACCOUNT);
}

/** Enough to confirm which key is saved, never enough to use it elsewhere. */
export function credentialSummary() {
  const found = credentials();
  if (!found) return null;
  if (found.kind === 'api-key') {
    const key = found.apiKey;
    return { kind: 'api-key', hint: `${key.slice(0, 4)}${'*'.repeat(8)}${key.slice(-4)}` };
  }
  return { kind: 'service-account', hint: found.account.client_email };
}

// ---------------------------------------------------------------------------
// Google auth
// ---------------------------------------------------------------------------
const base64url = (input) => Buffer.from(input).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let tokenCache = { token: null, expires: 0, subject: null };

/**
 * Service-account auth is a self-signed JWT traded for an access token. RS256
 * signing is in node:crypto, so this costs a dependency of zero.
 */
async function accessToken(account) {
  if (tokenCache.token && tokenCache.subject === account.client_email && tokenCache.expires > now() + 60_000) {
    return tokenCache.token;
  }
  const issued = Math.floor(now() / 1000);
  const audience = account.token_uri || 'https://oauth2.googleapis.com/token';
  const claims = {
    iss: account.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: audience,
    iat: issued,
    exp: issued + 3600,
  };
  const input = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(input).sign(account.private_key);
  const assertion = `${input}.${signature.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;

  const response = await fetch(audience, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new HttpError(502, `Google refused the service account: ${data.error_description || data.error || response.status}`);
  }
  tokenCache = {
    token: data.access_token,
    expires: now() + (Number(data.expires_in) || 3600) * 1000,
    subject: account.client_email,
  };
  return data.access_token;
}

const ENDPOINT = process.env.AUDIOSHELF_GOOGLE_TTS_ENDPOINT || 'https://texttospeech.googleapis.com/v1';

async function googleFetch(pathname, { method = 'GET', body } = {}) {
  const creds = credentials();
  if (!creds) {
    throw new HttpError(400, 'No Google API key saved yet - add one on the Generate page first.');
  }
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  let url = `${ENDPOINT}${pathname}`;
  if (creds.kind === 'api-key') {
    url += `${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(creds.apiKey)}`;
  } else {
    headers.authorization = `Bearer ${await accessToken(creds.account)}`;
  }

  let response;
  try {
    response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (err) {
    throw new HttpError(502, `Could not reach Google: ${err.message}`);
  }
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* Google sent HTML, handled below */ }

  if (!response.ok) {
    const message = data?.error?.message || text.slice(0, 300) || `HTTP ${response.status}`;
    // 403 here is nearly always "you did not turn the API on", which is a link
    // away from fixed and worth saying outright rather than echoing Google.
    if (response.status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(message)) {
      throw new HttpError(403, `${message} Enable "Cloud Text-to-Speech API" for your project in the Google Cloud console, then try again.`);
    }
    if (response.status === 429) {
      throw new HttpError(429, `Google is rate limiting this key: ${message}`);
    }
    throw new HttpError(response.status === 401 ? 401 : 502, message);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------
/**
 * Text pasted out of a reader app arrives with its furniture attached: nav
 * arrows, a pencil, a close cross, "No chapters detected". A voice will read
 * every one of those and charge for the privilege, so they go first.
 */
export function cleanText(raw) {
  let text = String(raw || '')
    .replace(/\r\n?/g, '\n')
    // Non-breaking spaces and the invisible formatting characters that ride
    // along with a copy-paste: a voice engine charges for them all the same.
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '');

  // Done in stages, because whether a line is furniture depends on what is
  // left around it: "Read" above "Chat" above a pencil is a toolbar, while
  // "Read" above a paragraph could be a heading.
  let lines = text.split('\n').map((line) => line.trim());

  // 1. Lines made entirely of symbols, and the reader's own footer note.
  lines = lines.filter((line) => !(
    (line && /^[^\p{L}\p{N}]+$/u.test(line))
    || /^no chapters detected/i.test(line)
  ));

  // 2. Toolbar words and stray counters, but only where nothing around them
  //    reads like prose - a heading always has a paragraph under it.
  const isProse = (line) => !!line
    && (line.split(/\s+/).length > 3 || /[.!?:]["')\]]*$/.test(line));
  const nextRealLine = (from) => {
    for (let i = from + 1; i < lines.length; i++) if (lines[i]) return lines[i];
    return null;
  };
  const CHROME = /^(read|chat|contents|menu|share|back|next|previous|close|home|save|edit|copy|download|settings|more|done|cancel)$/i;

  lines = lines.filter((line, index) => {
    if (!line) return true;
    const orphan = !isProse(nextRealLine(index));
    if (CHROME.test(line) && orphan) return false;
    // A bare number on its own line: an annotation count, a page number.
    if (/^\d{1,3}$/.test(line) && orphan) return false;
    return true;
  });

  text = lines.join('\n');

  return text
    // Markdown that would otherwise be spoken or mangled. Headings keep their
    // text because chapter splitting runs next and wants to see it.
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$|[.,;:!?])/g, '$1$2')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CHAPTER_WORDS = /^(chapter|part|section|book|act|introduction|prologue|epilogue|conclusion|afterword|foreword|preface|appendix|interlude|summary|overview)\b/i;

/**
 * Splits cleaned text into chapters. A heading is a short line that opens with
 * a chapter-ish word, or a numbered line - deliberately conservative, because
 * inventing chapter breaks in the middle of a sentence is worse than having
 * none at all. Everything before the first heading becomes its own chapter so
 * no text is ever silently dropped.
 */
export function splitChapters(text) {
  const lines = String(text || '').split('\n');
  const chapters = [];
  let current = { title: null, lines: [] };

  const isHeading = (line, next) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length > 90) return false;
    if (/[.!?,;:]$/.test(trimmed) && !CHAPTER_WORDS.test(trimmed)) return false;
    if (CHAPTER_WORDS.test(trimmed)) return true;
    // "1. Something" or "12 - Something" on its own line, followed by prose.
    return /^\d{1,3}[.)\-–—]\s+\S/.test(trimmed) && next !== undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    if (isHeading(lines[i], lines[i + 1])) {
      if (current.title !== null || current.lines.join('').trim()) chapters.push(current);
      current = { title: lines[i].trim(), lines: [] };
    } else {
      current.lines.push(lines[i]);
    }
  }
  if (current.title !== null || current.lines.join('').trim()) chapters.push(current);

  return chapters
    .map((chapter) => ({
      title: chapter.title,
      // The heading is spoken too - otherwise a chapter starts mid-thought.
      text: [chapter.title, chapter.lines.join('\n').trim()].filter(Boolean).join('.\n\n').trim(),
    }))
    .filter((chapter) => chapter.text)
    .map((chapter, index) => ({ ...chapter, title: chapter.title || (index === 0 ? 'Start' : `Part ${index + 1}`) }));
}

const bytes = (text) => Buffer.byteLength(text, 'utf8');

/**
 * Google caps one request at 5,000 bytes. Splitting is done on paragraph, then
 * sentence, then word boundaries so a chunk never ends mid-word - the seam
 * between two chunks is audible, and a seam inside a word is unmistakable.
 */
export function chunkText(text, maxBytes = config.ttsChunkBytes) {
  const limit = Math.max(500, Math.min(Number(maxBytes) || 4000, 4800));
  const chunks = [];
  let buffer = '';

  const flush = () => {
    if (buffer.trim()) chunks.push(buffer.trim());
    buffer = '';
  };

  const add = (piece, joiner) => {
    const candidate = buffer ? buffer + joiner + piece : piece;
    if (bytes(candidate) <= limit) { buffer = candidate; return true; }
    return false;
  };

  const splitHard = (piece) => {
    // A single "sentence" longer than the limit: fall back to words, then to a
    // blunt byte cut if even one word is somehow too long.
    let part = '';
    for (const word of piece.split(/\s+/)) {
      const candidate = part ? `${part} ${word}` : word;
      if (bytes(candidate) <= limit) { part = candidate; continue; }
      if (part) chunks.push(part);
      if (bytes(word) > limit) {
        let rest = Buffer.from(word, 'utf8');
        while (rest.length > limit) {
          chunks.push(rest.subarray(0, limit).toString('utf8'));
          rest = rest.subarray(limit);
        }
        part = rest.toString('utf8');
      } else {
        part = word;
      }
    }
    if (part) chunks.push(part);
  };

  for (const paragraph of String(text || '').split(/\n{2,}/)) {
    const block = paragraph.trim();
    if (!block) continue;
    if (add(block, '\n\n')) continue;
    flush();
    if (bytes(block) <= limit) { buffer = block; continue; }

    // Keep the terminator with the sentence it ends.
    const sentences = block.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n|$)/g) || [block];
    for (const sentence of sentences) {
      const piece = sentence.trim();
      if (!piece) continue;
      if (add(piece, ' ')) continue;
      flush();
      if (bytes(piece) <= limit) buffer = piece;
      else splitHard(piece);
    }
  }
  flush();
  return chunks;
}

// ---------------------------------------------------------------------------
// Usage and estimates
// ---------------------------------------------------------------------------
const monthKey = (at = new Date()) =>
  `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;

/** Characters this server has spent this month, per billing bucket. */
export function monthlyUsage(month = monthKey()) {
  const rows = db.prepare('SELECT tier, characters FROM usage_counters WHERE month = ? AND provider = ?')
    .all(month, 'google');
  const used = Object.fromEntries(Object.keys(PRICING).map((tier) => [tier, 0]));
  for (const row of rows) used[row.tier] = row.characters;
  return { month, used };
}

const recordUsage = (tier, characters) => {
  db.prepare(`INSERT INTO usage_counters (month, provider, tier, characters) VALUES (?, ?, ?, ?)
    ON CONFLICT(month, provider, tier) DO UPDATE SET characters = characters + excluded.characters`)
    .run(monthKey(), 'google', tier, characters);
};

/**
 * What a piece of text would cost, given what has already been spent this
 * month. The count AudioShelf keeps is its own tally, not Google's - a second
 * app on the same project spends from the same allowance without appearing
 * here, so this is guidance, not a bill.
 */
export function estimate({ text, voice = DEFAULT_VOICE, alreadyClean = false } = {}) {
  const cleaned = alreadyClean ? String(text || '') : cleanText(text);
  const chapters = splitChapters(cleaned);
  const chunks = chapters.flatMap((chapter) => chunkText(chapter.text));
  // Google bills the characters it is sent, which is the cleaned text plus the
  // chapter headings we speak - counting the chunks is the only honest count.
  const characters = chunks.reduce((total, chunk) => total + chunk.length, 0);

  const tier = voiceTier(voice);
  const rates = PRICING[tier] || PRICING.other;
  const { used } = monthlyUsage();
  const freeLeft = Math.max(0, rates.freePerMonth - (used[tier] || 0));
  const billable = Math.max(0, characters - freeLeft);

  return {
    characters,
    words: cleaned.split(/\s+/).filter(Boolean).length,
    chunks: chunks.length,
    chapters: chapters.map((chapter, index) => ({
      index: index + 1,
      title: chapter.title,
      characters: chapter.text.length,
      chunks: chunkText(chapter.text).length,
    })),
    // ~150 words a minute is the usual narration pace.
    estimatedSeconds: Math.round((cleaned.split(/\s+/).filter(Boolean).length / 150) * 60),
    tier,
    tierLabel: rates.label,
    freePerMonth: rates.freePerMonth,
    freeRemaining: freeLeft,
    usedThisMonth: used[tier] || 0,
    billableCharacters: billable,
    cost: Number(((billable / 1_000_000) * rates.perMillion).toFixed(4)),
    perMillion: rates.perMillion,
  };
}

// ---------------------------------------------------------------------------
// Google calls
// ---------------------------------------------------------------------------
export async function listVoices(language = 'en-US') {
  const data = await googleFetch(`/voices${language ? `?languageCode=${encodeURIComponent(language)}` : ''}`);
  return (data?.voices || [])
    .map((voice) => ({
      name: voice.name,
      gender: voice.ssmlGender,
      languages: voice.languageCodes,
      tier: voiceTier(voice.name),
    }))
    // Cheapest-per-character last is the wrong order for a picker; put the
    // voices someone actually wants to narrate a book at the top.
    .sort((a, b) => {
      const rank = { 'chirp3-hd': 0, neural2: 1, studio: 2, 'standard-wavenet': 3, other: 4 };
      return (rank[a.tier] - rank[b.tier]) || a.name.localeCompare(b.name);
    });
}

/** One chunk of text to MP3 bytes. */
export async function synthesize(text, { voice = DEFAULT_VOICE, language, speakingRate = 1 } = {}) {
  const languageCode = language || voice.split('-').slice(0, 2).join('-') || 'en-US';
  const audioConfig = { audioEncoding: 'MP3' };
  // Chirp 3 voices reject some audioConfig fields, so only send a rate when it
  // is actually asked for rather than always sending a no-op 1.0.
  if (Number(speakingRate) && Number(speakingRate) !== 1) {
    audioConfig.speakingRate = Math.min(Math.max(Number(speakingRate), 0.25), 4);
  }
  const data = await googleFetch('/text:synthesize', {
    method: 'POST',
    body: { input: { text }, voice: { languageCode, name: voice }, audioConfig },
  });
  if (!data?.audioContent) throw new HttpError(502, 'Google returned no audio for that chunk.');
  return Buffer.from(data.audioContent, 'base64');
}

// ---------------------------------------------------------------------------
// Assembling files
// ---------------------------------------------------------------------------
const run = (command, args) => new Promise((resolve) => {
  let child;
  try {
    child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return resolve({ code: -1, stdout: '', stderr: err.message });
  }
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

export const sanitizeName = (value, fallback) => {
  const cleaned = String(value || '')
    // Separators become a dash rather than vanishing, so "Apply the 80/20
    // Rule" is not filed as "Apply the 8020 Rule". The real title survives in
    // the file's tags either way; this is only what shows up in Explorer.
    .replace(/\s*[\\/]\s*/g, '-')
    .replace(/\s*:\s*/g, ' - ')
    .replace(/[*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  return cleaned.slice(0, 110) || fallback;
};

/**
 * Joins a chapter's chunk files into one tagged MP3.
 *
 * The audio stream is copied, never re-encoded - same rule as Audible imports.
 * -write_xing rebuilds the duration header from the joined frames; without it
 * the file inherits the first chunk's header and the shelf shows a 12-second
 * book. With one chunk and no ffmpeg it is a plain copy, so short pieces work
 * on a machine that has no converter installed.
 */
export async function stitch(chunkFiles, outputPath, tags = {}) {
  const tools = await checkTools();
  if (!tools.ffmpeg) {
    if (chunkFiles.length === 1) {
      await fs.copyFile(chunkFiles[0], outputPath);
      return outputPath;
    }
    throw new HttpError(503, `ffmpeg is needed to join ${chunkFiles.length} pieces into one chapter (looked for "${config.ffmpeg}").`);
  }

  const listPath = `${outputPath}.list`;
  // The concat demuxer reads paths from a file; single quotes are escaped the
  // way ffmpeg wants them, which is not the way a shell does.
  await fs.writeFile(listPath, chunkFiles
    .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
    .join('\n'), 'utf8');

  const metadata = [];
  for (const [key, value] of Object.entries(tags)) {
    if (value !== undefined && value !== null && value !== '') metadata.push('-metadata', `${key}=${value}`);
  }

  const temporary = `${outputPath}.part`;
  const result = await run(config.ffmpeg, [
    '-nostdin', '-hide_banner', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy',
    '-write_xing', '1',
    '-id3v2_version', '3',
    ...metadata,
    '-f', 'mp3',
    temporary,
  ]);
  await fs.rm(listPath, { force: true });

  if (result.code !== 0) {
    await fs.rm(temporary, { force: true });
    throw new HttpError(500, `Could not join the audio: ${String(result.stderr).split('\n').slice(-3).join(' ').slice(0, 300)}`);
  }
  await fs.rename(temporary, outputPath);
  return outputPath;
}

// ---------------------------------------------------------------------------
// Generation records
// ---------------------------------------------------------------------------
const textHash = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The given folder, or the first "name (n)" beside it that holds nothing yet. */
async function freeDir(target) {
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? target : `${target} (${n})`;
    const entries = await fs.readdir(candidate).catch(() => []);
    if (!entries.length) return candidate;
  }
  return target;
}

export function createGeneration({ title, author, text, voice = DEFAULT_VOICE, speakingRate = 1, userId = null }) {
  const cleaned = cleanText(text);
  if (!cleaned) throw new HttpError(400, 'There is no text to read.');
  if (cleaned.length > config.ttsMaxCharacters) {
    throw new HttpError(400, `That is ${cleaned.length.toLocaleString()} characters, over the ${config.ttsMaxCharacters.toLocaleString()} limit for one go. Split it into a few parts.`);
  }
  const bookTitle = sanitizeName(title, 'Untitled');
  const chapters = splitChapters(cleaned);
  const plan = chapters.map((chapter) => ({ title: chapter.title, chunks: chunkText(chapter.text) }));
  const chunkCount = plan.reduce((total, chapter) => total + chapter.chunks.length, 0);

  const info = db.prepare(`
    INSERT INTO generations
      (title, author, provider, voice, speaking_rate, source_text, text_hash, characters,
       chunk_count, chunks_done, chapters, status, progress, created_by, created_at, updated_at)
    VALUES (?, ?, 'google', ?, ?, ?, ?, ?, ?, 0, ?, 'pending', 0, ?, ?, ?)
  `).run(
    bookTitle, sanitizeName(author, '') || null, voice, Number(speakingRate) || 1,
    cleaned, textHash(cleaned),
    plan.reduce((total, chapter) => total + chapter.chunks.reduce((sum, chunk) => sum + chunk.length, 0), 0),
    chunkCount,
    JSON.stringify(plan.map((chapter) => ({ title: chapter.title, chunks: chapter.chunks.length }))),
    userId, now(), now(),
  );
  return Number(info.lastInsertRowid);
}

const shapeGeneration = (row) => ({
  id: row.id,
  title: row.title,
  author: row.author,
  voice: row.voice,
  tier: voiceTier(row.voice),
  characters: row.characters,
  chunkCount: row.chunk_count,
  chunksDone: row.chunks_done,
  chapters: JSON.parse(row.chapters || '[]'),
  status: row.status,
  progress: row.progress,
  error: row.error,
  output: row.output,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const listGenerations = () =>
  db.prepare('SELECT * FROM generations ORDER BY created_at DESC LIMIT 50').all().map(shapeGeneration);

export const getGeneration = (id) => {
  const row = db.prepare('SELECT * FROM generations WHERE id = ?').get(id);
  return row ? shapeGeneration(row) : null;
};

const workDirFor = (id) => path.join(config.ttsWorkDir, String(id));

export async function deleteGeneration(id) {
  const row = db.prepare('SELECT id FROM generations WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'No such generation');
  if (ttsState.running && ttsState.generationId === id) throw new HttpError(409, 'That one is still running.');
  await fs.rm(workDirFor(id), { recursive: true, force: true });
  db.prepare('DELETE FROM generations WHERE id = ?').run(id);
}

export function cancelGeneration(id) {
  if (!ttsState.running || ttsState.generationId !== id) throw new HttpError(409, 'That generation is not running.');
  ttsState.cancel = true;
  return true;
}

/**
 * Runs one generation to completion. Chunks already on disk from an earlier
 * attempt are reused, so a retry after a network wobble costs nothing extra.
 */
export async function runGeneration(id) {
  if (ttsState.running) throw new HttpError(409, 'Another generation is already running.');
  const row = db.prepare('SELECT * FROM generations WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'No such generation');
  if (!credentials()) throw new HttpError(400, 'No Google API key saved yet - add one on the Generate page first.');

  const update = (fields) => {
    const names = Object.keys(fields);
    db.prepare(`UPDATE generations SET ${names.map((name) => `${name} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...names.map((name) => fields[name]), now(), id);
  };

  const chapters = splitChapters(row.source_text).map((chapter) => ({
    ...chapter,
    chunks: chunkText(chapter.text),
  }));
  const total = chapters.reduce((sum, chapter) => sum + chapter.chunks.length, 0);

  Object.assign(ttsState, {
    running: true, cancel: false, generationId: id, title: row.title,
    progress: 0, chunk: 0, chunks: total, startedAt: now(), message: null,
  });
  update({ status: 'running', progress: 0, error: null, chunks_done: 0 });

  const workDir = workDirFor(id);
  await fs.mkdir(workDir, { recursive: true });
  const tier = voiceTier(row.voice);

  try {
    let index = 0;
    const chapterFiles = [];

    for (const [chapterIndex, chapter] of chapters.entries()) {
      const files = [];
      for (const chunk of chapter.chunks) {
        index++;
        if (ttsState.cancel) throw new HttpError(499, 'Cancelled.');

        // The hash in the name means a chunk is only reused when the text that
        // produced it is byte-for-byte the same.
        const file = path.join(workDir, `${String(index).padStart(4, '0')}-${textHash(chunk)}.mp3`);
        const existing = await fs.stat(file).catch(() => null);
        if (!existing || existing.size === 0) {
          const audio = await synthesize(chunk, { voice: row.voice, speakingRate: row.speaking_rate });
          await fs.writeFile(file, audio);
          recordUsage(tier, chunk.length);
        }
        files.push(file);

        ttsState.chunk = index;
        ttsState.progress = total ? index / total : 0;
        update({ progress: ttsState.progress, chunks_done: index });
      }

      const name = `${String(chapterIndex + 1).padStart(2, '0')} - ${sanitizeName(chapter.title, `Part ${chapterIndex + 1}`)}.mp3`;
      chapterFiles.push({ path: path.join(workDir, name), files, title: chapter.title, index: chapterIndex + 1 });
    }

    // Only once every chunk exists: a half-written book folder would be picked
    // up by the watcher and land on the shelf as a broken book.
    const author = row.author || 'Generated';
    // Generating the same title twice makes a second book rather than mixing
    // new chapters into the old folder, where a shorter second run would leave
    // the tail of the first one behind and the shelf would show both.
    const bookDir = await freeDir(path.join(
      config.generatedDir, sanitizeName(author, 'Generated'), sanitizeName(row.title, 'Untitled')));
    await fs.mkdir(bookDir, { recursive: true });

    for (const chapter of chapterFiles) {
      await stitch(chapter.files, chapter.path, {
        title: chapter.title,
        album: row.title,
        artist: author,
        album_artist: author,
        track: `${chapter.index}/${chapterFiles.length}`,
        genre: 'Speech',
        comment: `Generated by AudioShelf with ${row.voice}`,
      });
      await fs.rename(chapter.path, path.join(bookDir, path.basename(chapter.path)));
    }

    await fs.rm(workDir, { recursive: true, force: true });
    update({ status: 'done', progress: 1, output: bookDir, error: null, chunks_done: total });
    Object.assign(ttsState, { running: false, cancel: false, progress: 1, message: `Generated ${row.title}` });
    return { path: bookDir, chapters: chapterFiles.length };
  } catch (err) {
    const cancelled = err.status === 499;
    // Chunk files are deliberately left behind on failure: they are what makes
    // a retry free.
    update({ status: cancelled ? 'cancelled' : 'failed', error: cancelled ? null : err.message });
    Object.assign(ttsState, { running: false, cancel: false, message: err.message });
    throw err;
  }
}
