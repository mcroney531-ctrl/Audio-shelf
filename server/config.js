import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const env = process.env;

const bool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
};

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const dataDir = path.resolve(root, env.AUDIOSHELF_DATA || 'data');

/** The instance secret signs session cookies. Generated once, then reused. */
function loadSecret() {
  if (env.AUDIOSHELF_SECRET) return env.AUDIOSHELF_SECRET;
  const file = path.join(dataDir, 'secret');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const secret = randomBytes(32).toString('hex');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, secret + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* best effort on exotic filesystems */ }
  return secret;
}

export const config = {
  root,
  webDir: path.join(root, 'web'),
  dataDir,
  coversDir: path.join(dataDir, 'covers'),
  dbFile: path.join(dataDir, 'audioshelf.db'),
  libraryDir: path.resolve(root, env.AUDIOSHELF_LIBRARY || 'library'),
  host: env.AUDIOSHELF_HOST || '0.0.0.0',
  port: num(env.AUDIOSHELF_PORT, 8080),
  scanOnStart: bool(env.AUDIOSHELF_SCAN_ON_START, true),
  scanIntervalMin: num(env.AUDIOSHELF_SCAN_INTERVAL_MIN, 0),
  sessionTtlDays: num(env.AUDIOSHELF_SESSION_DAYS, 30),
  trustProxy: bool(env.AUDIOSHELF_TRUST_PROXY, false),
  secret: loadSecret(),
};

mkdirSync(config.coversDir, { recursive: true });
