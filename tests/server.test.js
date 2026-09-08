import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from './helpers.js';

let server;
before(async () => { server = await startTestServer(); });
after(async () => { await server?.stop(); });

describe('setup and auth', () => {
  test('a fresh server asks to be set up', async () => {
    const { body } = await server.json('/api/setup');
    assert.equal(body.needsSetup, true);
  });

  test('rejects a weak first password', async () => {
    const { status } = await server.json('/api/setup', {
      method: 'POST',
      body: { username: 'admin', password: 'short' },
    });
    assert.equal(status, 400);
  });

  test('creates the first account as an administrator', async () => {
    const { status, body } = await server.json('/api/setup', {
      method: 'POST',
      body: { username: 'listener', password: 'correct horse battery', displayName: 'Test Listener' },
    });
    assert.equal(status, 201);
    assert.equal(body.user.isAdmin, true);
  });

  test('setup is closed once a user exists', async () => {
    const { status } = await server.json('/api/setup', {
      method: 'POST',
      body: { username: 'sneaky', password: 'another password' },
    });
    assert.equal(status, 403);
  });

  test('the session cookie identifies the user', async () => {
    const { body } = await server.json('/api/me');
    assert.equal(body.user.username, 'listener');
  });

  test('wrong passwords are refused', async () => {
    const response = await fetch(`${server.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'listener', password: 'nope' }),
    });
    assert.equal(response.status, 401);
  });

  test('the API is closed to anonymous callers', async () => {
    const response = await fetch(`${server.base}/api/books`);
    assert.equal(response.status, 401);
  });
});

describe('library', () => {
  test('the demo library scanned into books with tags', async () => {
    const { body } = await server.json('/api/books?sort=title');
    assert.equal(body.total, 4);
    const book = body.books.find((entry) => entry.title === 'Static Cathedral');
    assert.equal(book.author, 'Wren Okonkwo');
    assert.equal(book.narrator, 'Marcus Bell');
    assert.ok(book.duration > 300);
  });

  test('series metadata survives the scan', async () => {
    const { body } = await server.json('/api/books?series=Small%20Hours&sort=title');
    assert.equal(body.total, 2);
    assert.deepEqual(body.books.map((b) => b.seriesIndex).sort(), [1, 2]);
  });

  test('search matches author and title', async () => {
    assert.equal((await server.json('/api/books?q=okonkwo')).body.total, 1);
    assert.equal((await server.json('/api/books?q=cartographer')).body.total, 1);
    assert.equal((await server.json('/api/books?q=zzzz')).body.total, 0);
  });

  test('book detail carries tracks and chapters with offsets', async () => {
    const list = await server.json('/api/books?q=cartographer');
    const { body } = await server.json(`/api/books/${list.body.books[0].id}`);
    assert.equal(body.tracks.length, 5);
    assert.equal(body.chapters.length, 5);
    assert.equal(body.tracks[0].start, 0);
    assert.ok(body.tracks[1].start > 0);
    // chapter starts line up with track starts for multi-file books
    assert.deepEqual(body.chapters.map((c) => c.start), body.tracks.map((t) => t.start));
  });

  test('a missing book is a 404', async () => {
    assert.equal((await server.json('/api/books/9999')).status, 404);
  });
});

describe('streaming', () => {
  let trackId;
  before(async () => {
    const list = await server.json('/api/books?q=salt');
    const detail = await server.json(`/api/books/${list.body.books[0].id}`);
    trackId = detail.body.tracks[0].id;
  });

  test('serves the whole file with range support advertised', async () => {
    const response = await server.call(`/api/tracks/${trackId}/stream`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('accept-ranges'), 'bytes');
    assert.equal(response.headers.get('content-type'), 'audio/mpeg');
    await response.arrayBuffer();
  });

  test('answers a byte range with 206 and the right slice', async () => {
    const response = await server.call(`/api/tracks/${trackId}/stream`, { headers: { range: 'bytes=100-199' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-length'), '100');
    assert.match(response.headers.get('content-range'), /^bytes 100-199\/\d+$/);
    assert.equal((await response.arrayBuffer()).byteLength, 100);
  });

  test('answers an open-ended range', async () => {
    const response = await server.call(`/api/tracks/${trackId}/stream`, { headers: { range: 'bytes=1000-' } });
    assert.equal(response.status, 206);
    await response.arrayBuffer();
  });

  test('answers a suffix range', async () => {
    const response = await server.call(`/api/tracks/${trackId}/stream`, { headers: { range: 'bytes=-500' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-length'), '500');
    await response.arrayBuffer();
  });

  test('refuses a range past the end of the file', async () => {
    const response = await server.call(`/api/tracks/${trackId}/stream`, { headers: { range: 'bytes=99999999-' } });
    assert.equal(response.status, 416);
    await response.arrayBuffer();
  });

  test('anonymous callers cannot stream audio', async () => {
    const response = await fetch(`${server.base}/api/tracks/${trackId}/stream`);
    assert.equal(response.status, 401);
    await response.arrayBuffer();
  });

  test('covers come back as images', async () => {
    const list = await server.json('/api/books?q=salt');
    const response = await server.call(`/api/books/${list.body.books[0].id}/cover`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^image\//);
    await response.arrayBuffer();
  });
});

describe('listening progress', () => {
  let bookId;
  before(async () => {
    const list = await server.json('/api/books?q=salt');
    bookId = list.body.books[0].id;
  });

  test('stores and returns a position', async () => {
    await server.json(`/api/books/${bookId}/progress`, { method: 'PUT', body: { position: 42.5, speed: 1.5 } });
    const { body } = await server.json(`/api/books/${bookId}`);
    assert.equal(body.progress.position, 42.5);
    assert.equal(body.progress.speed, 1.5);
    assert.equal(body.progress.finished, false);
  });

  test('clamps a position past the end of the book', async () => {
    const { body } = await server.json(`/api/books/${bookId}/progress`, {
      method: 'PUT', body: { position: 999999 },
    });
    assert.ok(body.position < 1000);
    assert.equal(body.finished, true);
  });

  test('shows up on the continue-listening shelf', async () => {
    await server.json(`/api/books/${bookId}/progress`, { method: 'PUT', body: { position: 20, finished: false } });
    const { body } = await server.json('/api/shelves');
    assert.equal(body.continueListening[0].id, bookId);
    assert.ok(body.totals.books >= 4);
  });

  test('filters by in-progress and finished', async () => {
    assert.ok((await server.json('/api/books?filter=in-progress')).body.total >= 1);
    assert.ok((await server.json('/api/books?filter=unstarted')).body.total >= 1);
  });

  test('bookmarks round-trip', async () => {
    const created = await server.json(`/api/books/${bookId}/bookmarks`, {
      method: 'POST', body: { position: 12, note: 'the caravan bit' },
    });
    assert.equal(created.status, 201);
    const detail = await server.json(`/api/books/${bookId}`);
    assert.equal(detail.body.bookmarks[0].note, 'the caravan bit');
    assert.equal((await server.json(`/api/bookmarks/${created.body.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await server.json(`/api/books/${bookId}`)).body.bookmarks.length, 0);
  });
});

