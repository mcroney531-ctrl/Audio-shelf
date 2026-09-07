import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseFile } from 'music-metadata';
import { db } from './db.js';
import { config } from './config.js';

const AUDIO_EXT = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.m4b', 'audio/mp4'],
  ['.m4a', 'audio/mp4'],
  ['.mp4', 'audio/mp4'],
  ['.aac', 'audio/aac'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.opus', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.wav', 'audio/wav'],
  ['.webm', 'audio/webm'],
]);

const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'artwork'];
const COVER_EXT = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'],
]);

/** Live scan state, polled by the admin UI. */
export const scanState = {
  running: false,
  startedAt: null,
  finishedAt: null,
  found: 0,
  processed: 0,
  added: 0,
  updated: 0,
  removed: 0,
  current: null,
  error: null,
};

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const sha1 = (value) => createHash('sha1').update(value).digest('hex');

const sortTitle = (title) =>
  String(title || '').toLowerCase().replace(/^(the|a|an)\s+/, '').trim();

const clean = (value) => {
  if (value === undefined || value === null) return null;
  const text = String(Array.isArray(value) ? value[0] : value).trim();
  return text ? text : null;
};

/** Recursively collect audio files, one entry per directory. */
async function walk(dir, out = new Map(), seen = new Set()) {
  let real;
  try {
    real = await fs.realpath(dir);
  } catch {
    return out;
  }
  if (seen.has(real)) return out; // symlink loop
  seen.add(real);

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'EACCES' && err.code !== 'ENOENT') throw err;
    return out;
  }

  const files = [];
  const dirs = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '@eaDir') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) dirs.push(full);
    else if (entry.isFile() || entry.isSymbolicLink()) {
      if (AUDIO_EXT.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  }
  if (files.length) out.set(dir, files.sort(collator.compare));
  for (const child of dirs) await walk(child, out, seen);
  return out;
}

/**
 * A book is a folder of audio files. When a folder holds both audio files and
 * sub-folders that are themselves books, its loose files each become a
 * single-file book — that is the common "library root full of .m4b" layout.
 */
function groupIntoBooks(dirMap, libraryDir) {
  const dirs = [...dirMap.keys()];
  const hasBookChild = (dir) => dirs.some((d) => d !== dir && d.startsWith(dir + path.sep));
  const books = [];

  for (const [dir, files] of dirMap) {
    if (dir === libraryDir || hasBookChild(dir)) {
      for (const file of files) books.push({ folder: dir, files: [file], single: true });
    } else {
      books.push({ folder: dir, files, single: files.length === 1 });
    }
  }
  return books;
}

const bookKey = (book) =>
  sha1(book.single ? book.files[0] : book.folder + path.sep);

