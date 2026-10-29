import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runScript } from './helpers.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;
const skip = ffmpegAvailable ? false : 'ffmpeg is not installed on this machine';

/**
 * Builds an .m4b exactly the way server/audible.js convert() does - audio
 * copied, chapters mapped in, faststart, mp4 - from silent audio and a chapter
 * list. ffmpeg packs several chapter titles into one chunk of such a file,
 * which is what music-metadata's chapter reader cannot follow.
 */
function convertedBook(dir, chapters, secondsEach) {
  const meta = [';FFMETADATA1', 'title=A Converted Book', 'artist=An Author', ''];
  for (let i = 0; i < chapters; i++) {
    meta.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${i * secondsEach * 1000}`,
      `END=${(i + 1) * secondsEach * 1000}`, `title=Part ${i + 1}`, '');
  }
  const metaFile = path.join(dir, `meta-${chapters}.txt`);
  writeFileSync(metaFile, meta.join('\n'));
  const source = path.join(dir, `source-${chapters}.m4a`);
  const output = path.join(dir, `book-${chapters}.m4b`);
  for (const args of [
    ['-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-t', String(chapters * secondsEach), '-c:a', 'aac', '-b:a', '32k', source],
    ['-i', source, '-i', metaFile, '-map', '0:a', '-c:a', 'copy', '-map_metadata', '1', '-map_chapters', '1',
      '-movflags', '+faststart', '-f', 'mp4', output],
  ]) {
    const result = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args]);
    if (result.status !== 0) throw new Error(`fixture build failed: ${result.stderr}`);
  }
  return output;
}

describe('scanning converted books with many chapters', { skip }, () => {
  let root;
  let books;

  before(() => {
    root = mkdtempSync(path.join(tmpdir(), 'audioshelf-chapters-'));
    books = { two: convertedBook(root, 2, 20), many: convertedBook(root, 41, 30) };
  });

  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  /** Scans a fresh library holding both books and returns what reached the shelf. */
  async function scan(name, extraEnv = {}) {
    const library = path.join(root, name, 'library');
    const data = path.join(root, name, 'data');
    for (const [label, file] of Object.entries(books)) {
      mkdirSync(path.join(library, 'An Author', label), { recursive: true });
      copyFileSync(file, path.join(library, 'An Author', label, 'book.m4b'));
    }
    const output = await runScript(['server/cli.js', 'scan'], {
      AUDIOSHELF_DATA: data, AUDIOSHELF_LIBRARY: library, ...extraEnv,
    });
    const db = new DatabaseSync(path.join(data, 'audioshelf.db'), { readOnly: true });
    const shelf = Object.fromEntries(db.prepare('SELECT id, folder, duration FROM books').all().map((book) => [
      path.basename(book.folder),
      {
        duration: book.duration,
        chapters: db.prepare('SELECT title, start FROM chapters WHERE book_id = ? ORDER BY idx').all(book.id),
      },
    ]));
    db.close();
    return { output, shelf };
  }

  test('a 41-chapter book reaches the shelf with every chapter, via ffprobe', async () => {
    // The first real pilot: three Audible books with 26 to 41 chapters each
    // converted perfectly, then the scanner skipped all three with
    // "Expected equal chunk-offset-table & sample-size-table length".
    const { output, shelf } = await scan('with-ffprobe');
    assert.doesNotMatch(output, /skipping/);
    assert.equal(shelf.many?.chapters.length, 41, 'every chapter, not a shelf entry without any');
    assert.equal(shelf.many.chapters[0].title, 'Part 1');
    assert.equal(shelf.many.chapters[40].title, 'Part 41');
    assert.ok(Math.abs(shelf.many.chapters[40].start - 1200) < 1, `last chapter starts at 20:00, got ${shelf.many.chapters[40].start}`);
    // music-metadata alone reads this one as a single chapter.
    assert.equal(shelf.two?.chapters.length, 2);
  });

  test('without ffprobe the book still reaches the shelf, just without chapter marks', async () => {
    const { output, shelf } = await scan('without-ffprobe', { AUDIOSHELF_FFPROBE: path.join(root, 'no-such-ffprobe') });
    assert.doesNotMatch(output, /skipping/, 'a chapter problem must never keep a book off the shelf');
    assert.ok(shelf.many, 'the 41-chapter book is on the shelf');
    assert.ok(shelf.many.duration > 1200, 'with its full length');
    assert.match(output, /chapters need ffprobe/, 'and the scan says why its chapters are missing');
  });
});
