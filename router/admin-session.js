const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const COOKIE = 'electric_sea_admin';
const LIFETIME = 30 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');

function createAdmin(env = process.env, now = Date.now) {
  const sessions = new Map();
  let attempts = 0, windowStart = now();
  function cookie(req) {
    return (req.headers.cookie || '').split(';').map(s => s.trim())
      .find(s => s.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || '';
  }
  function authenticated(req) {
    for (const [key, session] of sessions) {
      if (session.expires <= now() || session.password !== digest(env.ELECTRIC_SEA_ADMIN_PASSWORD || '')) sessions.delete(key);
    }
    return Boolean(env.ELECTRIC_SEA_ADMIN_PASSWORD && sessions.has(digest(cookie(req))));
  }
  function sameOrigin(req, res, next) {
    // Custom header prevents cross-site simple requests, even without Origin.
    if (req.get('X-Electric-Sea-Admin') !== '1') return res.status(403).json({ detail: 'Same-origin admin request required' });
    if (req.get('Origin')) {
      try {
        if (new URL(req.get('Origin')).host !== req.get('Host')) throw new Error();
      } catch { return res.status(403).json({ detail: 'Same-origin admin request required' }); }
    }
    next();
  }
  function requireAdmin(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!authenticated(req)) return res.status(401).json({ detail: 'Admin unlock required' });
    sameOrigin(req, res, next);
  }
  const options = req => ({ httpOnly: true, secure: req.secure, sameSite: 'strict', path: '/', maxAge: LIFETIME });
  function install(app) {
    app.get('/api/admin/status', (req, res) => res.set('Cache-Control', 'no-store').json({ authenticated: authenticated(req) }));
    app.post('/api/admin/login', sameOrigin, (req, res) => {
      res.set('Cache-Control', 'no-store');
      const expected = env.ELECTRIC_SEA_ADMIN_PASSWORD;
      if (!expected) return res.status(503).json({ detail: 'Administrator password is not configured' });
      if (now() - windowStart >= 60000) { attempts = 0; windowStart = now(); }
      if (++attempts > 10) return res.status(429).json({ detail: 'Too many attempts; try again in a minute' });
      const supplied = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!timingSafeEqual(Buffer.from(digest(expected)), Buffer.from(digest(supplied)))) {
        return res.status(401).json({ detail: 'Incorrect administrator password' });
      }
      authenticated(req); // prune expired sessions
      sessions.delete(digest(cookie(req)));
      while (sessions.size >= 8) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('hex');
      sessions.set(digest(token), { expires: now() + LIFETIME, password: digest(expected) });
      res.cookie(COOKIE, token, options(req)).json({ authenticated: true });
    });
    app.post('/api/admin/logout', sameOrigin, (req, res) => {
      sessions.delete(digest(cookie(req)));
      res.clearCookie(COOKIE, { ...options(req), maxAge: undefined }).set('Cache-Control', 'no-store').json({ authenticated: false });
    });
  }
  return { install, requireAdmin };
}

module.exports = { createAdmin };
