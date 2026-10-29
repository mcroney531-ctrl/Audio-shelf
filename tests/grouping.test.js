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

// convert() lives in a module that opens the database on import, so point it at
// a scratch data folder first.
const root = mkdtempSync(path.join(tmpdir(), 'audioshelf-grouping-'));
process.env.AUDIOSHELF_DATA = path.join(root, 'unit-data');
process.env.AUDIOSHELF_LIBRARY = path.join(root, 'unit-library');

/** A small tagged, chaptered m4b standing in for a decrypted Audible download. */
function sourceBook(title, author, chapters = 3) {
  const meta = [';FFMETADATA1', `title=${title}`, `album=${title}`, `artist=${author}`, ''];
  for (let i = 0; i < chapters; i++) {
    meta.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${i * 10000}`, `END=${(i + 1) * 10000}`, `title=Chapter ${i + 1}`, '');
  }
  const slug = title.replace(/\W+/g, '-');
  const metaFile = path.join(root, `${slug}.txt`);
  const file = path.join(root, `${slug}.m4b`);
  writeFileSync(metaFile, meta.join('\n'));
  const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono', '-i', metaFile,
    '-t', String(chapters * 10), '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1',
    '-c:a', 'aac', '-b:a', '32k', '-f', 'mp4', file]);
  if (made.status !== 0) throw new Error(`fixture build failed: ${made.stderr}`);
  return file;
}

describe('several imported books by one author', { skip }, () => {
  let env;
  let imports;

  before(() => {
    imports = path.join(root, 'imported');
    env = {
      AUDIOSHELF_DATA: path.join(root, 'data'),
      AUDIOSHELF_LIBRARY: path.join(root, 'library'),
      AUDIOSHELF_IMPORTS: imports,
    };
    mkdirSync(env.AUDIOSHELF_LIBRARY, { recursive: true });
  });

  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const shelf = () => {
    const db = new DatabaseSync(path.join(env.AUDIOSHELF_DATA, 'audioshelf.db'), { readOnly: true });
    const books = db.prepare('SELECT id, key, title, author, track_count AS tracks FROM books ORDER BY title').all();
    db.close();
    return books;
  };

  test('each one is its own shelf entry, and a book from before the fix keeps its identity', async () => {
    // A pilot book converted before this fix sits loose in its author folder.
    mkdirSync(path.join(imports, 'Steve Coll'), { recursive: true });
    copyFileSync(sourceBook('Ghost Wars', 'Steve Coll'), path.join(imports, 'Steve Coll', 'Ghost Wars.m4b'));
    await runScript(['server/cli.js', 'scan'], env);
    const before = shelf();
    assert.equal(before.length, 1);
    const ghostWars = before[0];

    // Then two more books by the same author go through the real converter.
    const { convert } = await import('../server/audible.js');
    const first = await convert(sourceBook('Directorate S', 'Steve Coll'), {}, { outputDir: imports });
    const second = await convert(sourceBook('Private Empire', 'Steve Coll'), {}, { outputDir: imports });
    assert.notEqual(path.dirname(first.path), path.dirname(second.path), 'each book gets its own folder');

    await runScript(['server/cli.js', 'scan'], env);
    const after = shelf();
    assert.deepEqual(after.map((book) => book.title), ['Directorate S', 'Ghost Wars', 'Private Empire'],
      'three books, not one three-part book');
    assert.ok(after.every((book) => book.author === 'Steve Coll' && book.tracks === 1));

    // Same row, same key: listening progress and bookmarks hang off the id, so
    // the pilot book keeps them.
    const stillThere = after.find((book) => book.title === 'Ghost Wars');
    assert.equal(stillThere.id, ghostWars.id);
    assert.equal(stillThere.key, ghostWars.key);
  });

  test('a genuinely multi-part book in one folder is still one book', async () => {
    // The rule the fix must not break: parts of one book share a folder.
    const parts = path.join(env.AUDIOSHELF_LIBRARY, 'An Author', 'A Long Book');
    mkdirSync(parts, { recursive: true });
    const part = sourceBook('A Long Book', 'An Author', 1);
    copyFileSync(part, path.join(parts, 'Part 1.m4b'));
    copyFileSync(part, path.join(parts, 'Part 2.m4b'));
    await runScript(['server/cli.js', 'scan'], env);
    const book = shelf().find((entry) => entry.title === 'A Long Book');
    assert.ok(book, 'the multi-part book is on the shelf');
    assert.equal(book.tracks, 2);
  });
});