describe('administration', () => {
  test('reports library status', async () => {
    const { body } = await server.json('/api/admin/status');
    assert.equal(body.library.books, 4);
    assert.equal(body.users.length, 1);
  });

  test('adds a listener who cannot administer', async () => {
    const created = await server.json('/api/admin/users', {
      method: 'POST', body: { username: 'guest', password: 'guest password', displayName: 'Guest' },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.user.isAdmin, false);

    const guest = await startGuestSession(server, 'guest', 'guest password');
    assert.equal((await guest('/api/admin/status')).status, 403);
    assert.equal((await guest('/api/books')).status, 200);
  });

  test('duplicate usernames are refused', async () => {
    const { status } = await server.json('/api/admin/users', {
      method: 'POST', body: { username: 'guest', password: 'another password' },
    });
    assert.equal(status, 409);
  });

  test('an admin cannot delete themselves', async () => {
    const { body } = await server.json('/api/admin/status');
    const me = body.users.find((user) => user.username === 'listener');
    assert.equal((await server.json(`/api/admin/users/${me.id}`, { method: 'DELETE' })).status, 400);
  });

  test('a scan can be triggered and reports state', async () => {
    const { status, body } = await server.json('/api/admin/scan', { method: 'POST', body: {} });
    assert.equal(status, 202);
    assert.ok('running' in body.scan);
  });
});

describe('static app shell', () => {
  test('serves the PWA entry points', async () => {
    for (const path of ['/', '/manifest.json', '/sw.js', '/styles.css', '/js/app.js']) {
      const response = await server.call(path);
      assert.equal(response.status, 200, `${path} should be served`);
      await response.text();
    }
  });

  test('unknown app routes fall back to the shell', async () => {
    const response = await server.call('/book/12');
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>AudioShelf<\/title>/);
  });

  test('the manifest meets Android WebAPK install criteria', async () => {
    const response = await server.call('/manifest.json');
    assert.match(response.headers.get('content-type'), /application\/manifest\+json/);
    const manifest = await response.json();

    for (const field of ['name', 'short_name', 'start_url', 'icons']) {
      assert.ok(manifest[field], `manifest.${field} is required for installability`);
    }
    assert.ok(['standalone', 'fullscreen', 'minimal-ui'].includes(manifest.display));

    const purposes = (entry) => String(entry.purpose || 'any').trim().split(/\s+/);
    // A combined "any maskable" purpose trips a Chrome WebAPK bug: Android then
    // drops a bookmark shortcut instead of installing an app.
    assert.equal(manifest.icons.filter((entry) => purposes(entry).length > 1).length, 0);

    for (const purpose of ['any', 'maskable']) {
      for (const size of ['192x192', '512x512']) {
        assert.ok(
          manifest.icons.some((entry) => purposes(entry).includes(purpose) && entry.sizes === size),
          `manifest needs a ${size} icon with purpose "${purpose}"`,
        );
      }
    }
  });

  test('every manifest icon is actually served as an image', async () => {
    const manifest = await (await server.call('/manifest.json')).json();
    for (const entry of manifest.icons) {
      const response = await server.call(entry.src);
      assert.equal(response.status, 200, `${entry.src} should exist`);
      assert.match(response.headers.get('content-type'), /^image\//);
      await response.arrayBuffer();
    }
  });

  test('refuses to serve files outside the web directory', async () => {
    const response = await server.call('/js/%2e%2e/%2e%2e/server/config.js');
    assert.equal(response.status, 404);
    await response.text();
  });
});

async function startGuestSession(server, username, password) {
  const login = await fetch(`${server.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = (login.headers.getSetCookie?.() || []).map((value) => value.split(';')[0]).join('; ');
  return async (path, options = {}) => {
    const response = await fetch(`${server.base}${path}`, { ...options, headers: { ...(options.headers || {}), cookie } });
    await response.arrayBuffer();
    return response;
  };
}
