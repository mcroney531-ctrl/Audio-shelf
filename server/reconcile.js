/**
 * Accounts for every entry in an Audible library export: where it is in the
 * journey from "bought" to "playable on the shelf", and what is in the way.
 *
 * Read-only by design. It never converts, scans, moves or marks anything; it
 * looks at the export, the files on disk, the import records and the converted
 * output, and says what it found. A migration is finished when this report says
 * so, not when the converter stops complaining.
 *
 * Matching is by ASIN, because titles are not unique: editions, dramatised
 * versions and "Book 1" of two different series all collide. Files downloaded
 * with `audible download --filename-mode asin_only` are named <ASIN>-<codec>.aax,
 * and any filename containing a known ASIN as a separate token counts as a match.
 * Title matching is only ever a fallback, and its results are always flagged for
 * review rather than trusted.
 *
 * "Verified" means the converted file exists, is not empty, ffprobe can read it,
 * its length agrees with what Audible says the book runs for, and the scanner
 * has put it on the shelf. It does not mean anyone has listened to it. Play a
 * few before deleting originals.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Report order. Each export entry lands in exactly one of these. */
export const STATES = [
  ['verified', 'Converted and verified'],
  ['unverified', 'Converted, not verified (ffprobe unavailable)'],
  ['not-shelved', 'Converted, but not on the shelf'],
  ['invalid', 'File missing, empty, unreadable or wrong length'],
  ['failed', 'Conversion failed'],
  ['not-converted', 'Downloaded, not converted yet'],
  ['not-downloaded', 'Not downloaded'],
  ['excluded', 'Excluded on purpose'],
  ['review', 'Needs review'],
];

const DONE_STATES = new Set(['verified', 'excluded']);
const AUDIBLE_EXT = new Set(['.aax', '.aaxc']);
const PLAIN_AUDIO_EXT = new Set(['.mp3', '.m4b', '.m4a', '.mp4', '.flac', '.ogg', '.opus']);
const ASIN_SHAPE = /^(B0[0-9A-Z]{8}|\d{9}[\dX])$/;

// ---------------------------------------------------------------------------
// The export
// ---------------------------------------------------------------------------
/**
 * A tiny RFC 4180 reader: quoted fields, doubled quotes, delimiters and line
 * breaks inside quotes. Enough for audible-cli's csv and tsv output, whose
 * descriptions are full of commas and the occasional newline.
 */
function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) { row.push(field); field = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const [header, ...body] = rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
  if (!header) return [];
  const names = header.map((name) => name.trim());
  return body.map((cells) => Object.fromEntries(names.map((name, i) => [name, cells[i] ?? ''])));
}

const authorsOf = (raw) => {
  const value = raw.authors ?? raw.author;
  if (Array.isArray(value)) return value.map((entry) => entry?.name ?? entry).filter(Boolean).join(', ');
  return value ? String(value) : null;
};

function normaliseRecord(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { index, asin: null, title: null, authors: null, runtimeMin: null, problem: 'not an object' };
  }
  const asin = String(raw.asin ?? raw.ASIN ?? '').trim().toUpperCase() || null;
  const runtime = Number(raw.runtime_length_min);
  return {
    index,
    asin,
    title: raw.title ? String(raw.title) : null,
    authors: authorsOf(raw),
    runtimeMin: Number.isFinite(runtime) && runtime > 0 ? runtime : null,
    problem: null,
  };
}

/**
 * Reads `audible library export` output. audible-cli writes TSV unless told
 * `--format json`, whatever the output file is called, so a "library.json"
 * full of tabs is the common case and is read rather than rejected.
 */
export function parseLibraryExport(text) {
  const body = String(text || '').replace(/^﻿/, '');
  const start = body.trimStart()[0];

  if (start === '[' || start === '{') {
    let data;
    try {
      data = JSON.parse(body);
    } catch (err) {
      throw new Error(`The library export looks like JSON but does not parse: ${err.message}`);
    }
    let list = Array.isArray(data) ? data : null;
    if (!list) {
      for (const key of ['items', 'library', 'books', 'data']) {
        if (Array.isArray(data?.[key])) { list = data[key]; break; }
      }
    }
    if (!list) {
      throw new Error(`Expected a list of books, but the JSON is an object with keys: ${Object.keys(data || {}).join(', ') || 'none'}.`);
    }
    return { format: 'json', records: list.map(normaliseRecord) };
  }

  const firstLine = body.split(/\r?\n/, 1)[0] || '';
  if (/\basin\b/i.test(firstLine)) {
    const delimiter = firstLine.includes('\t') ? '\t' : ',';
    return {
      format: delimiter === '\t' ? 'tsv' : 'csv',
      records: parseDelimited(body, delimiter).map(normaliseRecord),
    };
  }
  throw new Error('The library export is neither JSON nor a CSV/TSV file with an "asin" column. Create it with: audible library export --format json --output library.json');
}

