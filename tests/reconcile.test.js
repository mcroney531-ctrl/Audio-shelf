import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoRoot, runScript } from './helpers.js';
import {
  parseLibraryExport, parseExclusions, asinsInName, reconcile, formatReport, pathKey,
} from '../server/reconcile.js';

const ffmpegAvailable = spawnSync('ffmpeg', ['-hide_banner', '-version']).status === 0;

// ---------------------------------------------------------------------------
// Fixtures for the pure tests
// ---------------------------------------------------------------------------
const record = (asin, title, extra = {}) => ({ index: 0, asin, title, authors: null, runtimeMin: null, problem: null, ...extra });
const indexed = (list) => list.map((item, index) => ({ ...item, index }));
const doneRow = (asin, output, extra = {}) => ({
  path: `/lib/${asin}-LC_64_22050_stereo.aax`, format: 'aax', status: 'done', output, title: `Title ${asin}`, ...extra,
});
const goodOutput = (duration = 3600) => ({ exists: true, size: 1000, probe: { ok: true, duration } });
const stateOf = (report, asin) => report.entries.find((entry) => entry.asin === asin)?.state;
const detailOf = (report, asin) => report.entries.find((entry) => entry.asin === asin)?.detail || '';

describe('reading the Audible export', () => {
  test('reads the JSON list audible-cli writes with --format json', () => {
    const { format, records } = parseLibraryExport(JSON.stringify([
      { asin: 'b00aaaaaaa', title: 'One', authors: 'A, B', runtime_length_min: 61 },
      { asin: 'B00BBBBBBB', title: 'Two', authors: [{ name: 'C' }, { name: 'D' }] },
    ]));
    assert.equal(format, 'json');
    assert.equal(records[0].asin, 'B00AAAAAAA', 'ASINs are upper-cased');
    assert.equal(records[0].runtimeMin, 61);
    assert.equal(records[1].authors, 'C, D');
  });

  test('reads TSV even when the file is called library.json', () => {
    // audible-cli defaults to TSV whatever the output file is named, so this is
    // the likely first attempt - and descriptions contain tabs and quotes.
    const tsv = 'asin\ttitle\tauthors\truntime_length_min\n'
      + 'B00AAAAAAA\t"A ""quoted""\ttitle"\tAnn\t90\n'
      + 'B00BBBBBBB\tPlain\tBob\t\n';
    const { format, records } = parseLibraryExport(tsv);
    assert.equal(format, 'tsv');
    assert.equal(records.length, 2);
    assert.equal(records[0].title, 'A "quoted"\ttitle');
    assert.equal(records[0].runtimeMin, 90);
    assert.equal(records[1].runtimeMin, null);
  });

  test('reads CSV, with a byte-order mark and Windows line endings', () => {
    const { format, records } = parseLibraryExport('\uFEFFasin,title\r\nB00AAAAAAA,"One, with a comma"\r\n');
    assert.equal(format, 'csv');
    assert.equal(records[0].title, 'One, with a comma');
  });

  test('finds the list inside a wrapping object', () => {
    const { records } = parseLibraryExport(JSON.stringify({ items: [{ asin: 'B00AAAAAAA' }] }));
    assert.equal(records.length, 1);
  });

  test('keeps records it cannot identify instead of dropping them', () => {
    const { records } = parseLibraryExport(JSON.stringify([{ title: 'No ASIN' }, 'junk', null]));
    assert.equal(records.length, 3);
    assert.ok(records.every((item) => item.asin === null));
    assert.equal(records[1].problem, 'not an object');
  });

  test('explains what it could not read', () => {
    assert.throws(() => parseLibraryExport('[{"asin": '), /does not parse/);
    assert.throws(() => parseLibraryExport('{"something": 1}'), /keys: something/);
    assert.throws(() => parseLibraryExport('hello world'), /--format json/);
  });

  test('reads an exclusion list with reasons and comments', () => {
    const exclusions = parseExclusions('# not migrating these\nB00AAAAAAA returned for refund\nb00bbbbbbb\n\n');
    assert.equal(exclusions.get('B00AAAAAAA'), 'returned for refund');
    assert.equal(exclusions.get('B00BBBBBBB'), 'excluded');
    assert.equal(exclusions.size, 2);
  });
});

