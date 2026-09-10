import http from 'node:http';
import { config } from './config.js';
import { migrate, db } from './db.js';
import { matchApi } from './api.js';
import { serveStatic, streamTrack, sendCover } from './files.js';
import { scanLibrary, scanState } from './scanner.js';
import { watchLibrary } from './watcher.js';
import {
  COOKIE, userForToken, userForApiToken, requireUser, requireAdmin, pruneSessions, userCount,
} from './auth.js';
import { parseCookies, send, HttpError, notFound, clientErrorReply } from './http.js';
import { receiveUpload } from './upload.js';

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
  // Browsers send the session cookie; scripts and agents send a bearer token.
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '')?.[1];
  const ctx = {
    req, res, url, token,
    user: userForToken(token) || (bearer ? userForApiToken(bearer) : null),
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

  if (url.pathname === '/api/upload' && req.method === 'POST') {
    requireAdmin(ctx);
    const result = await receiveUpload(req, {
      name: url.searchParams.get('name') || req.headers['x-file-name'],
      folder: url.searchParams.get('folder') || req.headers['x-file-folder'],
    });
    return send(res, 201, { file: result });
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
  if (socket.destroyed || !socket.writable) return;
  const reply = clientErrorReply(err);
  if (reply) socket.end(reply);
  else socket.destroy();
});

server.listen(config.port, config.host, () => {
  console.log(`AudioShelf listening on http://${config.host}:${config.port}`);
  console.log(`  library : ${config.libraryDir}`);
  console.log(`  data    : ${config.dataDir}`);
  if (userCount() === 0) console.log('  no users yet — open the app to create the first account');
  if (config.scanOnStart) scanLibrary().then(report);
  if (config.watch) watcher = watchLibrary();
  if (config.scanIntervalMin > 0) {
    setInterval(() => scanLibrary().then(report), config.scanIntervalMin * 60_000).unref();
  }
});

function report() {
  if (scanState.error) console.warn(`[scan] ${scanState.error}`);
  else console.log(`[scan] ${scanState.found} books · +${scanState.added} added · ~${scanState.updated} updated · -${scanState.removed} removed`);
}

let watcher = null;

const shutdown = () => {
  watcher?.close();
  server.close(() => {
    try { db.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
