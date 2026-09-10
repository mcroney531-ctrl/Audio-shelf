/* AudioShelf service worker: app shell offline, API responses as a fallback,
   and downloaded audio served straight from the cache — Range requests
   included, so seeking works with the network off. */

const VERSION = 'v1';
const SHELL_CACHE = `audioshelf-shell-${VERSION}`;
const API_CACHE = `audioshelf-api-${VERSION}`;
const MEDIA_CACHE = 'audioshelf-media-v1'; // deliberately unversioned: user downloads survive updates

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.json',
  '/js/app.js',
  '/js/api.js',
  '/js/dom.js',
  '/js/install.js',
  '/js/offline.js',
  '/js/player.js',
  '/js/playerui.js',
  '/js/views.js',
  '/fonts/fraunces-latin.woff2',
  '/fonts/fraunces-latin-ext.woff2',
  '/fonts/karla-latin.woff2',
  '/fonts/karla-latin-ext.woff2',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/favicon-32.png',
];

const API_CACHEABLE = [/^\/api\/(shelves|books|progress|me)$/, /^\/api\/books\/\d+$/];
const isMedia = (pathname) => /^\/api\/(tracks\/\d+\/stream|books\/\d+\/cover)$/.test(pathname);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith('audioshelf-') && key !== SHELL_CACHE && key !== API_CACHE && key !== MEDIA_CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname === '/api/upload') return;   // never intercept an upload
  if (isMedia(url.pathname)) return event.respondWith(mediaFirst(request));
  if (request.mode === 'navigate') return event.respondWith(navigation(request));
  if (url.pathname.startsWith('/api/')) {
    if (API_CACHEABLE.some((pattern) => pattern.test(url.pathname))) {
      return event.respondWith(networkFirst(request));
    }
    return;
  }
  event.respondWith(staleWhileRevalidate(request));
});

async function navigation(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    return (await cache.match('/index.html')) || Response.error();
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}

async function networkFirst(request) {
  const cache = await caches.open(API_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set('x-audioshelf-offline', '1');
      return new Response(cached.body, { status: cached.status, headers });
    }
    return new Response(JSON.stringify({ error: 'You are offline' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
  }
}

/** Downloaded audio wins; otherwise straight to the network (which does its own ranges). */
async function mediaFirst(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const cached = await cache.match(request.url);
  if (cached) return withRange(request, cached);
  try {
    return await fetch(request);
  } catch {
    return new Response('Not available offline', { status: 504 });
  }
}

/**
 * Cache Storage always hands back the whole file, but <audio> asks for byte
 * ranges when it seeks. Slice the cached blob and answer with a real 206.
 */
async function withRange(request, response) {
  const range = request.headers.get('range');
  if (!range) return response;

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) return response;

  const blob = await response.blob();
  const size = blob.size;
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);

  if (start === null) {           // suffix range: last N bytes
    start = Math.max(0, size - (end || 0));
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start >= size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}` },
    });
  }

  const headers = new Headers(response.headers);
  headers.set('content-range', `bytes ${start}-${end}/${size}`);
  headers.set('content-length', String(end - start + 1));
  headers.set('accept-ranges', 'bytes');
  return new Response(blob.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
}
