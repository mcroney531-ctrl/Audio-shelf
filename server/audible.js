/**
 * Audible import: turns the .aax / .aaxc files you downloaded from your own
 * account into plain .m4b files the rest of AudioShelf can play.
 *
 * The decryption keys are NOT derived or cracked here - you supply them:
 *   .aax   needs your account's activation bytes (8 hex characters). Tools like
 *          audible-cli fetch them from your own account with your credentials.
 *   .aaxc  ships with a companion <name>.voucher JSON written by the Audible
 *          downloader; it holds the per-file key and iv, and we read it as-is.
 *
 * ffmpeg does the work (it has supported both formats for years) and the audio
 * stream is copied, never re-encoded: same bytes, same chapters, no quality
 * loss, and a conversion runs at disk speed rather than CPU speed.
 */
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { config } from './config.js';
import { HttpError } from './http.js';

export const AUDIBLE_EXT = new Set(['.aax', '.aaxc']);

/** One conversion at a time - these are large files and I/O bound. */
export const importState = {
  running: false,
  importId: null,
  title: null,
  progress: 0,
  startedAt: null,
  message: null,
};

const now = () => Date.now();

const run = (command, args, { onLine } = {}) => new Promise((resolve) => {
  let child;
  try {
    child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return resolve({ code: -1, stdout: '', stderr: err.message });
  }
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (onLine) String(chunk).split('\n').forEach((line) => onLine(line));
  });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-8000); });
  child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  child.on('close', (code) => resolve({ code, stdout, stderr }));
});

let toolsCache = null;

/** Is ffmpeg available, and does this build know about Audible files? */
export async function checkTools({ refresh = false } = {}) {
  if (toolsCache && !refresh) return toolsCache;
  const ffmpeg = await run(config.ffmpeg, ['-hide_banner', '-version']);
  const ffprobe = await run(config.ffprobe, ['-hide_banner', '-version']);
  const options = ffmpeg.code === 0 ? await run(config.ffmpeg, ['-hide_banner', '-h', 'demuxer=mov']) : null;
  const help = `${options?.stdout || ''}${options?.stderr || ''}`;

  toolsCache = {
    ffmpeg: ffmpeg.code === 0,
    ffprobe: ffprobe.code === 0,
    version: ffmpeg.code === 0
      ? (ffmpeg.stdout.split('\n')[0] || '').replace('ffmpeg version ', '').split(' Copyright')[0].trim()
      : null,
    supportsAax: help.includes('activation_bytes'),
    supportsAaxc: help.includes('audible_key'),
    path: config.ffmpeg,
  };
  return toolsCache;
}

const requireTools = async () => {
  const tools = await checkTools();
  if (!tools.ffmpeg) {
    throw new HttpError(503, `ffmpeg was not found (looked for "${config.ffmpeg}"). Install it, or set AUDIOSHELF_FFMPEG to its full path.`);
  }
  return tools;
};

export const normalizeActivationBytes = (value) => {
  const cleaned = String(value || '').trim().replace(/^0x/i, '').replace(/\s+/g, '');
  if (!/^[0-9a-fA-F]{8}$/.test(cleaned)) {
    throw new HttpError(400, 'Activation bytes must be exactly 8 hexadecimal characters, e.g. 1a2b3c4d');
  }
  return cleaned.toLowerCase();
};

const isHex = (value, length) => new RegExp(`^[0-9a-fA-F]{${length}}$`).test(String(value || '').trim());

/**
 * Reads the .voucher that Audible's own downloader writes next to a .aaxc.
 * Shape: { content_license: { license_response: { key, iv } } }, with a couple
 * of older layouts still in the wild.
 */
export async function readVoucher(aaxcPath) {
  const voucherPath = aaxcPath.replace(/\.aaxc$/i, '.voucher');
  let raw;
  try {
    raw = await fs.readFile(voucherPath, 'utf8');
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { path: voucherPath, error: 'The voucher file is not valid JSON' };
  }
  const license = parsed?.content_license?.license_response ?? parsed?.license_response ?? parsed;
  const key = license?.key ?? parsed?.key;
  const iv = license?.iv ?? parsed?.iv;
  if (!isHex(key, 32) || !isHex(iv, 32)) {
    return { path: voucherPath, error: 'The voucher does not contain a 16-byte key and iv' };
  }
  return { path: voucherPath, key: String(key).trim(), iv: String(iv).trim() };
}

const parseJson = (text) => {
  try { return JSON.parse(text); } catch { return null; }
};