async function fingerprint(files) {
  const parts = [];
  for (const file of files) {
    const stat = await fs.stat(file);
    parts.push(`${file}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
  }
  return { hash: sha1(parts.join('|')), stats: parts };
}

function chapterSeconds(chapter, format) {
  if (Number.isFinite(chapter.sampleOffset) && format.sampleRate) {
    return chapter.sampleOffset / format.sampleRate;
  }
  const scale = chapter.timeScale || 1000;
  return (chapter.start || 0) / scale;
}

async function saveCover(key, picture, folder) {
  if (picture) {
    const ext = picture.format?.includes('png') ? '.png' : '.jpg';
    const name = `${key}${ext}`;
    await fs.writeFile(path.join(config.coversDir, name), Buffer.from(picture.data));
    return name;
  }
  let entries = [];
  try {
    entries = await fs.readdir(folder);
  } catch { return null; }
  const match = entries.find((entry) => {
    const ext = path.extname(entry).toLowerCase();
    return COVER_EXT.has(ext) && COVER_NAMES.includes(path.basename(entry, ext).toLowerCase());
  });
  if (!match) return null;
  const name = `${key}${path.extname(match).toLowerCase()}`;
  await fs.copyFile(path.join(folder, match), path.join(config.coversDir, name));
  return name;
}

/** Pull the fields we care about out of a parsed file's tags. */
function readTags(metadata) {
  const common = metadata.common || {};
  const native = metadata.native || {};
  const findNativeId = (...ids) => {
    const wanted = ids.map((id) => id.toLowerCase());
    for (const tags of Object.values(native)) {
      for (const tag of tags) {
        if (wanted.includes(tag.id.toLowerCase())) return clean(tag.value?.text ?? tag.value);
      }
    }
    return null;
  };
  const findNative = (needle) => {
    for (const tags of Object.values(native)) {
      for (const tag of tags) {
        if (tag.id.toLowerCase().includes(needle)) return clean(tag.value?.text ?? tag.value);
      }
    }
    return null;
  };
  return {
    album: clean(common.album),
    title: clean(common.title),
    author: clean(common.albumartist) || clean(common.artist) || findNative('author'),
    narrator: clean(common.composer) || findNative('narrat'),
    series: clean(common.movement) || clean(common.grouping)
      || findNativeId('TXXX:SERIES', '----:com.apple.iTunes:SERIES'),
    seriesIndex: Number.isFinite(common.movementIndex?.no)
      ? common.movementIndex.no
      : Number(findNativeId('TXXX:SERIES-PART', 'TXXX:SERIESPART', '----:com.apple.iTunes:SERIES-PART')) || null,
    description: clean(common.description) || clean(common.comment?.[0]?.text ?? common.comment?.[0]),
    year: Number.isFinite(common.year) ? common.year : null,
    genre: clean(common.genre),
    trackNo: common.track?.no ?? null,
    diskNo: common.disk?.no ?? null,
  };
}

async function parseTrack(file) {
  const metadata = await parseFile(file, { duration: true, includeChapters: true, skipPostHeaders: false });
  return { metadata, tags: readTags(metadata) };
}

const upsertBook = db.prepare(`
  INSERT INTO books (key, folder, title, sort_title, author, narrator, series, series_index,
                     year, genre, description, duration, track_count, size, cover, fingerprint,
                     added_at, scanned_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET
    folder = excluded.folder, title = excluded.title, sort_title = excluded.sort_title,
    author = excluded.author, narrator = excluded.narrator, series = excluded.series,
    series_index = excluded.series_index, year = excluded.year, genre = excluded.genre,
    description = excluded.description, duration = excluded.duration,
    track_count = excluded.track_count, size = excluded.size, cover = excluded.cover,
    fingerprint = excluded.fingerprint, scanned_at = excluded.scanned_at
`);

async function ingest(book, existing, now) {
  const key = bookKey(book);
  const parsed = [];
  for (const file of book.files) {
    try {
      parsed.push({ file, ...(await parseTrack(file)) });
    } catch (err) {
      console.warn(`[scan] skipping ${path.relative(config.libraryDir, file)}: ${err.message}`);
    }
  }
  if (!parsed.length) return null;

  parsed.sort((a, b) => {
    const disk = (a.tags.diskNo ?? 1) - (b.tags.diskNo ?? 1);
    if (disk) return disk;
    const track = (a.tags.trackNo ?? Infinity) - (b.tags.trackNo ?? Infinity);
    if (Number.isFinite(track) && track) return track;
    return collator.compare(a.file, b.file);
  });

  const first = parsed[0];
  const folderName = path.basename(book.folder);
  const fileName = path.basename(book.files[0], path.extname(book.files[0]));
  const title = first.tags.album || (book.single ? first.tags.title || fileName : folderName);
  const parentName = path.basename(path.dirname(book.folder));
  const author = first.tags.author
    || (!book.single && parentName !== path.basename(config.libraryDir) ? parentName : null);

  const cover = await saveCover(key, first.metadata.common?.picture?.[0], book.folder);

  let offset = 0;
  const tracks = [];
  for (const [idx, entry] of parsed.entries()) {
    const stat = await fs.stat(entry.file);
    const duration = Number(entry.metadata.format?.duration) || 0;
    tracks.push({
      idx,
      path: entry.file,
      title: entry.tags.title || path.basename(entry.file, path.extname(entry.file)),
      duration,
      start: offset,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs),
      mime: AUDIO_EXT.get(path.extname(entry.file).toLowerCase()) || 'audio/mpeg',
    });
    offset += duration;
  }

  // Chapters: embedded ones win, otherwise each file is a chapter.
  let chapters = [];
  const embedded = parsed.length === 1 ? first.metadata.format?.chapters : null;
  if (embedded?.length) {
    chapters = embedded.map((chapter, idx) => ({
      idx,
      title: clean(chapter.title) || `Chapter ${idx + 1}`,
      start: chapterSeconds(chapter, first.metadata.format),
    })).map((chapter, idx, all) => ({
      ...chapter,
      end: idx + 1 < all.length ? all[idx + 1].start : offset,
    }));
  } else if (tracks.length > 1) {
    chapters = tracks.map((track) => ({
      idx: track.idx,
      title: track.title,
      start: track.start,
      end: track.start + track.duration,
    }));
  }

  const fp = await fingerprint(book.files);
  const size = tracks.reduce((sum, track) => sum + track.size, 0);

  db.exec('BEGIN');
  try {
    upsertBook.run(
      key, book.folder, title, sortTitle(title), author, first.tags.narrator,
      first.tags.series, first.tags.seriesIndex, first.tags.year, first.tags.genre,
      first.tags.description, offset, tracks.length, size, cover, fp.hash,
      existing?.added_at ?? now, now,
    );
    const row = db.prepare('SELECT id FROM books WHERE key = ?').get(key);
    db.prepare('DELETE FROM tracks WHERE book_id = ?').run(row.id);
    db.prepare('DELETE FROM chapters WHERE book_id = ?').run(row.id);
    const insertTrack = db.prepare(
      'INSERT INTO tracks (book_id, idx, path, title, duration, start, size, mtime, mime) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    for (const track of tracks) {
      insertTrack.run(row.id, track.idx, track.path, track.title, track.duration, track.start, track.size, track.mtime, track.mime);
    }
    const insertChapter = db.prepare(
      'INSERT INTO chapters (book_id, idx, title, start, end) VALUES (?,?,?,?,?)'
    );
    for (const chapter of chapters) {
      insertChapter.run(row.id, chapter.idx, chapter.title, chapter.start, chapter.end);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return key;
}

export async function scanLibrary({ force = false } = {}) {
  if (scanState.running) return scanState;
  Object.assign(scanState, {
    running: true, startedAt: Date.now(), finishedAt: null, found: 0, processed: 0,
    added: 0, updated: 0, removed: 0, current: null, error: null,
  });

  try {
    await fs.access(config.libraryDir);
  } catch {
    Object.assign(scanState, {
      running: false, finishedAt: Date.now(),
      error: `Library folder not found: ${config.libraryDir}`,
    });
    return scanState;
  }

  try {
    const dirMap = await walk(config.libraryDir);
    const books = groupIntoBooks(dirMap, config.libraryDir);
    scanState.found = books.length;
    const now = Date.now();
    const seenKeys = new Set();

    for (const book of books) {
      const key = bookKey(book);
      seenKeys.add(key);
      scanState.current = path.relative(config.libraryDir, book.single ? book.files[0] : book.folder);
      const existing = db.prepare('SELECT id, added_at, fingerprint FROM books WHERE key = ?').get(key);
      const fp = await fingerprint(book.files);
      if (existing && existing.fingerprint === fp.hash && !force) {
        db.prepare('UPDATE books SET scanned_at = ? WHERE id = ?').run(now, existing.id);
      } else {
        try {
          if (await ingest(book, existing, now)) {
            if (existing) scanState.updated++; else scanState.added++;
          }
        } catch (err) {
          console.error(`[scan] failed on ${book.folder}: ${err.message}`);
        }
      }
      scanState.processed++;
      // Yield so streaming requests are not starved during a long scan.
      await new Promise((resolve) => setImmediate(resolve));
    }

    // Prune books that vanished — but never wipe the shelf if a mount dropped out.
    const stale = db.prepare('SELECT id, key, cover FROM books WHERE scanned_at < ?').all(now);
    if (stale.length && (seenKeys.size > 0 || books.length === 0)) {
      for (const row of stale) {
        db.prepare('DELETE FROM books WHERE id = ?').run(row.id);
        if (row.cover) await fs.rm(path.join(config.coversDir, row.cover), { force: true });
      }
      scanState.removed = stale.length;
    }
    scanState.current = null;
  } catch (err) {
    scanState.error = err.message;
    console.error('[scan] aborted:', err);
  } finally {
    scanState.running = false;
    scanState.finishedAt = Date.now();
  }
  return scanState;
}

export { AUDIO_EXT, COVER_EXT };
