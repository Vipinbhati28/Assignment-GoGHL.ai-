import { Router } from 'express';
import { config } from '../config.js';
import { finishLogin, startLogin } from '../auth/oidc.js';
import { createSession, destroySession, saveLogin, sessionCookie, sessionIdFrom, takeLogin } from '../auth/sessions.js';
import { requireSession, wrap } from './middleware.js';

export const auth = Router();

auth.get(
  '/auth/login',
  wrap(async (_req, res) => {
    const login = await startLogin();
    await saveLogin(login.state, { verifier: login.verifier, nonce: login.nonce });
    res.redirect(302, login.url);
  }),
);

auth.get(
  '/auth/callback',
  wrap(async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) return res.status(400).send('missing code or state');
    const pending = await takeLogin(state);
    if (!pending) return res.status(400).send('login expired or already used; start again at /auth/login');
    let identity;
    try {
      identity = await finishLogin(code, pending.verifier, pending.nonce);
    } catch (e) {
      console.error('[auth] login failed', e);
      return res.status(401).send('login failed');
    }
    const sid = await createSession(identity);
    res.setHeader('set-cookie', sessionCookie(sid));
    res.redirect(302, `${config.webOrigin}/`);
  }),
);

auth.post(
  '/auth/logout',
  wrap(async (req, res) => {
    const sid = sessionIdFrom(req);
    if (sid) await destroySession(sid);
    res.setHeader('set-cookie', sessionCookie('', 0));
    res.status(204).end();
  }),
);

auth.get('/api/me', requireSession, (req, res) => {
  const s = req.session!;
  res.json({ sub: s.sub, name: s.name, email: s.email, workspaces: s.workspaces.map((w) => ({ id: w.id, role: w.role })) });
});
