import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTestServer, repoRoot, runScript } from './helpers.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;
const skip = ffmpegAvailable ? false : 'ffmpeg is not installed on this machine';

let workDir;
let fixture;

/** An ordinary, unencrypted m4b with chapters — stands in for a decrypted Audible file. */
function buildFixture(dir) {
  const source = path.join(repoRoot, 'library');
  const mp3 = path.join(source, 'Hollis Vance', 'Salt Roads', '01 - Caravan.mp3');
  const meta = path.join(dir, 'meta.txt');
  const output = path.join(dir, 'fixture.m4b');
  const chapters = [
    ';FFMETADATA1', 'title=A Test Recording', 'artist=Test Author', 'composer=Test Narrator', '',
    '[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=20000', 'title=One', '',
    '[CHAPTER]', 'TIMEBASE=1/1000', 'START=20000', 'END=45000', 'title=Two', '',
  ].join('\n');
  writeFileSync(meta, chapters);
  const result = spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-i', mp3, '-i', meta,
    '-map', '0:a:0', '-map_metadata', '1', '-c:a', 'aac', '-b:a', '64k', '-f', 'mp4', output,
  ]);
  if (result.status !== 0) throw new Error(`fixture build failed: ${result.stderr}`);
  return output;
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'audioshelf-import-'));
  if (ffmpegAvailable) {
    // The demo library provides the source audio for the fixture.
    await runScript(['scripts/seed-demo.js'], { AUDIOSHELF_DATA: path.join(workDir, 'seed-data') });
    fixture = buildFixture(workDir);
  }
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe('voucher and key handling', () => {
  test('validates activation bytes', async () => {
    const { normalizeActivationBytes } = await import('../server/audible.js');
    assert.equal(normalizeActivationBytes('1A2B3C4D'), '1a2b3c4d');
    assert.equal(normalizeActivationBytes(' 0x1a2b3c4d '), '1a2b3c4d');
    for (const bad of ['', 'nope', '1a2b3c', '1a2b3c4d5', 'zzzzzzzz']) {
      assert.throws(() => normalizeActivationBytes(bad), /8 hexadecimal/);
    }
  });

  test('reads the key and iv out of a .voucher', async () => {
    const { readVoucher } = await import('../server/audible.js');
    const key = 'a'.repeat(32);
    const iv = 'b'.repeat(32);

    const nested = path.join(workDir, 'nested.aaxc');
    await fs.writeFile(nested.replace('.aaxc', '.voucher'),
      JSON.stringify({ content_license: { license_response: { key, iv } } }));
    assert.deepEqual(await readVoucher(nested), { path: nested.replace('.aaxc', '.voucher'), key, iv });

    const flat = path.join(workDir, 'flat.aaxc');
    await fs.writeFile(flat.replace('.aaxc', '.voucher'), JSON.stringify({ key, iv }));
    assert.equal((await readVoucher(flat)).key, key);
  });

  test('reports unusable vouchers rather than guessing', async () => {
    const { readVoucher } = await import('../server/audible.js');
    const missing = path.join(workDir, 'missing.aaxc');
    assert.equal(await readVoucher(missing), null);

    const broken = path.join(workDir, 'broken.aaxc');
    await fs.writeFile(broken.replace('.aaxc', '.voucher'), 'not json at all');
    assert.match((await readVoucher(broken)).error, /not valid JSON/);

    const short = path.join(workDir, 'short.aaxc');
    await fs.writeFile(short.replace('.aaxc', '.voucher'), JSON.stringify({ key: 'abc', iv: 'def' }));
    assert.match((await readVoucher(short)).error, /key and iv/);
  });
});

describe('conversion', { skip }, () => {
  test('reports what the local ffmpeg can do', async () => {
    const { checkTools } = await import('../server/audible.js');
    const tools = await checkTools({ refresh: true });
    assert.equal(tools.ffmpeg, true);
    assert.equal(tools.ffprobe, true);
    assert.ok(tools.version);
    // Every ffmpeg since 4.4 carries both Audible demuxer options.
    assert.equal(tools.supportsAax, true);
    assert.equal(tools.supportsAaxc, true);
  });

  test('copies audio, chapters and tags into an m4b named from its metadata', async () => {
    const { convert, probe } = await import('../server/audible.js');
    const outputDir = path.join(workDir, 'out');
    const seen = [];
    const result = await convert(fixture, {}, { outputDir, onProgress: (p) => seen.push(p) });

    assert.equal(result.title, 'A Test Recording');
    assert.equal(result.author, 'Test Author');
    assert.equal(result.path, path.join(outputDir, 'Test Author', 'A Test Recording.m4b'));
    assert.ok(seen.at(-1) === 1, 'progress should finish at 100%');

    const info = await probe(result.path);
    assert.ok(info.ok);
    assert.ok(Math.abs(info.duration - 45) < 2, `duration ${info.duration} should match the source`);
    assert.equal(info.narrator, 'Test Narrator');

    const chapters = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_chapters', result.path]);
    assert.equal(JSON.parse(chapters.stdout).chapters.length, 2, 'chapters must survive the copy');
  });

  test('a second import of the same book does not overwrite the first', async () => {
    const { convert } = await import('../server/audible.js');
    const outputDir = path.join(workDir, 'out');
    const again = await convert(fixture, {}, { outputDir });
    assert.equal(again.path, path.join(outputDir, 'Test Author', 'A Test Recording (2).m4b'));
  });

  test('refuses a .aax with no activation bytes', async () => {
    const { convert } = await import('../server/audible.js');
    const fake = path.join(workDir, 'locked.aax');
    await fs.copyFile(fixture, fake);
    await assert.rejects(
      () => convert(fake, {}, { outputDir: path.join(workDir, 'out') }),
      /activation bytes/,
    );
  });

  test('refuses a .aaxc with no key and iv', async () => {
    const { convert } = await import('../server/audible.js');
    const fake = path.join(workDir, 'locked.aaxc');
    await fs.copyFile(fixture, fake);
    await assert.rejects(
      () => convert(fake, {}, { outputDir: path.join(workDir, 'out') }),
      /key and iv/,
    );
  });

  test('surfaces ffmpeg failures instead of writing a broken file', async () => {
    const { convert } = await import('../server/audible.js');
    const junk = path.join(workDir, 'junk.aax');
    await fs.writeFile(junk, Buffer.alloc(4096, 7));
    await assert.rejects(
      () => convert(junk, { activationBytes: '1a2b3c4d' }, { outputDir: path.join(workDir, 'out') }),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /could not read that file|convert/i);
        return true;
      },
    );
    // nothing half-written left behind
    const leftovers = await fs.readdir(path.join(workDir, 'out')).catch(() => []);
    assert.ok(!leftovers.includes('junk.m4b'));
  });
});

