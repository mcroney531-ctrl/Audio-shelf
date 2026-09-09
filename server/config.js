import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

// node:sqlite is built in from 22.5 onwards; without it nothing here works, and
// the failure is otherwise a cryptic module error.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(`AudioShelf needs Node 22.5 or newer (this is ${process.versions.node}).`);
  console.error('Install the current LTS from https://nodejs.org, or: winget install OpenJS.NodeJS.LTS');
  process.exit(1);
}

/**
 * A .env file in the project root, for people who would rather edit a file than
 * fight their shell's variable syntax. Real environment variables win over it.
 */
function loadDotEnv() {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  try {
    // Strip a UTF-8 BOM: Windows editors and PowerShell add one happily.
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    for (const [key, value] of Object.entries(parseEnv(text))) {
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    console.warn(`Ignoring .env: ${err.message}`);
  }
}
loadDotEnv();

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
  // Converted Audible imports land here; the scanner treats it as a second
  // library root so the library folder itself can stay read-only.
  importsDir: path.resolve(root, env.AUDIOSHELF_IMPORTS || path.join(dataDir, 'imported')),
  ffmpeg: env.AUDIOSHELF_FFMPEG || 'ffmpeg',
  ffprobe: env.AUDIOSHELF_FFPROBE || 'ffprobe',
  host: env.AUDIOSHELF_HOST || '0.0.0.0',
  // PORT is what Render, Railway, Heroku and friends inject.
  port: num(env.AUDIOSHELF_PORT || env.PORT, 8080),
  scanOnStart: bool(env.AUDIOSHELF_SCAN_ON_START, true),
  scanIntervalMin: num(env.AUDIOSHELF_SCAN_INTERVAL_MIN, 0),
  sessionTtlDays: num(env.AUDIOSHELF_SESSION_DAYS, 30),
  trustProxy: bool(env.AUDIOSHELF_TRUST_PROXY, false),
  secret: loadSecret(),
};

config.libraryRoots = [config.libraryDir, config.importsDir];

mkdirSync(config.coversDir, { recursive: true });
mkdirSync(config.importsDir, { recursive: true });
