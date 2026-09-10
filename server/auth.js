import { randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { db } from './db.js';
import { config } from './config.js';
import { HttpError, unauthorized, forbidden, serializeCookie } from './http.js';

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const COOKIE = 'audioshelf_session';

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = scryptSync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N), r: Number(r), p: Number(p),
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

const tokenHash = (token) => createHmac('sha256', config.secret).update(token).digest('hex');

export function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

export function createUser({ username, password, displayName, isAdmin = false }) {
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(name)) {
    throw new HttpError(400, 'Username must be 2-32 characters: letters, numbers, dot, dash or underscore');
  }
  if (String(password || '').length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) {
    throw new HttpError(409, 'That username is taken');
  }
  const info = db.prepare(
    `INSERT INTO users (username, display_name, password_hash, is_admin, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(name, (displayName || name).trim(), hashPassword(password), isAdmin ? 1 : 0, Date.now());
  return getUser(Number(info.lastInsertRowid));
}

export const getUser = (id) =>
  db.prepare('SELECT id, username, display_name, is_admin, created_at FROM users WHERE id = ?').get(id);

export function login(username, password, userAgent) {
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  // Always run a hash comparison so a missing user and a wrong password cost the same.
  const reference = row?.password_hash || hashPassword(randomBytes(12).toString('hex'));
  if (!verifyPassword(String(password || ''), reference) || !row) {
    throw new HttpError(401, 'Wrong username or password');
  }
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)'
  ).run(tokenHash(token), row.id, now, now + config.sessionTtlDays * 86400_000, String(userAgent || '').slice(0, 200));
  return { token, user: getUser(row.id) };
}

export function logout(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

export function userForToken(token) {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.expires_at, u.id, u.username, u.display_name, u.is_admin
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ?`
  ).get(tokenHash(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
    return null;
  }
  return { id: row.id, username: row.username, display_name: row.display_name, is_admin: row.is_admin };
}

export function sessionCookie(token, secure) {
  return serializeCookie(COOKIE, token, {
    maxAge: config.sessionTtlDays * 86400,
    sameSite: 'Lax',
    httpOnly: true,
    secure,
  });
}

export const clearCookie = (secure) =>
  serializeCookie(COOKIE, '', { maxAge: 0, sameSite: 'Lax', httpOnly: true, secure });

export function requireUser(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

export function requireAdmin(ctx) {
  const user = requireUser(ctx);
  if (!user.is_admin) throw forbidden('Administrator access required');
  return user;
}

/**
 * API tokens for scripts and agents. Stored hashed, shown once at creation,
 * and carrying the permissions of the user who made them.
 */
export function createToken(userId, label) {
  const token = `as_${randomBytes(24).toString('base64url')}`;
  db.prepare(
    'INSERT INTO api_tokens (token_hash, user_id, label, created_at) VALUES (?, ?, ?, ?)'
  ).run(tokenHash(token), userId, String(label || 'API token').slice(0, 60), Date.now());
  return token;
}

export function userForApiToken(token) {
  if (!token || !token.startsWith('as_')) return null;
  const row = db.prepare(`
    SELECT t.id, u.id AS user_id, u.username, u.display_name, u.is_admin
    FROM api_tokens t JOIN users u ON u.id = t.user_id
    WHERE t.token_hash = ?
  `).get(tokenHash(token));
  if (!row) return null;
  db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
  return { id: row.user_id, username: row.username, display_name: row.display_name, is_admin: row.is_admin };
}

export const listTokens = (userId) =>
  db.prepare('SELECT id, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC')
    .all(userId);

export const revokeToken = (userId, id) =>
  db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;

export function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

export const publicUser = (user) => user && ({
  id: user.id,
  username: user.username,
  displayName: user.display_name,
  isAdmin: !!user.is_admin,
});

export { createHash };

/** Sign out every session except the one presenting `token`. */
export function logoutOtherSessions(userId, token) {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .run(userId, token ? tokenHash(token) : '');
}
