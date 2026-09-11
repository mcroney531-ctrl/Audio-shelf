import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { promises as fs, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startTestServer, repoRoot, runScript } from './helpers.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;
const needsFfmpeg = ffmpegAvailable ? false : 'ffmpeg is not installed on this machine';

// The module reads config at import time, so point it at a scratch data dir
// before anything pulls in db.js.
const unitRoot = mkdtempSync(path.join(tmpdir(), 'audioshelf-tts-unit-'));
process.env.AUDIOSHELF_DATA = path.join(unitRoot, 'data');
process.env.AUDIOSHELF_LIBRARY = path.join(unitRoot, 'library');
const tts = await import('../server/tts.js');

/**
 * A reader-app paste, furniture and all: the nav row, the pencil, the close
 * cross and the "no chapters detected" footer are exactly what should not be
 * read aloud or paid for.
 */
const PASTED = `Read
Chat

✎
2

←
Brian Tracy

Eat That Frog
◆
The thesis: You will **never** get everything done. The only move that works is
deciding which tasks matter most and doing those first.

Introduction: Eat That Frog

The Mark Twain quote: if you eat a live frog first thing every morning, you can
go through the rest of the day knowing the worst is behind you.

Chapter 1: Set the Table

Clarity is the foundation. The number one reason people procrastinate is
vagueness. Only 3% of adults have written goals.

Chapter 2: Plan Every Day In Advance

Every minute spent planning saves ten minutes in execution. See [the 10/90
rule](https://example.com/rule) for the arithmetic.

Conclusion

21 principles summarized. Just begin. Eat the frog.

Contents
✕
No chapters detected in this summary.`;

let workDir;
let silentMp3;

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'audioshelf-tts-'));
  if (ffmpegAvailable) {
    // One second of silence, encoded the way Google encodes: a stand-in for a
    // synthesised chunk, so the joining path is tested for real.
    silentMp3 = path.join(workDir, 'chunk.mp3');
    const result = spawnSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono',
      '-t', '1', '-c:a', 'libmp3lame', '-b:a', '32k', silentMp3,
    ]);
    if (result.status !== 0) throw new Error(`fixture build failed: ${result.stderr}`);
  }
});

after(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.rm(unitRoot, { recursive: true, force: true });
});

describe('preparing text', () => {
  test('strips the furniture a reader app pastes along with the words', () => {
    const cleaned = tts.cleanText(PASTED);
    for (const junk of ['✎', '✕', '←', '◆', 'No chapters detected']) {
      assert.ok(!cleaned.includes(junk), `expected "${junk}" to be gone`);
    }
    assert.ok(!/^Read$/m.test(cleaned), 'the Read/Chat toolbar should be gone');
    // and the actual words survive
    assert.ok(cleaned.includes('Eat That Frog'));
    assert.ok(cleaned.includes('Only 3% of adults have written goals.'));
  });

  test('removes markdown that would otherwise be spoken', () => {
    const cleaned = tts.cleanText(PASTED);
    assert.ok(cleaned.includes('You will never get everything done'), 'bold markers should go, words should stay');
    assert.ok(!cleaned.includes('**'));
    assert.ok(cleaned.includes('the 10/90\nrule') || cleaned.includes('the 10/90 rule'));
    assert.ok(!cleaned.includes('https://example.com/rule'), 'a URL should not be read aloud');
  });

  test('an empty paste stays empty rather than becoming a book', () => {
    assert.equal(tts.cleanText('   \n\n ✕ \n'), '');
    assert.equal(tts.cleanText(null), '');
  });
});