/** `ASIN  optional reason`, one per line, # for comments. */
export function parseExclusions(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const clean = line.replace(/#.*$/, '').trim();
    if (!clean) continue;
    const [asin, ...reason] = clean.split(/\s+/);
    out.set(asin.toUpperCase(), reason.join(' ') || 'excluded');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
/** Every separate alphanumeric token of a filename that is an ASIN we know. */
export function asinsInName(fileName, known) {
  const stem = path.basename(fileName).replace(/\.[^.]+$/, '');
  return [...new Set(stem.split(/[^A-Za-z0-9]+/).map((token) => token.toUpperCase())
    .filter((token) => known.has(token)))];
}

const looksLikeAsin = (fileName) => path.basename(fileName).replace(/\.[^.]+$/, '')
  .split(/[^A-Za-z0-9]+/).map((token) => token.toUpperCase()).find((token) => ASIN_SHAPE.test(token)) || null;

/**
 * Audible files anywhere under the given folders, plus plain audio files whose
 * names carry a known ASIN (a book someone converted with another tool).
 */
export async function collectSources(roots, knownAsins) {
  const found = [];
  const seen = new Set();

  async function walk(dir, root) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(full, root); continue; }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      const audible = AUDIBLE_EXT.has(ext);
      if (!audible && !(PLAIN_AUDIO_EXT.has(ext) && asinsInName(entry.name, knownAsins).length)) continue;
      const key = path.resolve(full);
      if (seen.has(key)) continue;
      seen.add(key);
      const stat = await fs.stat(full).catch(() => null);
      found.push({
        path: full,
        root,
        kind: audible ? ext.slice(1) : 'audio',
        size: stat?.size ?? 0,
        hasVoucher: ext === '.aaxc'
          ? !!(await fs.stat(full.replace(/\.aaxc$/i, '.voucher')).catch(() => null))
          : null,
      });
    }
  }

  for (const root of roots.filter(Boolean)) await walk(root, root);
  return found;
}

// ---------------------------------------------------------------------------
// Reconciling
// ---------------------------------------------------------------------------
/** A path in a form two spellings of the same file agree on. */
export const pathKey = (value) => {
  const norm = path.resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
};
const samePath = (a, b) => pathKey(a) === pathKey(b);

const normaliseTitle = (value) => String(value || '').toLowerCase()
  .replace(/^(the|a|an)\s+/, '').replace(/[^a-z0-9]+/g, '');

export const formatDuration = (seconds) => {
  const minutes = Math.round(Number(seconds) / 60);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
};

/**
 * One candidate per downloaded book: disk files and import records for the same
 * path are merged, and a file copied (not moved) from the download folder into
 * the library - same name, same size - counts once rather than as a duplicate.
 */
function buildCandidates(sources, imports) {
  const candidates = [];
  const find = (filePath) => candidates.find((candidate) => candidate.paths.some((p) => samePath(p, filePath)));

  for (const row of imports) {
    candidates.push({ paths: [row.path], kind: row.format, size: null, onDisk: false, import: row, root: null });
  }
  // Two passes, so a copy in the download folder is compared against the
  // library file it duplicates no matter which folder was walked first.
  const loose = [];
  for (const source of sources) {
    const existing = find(source.path);
    if (existing) Object.assign(existing, { size: source.size, onDisk: true, hasVoucher: source.hasVoucher, root: source.root });
    else loose.push(source);
  }
  for (const source of loose) {
    const copy = candidates.find((candidate) => candidate.onDisk
      && path.basename(candidate.paths[0]).toLowerCase() === path.basename(source.path).toLowerCase()
      && candidate.size === source.size);
    if (copy) { copy.paths.push(source.path); continue; }
    candidates.push({
      paths: [source.path], kind: source.kind, size: source.size, onDisk: true,
      hasVoucher: source.hasVoucher, import: null, root: source.root,
    });
  }
  return candidates;
}

