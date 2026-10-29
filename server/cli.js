#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { migrate, db } from './db.js';
import { config } from './config.js';
import { createUser, userCount, hashPassword } from './auth.js';
import { scanLibrary, scanState } from './scanner.js';
import {
  checkTools, listImports, runImport, noteImport, readVoucher, normalizeActivationBytes,
  setSetting, storedActivationBytes, ACTIVATION_KEY, ensureChecksum, probe,
} from './audible.js';
import {
  parseLibraryExport, parseExclusions, collectSources, reconcile, formatReport, pathKey,
} from './reconcile.js';
import {
  estimate, listVoices, saveApiKey, saveServiceAccount, clearCredentials, credentialSummary,
  createGeneration, runGeneration, listGenerations, monthlyUsage, PRICING, DEFAULT_VOICE, ttsState,
} from './tts.js';

migrate();

const [command, ...args] = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const commands = {
  async scan() {
    console.log(`Scanning ${config.libraryDir} ...`);
    await scanLibrary({ force: args.includes('--force') });
    if (scanState.error) {
      console.error(scanState.error);
      process.exitCode = 1;
      return;
    }
    console.log(`${scanState.found} books · +${scanState.added} · ~${scanState.updated} · -${scanState.removed}`);
  },

  'user:add'() {
    const username = flag('username');
    const password = flag('password');
    if (!username || !password) {
      console.error('usage: npm run cli -- user:add --username=NAME --password=SECRET [--admin] [--name="Display Name"]');
      process.exitCode = 1;
      return;
    }
    const user = createUser({
      username,
      password,
      displayName: flag('name') || username,
      isAdmin: args.includes('--admin') || userCount() === 0,
    });
    console.log(`Created ${user.username}${user.is_admin ? ' (admin)' : ''}`);
  },

  'user:password'() {
    const username = flag('username');
    const password = flag('password');
    if (!username || !password) {
      console.error('usage: npm run cli -- user:password --username=NAME --password=SECRET');
      process.exitCode = 1;
      return;
    }
    const info = db.prepare('UPDATE users SET password_hash = ? WHERE username = ?')
      .run(hashPassword(password), username);
    if (!info.changes) {
      console.error(`No user named ${username}`);
      process.exitCode = 1;
      return;
    }
    db.prepare('DELETE FROM sessions WHERE user_id = (SELECT id FROM users WHERE username = ?)').run(username);
    console.log(`Password updated for ${username}; other sessions signed out.`);
  },

  'user:list'() {
    for (const user of db.prepare('SELECT id, username, display_name, is_admin FROM users ORDER BY id').all()) {
      console.log(`${String(user.id).padStart(3)}  ${user.username}${user.is_admin ? ' *admin' : ''}  (${user.display_name})`);
    }
  },

  async 'import:list'() {
    const tools = await checkTools();
    console.log(tools.ffmpeg
      ? `ffmpeg ${tools.version} (aax: ${tools.supportsAax ? 'yes' : 'no'}, aaxc: ${tools.supportsAaxc ? 'yes' : 'no'})`
      : `ffmpeg not found at "${config.ffmpeg}" - imports are unavailable`);
    const rows = listImports();
    if (!rows.length) {
      console.log(`No .aax or .aaxc files found under ${config.libraryDir}`);
      return;
    }
    for (const row of rows) {
      const detail = row.status === 'done' ? row.output
        : row.error ? `! ${row.error}`
          : row.format === 'aaxc' ? (row.hasVoucher ? 'voucher found' : 'voucher missing')
            : storedActivationBytes() ? 'activation bytes saved' : 'needs activation bytes';
      console.log(`${String(row.id).padStart(3)}  [${row.status.padEnd(10)}] ${row.title || row.file}  (${row.format}) - ${detail}`);
    }
  },

  /** Convert one file, or everything pending, into the imports folder. */
  async import() {
    const activationBytes = flag('activation-bytes') || flag('activation');
    const keys = {};
    if (activationBytes) keys.activationBytes = normalizeActivationBytes(activationBytes);
    if (flag('key') && flag('iv')) { keys.key = flag('key'); keys.iv = flag('iv'); }

    const voucherPath = flag('voucher');
    if (voucherPath) {
      const voucher = await readVoucher(voucherPath.replace(/\.voucher$/i, '.aaxc'));
      if (!voucher || voucher.error) {
        console.error(voucher?.error || `Could not read ${voucherPath}`);
        process.exitCode = 1;
        return;
      }
      keys.key = voucher.key;
      keys.iv = voucher.iv;
    }

    const file = flag('file');
    let targets = [];
    if (file) {
      const absolute = path.resolve(file);
      const stat = await fs.stat(absolute).catch(() => null);
      if (!stat) {
        console.error(`No such file: ${absolute}`);
        process.exitCode = 1;
        return;
      }
      targets = [await noteImport(absolute, stat)];
    } else if (args.includes('--all')) {
      targets = listImports().filter((row) => row.status !== 'done').map((row) => row.id);
    } else {
      console.error('usage: npm run cli -- import (--file=book.aax | --all) [--activation-bytes=1a2b3c4d] [--voucher=book.voucher]');
      process.exitCode = 1;
      return;
    }

    if (!targets.length) {
      console.log('Nothing to import.');
      return;
    }

    for (const id of targets) {
      const row = listImports().find((entry) => entry.id === id);
      process.stdout.write(`Converting ${row?.title || id} ... `);
      try {
        const result = await runImport(id, keys);
        console.log(`done -> ${result.path}`);
      } catch (err) {
        console.log('failed');
        console.error(`  ${err.message}`);
        process.exitCode = 1;
      }
    }
    await scanLibrary();
    console.log(`Library now holds ${db.prepare('SELECT COUNT(*) AS n FROM books').get().n} books.`);
  },

  /** Store (or clear) the account activation bytes used for .aax files. */
  async 'import:activation'() {
    if (args.includes('--clear')) {
      db.prepare('DELETE FROM settings WHERE key = ?').run(ACTIVATION_KEY);
      console.log('Activation bytes cleared.');
      return;
    }
    const value = flag('set');
    if (!value) {
      const stored = storedActivationBytes();
      console.log(stored ? `Stored activation bytes: ${stored.slice(0, 2)}****${stored.slice(-2)}` : 'No activation bytes stored.');
      console.log('usage: npm run cli -- import:activation --set=1a2b3c4d | --clear');
      return;
    }
    setSetting(ACTIVATION_KEY, normalizeActivationBytes(value));
    console.log('Activation bytes saved.');
  },

  /** Print the AAX checksum that activation-byte lookup tools ask for. */
  async 'import:checksum'() {
    const id = Number(flag('id'));
    if (!Number.isFinite(id)) {
      console.error('usage: npm run cli -- import:checksum --id=3   (ids come from import:list)');
      process.exitCode = 1;
      return;
    }
    const checksum = await ensureChecksum(id);
    console.log(checksum || 'No checksum available for that file.');
  },

  /**
   * Accounts for every book in an Audible library export: downloaded,
   * converted, verified, or what is missing. Read-only - changes nothing.
   */
  async 'import:reconcile'() {
    const exportFile = flag('library');
    if (!exportFile) {
      console.error('usage: npm run cli -- import:reconcile --library=library.json [--downloads=D:\\AudibleDownloads]');
      console.error('                   [--exclude=excluded.txt] [--json=report.json] [--verbose]');
      console.error('Create the export with: audible library export --format json --output library.json');
      process.exitCode = 1;
      return;
    }

    let parsed;
    try {
      parsed = parseLibraryExport(await fs.readFile(path.resolve(exportFile), 'utf8'));
    } catch (err) {
      console.error(err.code === 'ENOENT' ? `No such file: ${path.resolve(exportFile)}` : err.message);
      process.exitCode = 1;
      return;
    }

    const excludeFile = flag('exclude');
    const exclusions = excludeFile
      ? parseExclusions(await fs.readFile(path.resolve(excludeFile), 'utf8'))
      : new Map();

    const downloads = flag('downloads') ? path.resolve(flag('downloads')) : null;
    const known = new Set(parsed.records.map((record) => record.asin).filter(Boolean));
    const sources = await collectSources([config.libraryDir, downloads], known);
    const imports = db.prepare('SELECT * FROM imports').all();

    // Check the converted files themselves; the "done" flag is only a claim.
    const tools = await checkTools();
    const canProbe = tools.ffmpeg && tools.ffprobe;
    const outputs = new Map();
    for (const row of imports) {
      if (row.status !== 'done' || !row.output || outputs.has(row.output)) continue;
      const stat = await fs.stat(row.output).catch(() => null);
      let result = null;
      if (stat?.size && canProbe) result = await probe(row.output).catch((err) => ({ ok: false, error: err.message }));
      outputs.set(row.output, { exists: !!stat, size: stat?.size ?? 0, probe: result });
    }

    const report = reconcile({
      records: parsed.records,
      sources,
      imports,
      outputs,
      exclusions,
      hasActivationBytes: !!storedActivationBytes(),
      downloadRoots: downloads ? [downloads] : [],
      shelved: new Set(db.prepare('SELECT path FROM tracks').all().map((row) => pathKey(row.path))),
    });

    console.log(formatReport(report, {
      verbose: args.includes('--verbose'),
      header: [
        `export   : ${path.resolve(exportFile)} (${parsed.format}, ${parsed.records.length} entries)`,
        `searched : ${[config.libraryDir, downloads].filter(Boolean).join(', ')}`,
        `ffprobe  : ${canProbe ? 'yes - converted files are read, not just checked for' : 'not found - converted files cannot be verified'}`,
      ],
    }));

    const jsonFile = flag('json');
    if (jsonFile) {
      // Written by Node rather than a shell redirect: Windows PowerShell 5.1's
      // `>` writes UTF-16, which most tools then fail to read.
      await fs.writeFile(path.resolve(jsonFile), JSON.stringify({
        generatedAt: new Date().toISOString(),
        export: { path: path.resolve(exportFile), format: parsed.format },
        searched: [config.libraryDir, downloads].filter(Boolean),
        ffprobe: canProbe,
        ...report,
      }, null, 2) + '\n', 'utf8');
      console.log(`\nFull report written to ${path.resolve(jsonFile)}`);
    }

    // Non-zero until the migration is actually done, so a script can tell.
    if (!report.complete) process.exitCode = 1;
  },

  /** Store (or clear) the Google credentials used for generating speech. */
  async 'tts:key'() {
    if (args.includes('--clear')) {
      clearCredentials();
      console.log('Google credentials cleared.');
      return;
    }
    const file = flag('service-account');
    if (file) {
      saveServiceAccount(await fs.readFile(path.resolve(file), 'utf8'));
      console.log(`Service account saved (${credentialSummary().hint}).`);
      return;
    }
    const value = flag('set');
    if (!value) {
      const stored = credentialSummary();
      console.log(stored ? `${stored.kind}: ${stored.hint}` : 'No Google credentials stored.');
      console.log('usage: npm run cli -- tts:key --set=AIza... | --service-account=key.json | --clear');
      return;
    }
    saveApiKey(value);
    console.log('API key saved.');
  },

  async 'tts:voices'() {
    const voices = await listVoices(flag('language') || 'en-US');
    for (const entry of voices) {
      console.log(`${entry.name.padEnd(30)} ${String(entry.gender || '').toLowerCase().padEnd(8)} ${entry.tier}`);
    }
    console.log(`\n${voices.length} voices. Cost per tier:`);
    for (const [tier, rates] of Object.entries(PRICING)) {
      if (tier === 'other') continue;
      console.log(`  ${tier.padEnd(18)} ${rates.freePerMonth.toLocaleString().padStart(9)} free/month, then $${rates.perMillion}/million`);
    }
  },

  /** Read a text file aloud into the generated library. --dry-run costs nothing. */
  async tts() {
    const file = flag('file');
    if (!file) {
      console.error('usage: npm run cli -- tts --file=notes.txt --title="My Book" [--author=Name] [--voice=en-US-Chirp3-HD-Charon] [--rate=1] [--dry-run]');
      process.exitCode = 1;
      return;
    }
    const text = await fs.readFile(path.resolve(file), 'utf8');
    const voice = flag('voice') || DEFAULT_VOICE;
    const guess = await estimate({ text, voice });

    console.log(`${guess.characters.toLocaleString()} characters, ${guess.words.toLocaleString()} words, ${guess.chapters.length} chapters`);
    console.log(`about ${Math.round(guess.estimatedSeconds / 60)} minutes of audio in ${guess.chunks} pieces`);
    console.log(`${guess.tierLabel}: ${guess.freeRemaining.toLocaleString()} free characters left this month`);
    console.log(guess.cost > 0 ? `estimated cost: $${guess.cost.toFixed(4)}` : 'estimated cost: nothing - inside the free tier');

    if (args.includes('--dry-run')) {
      for (const chapter of guess.chapters) {
        console.log(`  ${String(chapter.index).padStart(3)}. ${chapter.title}  (${chapter.characters.toLocaleString()} chars)`);
      }
      return;
    }

    const id = createGeneration({
      title: flag('title') || path.basename(file, path.extname(file)),
      author: flag('author') || '',
      text,
      voice,
      speakingRate: Number(flag('rate')) || 1,
    });
    // A long text is a lot of quiet minutes; say which piece it is on.
    const ticker = setInterval(() => {
      if (ttsState.running) process.stdout.write(`\rGenerating piece ${ttsState.chunk} of ${ttsState.chunks} `);
    }, 500);
    try {
      const result = await runGeneration(id);
      clearInterval(ticker);
      console.log(`\ndone -> ${result.path} (${result.chapters} chapters)`);
    } catch (err) {
      clearInterval(ticker);
      console.log('\nfailed');
      console.error(`  ${err.message}`);
      console.error('  Pieces already generated are kept; run tts:resume to pick up where it stopped.');
      process.exitCode = 1;
      return;
    }
    await scanLibrary();
    console.log(`Library now holds ${db.prepare('SELECT COUNT(*) AS n FROM books').get().n} books.`);
  },

  async 'tts:resume'() {
    const id = Number(flag('id'));
    if (!Number.isFinite(id)) {
      console.error('usage: npm run cli -- tts:resume --id=3   (ids come from tts:list)');
      process.exitCode = 1;
      return;
    }
    const result = await runGeneration(id);
    console.log(`done -> ${result.path}`);
    await scanLibrary();
  },

  'tts:list'() {
    const rows = listGenerations();
    if (!rows.length) {
      console.log('Nothing generated yet.');
      return;
    }
    for (const row of rows) {
      const detail = row.status === 'done' ? row.output
        : row.error ? `! ${row.error}`
          : `${row.chunksDone}/${row.chunkCount} pieces`;
      console.log(`${String(row.id).padStart(3)}  [${row.status.padEnd(9)}] ${row.title}  (${row.characters.toLocaleString()} chars, ${row.voice}) - ${detail}`);
    }
  },

  'tts:usage'() {
    const { month, used } = monthlyUsage();
    console.log(`Characters spent in ${month} (this server's own count):`);
    for (const [tier, rates] of Object.entries(PRICING)) {
      if (tier === 'other') continue;
      const spent = used[tier] || 0;
      const over = Math.max(0, spent - rates.freePerMonth);
      console.log(`  ${rates.label.padEnd(20)} ${spent.toLocaleString().padStart(10)} of ${rates.freePerMonth.toLocaleString()} free`
        + (over ? `  -> $${((over / 1e6) * rates.perMillion).toFixed(2)}` : ''));
    }
  },

  stats() {
    const books = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(duration),0) AS d, COALESCE(SUM(size),0) AS s FROM books').get();
    console.log(`books   : ${books.n}`);
    console.log(`runtime : ${(books.d / 3600).toFixed(1)} h`);
    console.log(`on disk : ${(books.s / 1e9).toFixed(2)} GB`);
    console.log(`users   : ${userCount()}`);
  },
};

const run = commands[command];
if (!run) {
  console.error(`Commands: ${Object.keys(commands).join(', ')}`);
  process.exitCode = 1;
} else {
  await run();
}