describe('matching files by ASIN', () => {
  const known = new Set(['B00AAAAAAA', 'B00BBBBBBB']);

  test('finds the ASIN in audible-cli asin_only names', () => {
    assert.deepEqual(asinsInName('B00AAAAAAA-LC_64_22050_stereo.aax', known), ['B00AAAAAAA']);
    assert.deepEqual(asinsInName('C:\\Books\\B00BBBBBBB-AAX_44_128.aaxc', known), ['B00BBBBBBB']);
  });

  test('only matches a whole token, never part of a longer word', () => {
    assert.deepEqual(asinsInName('XB00AAAAAAAX.aax', known), []);
    assert.deepEqual(asinsInName('Some Title.aax', known), []);
  });
});

describe('reconciling', () => {
  test('a converted file that reads at the right length is verified', () => {
    const report = reconcile({
      records: indexed([record('B00AAAAAAA', 'One', { runtimeMin: 60 })]),
      imports: [doneRow('B00AAAAAAA', '/out/one.m4b')],
      outputs: new Map([['/out/one.m4b', goodOutput(3600)]]),
    });
    assert.equal(stateOf(report, 'B00AAAAAAA'), 'verified');
    assert.equal(report.complete, true);
  });

  test('"done" in the database is not enough on its own', () => {
    const records = indexed([
      record('B00AAAAAAA', 'Missing output'),
      record('B00BBBBBBB', 'Empty output'),
      record('B00CCCCCCC', 'Unreadable'),
      record('B00DDDDDDD', 'Too short', { runtimeMin: 600 }),
      record('B00EEEEEEE', 'No ffprobe'),
      record('B00FFFFFFF', 'No output recorded'),
    ]);
    const report = reconcile({
      records,
      imports: [
        doneRow('B00AAAAAAA', '/out/a.m4b'),
        doneRow('B00BBBBBBB', '/out/b.m4b'),
        doneRow('B00CCCCCCC', '/out/c.m4b'),
        doneRow('B00DDDDDDD', '/out/d.m4b'),
        doneRow('B00EEEEEEE', '/out/e.m4b'),
        doneRow('B00FFFFFFF', null),
      ],
      outputs: new Map([
        ['/out/a.m4b', { exists: false, size: 0, probe: null }],
        ['/out/b.m4b', { exists: true, size: 0, probe: null }],
        ['/out/c.m4b', { exists: true, size: 10, probe: { ok: false, error: 'moov atom not found' } }],
        ['/out/d.m4b', goodOutput(3600)],
        ['/out/e.m4b', { exists: true, size: 10, probe: null }],
      ]),
    });
    assert.equal(stateOf(report, 'B00AAAAAAA'), 'invalid');
    assert.match(detailOf(report, 'B00AAAAAAA'), /missing/);
    assert.equal(stateOf(report, 'B00BBBBBBB'), 'invalid');
    assert.equal(stateOf(report, 'B00CCCCCCC'), 'invalid');
    assert.match(detailOf(report, 'B00CCCCCCC'), /moov atom/);
    assert.equal(stateOf(report, 'B00DDDDDDD'), 'invalid', 'a one-hour file for a ten-hour book is incomplete');
    assert.match(detailOf(report, 'B00DDDDDDD'), /1h 0m.*10h 0m/);
    assert.equal(stateOf(report, 'B00EEEEEEE'), 'unverified', 'without ffprobe nothing is called verified');
    assert.equal(stateOf(report, 'B00FFFFFFF'), 'invalid');
    assert.equal(report.complete, false);
  });

  test('a sound file that never reached the shelf is not verified', () => {
    // What the first real pilot hit: ffprobe read all three books perfectly
    // while the scanner rejected every one, so "verified" and an empty shelf
    // disagreed.
    const report = reconcile({
      records: indexed([record('B00AAAAAAA', 'On shelf'), record('B00BBBBBBB', 'Rejected by scan')]),
      imports: [doneRow('B00AAAAAAA', '/out/a.m4b'), doneRow('B00BBBBBBB', '/out/b.m4b')],
      outputs: new Map([['/out/a.m4b', goodOutput()], ['/out/b.m4b', goodOutput()]]),
      shelved: new Set([pathKey('/out/a.m4b')]),
    });
    assert.equal(stateOf(report, 'B00AAAAAAA'), 'verified');
    assert.equal(stateOf(report, 'B00BBBBBBB'), 'not-shelved');
    assert.match(detailOf(report, 'B00BBBBBBB'), /skipping/);
    assert.equal(report.complete, false);
  });

  test('small differences from the listed runtime are tolerated', () => {
    const report = reconcile({
      records: indexed([record('B00AAAAAAA', 'One', { runtimeMin: 600 })]),
      imports: [doneRow('B00AAAAAAA', '/out/one.m4b')],
      outputs: new Map([['/out/one.m4b', goodOutput(600 * 60 - 90)]]),
    });
    assert.equal(stateOf(report, 'B00AAAAAAA'), 'verified');
  });

  test('says why a downloaded book is not converted yet', () => {
    const report = reconcile({
      records: indexed([
        record('B00AAAAAAA', 'In downloads'),
        record('B00BBBBBBB', 'In library, unscanned'),
        record('B00CCCCCCC', 'Pending, no bytes'),
        record('B00DDDDDDD', 'AAXC without voucher'),
        record('B00EEEEEEE', 'Interrupted'),
      ]),
      sources: [
        { path: '/dl/B00AAAAAAA-LC.aax', root: '/dl', kind: 'aax', size: 10, hasVoucher: null },
        { path: '/lib/B00BBBBBBB-LC.aax', root: '/lib', kind: 'aax', size: 10, hasVoucher: null },
        { path: '/dl/B00DDDDDDD-LC.aaxc', root: '/dl', kind: 'aaxc', size: 10, hasVoucher: false },
      ],
      imports: [
        { path: '/lib/B00CCCCCCC-LC.aax', format: 'aax', status: 'pending' },
        { path: '/lib/B00EEEEEEE-LC.aax', format: 'aax', status: 'converting' },
      ],
      downloadRoots: ['/dl'],
      hasActivationBytes: false,
    });
    for (const asin of ['B00AAAAAAA', 'B00BBBBBBB', 'B00CCCCCCC', 'B00DDDDDDD', 'B00EEEEEEE']) {
      assert.equal(stateOf(report, asin), 'not-converted', asin);
    }
    assert.match(detailOf(report, 'B00AAAAAAA'), /download folder/);
    assert.match(detailOf(report, 'B00BBBBBBB'), /rescan/);
    assert.match(detailOf(report, 'B00CCCCCCC'), /activation bytes/);
    assert.match(detailOf(report, 'B00DDDDDDD'), /voucher/);
    assert.match(detailOf(report, 'B00EEEEEEE'), /convert it again/);
  });

  test('reports failures, missing books and exclusions separately', () => {
    const report = reconcile({
      records: indexed([
        record('B00AAAAAAA', 'Failed'),
        record('B00BBBBBBB', 'Never downloaded'),
        record('B00CCCCCCC', 'Refunded'),
      ]),
      imports: [{ path: '/lib/B00AAAAAAA-LC.aax', format: 'aax', status: 'failed', error: 'Decryption failed' }],
      exclusions: new Map([['B00CCCCCCC', 'returned']]),
    });
    assert.equal(stateOf(report, 'B00AAAAAAA'), 'failed');
    assert.match(detailOf(report, 'B00AAAAAAA'), /Decryption failed/);
    assert.equal(stateOf(report, 'B00BBBBBBB'), 'not-downloaded');
    assert.equal(stateOf(report, 'B00CCCCCCC'), 'excluded');
    assert.match(detailOf(report, 'B00CCCCCCC'), /returned/);
  });

  test('a file copied rather than moved into the library counts once', () => {
    const report = reconcile({
      records: indexed([record('B00AAAAAAA', 'Copied')]),
      sources: [
        { path: '/dl/B00AAAAAAA-LC.aax', root: '/dl', kind: 'aax', size: 500, hasVoucher: null },
        { path: '/lib/B00AAAAAAA-LC.aax', root: '/lib', kind: 'aax', size: 500, hasVoucher: null },
      ],
      imports: [doneRow('B00AAAAAAA', '/out/a.m4b', { path: '/lib/B00AAAAAAA-LC.aax' })],
      outputs: new Map([['/out/a.m4b', goodOutput()]]),
    });
    assert.equal(stateOf(report, 'B00AAAAAAA'), 'verified');
  });

  test('two genuinely different copies need a person to decide', () => {
    const report = reconcile({
      records: indexed([record('B00AAAAAAA', 'Twice')]),
      sources: [
        { path: '/lib/B00AAAAAAA-LC_64.aax', root: '/lib', kind: 'aax', size: 500, hasVoucher: null },
        { path: '/lib/B00AAAAAAA-LC_128.aax', root: '/lib', kind: 'aax', size: 900, hasVoucher: null },
      ],
    });
    assert.equal(stateOf(report, 'B00AAAAAAA'), 'review');
    assert.match(detailOf(report, 'B00AAAAAAA'), /2 copies/);
  });

  test('a duplicated ASIN in the export is flagged, and both entries are counted', () => {
    const report = reconcile({
      records: indexed([record('B00AAAAAAA', 'Once'), record('B00AAAAAAA', 'Twice')]),
    });
    assert.equal(report.entries.length, 2);
    assert.ok(report.entries.every((entry) => entry.state === 'review'));
    assert.match(report.entries[0].detail, /2 times/);
  });

  test('a title match is only ever a suggestion', () => {
    // Two different books can share a title. Matching by name alone must not
    // be reported as success, however likely it looks.
    const report = reconcile({
      records: indexed([record('B00AAAAAAA', 'The Hobbit')]),
      imports: [{ path: '/lib/Hobbit.aax', format: 'aax', status: 'done', output: '/out/h.m4b', title: 'Hobbit' }],
      outputs: new Map([['/out/h.m4b', goodOutput()]]),
    });
    assert.equal(stateOf(report, 'B00AAAAAAA'), 'review');
    assert.match(detailOf(report, 'B00AAAAAAA'), /title only.*verified/);
    assert.equal(report.extras.length, 0, 'a title-matched file is not also listed as unexplained');
  });

  test('files that match nothing in the export are listed, not ignored', () => {
    const report = reconcile({
      records: indexed([record('B00AAAAAAA', 'One')]),
      sources: [
        { path: '/lib/B09ZZZZZZZ-LC.aax', root: '/lib', kind: 'aax', size: 5, hasVoucher: null },
        { path: '/lib/Mystery.aax', root: '/lib', kind: 'aax', size: 5, hasVoucher: null },
      ],
    });
    assert.equal(report.extras.length, 2);
    assert.match(report.extras.find((extra) => extra.path.includes('B09')).reason, /B09ZZZZZZZ is not in the export/);
    assert.match(report.extras.find((extra) => extra.path.includes('Mystery')).reason, /no ASIN/);
  });

  test('every entry is accounted for exactly once', () => {
    const records = indexed([
      record('B00AAAAAAA', 'a'), record('B00BBBBBBB', 'b'), record(null, 'c'),
      record('B00AAAAAAA', 'dup'), record('B00CCCCCCC', 'e'),
    ]);
    const report = reconcile({ records, exclusions: new Map([['B00CCCCCCC', 'x']]) });
    const sum = Object.values(report.totals.byState).reduce((total, n) => total + n, 0);
    assert.equal(sum, records.length);
    assert.equal(report.totals.accounted, records.length);
    assert.match(formatReport(report), /every entry accounted for/);
  });

  test('an empty export is never reported as a finished migration', () => {
    assert.equal(reconcile({ records: [] }).complete, false);
  });
});