/** Where one downloaded copy of a book has got to. */
function assess(candidate, record, { outputs, hasActivationBytes, downloadRoots, shelved }) {
  const where = candidate.paths[0];
  const row = candidate.import;

  if (candidate.kind === 'audio') {
    return { state: 'review', detail: `found as a plain audio file, not an Audible download: ${where}` };
  }
  if (candidate.onDisk && candidate.size === 0) {
    return { state: 'invalid', detail: `downloaded file is empty: ${where}` };
  }

  if (!row) {
    const inDownloads = candidate.root && downloadRoots.some((root) => samePath(root, candidate.root));
    const needs = [];
    if (inDownloads) needs.push('still in the download folder: move it into the library, then rescan');
    else needs.push('not scanned yet: rescan the library');
    if (candidate.kind === 'aaxc' && candidate.hasVoucher === false) needs.push('no .voucher file beside it');
    return { state: 'not-converted', detail: `${needs.join('; ')} (${where})` };
  }

  if (row.status === 'failed') {
    return { state: 'failed', detail: row.error || 'conversion failed with no message recorded' };
  }
  if (row.status === 'converting') {
    return { state: 'not-converted', detail: 'marked as converting, but nothing is running: convert it again' };
  }
  if (row.status !== 'done') {
    const hints = ['waiting for conversion'];
    if (row.format === 'aax' && !hasActivationBytes) hints.push('no activation bytes saved yet');
    if (row.format === 'aaxc' && !row.has_voucher) hints.push('no .voucher file beside it');
    return { state: 'not-converted', detail: hints.join('; ') };
  }

  // Marked done. Trust the file, not the flag.
  if (!row.output) return { state: 'invalid', detail: 'marked converted, but no output file is recorded' };
  const out = outputs.get(row.output);
  if (!out || !out.exists) return { state: 'invalid', detail: `converted file is missing: ${row.output}` };
  if (!out.size) return { state: 'invalid', detail: `converted file is empty: ${row.output}` };
  if (!out.probe) return { state: 'unverified', detail: row.output };
  if (!out.probe.ok) return { state: 'invalid', detail: `converted file does not read: ${out.probe.error || 'ffprobe failed'}` };
  if (!(out.probe.duration > 0)) return { state: 'invalid', detail: 'converted file has no length' };

  if (record?.runtimeMin) {
    const expected = record.runtimeMin * 60;
    const tolerance = Math.max(180, expected * 0.03);
    if (Math.abs(out.probe.duration - expected) > tolerance) {
      return {
        state: 'invalid',
        detail: `length is ${formatDuration(out.probe.duration)}, Audible lists ${formatDuration(expected)}: incomplete download or wrong file`,
      };
    }
  }
  // A sound file nobody can find in the app is not migrated. The first pilot
  // proved this: three books passed every check above while the scanner was
  // rejecting all of them, so the report and the shelf disagreed.
  if (shelved && !shelved.has(pathKey(row.output))) {
    return {
      state: 'not-shelved',
      detail: `reads fine but is not on the shelf: rescan, and look for a "[scan] skipping" line for ${row.output}`,
    };
  }
  return { state: 'verified', detail: `${formatDuration(out.probe.duration)}, ${row.output}` };
}

/**
 * The whole report. Pure: everything it needs is passed in, so it can be tested
 * without Audible, ffmpeg or a database.
 */
