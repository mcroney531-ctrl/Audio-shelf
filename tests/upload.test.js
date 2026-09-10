import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { startTestServer, repoRoot } from './helpers.js';

let server;
let sample;

before(async () => {
  server = await startTestServer();
  await server.json('/api/setup', {
    method: 'POST',
    body: { username: 'uploader', password: 'a good long password' },
  });
  sample = await fs.readFile(path.join(server.env.AUDIOSHELF_LIBRARY, 'Hollis Vance', 'Salt Roads', '01 - Caravan.mp3'));
});

after(async () => { await server?.stop(); });

const upload = (query, body, options = {}) =>
  server.call(`/api/upload?${new URLSearchParams(query)}`, { method: 'POST', body, ...options });

describe('uploading books', () => {
  test('streams a file into the folder it was given', async () => {
    const response = await upload({ name: '01 - Opening.mp3', folder: 'Nell Prior/The Long Field' }, sample);
    assert.equal(response.status, 201);
    const { file } = await response.json();
    assert.equal(file.relative, path.join('Nell Prior', 'The Long Field', '01 - Opening.mp3'));
    assert.equal(file.size, sample.length);

    const onDisk = await fs.readFile(file.path);
    assert.equal(onDisk.length, sample.length, 'the whole file should arrive');
  });

  test('a second upload of the same name does not clobber the first', async () => {
    const response = await upload({ name: '01 - Opening.mp3', folder: 'Nell Prior/The Long Field' }, sample);
    const { file } = await response.json();
    assert.match(file.name, /\(2\)\.mp3$/);
  });

  test('leaves no .part file behind', async () => {
    const dir = path.join(server.env.AUDIOSHELF_LIBRARY, 'Nell Prior', 'The Long Field');
    const entries = await fs.readdir(dir);
    assert.equal(entries.some((entry) => entry.endsWith('.part')), false);
  });

  test('a traversing filename cannot escape the library', async () => {
    const response = await upload({ name: '../../../../escaped.mp3', folder: '../../..' }, sample);
    assert.equal(response.status, 201);
    const { file } = await response.json();
    assert.equal(file.relative, 'escaped.mp3');
    assert.ok(file.path.startsWith(server.env.AUDIOSHELF_LIBRARY + path.sep));

    // and nothing appeared next to the library folder
    const outside = await fs.readdir(path.dirname(server.env.AUDIOSHELF_LIBRARY));
    assert.equal(outside.includes('escaped.mp3'), false);
  });

  test('an absolute Windows path is treated as a bare filename', async () => {
    const response = await upload({ name: 'C:\\Windows\\System32\\evil.mp3' }, sample);
    const { file } = await response.json();
    assert.equal(file.relative, 'evil.mp3');
  });

  test('refuses file types the library has no use for', async () => {
    for (const name of ['payload.sh', 'notes.txt', 'thing.exe', 'noextension']) {
      const response = await upload({ name }, Buffer.from('x'));
      assert.equal(response.status, 400, `${name} should be refused`);
      await response.json();
    }
  });

  test('refuses an empty upload', async () => {
    const response = await upload({ name: 'empty.mp3' }, Buffer.alloc(0));
    assert.equal(response.status, 400);
    await response.json();
  });

  test('is closed to anonymous callers', async () => {
    const response = await fetch(`${server.base}/api/upload?name=x.mp3`, { method: 'POST', body: sample });
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  });

  test('is closed to non-admin listeners', async () => {
    await server.json('/api/admin/users', {
      method: 'POST', body: { username: 'listener2', password: 'another long password' },
    });
    const login = await fetch(`${server.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'listener2', password: 'another long password' }),
    });
    const cookie = (login.headers.getSetCookie?.() || []).map((value) => value.split(';')[0]).join('; ');
    const response = await fetch(`${server.base}/api/upload?name=x.mp3`, {
      method: 'POST', headers: { cookie }, body: sample,
    });
    assert.equal(response.status, 403);
    await response.arrayBuffer();
  });

  test('uploaded books reach the shelf after a scan', async () => {
    await server.json('/api/admin/scan', { method: 'POST', body: {} });
    for (let i = 0; i < 40; i++) {
      const { body } = await server.json('/api/admin/status');
      if (!body.scan.running) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const { body } = await server.json('/api/books?limit=100');
    assert.ok(body.total > 4, 'the uploads should have become books');
  });
});

describe('API tokens', () => {
  let token;

  test('are created once and never echoed again', async () => {
    const created = await server.json('/api/me/tokens', { method: 'POST', body: { label: 'agent' } });
    assert.equal(created.status, 201);
    assert.match(created.body.token, /^as_/);
    token = created.body.token;

    const listed = await server.json('/api/me/tokens');
    assert.equal(listed.body.tokens.length, 1);
    assert.equal(listed.body.tokens[0].label, 'agent');
    assert.ok(!JSON.stringify(listed.body).includes(token), 'the raw token must not come back');
  });

  test('authenticate an upload with no cookie at all', async () => {
    const response = await fetch(`${server.base}/api/upload?name=by-token.m4b&folder=Agent%20Drop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: sample,
    });
    assert.equal(response.status, 201);
    const { file } = await response.json();
    assert.equal(file.relative, path.join('Agent Drop', 'by-token.m4b'));
  });

  test('work for reading the library too', async () => {
    const response = await fetch(`${server.base}/api/books`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    await response.json();
  });

  test('a wrong or malformed token is refused', async () => {
    for (const value of ['Bearer as_nonsense', 'Bearer nonsense', 'Basic hunter2', '']) {
      const response = await fetch(`${server.base}/api/books`, { headers: value ? { authorization: value } : {} });
      assert.equal(response.status, 401, `"${value}" should not authenticate`);
      await response.arrayBuffer();
    }
  });

  test('revoking one stops it working', async () => {
    const { body } = await server.json('/api/me/tokens');
    const id = body.tokens.find((entry) => entry.label === 'agent').id;
    assert.equal((await server.json(`/api/me/tokens/${id}`, { method: 'DELETE' })).status, 200);

    const response = await fetch(`${server.base}/api/books`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  });

  test('records when a token was last used', async () => {
    const created = await server.json('/api/me/tokens', { method: 'POST', body: { label: 'second' } });
    await fetch(`${server.base}/api/books`, { headers: { authorization: `Bearer ${created.body.token}` } })
      .then((response) => response.arrayBuffer());
    const { body } = await server.json('/api/me/tokens');
    const row = body.tokens.find((entry) => entry.label === 'second');
    assert.ok(row.lastUsedAt, 'lastUsedAt should be stamped');
  });
});