/** Duration, tags and cover-stream presence. Works with or without keys. */
export async function probe(file, keys = {}) {
  await requireTools();
  const args = [...keyArgs(keys), '-v', 'error', '-print_format', 'json',
    '-show_format', '-show_streams', '-i', file];
  const result = await run(config.ffprobe, args);
  const data = parseJson(result.stdout);
  if (!data || !data.format) return { ok: false, error: tailError(result.stderr) };
  const tags = data.format.tags || {};
  return {
    ok: true,
    duration: Number(data.format.duration) || 0,
    title: tags.title || tags.album || null,
    author: tags.artist || tags.album_artist || null,
    narrator: tags.composer || null,
    hasCover: (data.streams || []).some((stream) =>
      stream.codec_type === 'video' && ['mjpeg', 'png', 'jpeg'].includes(stream.codec_name)),
  };
}

/**
 * The AAX file checksum ffmpeg prints. It is what activation-byte lookup tools
 * take as input, so we surface it rather than making anyone re-run ffmpeg.
 */
export async function aaxChecksum(file) {
  const result = await run(config.ffmpeg, ['-hide_banner', '-i', file, '-f', 'null', '-']);
  const match = /file checksum ==\s*([0-9a-f]+)/i.exec(`${result.stdout}${result.stderr}`);
  return match ? match[1] : null;
}

const keyArgs = ({ activationBytes, key, iv } = {}) => {
  if (activationBytes) return ['-activation_bytes', activationBytes];
  if (key && iv) return ['-audible_key', key, '-audible_iv', iv];
  return [];
};

const tailError = (stderr) => {
  const lines = String(stderr || '').trim().split('\n').filter(Boolean);
  const interesting = lines.filter((line) => /error|invalid|fail|missing|denied|no such/i.test(line));
  return (interesting.length ? interesting : lines).slice(-3).join(' / ').slice(0, 400) || 'ffmpeg failed';
};

const sanitize = (value, fallback) => {
  const cleaned = String(value || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 120) || fallback;
};

async function uniquePath(target) {
  const ext = path.extname(target);
  const base = target.slice(0, -ext.length);
  let candidate = target;
  for (let n = 2; n < 100; n++) {
    try {
      await fs.access(candidate);
      candidate = `${base} (${n})${ext}`;
    } catch {
      return candidate;
    }
  }
  return candidate;
}

/**
 * Converts one Audible file to .m4b with the audio stream copied verbatim.
 * Chapters, tags and cover art come along; nothing is re-encoded.
 */
export async function convert(file, keys, { onProgress, outputDir = config.importsDir } = {}) {
  const tools = await requireTools();
  const extension = path.extname(file).toLowerCase();

  if (extension === '.aax' && !keys.activationBytes) {
    throw new HttpError(400, 'This .aax needs your account activation bytes (8 hex characters).');
  }
  if (extension === '.aaxc' && !(keys.key && keys.iv)) {
    throw new HttpError(400, 'This .aaxc needs the key and iv from its .voucher file.');
  }
  if (extension === '.aax' && !tools.supportsAax) {
    throw new HttpError(503, 'This ffmpeg build has no Audible (.aax) support - install a standard ffmpeg build.');
  }
  if (extension === '.aaxc' && !tools.supportsAaxc) {
    throw new HttpError(503, 'This ffmpeg build is too old for .aaxc - ffmpeg 4.4 or newer is needed.');
  }

  const info = await probe(file, keys);
  if (!info.ok) {
    throw new HttpError(400, `Could not read that file with those keys: ${info.error}`);
  }

  const title = sanitize(info.title, path.basename(file, extension));
  const author = sanitize(info.author, 'Unknown Author');
  const targetDir = path.join(outputDir, author);
  await fs.mkdir(targetDir, { recursive: true });
  const finalPath = await uniquePath(path.join(targetDir, `${title}.m4b`));
  const tempPath = `${finalPath}.part`;

  const args = [
    '-nostdin', '-hide_banner', '-y',
    ...keyArgs(keys),
    '-i', file,
    '-map', '0:a', '-c:a', 'copy',
    ...(info.hasCover ? ['-map', '0:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic'] : []),
    '-map_metadata', '0',
    '-map_chapters', '0',
    '-movflags', '+faststart',
    '-f', 'mp4',
    '-progress', 'pipe:1', '-nostats',
    tempPath,
  ];

  const result = await run(config.ffmpeg, args, {
    onLine: (line) => {
      const match = /^out_time_us=(\d+)/.exec(line.trim());
      if (match && info.duration > 0 && onProgress) {
        onProgress(Math.min(0.999, Number(match[1]) / 1e6 / info.duration));
      }
    },
  });

  if (result.code !== 0) {
    await fs.rm(tempPath, { force: true });
    const message = tailError(result.stderr);
    throw new HttpError(400, /activation|invalid data|decrypt|key/i.test(message)
      ? `Decryption failed - check the activation bytes or voucher for this file. (${message})`
      : `ffmpeg could not convert this file: ${message}`);
  }

  const check = await probe(tempPath);
  if (!check.ok || check.duration <= 0) {
    await fs.rm(tempPath, { force: true });
    throw new HttpError(400, 'The converted file came out empty - the keys are probably wrong for this book.');
  }

  await fs.rename(tempPath, finalPath);
  if (onProgress) onProgress(1);
  return { path: finalPath, duration: check.duration, title, author };
}