export function reconcile({
  records, sources = [], imports = [], outputs = new Map(), exclusions = new Map(),
  hasActivationBytes = false, downloadRoots = [], shelved = null,
}) {
  const known = new Set(records.map((record) => record.asin).filter(Boolean));
  const counts = new Map();
  for (const record of records) if (record.asin) counts.set(record.asin, (counts.get(record.asin) || 0) + 1);

  const candidates = buildCandidates(sources, imports);
  for (const candidate of candidates) {
    candidate.asins = [...new Set(candidate.paths.flatMap((p) => asinsInName(p, known)))];
    candidate.claimed = false;
  }
  // `shelved` is the set of track paths the scanner has put on the shelf (as
  // pathKey values). Leaving it out skips that check.
  const context = { outputs, hasActivationBytes, downloadRoots, shelved };

  const entries = records.map((record) => {
    const base = { index: record.index, asin: record.asin, title: record.title, authors: record.authors };
    if (!record.asin) {
      return { ...base, state: 'review', detail: `export entry ${record.index + 1} has no ASIN${record.problem ? ` (${record.problem})` : ''}` };
    }

    const matches = candidates.filter((candidate) => candidate.asins.includes(record.asin));
    for (const candidate of matches) candidate.claimed = true;
    const assessed = matches.map((candidate) => ({ candidate, ...assess(candidate, record, context) }));

    if (exclusions.has(record.asin)) {
      const note = assessed.some((item) => item.state === 'verified') ? '; a verified copy is also present' : '';
      return { ...base, state: 'excluded', detail: `${exclusions.get(record.asin)}${note}` };
    }
    if (counts.get(record.asin) > 1) {
      return { ...base, state: 'review', detail: `this ASIN appears ${counts.get(record.asin)} times in the export` };
    }
    if (assessed.length > 1) {
      return {
        ...base,
        state: 'review',
        detail: `${assessed.length} copies found: ${assessed.map((item) => `${item.candidate.paths[0]} (${item.state})`).join('; ')}`,
      };
    }
    if (assessed.length === 1) return { ...base, state: assessed[0].state, detail: assessed[0].detail };
    return { ...base, state: 'not-downloaded', detail: null, needsTitleCheck: true };
  });

  // Title is a fallback only, and only for imports nothing else has claimed.
  // Whatever it finds goes to review: two books can share a title.
  for (const entry of entries.filter((item) => item.needsTitleCheck)) {
    delete entry.needsTitleCheck;
    const wanted = normaliseTitle(entry.title);
    if (!wanted) continue;
    const byTitle = candidates.filter((candidate) => !candidate.claimed
      && candidate.import && normaliseTitle(candidate.import.title) === wanted);
    if (!byTitle.length) continue;
    for (const candidate of byTitle) candidate.claimed = true;
    entry.state = 'review';
    entry.detail = `no file named with this ASIN; matched by title only: ${byTitle
      .map((candidate) => `${candidate.paths[0]} (${assess(candidate, null, context).state})`).join('; ')}`;
  }

  const extras = candidates.filter((candidate) => !candidate.claimed).map((candidate) => {
    const asin = looksLikeAsin(candidate.paths[0]);
    return {
      path: candidate.paths[0],
      kind: candidate.kind,
      status: candidate.import?.status ?? (candidate.onDisk ? 'not scanned' : 'unknown'),
      reason: asin ? `ASIN ${asin} is not in the export` : 'no ASIN in the filename',
    };
  });

  const byState = Object.fromEntries(STATES.map(([key]) => [key, 0]));
  for (const entry of entries) byState[entry.state]++;
  const accounted = Object.values(byState).reduce((sum, n) => sum + n, 0);

  return {
    entries,
    extras,
    totals: { entries: records.length, accounted, byState },
    complete: records.length > 0 && entries.every((entry) => DONE_STATES.has(entry.state)),
  };
}

// ---------------------------------------------------------------------------
// The console version
// ---------------------------------------------------------------------------
export function formatReport(report, { verbose = false, header = [] } = {}) {
  const lines = ['Audible library reconciliation', ...header.map((line) => `  ${line}`), ''];
  const label = (key) => STATES.find(([state]) => state === key)[1];
  const width = Math.max(...STATES.map(([, text]) => text.length)) + 4;

  for (const [key, text] of STATES) {
    lines.push(`  ${text.padEnd(width, '.')} ${report.totals.byState[key]}`);
  }
  lines.push(`  ${'Total'.padEnd(width, '.')} ${report.totals.entries}`
    + (report.totals.accounted === report.totals.entries ? '  (every entry accounted for)' : '  (MISMATCH: please report this)'));

  const describe = (entry) => {
    const name = entry.title || '(untitled)';
    return `    ${(entry.asin || '----------').padEnd(10)}  ${name}${entry.detail ? `\n                ${entry.detail}` : ''}`;
  };

  for (const [key] of STATES) {
    if (key === 'verified' && !verbose) continue;
    const group = report.entries.filter((entry) => entry.state === key)
      .sort((a, b) => String(a.title).localeCompare(String(b.title)));
    if (!group.length) continue;
    lines.push('', `  ${label(key)} (${group.length})`, ...group.map(describe));
  }

  if (report.extras.length) {
    lines.push('', `  On disk or imported, but not in the export (${report.extras.length})`);
    for (const extra of report.extras) lines.push(`    ${extra.path}\n                ${extra.reason}; ${extra.status}`);
  }

  const open = report.entries.filter((entry) => !DONE_STATES.has(entry.state)).length;
  lines.push('');
  lines.push(report.complete
    ? 'Complete: every entry is verified or deliberately excluded.'
    : `Not complete: ${open} of ${report.totals.entries} entries need attention.`);
  lines.push('"Verified" means the file exists, reads, is the right length and is on the shelf - not that it has been listened to.');
  lines.push('Keep the original .aax/.aaxc files and vouchers until you have played a sample and taken a backup.');
  return lines.join('\n');
}
