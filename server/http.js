/** Small helpers over node:http — just enough to avoid pulling in a framework. */

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || undefined;
  }
}

export const badRequest = (msg) => new HttpError(400, msg || 'Bad request');
export const unauthorized = (msg) => new HttpError(401, msg || 'Not signed in');
export const forbidden = (msg) => new HttpError(403, msg || 'Not allowed');
export const notFound = (msg) => new HttpError(404, msg || 'Not found');

export function send(res, status, body, headers = {}) {
  const payload = body === undefined || body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export async function readJson(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw badRequest('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('Invalid JSON body');
  }
}

export function parseCookies(header = '') {
  const out = Object.create(null);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) bits.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  bits.push(`Path=${opts.path || '/'}`);
  bits.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.httpOnly !== false) bits.push('HttpOnly');
  if (opts.secure) bits.push('Secure');
  return bits.join('; ');
}

/**
 * Routes are declared as `['GET', '/api/books/:id', handler]`. Matching is a
 * plain segment walk — no regex compilation, no dependency, no surprises.
 */
export function createRouter(routes) {
  const compiled = routes.map(([method, pattern, handler]) => ({
    method,
    segments: pattern.split('/').filter(Boolean),
    handler,
  }));

  return function match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const route of compiled) {
      if (route.segments.length !== parts.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      if (route.method !== method && !(route.method === 'GET' && method === 'HEAD')) {
        methodMismatch = true;
        continue;
      }
      return { handler: route.handler, params };
    }
    return methodMismatch ? { methodMismatch: true } : null;
  };
}
