#!/usr/bin/env node
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { migrate, db } from './db.js';
import { config } from './config.js';
import { createUser, userCount, hashPassword } from './auth.js';
import { scanLibrary, scanState } from './scanner.js';
import {
  checkTools, listImports, runImport, noteImport, readVoucher, normalizeActivationBytes,
  setSetting, storedActivationBytes, ACTIVATION_KEY, ensureChecksum,
} from './audible.js';

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
