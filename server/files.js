import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { notFound } from './http.js';

const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff2', 'font/woff2'],
  ['.txt', 'text/plain; charset=utf-8'],
]);

const etagFor = (stat) => `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;

/**
 * Send a file with byte-range support. Audio elements lean on this hard:
 * seeking in a 12-hour m4b is nothing but a stream of Range requests.
 */
export async function sendFile(req, res, filePath, { contentType, cacheControl, download } = {}) {
  let stat;
  try {
    stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw notFound('File is missing from disk');
  }

  const etag = etagFor(stat);
  const type = contentType || STATIC_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
  const headers = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'last-modified': new Date(stat.mtimeMs).toUTCString(),
    etag,
    'cache-control': cacheControl || 'private, max-age=0, must-revalidate',
  };
  if (download) headers['content-disposition'] = `attachment; filename="${encodeURIComponent(download)}"`;

  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }

  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!match) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    let [, rawStart, rawEnd] = match;
    let start;
    let end;
    if (rawStart === '') {
      const suffix = Number(rawEnd);
      if (!Number.isFinite(suffix) || suffix <= 0) {
        res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` });
        return res.end();
      }
      start = Math.max(0, stat.size - suffix);
      end = stat.size - 1;
    } else {
      start = Number(rawStart);
      end = rawEnd === '' ? stat.size - 1 : Math.min(Number(rawEnd), stat.size - 1);
    }
    if (!Number.isFinite(start) || start > end || start >= stat.size) {
      res.writeHead(416, { ...headers, 'content-range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${start}-${end}/${stat.size}`,
      'content-length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    return pipe(createReadStream(filePath, { start, end }), res);
  }

  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  return pipe(createReadStream(filePath), res);
}

function pipe(stream, res) {
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

/** Resolve a URL path inside a root directory, refusing anything that escapes it. */
export function resolveWithin(rootDir, urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.resolve(rootDir, '.' + path.posix.normalize('/' + decoded));
  if (resolved !== rootDir && !resolved.startsWith(rootDir + path.sep)) return null;
  return resolved;
}

export async function serveStatic(req, res, urlPath) {
  let target = resolveWithin(config.webDir, urlPath === '/' ? '/index.html' : urlPath);
  if (!target) throw notFound();
  let stat = await fs.stat(target).catch(() => null);
  if (stat?.isDirectory()) {
    target = path.join(target, 'index.html');
    stat = await fs.stat(target).catch(() => null);
  }
  if (!stat) {
    // Client-side routes fall back to the app shell.
    if (path.extname(urlPath)) throw notFound();
    target = path.join(config.webDir, 'index.html');
  }
  const immutable = /\.(woff2|png|svg|ico)$/i.test(target);
  await sendFile(req, res, target, {
    cacheControl: immutable ? 'public, max-age=604800' : 'no-cache',
  });
}

export async function streamTrack(req, res, trackId) {
  const track = db.prepare('SELECT t.*, b.title FROM tracks t JOIN books b ON b.id = t.book_id WHERE t.id = ?')
    .get(trackId);
  if (!track) throw notFound('No such track');
  await sendFile(req, res, track.path, {
    contentType: track.mime,
    // Immutable from the browser's point of view; a re-scan mints new track ids.
    cacheControl: 'private, max-age=31536000, immutable',
  });
}

export async function sendCover(req, res, bookId, { size } = {}) {
  const book = db.prepare('SELECT cover FROM books WHERE id = ?').get(bookId);
  if (!book?.cover) throw notFound('No cover art');
  await sendFile(req, res, path.join(config.coversDir, book.cover), {
    cacheControl: 'private, max-age=86400',
  });
}

export const fileHash = (value) => createHash('sha1').update(value).digest('hex');