// ---------------------------------------------------------------------------
// End to end: the real command, real files, real import records
// ---------------------------------------------------------------------------
describe('the import:reconcile command', { skip: ffmpegAvailable ? false : 'ffmpeg is not installed' }, () => {
  let root;
  let env;
  const run = (...args) => spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning', 'server/cli.js', 'import:reconcile', ...args,
  ], { cwd: repoRoot, env: { ...process.env, ...env }, encoding: 'utf8' });

  before(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'audioshelf-reconcile-'));
    env = {
      AUDIOSHELF_DATA: path.join(root, 'data'),
      AUDIOSHELF_LIBRARY: path.join(root, 'library'),
      AUDIOSHELF_LOG: 'quiet',
    };
    const lib = env.AUDIOSHELF_LIBRARY;
    const downloads = path.join(root, 'downloads');
    const out = path.join(root, 'data', 'imported', 'Ann');
    for (const dir of [lib, downloads, out]) mkdirSync(dir, { recursive: true });

    // One minute of real audio stands in for a converted book.
    const good = path.join(out, 'First.m4b');
    const made = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono',
      '-t', '60', '-c:a', 'aac', '-b:a', '32k', '-f', 'mp4', good]);
    assert.equal(made.status, 0, String(made.stderr));

    const unshelved = path.join(out, 'Second.m4b');
    writeFileSync(unshelved, readFileSync(good));

    const fakeAudible = (file) => writeFileSync(file, Buffer.alloc(2048, 1));
    fakeAudible(path.join(lib, 'B00AAAAAAA-LC_64_22050_stereo.aax'));
    fakeAudible(path.join(downloads, 'B00DDDDDDD-AAX_44_128.aaxc'));
    fakeAudible(path.join(lib, 'B09ZZZZZZZ-LC_64_22050_stereo.aax'));

    writeFileSync(path.join(root, 'library.json'), JSON.stringify([
      { asin: 'B00AAAAAAA', title: 'First', authors: 'Ann', runtime_length_min: 1 },
      { asin: 'B00BBBBBBB', title: 'Output Gone', authors: 'Ann', runtime_length_min: 1 },
      { asin: 'B00CCCCCCC', title: 'Failed One', authors: 'Ann' },
      { asin: 'B00DDDDDDD', title: 'Still Downloading', authors: 'Ann' },
      { asin: 'B00EEEEEEE', title: 'Refunded', authors: 'Ann' },
      { asin: 'B00FFFFFFF', title: 'Never Fetched', authors: 'Ann' },
      { asin: 'B00GGGGGGG', title: 'Truncated', authors: 'Ann', runtime_length_min: 600 },
      { asin: 'B00HHHHHHH', title: 'Never Scanned', authors: 'Ann', runtime_length_min: 1 },
    ]));
    writeFileSync(path.join(root, 'complete.json'), JSON.stringify([
      { asin: 'B00AAAAAAA', title: 'First', runtime_length_min: 1 },
      { asin: 'B00EEEEEEE', title: 'Refunded' },
    ]));
    writeFileSync(path.join(root, 'exclude.txt'), 'B00EEEEEEE  returned for a refund\n');

    // Import records, written the way the converter leaves them.
    process.env.AUDIOSHELF_DATA = env.AUDIOSHELF_DATA;
    process.env.AUDIOSHELF_LIBRARY = env.AUDIOSHELF_LIBRARY;
    const { db } = await import('../server/db.js');
    const insert = db.prepare(`INSERT INTO imports (path, format, status, error, output, title, discovered_at, updated_at)
      VALUES (?, 'aax', ?, ?, ?, ?, 0, 0)`);
    insert.run(path.join(lib, 'B00AAAAAAA-LC_64_22050_stereo.aax'), 'done', null, good, 'First');
    insert.run(path.join(lib, 'B00BBBBBBB-LC_64_22050_stereo.aax'), 'done', null, path.join(out, 'Gone.m4b'), 'Output Gone');
    insert.run(path.join(lib, 'B00CCCCCCC-LC_64_22050_stereo.aax'), 'failed', 'Decryption failed', null, 'Failed One');
    insert.run(path.join(lib, 'B00GGGGGGG-LC_64_22050_stereo.aax'), 'done', null, good, 'Truncated');
    insert.run(path.join(lib, 'B00HHHHHHH-LC_64_22050_stereo.aax'), 'done', null, unshelved, 'Never Scanned');

    // Only the first converted book has been through the scanner.
    const shelf = db.prepare(`INSERT INTO books (key, folder, title, sort_title, fingerprint, added_at, scanned_at)
      VALUES ('first', ?, 'First', 'first', 'fp', 0, 0)`).run(out);
    db.prepare('INSERT INTO tracks (book_id, idx, path) VALUES (?, 0, ?)').run(Number(shelf.lastInsertRowid), good);
  });

  after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  test('accounts for every book and exits non-zero while anything is outstanding', () => {
    const reportFile = path.join(root, 'report.json');
    const result = run(`--library=${path.join(root, 'library.json')}`,
      `--downloads=${path.join(root, 'downloads')}`,
      `--exclude=${path.join(root, 'exclude.txt')}`,
      `--json=${reportFile}`);
    assert.equal(result.status, 1, result.stderr || result.stdout);

    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    const state = (asin) => report.entries.find((entry) => entry.asin === asin).state;
    assert.equal(state('B00AAAAAAA'), 'verified', 'probed with ffprobe and the right length');
    assert.equal(state('B00BBBBBBB'), 'invalid', 'marked done, but the file is gone');
    assert.equal(state('B00CCCCCCC'), 'failed');
    assert.equal(state('B00DDDDDDD'), 'not-converted');
    assert.equal(state('B00EEEEEEE'), 'excluded');
    assert.equal(state('B00FFFFFFF'), 'not-downloaded');
    assert.equal(state('B00GGGGGGG'), 'invalid', 'a one-minute file for a ten-hour book');
    assert.equal(state('B00HHHHHHH'), 'not-shelved', 'converted and readable, but the scanner never added it');
    assert.equal(report.totals.accounted, 8);
    assert.equal(report.ffprobe, true);
    assert.deepEqual(report.extras.map((extra) => path.basename(extra.path)), ['B09ZZZZZZZ-LC_64_22050_stereo.aax']);

    assert.match(result.stdout, /Not complete: 6 of 8/);
    assert.match(result.stdout, /every entry accounted for/);
  });

  test('exits zero only when everything is verified or excluded', () => {
    const result = run(`--library=${path.join(root, 'complete.json')}`, `--exclude=${path.join(root, 'exclude.txt')}`);
    assert.equal(result.status, 0, result.stdout);
    assert.match(result.stdout, /Complete: every entry is verified or deliberately excluded/);
  });

  test('changes nothing: the import records are the same afterwards', async () => {
    const { db } = await import('../server/db.js');
    const before = JSON.stringify(db.prepare('SELECT * FROM imports ORDER BY id').all());
    run(`--library=${path.join(root, 'library.json')}`);
    const afterRun = JSON.stringify(db.prepare('SELECT * FROM imports ORDER BY id').all());
    assert.equal(afterRun, before);
  });

  test('deleting the originals after conversion does not erase the record', async () => {
    // B00HHHHHHH's source .aax is not on disk - exactly the state after the
    // originals are cleaned up. A rescan used to delete such rows, and with
    // them the only link from the ASIN to its converted .m4b.
    await runScript(['server/cli.js', 'scan'], env);
    const { db } = await import('../server/db.js');
    const rows = db.prepare('SELECT path, status FROM imports').all();
    assert.ok(rows.some((row) => row.path.includes('B00HHHHHHH') && row.status === 'done'),
      'a finished import survives its original being deleted');
    assert.ok(!rows.some((row) => row.path.includes('B00CCCCCCC')),
      'an unfinished one whose file is gone is still cleared away');

    const reportFile = path.join(root, 'after-cleanup.json');
    run(`--library=${path.join(root, 'library.json')}`, `--json=${reportFile}`);
    const report = JSON.parse(readFileSync(reportFile, 'utf8'));
    assert.equal(report.entries.find((entry) => entry.asin === 'B00HHHHHHH').state, 'verified',
      'once scanned onto the shelf, it verifies without the original');
  });

  test('a missing export file is a clear error, not a stack trace', () => {
    const result = run(`--library=${path.join(root, 'nope.json')}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No such file/);
  });
});
