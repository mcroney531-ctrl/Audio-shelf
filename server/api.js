import { db } from './db.js';
import { config } from './config.js';
import { scanLibrary, scanState } from './scanner.js';
import {
  createRouter, send, readJson, HttpError, badRequest, notFound, forbidden,
} from './http.js';
import {
  login, logout, createUser, getUser, userCount, requireUser, requireAdmin,
  sessionCookie, clearCookie, publicUser, hashPassword, verifyPassword, logoutOtherSessions,
} from './auth.js';

const num = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const shapeBook = (row) => ({
  id: row.id,
  title: row.title,
  author: row.author,
  narrator: row.narrator,
  series: row.series,
  seriesIndex: row.series_index,
  year: row.year,
  genre: row.genre,
  description: row.description,
  duration: row.duration,
  trackCount: row.track_count,
  size: row.size,
  hasCover: !!row.cover,
  addedAt: row.added_at,
  progress: row.position === null || row.position === undefined ? null : {
    position: row.position,
    finished: !!row.finished,
    speed: row.speed ?? 1,
    updatedAt: row.progress_updated_at,
  },
});

const BOOK_FIELDS = 'b.*, p.position, p.finished, p.speed, p.updated_at AS progress_updated_at';
const BOOK_FROM = `
  FROM books b
  LEFT JOIN progress p ON p.book_id = b.id AND p.user_id = ?
`;

const SORTS = {
  title: 'b.sort_title ASC',
  author: 'b.author IS NULL, b.author COLLATE NOCASE ASC, b.sort_title ASC',
  added: 'b.added_at DESC',
  duration: 'b.duration DESC',
  recent: 'p.updated_at IS NULL, p.updated_at DESC',
};

function listBooks(userId, query) {
  const where = [];
  const params = [userId];
  const search = String(query.get('q') || '').trim();
  if (search) {
    where.push('(b.title LIKE ? OR b.author LIKE ? OR b.narrator LIKE ? OR b.series LIKE ?)');
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  const filter = query.get('filter');
  if (filter === 'in-progress') where.push('p.position > 0 AND p.finished = 0');
  if (filter === 'finished') where.push('p.finished = 1');
  if (filter === 'unstarted') where.push('(p.position IS NULL OR p.position = 0)');
  const author = query.get('author');
  if (author) { where.push('b.author = ?'); params.push(author); }
  const series = query.get('series');
  if (series) { where.push('b.series = ?'); params.push(series); }

  const order = SORTS[query.get('sort')] || SORTS.title;
  const limit = Math.min(num(query.get('limit'), 500), 1000);
  const offset = num(query.get('offset'), 0);

  const filters = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT ${BOOK_FIELDS} ${BOOK_FROM} ${filters} ORDER BY ${order} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);
  const total = db.prepare(`SELECT COUNT(*) AS n ${BOOK_FROM} ${filters}`).get(...params).n;
  return { books: rows.map(shapeBook), total, limit, offset };
}

function bookDetail(userId, bookId) {
  const row = db.prepare(`SELECT ${BOOK_FIELDS} ${BOOK_FROM} WHERE b.id = ?`).get(userId, bookId);
  if (!row) throw notFound('No such book');
  const tracks = db.prepare(
    'SELECT id, idx, title, duration, start, size, mime FROM tracks WHERE book_id = ? ORDER BY idx'
  ).all(bookId);
  const chapters = db.prepare(
    'SELECT idx, title, start, end FROM chapters WHERE book_id = ? ORDER BY idx'
  ).all(bookId);
  const bookmarks = db.prepare(
    'SELECT id, position, note, created_at AS createdAt FROM bookmarks WHERE user_id = ? AND book_id = ? ORDER BY position'
  ).all(userId, bookId);
  return { ...shapeBook(row), tracks, chapters, bookmarks };
}