describe('chapters', () => {
  test('finds the chapters in a pasted book summary', () => {
    const chapters = tts.splitChapters(tts.cleanText(PASTED));
    const titles = chapters.map((chapter) => chapter.title);
    assert.ok(titles.includes('Introduction: Eat That Frog'));
    assert.ok(titles.includes('Chapter 1: Set the Table'));
    assert.ok(titles.includes('Chapter 2: Plan Every Day In Advance'));
    assert.ok(titles.includes('Conclusion'));
    // The lead-in before the first heading keeps its own chapter, so no text
    // is ever dropped on the floor.
    assert.equal(chapters[0].title, 'Start');
    assert.ok(chapters[0].text.includes('The thesis'));
  });

  test('speaks the heading as part of its chapter', () => {
    const chapters = tts.splitChapters('Chapter 1: Beginnings\n\nIt was a dark night.');
    assert.equal(chapters.length, 1);
    assert.ok(chapters[0].text.startsWith('Chapter 1: Beginnings'));
    assert.ok(chapters[0].text.includes('dark night'));
  });

  test('text with no headings is one chapter, not none', () => {
    const chapters = tts.splitChapters('Just a paragraph of prose, with nothing that looks like a heading.');
    assert.equal(chapters.length, 1);
    assert.equal(chapters[0].title, 'Start');
  });

  test('a sentence that merely starts with "part" is not a chapter break', () => {
    const text = 'Starting is the hardest part.\n\nOnce in motion the rest follows.';
    assert.equal(tts.splitChapters(text).length, 1);
  });
});

describe('chunking', () => {
  const long = Array.from({ length: 400 }, (_, i) => `This is sentence number ${i} in a long paragraph.`).join(' ');

  test('keeps every chunk under the request limit', () => {
    for (const limit of [800, 1500, 4000]) {
      for (const chunk of tts.chunkText(long, limit)) {
        assert.ok(Buffer.byteLength(chunk, 'utf8') <= limit, `chunk of ${Buffer.byteLength(chunk)} exceeded ${limit}`);
      }
    }
  });

  test('never splits a word in half', () => {
    const words = long.split(/\s+/);
    const rejoined = tts.chunkText(long, 900).join(' ').split(/\s+/);
    assert.deepEqual(rejoined, words);
  });

  test('survives text with no spaces at all', () => {
    const blob = 'x'.repeat(5000);
    const chunks = tts.chunkText(blob, 1000);
    assert.ok(chunks.length >= 5);
    assert.equal(chunks.join(''), blob);
  });

  test('short text is a single chunk', () => {
    assert.deepEqual(tts.chunkText('A short line.', 4000), ['A short line.']);
  });
});

describe('pricing', () => {
  test('maps voice names to the bucket Google bills them in', () => {
    assert.equal(tts.voiceTier('en-US-Chirp3-HD-Charon'), 'chirp3-hd');
    assert.equal(tts.voiceTier('en-US-Neural2-D'), 'neural2');
    assert.equal(tts.voiceTier('en-US-Wavenet-F'), 'standard-wavenet');
    assert.equal(tts.voiceTier('en-US-Standard-C'), 'standard-wavenet');
    assert.equal(tts.voiceTier('en-US-Studio-O'), 'studio');
  });

  test('costs nothing inside the free tier, and the published rate outside it', () => {
    const free = tts.estimate({ text: PASTED, voice: 'en-US-Chirp3-HD-Charon' });
    assert.ok(free.characters > 100);
    assert.equal(free.cost, 0);
    assert.equal(free.billableCharacters, 0);
    assert.equal(free.freePerMonth, 1_000_000);

    // Chirp 3 HD is $30 per million: a million billable characters is $30.
    const rates = tts.PRICING['chirp3-hd'];
    assert.equal(rates.perMillion, 30);
    assert.equal(Number(((2_000_000 - rates.freePerMonth) / 1e6 * rates.perMillion).toFixed(2)), 30);
  });

  test('the estimate counts the characters that will actually be sent', () => {
    const est = tts.estimate({ text: PASTED, voice: 'en-US-Neural2-D' });
    const cleaned = tts.cleanText(PASTED);
    // Chapter headings are spoken, so the count is the cleaned text or a little
    // more - never the raw paste, which still had its furniture attached.
    assert.ok(est.characters >= cleaned.length * 0.9);
    assert.ok(est.characters < PASTED.length + 200);
    assert.ok(est.chunks >= 1);
    assert.ok(est.estimatedSeconds > 0);
  });
});