// ---------------------------------------------------------------------------
// Import records
// ---------------------------------------------------------------------------
export const getSetting = (key) => db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;

export const setSetting = (key, value) =>
  db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value), now());

export const ACTIVATION_KEY = 'audible.activation_bytes';

export const storedActivationBytes = () => getSetting(ACTIVATION_KEY);

/** Records (or refreshes) one Audible file found during a scan. */
export async function noteImport(file, stat) {
  const format = path.extname(file).toLowerCase().slice(1);
  const existing = db.prepare('SELECT * FROM imports WHERE path = ?').get(file);
  const voucher = format === 'aaxc' ? await readVoucher(file) : null;
  const hasVoucher = voucher && !voucher.error ? 1 : 0;

  if (existing) {
    db.prepare('UPDATE imports SET size = ?, mtime = ?, has_voucher = ?, updated_at = ? WHERE id = ?')
      .run(stat.size, Math.floor(stat.mtimeMs), hasVoucher, now(), existing.id);
    return existing.id;
  }

  const info = await probe(file).catch(() => ({ ok: false }));
  const inserted = db.prepare(`
    INSERT INTO imports (path, format, size, mtime, title, author, duration, has_voucher, status, discovered_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(
    file, format, stat.size, Math.floor(stat.mtimeMs),
    info.title || path.basename(file, path.extname(file)), info.author || null,
    info.duration || 0, hasVoucher, now(), now(),
  );
  return Number(inserted.lastInsertRowid);
}

/** Drops rows for files that are no longer on disk. */
export function pruneImports() {
  const rows = db.prepare('SELECT id, path FROM imports').all();
  for (const row of rows) {
    if (!existsSync(row.path)) db.prepare('DELETE FROM imports WHERE id = ?').run(row.id);
  }
}

export const listImports = () =>
  db.prepare("SELECT * FROM imports ORDER BY status = 'done', discovered_at DESC").all().map((row) => ({
    id: row.id,
    path: row.path,
    file: path.basename(row.path),
    format: row.format,
    size: row.size,
    title: row.title,
    author: row.author,
    duration: row.duration,
    hasVoucher: !!row.has_voucher,
    checksum: row.checksum,
    status: row.status,
    progress: row.progress,
    error: row.error,
    output: row.output,
    needs: row.format === 'aax' ? 'activation-bytes' : 'voucher',
  }));

/** Fills in (and caches) the checksum an activation-byte lookup needs. */
export async function ensureChecksum(id) {
  const row = db.prepare('SELECT * FROM imports WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'No such import');
  if (row.checksum) return row.checksum;
  if (row.format !== 'aax') return null;
  await requireTools();
  const checksum = await aaxChecksum(row.path);
  if (checksum) db.prepare('UPDATE imports SET checksum = ?, updated_at = ? WHERE id = ?').run(checksum, now(), id);
  return checksum;
}

/** Runs one import to completion, updating its row as it goes. */
export async function runImport(id, keys = {}) {
  if (importState.running) throw new HttpError(409, 'Another import is already running');
  const row = db.prepare('SELECT * FROM imports WHERE id = ?').get(id);
  if (!row) throw new HttpError(404, 'No such import');

  const update = (fields) => {
    const names = Object.keys(fields);
    db.prepare(`UPDATE imports SET ${names.map((name) => `${name} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
      .run(...names.map((name) => fields[name]), now(), id);
  };

  Object.assign(importState, {
    running: true, importId: id, title: row.title, progress: 0, startedAt: now(), message: null,
  });
  update({ status: 'converting', progress: 0, error: null });

  try {
    // Resolve keys inside the try so a missing voucher is recorded on the row
    // rather than vanishing into a rejected promise.
    const resolved = { ...keys };
    if (row.format === 'aax' && !resolved.activationBytes) {
      const stored = storedActivationBytes();
      if (stored) resolved.activationBytes = stored;
    }
    if (row.format === 'aaxc' && !(resolved.key && resolved.iv)) {
      const voucher = await readVoucher(row.path);
      if (voucher?.error) throw new HttpError(400, voucher.error);
      if (!voucher) {
        throw new HttpError(400, `No .voucher file next to ${path.basename(row.path)} - Audible's downloader writes it alongside the .aaxc.`);
      }
      resolved.key = voucher.key;
      resolved.iv = voucher.iv;
    }

    const result = await convert(row.path, resolved, {
      onProgress: (fraction) => {
        importState.progress = fraction;
        update({ progress: fraction });
      },
    });
    update({ status: 'done', progress: 1, output: result.path, error: null });
    Object.assign(importState, { running: false, progress: 1, message: `Imported ${result.title}` });
    return result;
  } catch (err) {
    update({ status: 'failed', error: err.message });
    Object.assign(importState, { running: false, message: err.message });
    throw err;
  }
}
