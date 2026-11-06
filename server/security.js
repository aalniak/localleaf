import crypto from 'node:crypto';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]', '::1'];
const deny = (res, status, error) => res.status(status).json({ success: false, data: null, error });

/**
 * Only accept requests whose Host header names this server (blocks DNS-rebinding
 * attacks). Loopback names are always allowed; `allowedHosts` adds more, and "*"
 * turns the check off (e.g. behind a reverse proxy that validates Host itself).
 */
export function hostAllowList(allowedHosts = []) {
  if (allowedHosts.includes('*')) return (req, res, next) => next();
  const allowed = new Set([...LOOPBACK_HOSTS, ...allowedHosts]);
  return (req, res, next) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (allowed.has(host)) return next();
    return deny(res, 403, 'Host not allowed. Add it to LOCALLEAF_ALLOWED_HOSTS to serve this address.');
  };
}

/**
 * Require a custom header on state-changing requests. Browsers cannot attach it to
 * cross-site form posts without a CORS preflight, which we never approve (CSRF guard).
 */
export function requireApiHeader(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get('x-localleaf') === '1') return next();
  return deny(res, 403, 'Missing X-Localleaf header');
}

const digest = (s) => crypto.createHash('sha256').update(s).digest();
const MAX_TRACKED_CLIENTS = 10000;

/** Password from an "Authorization: Basic …" header (any username), or null. */
function basicPassword(header) {
  const match = /^basic +([A-Za-z0-9+/=]+) *$/i.exec(header ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  return colon === -1 ? null : decoded.slice(colon + 1);
}

/** Per-client failure counter: after `maxFailures` misses, block until the window ends. */
function failureTracker({ maxFailures, windowMs, now }) {
  const clients = new Map();
  const entry = (ip) => {
    const e = clients.get(ip);
    if (e && e.resetAt > now()) return e;
    clients.delete(ip);
    return null;
  };
  return {
    retryAfterSec(ip) {
      const e = entry(ip);
      return e && e.count >= maxFailures ? Math.ceil((e.resetAt - now()) / 1000) : 0;
    },
    fail(ip) {
      if (clients.size >= MAX_TRACKED_CLIENTS) {
        for (const [key, e] of clients) if (e.resetAt <= now()) clients.delete(key);
      }
      const e = entry(ip);
      clients.set(ip, e ? { ...e, count: e.count + 1 } : { count: 1, resetAt: now() + windowMs });
    },
    succeed(ip) {
      clients.delete(ip);
    },
  };
}

/**
 * Optional shared-password protection via HTTP Basic auth (any username).
 * Browsers remember the credentials, so the existing frontend needs no changes.
 * Repeated wrong passwords from one client are throttled (429). Use HTTPS when
 * exposed beyond your machine.
 */
export function passwordGate(password, {
  openPaths = ['/api/health'], maxFailures = 10, windowMs = 15 * 60 * 1000, now = Date.now,
} = {}) {
  if (!password) return (req, res, next) => next();
  const expected = digest(password);
  const failures = failureTracker({ maxFailures, windowMs, now });
  return (req, res, next) => {
    if (openPaths.includes(req.path)) return next();
    const ip = req.ip ?? 'unknown';
    const wait = failures.retryAfterSec(ip);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      return deny(res, 429, 'Too many wrong passwords. Try again later.');
    }
    const supplied = basicPassword(req.get('authorization'));
    if (supplied !== null && crypto.timingSafeEqual(digest(supplied), expected)) {
      failures.succeed(ip);
      return next();
    }
    if (supplied !== null) failures.fail(ip);
    res.set('WWW-Authenticate', 'Basic realm="Localleaf", charset="UTF-8"');
    return deny(res, 401, 'Password required');
  };
}