describe('joining audio', { skip: needsFfmpeg }, () => {
  test('joins chunks into one file whose duration is the sum of the parts', async () => {
    const output = path.join(workDir, 'joined.mp3');
    await tts.stitch([silentMp3, silentMp3, silentMp3], output, {
      title: 'Chapter One', artist: 'A Narrator', album: 'A Book',
    });

    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', output,
    ]);
    const info = JSON.parse(probe.stdout);
    const duration = Number(info.format.duration);
    // Three one-second pieces, and the rewritten header has to know it - without
    // -write_xing this reads as one second and the shelf shows a broken book.
    assert.ok(duration > 2.5 && duration < 3.6, `expected about 3s, got ${duration}`);
    assert.equal(info.format.tags.title, 'Chapter One');
    assert.equal(info.format.tags.album, 'A Book');
  });

  test('a single chunk still comes out playable', async () => {
    const output = path.join(workDir, 'single.mp3');
    await tts.stitch([silentMp3], output, { title: 'Only' });
    const probe = spawnSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', output]);
    assert.ok(Number(JSON.parse(probe.stdout).format.duration) > 0.5);
  });
});

// ---------------------------------------------------------------------------
// End to end, against a stand-in for Google
// ---------------------------------------------------------------------------
/** Answers /text:synthesize like Google does, and counts what it was asked for. */
function stubGoogle(audio, { failFrom = Infinity } = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    if (req.url.startsWith('/voices')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        voices: [{ name: 'en-US-Chirp3-HD-Charon', ssmlGender: 'MALE', languageCodes: ['en-US'] }],
      }));
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      calls.push(parsed.input.text);
      if (calls.length >= failFrom) {
        res.writeHead(500, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'stub failure' } }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ audioContent: audio.toString('base64') }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      calls,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

