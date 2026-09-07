#!/usr/bin/env node
import { migrate, db } from './db.js';
import { config } from './config.js';
import { createUser, userCount, hashPassword } from './auth.js';
import { scanLibrary, scanState } from './scanner.js';

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