describe('import API', { skip }, () => {
  let server;

  before(async () => {
    server = await startTestServer({ scan: false });
    // Two Audible-looking files inside the library, one with its voucher.
    const inbox = path.join(server.env.AUDIOSHELF_LIBRARY, 'audible');
    await fs.mkdir(inbox, { recursive: true });
    await fs.copyFile(fixture, path.join(inbox, 'Legacy Download.aax'));
    await fs.copyFile(fixture, path.join(inbox, 'New Download.aaxc'));
    await fs.writeFile(path.join(inbox, 'New Download.voucher'),
      JSON.stringify({ content_license: { license_response: { key: 'a'.repeat(32), iv: 'b'.repeat(32) } } }));

    await server.json('/api/setup', {
      method: 'POST',
      body: { username: 'importer', password: 'a good long password' },
    });
    await server.json('/api/admin/scan', { method: 'POST', body: {} });
    for (let i = 0; i < 40; i++) {
      const { body } = await server.json('/api/admin/status');
      if (!body.scan.running) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  });

  after(async () => { await server?.stop(); });

  test('a scan finds Audible files without treating them as books', async () => {
    const { body } = await server.json('/api/admin/imports');
    const names = body.imports.map((entry) => entry.file).sort();
    assert.deepEqual(names, ['Legacy Download.aax', 'New Download.aaxc']);
    assert.equal(body.imports.find((entry) => entry.format === 'aaxc').hasVoucher, true);
    assert.equal(body.imports.find((entry) => entry.format === 'aax').hasVoucher, false);

    // ...and they are not on the shelf, because nothing can play them yet.
    const books = await server.json('/api/books');
    assert.equal(books.body.books.some((book) => /Download/.test(book.title)), false);
  });

  test('stores activation bytes and only ever echoes them masked', async () => {
    assert.equal((await server.json('/api/admin/activation', {
      method: 'POST', body: { activationBytes: 'nope' },
    })).status, 400);

    assert.equal((await server.json('/api/admin/activation', {
      method: 'POST', body: { activationBytes: '1a2b3c4d' },
    })).status, 200);

    const { body } = await server.json('/api/admin/imports');
    assert.equal(body.hasActivationBytes, true);
    assert.equal(body.activationBytes, '1a****4d');
    assert.ok(!JSON.stringify(body).includes('1a2b3c4d'), 'the full key must never be sent back');
  });

  test('converts a file and puts the result on the shelf', async () => {
    const list = await server.json('/api/admin/imports');
    const target = list.body.imports.find((entry) => entry.format === 'aaxc');

    const started = await server.json(`/api/admin/imports/${target.id}/convert`, { method: 'POST', body: {} });
    assert.equal(started.status, 202);

    let row = null;
    for (let i = 0; i < 60; i++) {
      const { body } = await server.json('/api/admin/imports');
      row = body.imports.find((entry) => entry.id === target.id);
      if (row.status === 'done' || row.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.equal(row.status, 'done', row.error || '');
    assert.match(row.output, /\.m4b$/);

    // the scan that follows an import puts it in the library
    for (let i = 0; i < 40; i++) {
      const books = await server.json('/api/books?q=Test%20Recording');
      if (books.body.total > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.fail('the converted book never reached the library');
  });

  test('an unknown import is a 404', async () => {
    assert.equal((await server.json('/api/admin/imports/4242/convert', { method: 'POST', body: {} })).status, 404);
  });

  test('listeners cannot see or start imports', async () => {
    await server.json('/api/admin/users', {
      method: 'POST', body: { username: 'plain', password: 'another good password' },
    });
    const login = await fetch(`${server.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'plain', password: 'another good password' }),
    });
    const cookie = (login.headers.getSetCookie?.() || []).map((value) => value.split(';')[0]).join('; ');

    for (const [path, options] of [
      ['/api/admin/imports', {}],
      ['/api/admin/activation', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }],
    ]) {
      const response = await fetch(`${server.base}${path}`, {
        ...options,
        headers: { ...(options.headers || {}), cookie },
      });
      assert.equal(response.status, 403, `${path} should be admin-only`);
      await response.arrayBuffer();
    }
  });
});
