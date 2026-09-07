import http from 'node:http';
import { config } from './config.js';
import { migrate, db } from './db.js';
import { matchApi } from './api.js';
import { serveStatic, streamTrack, sendCover } from './files.js';
import { scanLibrary, scanState } from './scanner.js';
import {
  COOKIE, userForToken, requireUser, pruneSessions, userCount,
} from './auth.js';
import { parseCookies, send, HttpError, notFound } from './http.js';

migrate();
pruneSessions();

const isSecure = (req) =>
  config.trustProxy
    ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    : !!req.socket.encrypted;

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE];
  const ctx = {
    req, res, url, token,
    user: userForToken(token),
    secure: isSecure(req),
    params: {},
  };

  // Media endpoints stream files rather than JSON, so they sit outside the API router.
  const media = /^\/api\/(tracks\/(\d+)\/stream|books\/(\d+)\/cover)$/.exec(url.pathname);
  if (media) {
    requireUser(ctx);
    if (media[2]) return streamTrack(req, res, Number(media[2]));
    return sendCover(req, res, Number(media[3]));
  }

  if (url.pathname.startsWith('/api/')) {
    const route = matchApi(req.method, url.pathname);
    if (!route) throw notFound('Unknown endpoint');
    if (route.methodMismatch) throw new HttpError(405, `${req.method} not allowed here`);
    ctx.params = route.params;
    return route.handler(ctx);
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  return serveStatic(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'same-origin');

  Promise.resolve()
    .then(() => handle(req, res))
    .catch((err) => {
      if (res.headersSent) return res.destroy();
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(`[${req.method} ${req.url}]`, err);
      send(res, status, { error: status >= 500 ? 'Internal server error' : err.message });
    })
    .finally(() => {
      if (process.env.AUDIOSHELF_LOG === 'verbose') {
        console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
      }
    });
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(config.port, config.host, () => {
  console.log(`AudioShelf listening on http://${config.host}:${config.port}`);
  console.log(`  library : ${config.libraryDir}`);
  console.log(`  data    : ${config.dataDir}`);
  if (userCount() === 0) console.log('  no users yet — open the app to create the first account');
  if (config.scanOnStart) scanLibrary().then(report);
  if (config.scanIntervalMin > 0) {
    setInterval(() => scanLibrary().then(report), config.scanIntervalMin * 60_000).unref();
  }
});

function report() {
  if (scanState.error) console.warn(`[scan] ${scanState.error}`);
  else console.log(`[scan] ${scanState.found} books · +${scanState.added} added · ~${scanState.updated} updated · -${scanState.removed} removed`);
}

const shutdown = () => {
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