describe('generating a book end to end', { skip: needsFfmpeg }, () => {
  test('pasted text becomes a chaptered book on the shelf', async () => {
    const audio = await fs.readFile(silentMp3);
    const google = await stubGoogle(audio);
    const root = mkdtempSync(path.join(tmpdir(), 'audioshelf-tts-e2e-'));
    const source = path.join(root, 'frog.txt');
    writeFileSync(source, PASTED);

    const env = {
      AUDIOSHELF_DATA: path.join(root, 'data'),
      AUDIOSHELF_LIBRARY: path.join(root, 'library'),
      AUDIOSHELF_GOOGLE_TTS_KEY: 'test-key',
      AUDIOSHELF_GOOGLE_TTS_ENDPOINT: google.url,
      AUDIOSHELF_SCAN_ON_START: '0',
    };
    await fs.mkdir(env.AUDIOSHELF_LIBRARY, { recursive: true });

    const output = await runScript([
      'server/cli.js', 'tts', `--file=${source}`, '--title=Eat That Frog', '--author=Brian Tracy',
    ], env);

    assert.match(output, /done ->/);
    assert.ok(google.calls.length > 0, 'the provider should have been called');

    const bookDir = path.join(root, 'data', 'generated', 'Brian Tracy', 'Eat That Frog');
    const files = (await fs.readdir(bookDir)).filter((name) => name.endsWith('.mp3')).sort();
    assert.ok(files.length >= 4, `expected a file per chapter, got ${files.join(', ')}`);
    assert.match(files[0], /^01 - /);
    assert.ok(files.some((name) => /Chapter 1/.test(name)), `chapter names should survive: ${files.join(', ')}`);

    // Tagged, so the scanner names the book rather than guessing from folders.
    const probe = spawnSync('ffprobe', [
      '-v', 'error', '-print_format', 'json', '-show_format', path.join(bookDir, files[0]),
    ]);
    const tags = JSON.parse(probe.stdout).format.tags;
    assert.equal(tags.album, 'Eat That Frog');
    assert.equal(tags.artist, 'Brian Tracy');

    // The scan the CLI runs should have put it on the shelf.
    const listed = await runScript(['server/cli.js', 'tts:list'], env);
    assert.match(listed, /\[done/);

    // Nothing half-built is left lying around for the watcher to find.
    const leftovers = await fs.readdir(path.join(root, 'data', 'tts')).catch(() => []);
    assert.equal(leftovers.length, 0, 'work files should be cleaned up after success');

    await google.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  test('a failure part way through is resumable, and only pays for what is missing', async () => {
    const audio = await fs.readFile(silentMp3);
    const root = mkdtempSync(path.join(tmpdir(), 'audioshelf-tts-resume-'));
    const source = path.join(root, 'long.txt');
    // Five chapters, so there is something to fail in the middle of.
    writeFileSync(source, Array.from({ length: 5 }, (_, i) =>
      `Chapter ${i + 1}: Number ${i + 1}\n\nThis is the body of chapter ${i + 1}.`).join('\n\n'));

    const env = {
      AUDIOSHELF_DATA: path.join(root, 'data'),
      AUDIOSHELF_LIBRARY: path.join(root, 'library'),
      AUDIOSHELF_GOOGLE_TTS_KEY: 'test-key',
      AUDIOSHELF_SCAN_ON_START: '0',
    };
    await fs.mkdir(env.AUDIOSHELF_LIBRARY, { recursive: true });

    // First run dies on the fourth request.
    const failing = await stubGoogle(audio, { failFrom: 4 });
    await assert.rejects(() => runScript([
      'server/cli.js', 'tts', `--file=${source}`, '--title=Long', '--author=Tester',
    ], { ...env, AUDIOSHELF_GOOGLE_TTS_ENDPOINT: failing.url }));
    const firstRunCalls = failing.calls.length;
    assert.equal(firstRunCalls, 4, 'should have stopped at the failing request');
    await failing.close();

    // Second run picks up: the three chunks already on disk are not re-bought.
    const working = await stubGoogle(audio);
    const output = await runScript([
      'server/cli.js', 'tts:resume', '--id=1',
    ], { ...env, AUDIOSHELF_GOOGLE_TTS_ENDPOINT: working.url });
    assert.match(output, /done ->/);
    assert.equal(working.calls.length, 5 - 3,
      `expected only the 2 unpaid chunks to be re-requested, got ${working.calls.length}`);

    await working.close();
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('the API', () => {
  let server;

  before(async () => {
    server = await startTestServer({ seed: true, scan: true });
    await server.json('/api/setup', {
      method: 'POST',
      body: { username: 'admin', password: 'hunter22!', displayName: 'Admin' },
    });
  });

  after(async () => { await server?.stop(); });

  test('estimating costs nothing and needs no key', async () => {
    const { status, body } = await server.json('/api/admin/tts/estimate', {
      method: 'POST',
      body: { text: PASTED, voice: 'en-US-Chirp3-HD-Charon' },
    });
    assert.equal(status, 200);
    assert.ok(body.characters > 100);
    assert.equal(body.cost, 0);
    assert.equal(body.tierLabel, 'Chirp 3: HD');
    assert.ok(body.chapters.length >= 4);
  });

  test('generating without a key says so plainly', async () => {
    const { status, body } = await server.json('/api/admin/tts/generate', {
      method: 'POST',
      body: { title: 'Nope', text: 'Some words to read aloud.' },
    });
    assert.equal(status, 400);
    assert.match(body.error, /API key/i);
  });

  test('a saved key is never echoed back in full', async () => {
    await server.json('/api/admin/tts/credentials', {
      method: 'POST',
      body: { apiKey: 'AIzaSyTOTALLYFAKEKEY1234567890' },
    });
    const { body } = await server.json('/api/admin/tts');
    assert.equal(body.credentials.kind, 'api-key');
    assert.ok(!body.credentials.hint.includes('TOTALLYFAKEKEY'));
    assert.match(body.credentials.hint, /\*/);
    // and it is not hiding anywhere else in the payload
    assert.ok(!JSON.stringify(body).includes('AIzaSyTOTALLYFAKEKEY1234567890'));

    await server.json('/api/admin/tts/credentials', { method: 'POST', body: { clear: true } });
    const after = await server.json('/api/admin/tts');
    assert.equal(after.body.credentials, null);
  });

  test('listeners cannot generate or see the key', async () => {
    await server.json('/api/admin/users', {
      method: 'POST',
      body: { username: 'listener', password: 'listener22!', displayName: 'Listener' },
    });
    // Same server, different session: sign in as the listener.
    await server.json('/api/auth/login', { method: 'POST', body: { username: 'listener', password: 'listener22!' } });

    for (const [method, url] of [['GET', '/api/admin/tts'], ['POST', '/api/admin/tts/generate']]) {
      const { status } = await server.json(url, { method, body: method === 'POST' ? { title: 'x', text: 'y' } : undefined });
      assert.equal(status, 403, `${method} ${url} should be admin-only`);
    }

    await server.json('/api/auth/login', { method: 'POST', body: { username: 'admin', password: 'hunter22!' } });
  });
});