function saveProgress(userId, bookId, body) {
  const book = db.prepare('SELECT id, duration FROM books WHERE id = ?').get(bookId);
  if (!book) throw notFound('No such book');
  const position = Math.max(0, Math.min(num(body.position, 0), book.duration || Infinity));
  const finished = body.finished === undefined
    ? (book.duration > 0 && position >= book.duration - 30 ? 1 : 0)
    : (body.finished ? 1 : 0);
  const speed = Math.min(Math.max(num(body.speed, 1), 0.5), 4);
  db.prepare(`
    INSERT INTO progress (user_id, book_id, position, duration, finished, speed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, book_id) DO UPDATE SET
      position = excluded.position, duration = excluded.duration,
      finished = excluded.finished, speed = excluded.speed, updated_at = excluded.updated_at
  `).run(userId, bookId, position, book.duration, finished, speed, Date.now());
  return { position, finished: !!finished, speed, updatedAt: Date.now() };
}

const routes = [
  ['GET', '/api/health', (ctx) => send(ctx.res, 200, { ok: true, books: db.prepare('SELECT COUNT(*) AS n FROM books').get().n })],

  ['GET', '/api/setup', (ctx) => send(ctx.res, 200, { needsSetup: userCount() === 0 })],

  ['POST', '/api/setup', async (ctx) => {
    if (userCount() > 0) throw forbidden('This server is already set up');
    const body = await readJson(ctx.req);
    const user = createUser({ ...body, isAdmin: true });
    const session = login(body.username, body.password, ctx.req.headers['user-agent']);
    send(ctx.res, 201, { user: publicUser(session.user) }, {
      'set-cookie': sessionCookie(session.token, ctx.secure),
    });
  }],

  ['POST', '/api/auth/login', async (ctx) => {
    const body = await readJson(ctx.req);
    const session = login(body.username, body.password, ctx.req.headers['user-agent']);
    send(ctx.res, 200, { user: publicUser(session.user) }, {
      'set-cookie': sessionCookie(session.token, ctx.secure),
    });
  }],

  ['POST', '/api/auth/logout', (ctx) => {
    logout(ctx.token);
    send(ctx.res, 200, { ok: true }, { 'set-cookie': clearCookie(ctx.secure) });
  }],

  ['GET', '/api/me', (ctx) => {
    const user = requireUser(ctx);
    send(ctx.res, 200, {
      user: publicUser(user),
      library: { books: db.prepare('SELECT COUNT(*) AS n FROM books').get().n },
    });
  }],

  ['POST', '/api/me/password', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(String(body.currentPassword || ''), row.password_hash)) {
      throw new HttpError(400, 'Current password is not correct');
    }
    if (String(body.newPassword || '').length < 8) throw badRequest('New password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(body.newPassword), user.id);
    logoutOtherSessions(user.id, ctx.token);
    send(ctx.res, 200, { ok: true });
  }],

  ['GET', '/api/books', (ctx) => {
    const user = requireUser(ctx);
    send(ctx.res, 200, listBooks(user.id, ctx.url.searchParams));
  }],

  ['GET', '/api/books/:id', (ctx) => {
    const user = requireUser(ctx);
    send(ctx.res, 200, bookDetail(user.id, num(ctx.params.id, -1)));
  }],

  ['PUT', '/api/books/:id/progress', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    send(ctx.res, 200, saveProgress(user.id, num(ctx.params.id, -1), body));
  }],

  ['POST', '/api/books/:id/progress', async (ctx) => {
    // sendBeacon-friendly twin of the PUT above.
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    send(ctx.res, 200, saveProgress(user.id, num(ctx.params.id, -1), body));
  }],

  ['GET', '/api/progress', (ctx) => {
    const user = requireUser(ctx);
    const rows = db.prepare(`
      SELECT book_id AS bookId, position, duration, finished, speed, updated_at AS updatedAt
      FROM progress WHERE user_id = ? ORDER BY updated_at DESC
    `).all(user.id);
    send(ctx.res, 200, { progress: rows.map((row) => ({ ...row, finished: !!row.finished })) });
  }],

  ['POST', '/api/books/:id/bookmarks', async (ctx) => {
    const user = requireUser(ctx);
    const body = await readJson(ctx.req);
    const bookId = num(ctx.params.id, -1);
    if (!db.prepare('SELECT 1 FROM books WHERE id = ?').get(bookId)) throw notFound('No such book');
    const info = db.prepare(
      'INSERT INTO bookmarks (user_id, book_id, position, note, created_at) VALUES (?,?,?,?,?)'
    ).run(user.id, bookId, Math.max(0, num(body.position, 0)), String(body.note || '').slice(0, 500), Date.now());
    send(ctx.res, 201, { id: Number(info.lastInsertRowid) });
  }],

  ['DELETE', '/api/bookmarks/:id', (ctx) => {
    const user = requireUser(ctx);
    const info = db.prepare('DELETE FROM bookmarks WHERE id = ? AND user_id = ?').run(num(ctx.params.id, -1), user.id);
    if (!info.changes) throw notFound('No such bookmark');
    send(ctx.res, 200, { ok: true });
  }],

  ['GET', '/api/shelves', (ctx) => {
    const user = requireUser(ctx);
    const continueListening = db.prepare(`SELECT ${BOOK_FIELDS} ${BOOK_FROM}
      WHERE p.position > 0 AND p.finished = 0 ORDER BY p.updated_at DESC LIMIT 12`).all(user.id);
    const recentlyAdded = db.prepare(
      `SELECT ${BOOK_FIELDS} ${BOOK_FROM} ORDER BY b.added_at DESC LIMIT 12`
    ).all(user.id);
    const authors = db.prepare(`
      SELECT author AS name, COUNT(*) AS books FROM books
      WHERE author IS NOT NULL GROUP BY author ORDER BY books DESC, author LIMIT 24
    `).all();
    const series = db.prepare(`
      SELECT series AS name, COUNT(*) AS books FROM books
      WHERE series IS NOT NULL GROUP BY series ORDER BY name LIMIT 24
    `).all();
    send(ctx.res, 200, {
      continueListening: continueListening.map(shapeBook),
      recentlyAdded: recentlyAdded.map(shapeBook),
      authors,
      series,
      totals: {
        books: db.prepare('SELECT COUNT(*) AS n FROM books').get().n,
        duration: db.prepare('SELECT COALESCE(SUM(duration),0) AS d FROM books').get().d,
        finished: db.prepare('SELECT COUNT(*) AS n FROM progress WHERE user_id = ? AND finished = 1').get(user.id).n,
      },
    });
  }],

  ['GET', '/api/admin/status', (ctx) => {
    requireAdmin(ctx);
    send(ctx.res, 200, {
      scan: scanState,
      library: {
        path: config.libraryDir,
        books: db.prepare('SELECT COUNT(*) AS n FROM books').get().n,
        tracks: db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n,
        size: db.prepare('SELECT COALESCE(SUM(size),0) AS s FROM books').get().s,
      },
      users: db.prepare('SELECT id, username, display_name AS displayName, is_admin AS isAdmin, created_at AS createdAt FROM users ORDER BY id').all()
        .map((user) => ({ ...user, isAdmin: !!user.isAdmin })),
    });
  }],

  ['POST', '/api/admin/scan', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx.req).catch(() => ({}));
    if (!scanState.running) scanLibrary({ force: !!body.force });
    send(ctx.res, 202, { scan: scanState });
  }],

  ['POST', '/api/admin/users', async (ctx) => {
    requireAdmin(ctx);
    const body = await readJson(ctx.req);
    send(ctx.res, 201, { user: publicUser(createUser(body)) });
  }],

  ['DELETE', '/api/admin/users/:id', (ctx) => {
    const admin = requireAdmin(ctx);
    const id = num(ctx.params.id, -1);
    if (id === admin.id) throw badRequest('You cannot delete your own account');
    if (!getUser(id)) throw notFound('No such user');
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    send(ctx.res, 200, { ok: true });
  }],
];

export const matchApi = createRouter(routes);
