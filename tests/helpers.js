import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));

export const runScript = (args, env) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.on('exit', (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Throwaway data dir + demo library + a running server. */
export async function startTestServer({ seed = true, scan = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'audioshelf-'));
  const port = 9000 + Math.floor(Math.random() * 900);
  const env = {
    AUDIOSHELF_DATA: path.join(root, 'data'),
    AUDIOSHELF_LIBRARY: path.join(root, 'library'),
    AUDIOSHELF_PORT: String(port),
    AUDIOSHELF_SCAN_ON_START: '0',
    AUDIOSHELF_LOG: 'quiet',
  };

  if (seed) await runScript(['scripts/seed-demo.js'], env);
  if (scan) await runScript(['server/cli.js', 'scan'], env);

  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.js'], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
  });
  server.stderr.on('data', (chunk) => process.env.TEST_VERBOSE && console.error(String(chunk)));

  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) break;
    } catch { /* not up yet */ }
    await wait(100);
  }

  const jar = new Map();
  /** fetch that remembers cookies, so tests can act like a signed-in browser. */
  const call = async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (jar.size) headers.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
    if (options.body && typeof options.body !== 'string') {
      headers['content-type'] = 'application/json';
      options = { ...options, body: JSON.stringify(options.body) };
    }
    const response = await fetch(`${base}${path}`, { ...options, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie?.() || []) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    return response;
  };

  const json = async (path, options) => {
    const response = await call(path, options);
    return { status: response.status, body: await response.json().catch(() => null) };
  };

  return {
    base,
    env,
    root,
    call,
    json,
    async stop() {
      server.kill('SIGTERM');
      await wait(250);
      server.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    },
  };
}
