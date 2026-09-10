/**
 * Uploads: put a book on the shelf over HTTP instead of copying it onto the
 * server's disk by hand. Handy from a phone, another laptop, or a script.
 *
 * The body is the raw file, not multipart - browsers can send a File straight
 * through fetch/XHR, curl can --data-binary a path, and neither we nor the
 * caller has to buffer gigabytes in memory to parse an envelope.
 */
import { createWriteStream, promises as fs, constants as fsConstants } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { config } from './config.js';
import { HttpError, badRequest } from './http.js';

const ALLOWED_EXT = new Set([
  '.mp3', '.m4b', '.m4a', '.mp4', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.webm',
  '.aax', '.aaxc', '.voucher',
  '.jpg', '.jpeg', '.png', '.webp',
]);

const MAX_SEGMENTS = 3;

/** Strip a client-supplied name down to something safe to write. */
export function safeFileName(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  const base = path.posix.basename(raw);
  const cleaned = base
    .replace(/[\x00-\x1f<>:"|?*]/g, '')  // control chars and Windows-illegal
    .replace(/^\.+/, '')                     // no leading dots: no .., no hidden files
    .trim()
    .slice(0, 180);
  if (!cleaned) throw badRequest('That file needs a name');
  const ext = path.extname(cleaned).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw badRequest(`AudioShelf does not accept ${ext || 'files without an extension'}`);
  }
  return cleaned;
}

/** Sanitise "Author/Book Title" into path segments that cannot escape the root. */
export function safeSegments(folder) {
  return String(folder || '')
    .split(/[\\/]+/)
    .map((segment) => segment.replace(/[\x00-\x1f<>:"|?*]/g, '').replace(/^\.+/, '').trim().slice(0, 120))
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .slice(0, MAX_SEGMENTS);
}

export async function uploadTarget() {
  const dir = config.uploadDir;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.access(dir, fsConstants.W_OK);
    return { dir, writable: true };
  } catch {
    return { dir, writable: false };
  }
}

/**
 * Streams the request body to <library>/<folder>/<name>, writing to a .part
 * file first so the library watcher never sees a half-copied book.
 */
export async function receiveUpload(req, { name, folder }) {
  const { dir, writable } = await uploadTarget();
  if (!writable) {
    throw new HttpError(503, `Uploads are off because ${dir} is not writable. Point AUDIOSHELF_UPLOAD_DIR at a folder the server can write to.`);
  }

  const fileName = safeFileName(name);
  const segments = safeSegments(folder);
  const targetDir = path.resolve(dir, ...segments);

  // Belt and braces: even after sanitising, refuse anything outside the root.
  if (targetDir !== dir && !targetDir.startsWith(dir + path.sep)) {
    throw badRequest('That destination folder is not inside the library');
  }

  const declared = Number(req.headers['content-length']) || 0;
  const limit = config.uploadMaxGb * 1024 ** 3;
  if (declared > limit) {
    throw new HttpError(413, `That file is larger than the ${config.uploadMaxGb} GB upload limit`);
  }

  await fs.mkdir(targetDir, { recursive: true });
  const finalPath = await uniquePath(path.join(targetDir, fileName));
  const tempPath = `${finalPath}.part`;

  let written = 0;
  req.on('data', (chunk) => {
    written += chunk.length;
    if (written > limit) req.destroy(new Error('upload too large'));
  });

  try {
    await pipeline(req, createWriteStream(tempPath));
  } catch (err) {
    await fs.rm(tempPath, { force: true });
    if (/too large/.test(err.message)) {
      throw new HttpError(413, `That file is larger than the ${config.uploadMaxGb} GB upload limit`);
    }
    throw new HttpError(400, `The upload did not finish: ${err.message}`);
  }

  if (written === 0) {
    await fs.rm(tempPath, { force: true });
    throw badRequest('That file was empty');
  }

  await fs.rename(tempPath, finalPath);
  return {
    path: finalPath,
    relative: path.relative(dir, finalPath),
    name: path.basename(finalPath),
    folder: segments.join('/'),
    size: written,
  };
}

async function uniquePath(target) {
  const ext = path.extname(target);
  const base = target.slice(0, -ext.length);
  let candidate = target;
  for (let n = 2; n < 200; n++) {
    try {
      await fs.access(candidate);
      candidate = `${base} (${n})${ext}`;
    } catch {
      return candidate;
    }
  }
  return candidate;
}

export { ALLOWED_EXT };
