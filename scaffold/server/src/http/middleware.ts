import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { loadSession, roleIn, type Session } from '../auth/sessions.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session?: Session;
      workspace?: string;
      role?: 'admin' | 'agent';
    }
  }
}

export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export const requireSession: RequestHandler = wrap(async (req, res, next) => {
  const s = await loadSession(req);
  if (!s) return res.status(401).json({ error: 'not signed in' });
  req.session = s;
  next();
});

// Workspace comes from ?workspace= or the JSON body. 403 for a non-member.
export const requireMember: RequestHandler = (req, res, next) => {
  const ws = (typeof req.query.workspace === 'string' && req.query.workspace) || (req.body && typeof req.body.workspace === 'string' && req.body.workspace) || null;
  if (!ws) return res.status(400).json({ error: 'workspace is required' });
  const role = req.session ? roleIn(req.session, ws) : null;
  if (!role) return res.status(403).json({ error: 'not a member of this workspace' });
  req.workspace = ws;
  req.role = role;
  next();
};

export const requireGraderToken: RequestHandler = (req, res, next) => {
  const got = Buffer.from(String(req.headers['x-grader-token'] ?? ''));
  const want = Buffer.from(config.graderToken);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return res.status(401).json({ error: 'bad grader token' });
  next();
};
