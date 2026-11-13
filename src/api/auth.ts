import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db.js';
import { logger } from '../logger.js';
import { isSessionValid } from '../repo/backend.js';

export interface AuthUser {
  userId: string;
  role: string;
  jti?: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthUser;
    }
  }
}

const SESSION_CACHE_MS = 60_000;
const sessionCache = new Map<string, { valid: boolean; until: number }>();

async function sessionOk(user: AuthUser): Promise<boolean> {
  if (!config.AUTH_CHECK_SESSION) return true;
  const key = `${user.userId}:${user.jti ?? ''}`;
  const hit = sessionCache.get(key);
  if (hit && hit.until > Date.now()) return hit.valid;
  const valid = await isSessionValid(pool, user.userId, user.jti);
  sessionCache.set(key, { valid, until: Date.now() + SESSION_CACHE_MS });
  if (sessionCache.size > 10_000) {
    const now = Date.now();
    for (const [k, v] of sessionCache) if (v.until <= now) sessionCache.delete(k);
  }
  return valid;
}

/** Verifies the access token issued by tool-samadhan (same JWT_SECRET). */
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, message: 'Missing access token' });

  let payload: jwt.JwtPayload;
  try {
    payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;
  } catch {
    return res.status(401).json({ success: false, message: 'Invalid or expired access token' });
  }

  const userId = payload.userId ?? payload.id ?? payload.sub;
  if (userId === undefined || userId === null || !/^\d+$/.test(String(userId))) {
    return res.status(401).json({ success: false, message: 'Access token has no user id' });
  }
  const user: AuthUser = { userId: String(userId), role: String(payload.role ?? ''), jti: payload.jti };

  try {
    if (!(await sessionOk(user))) return res.status(401).json({ success: false, message: 'Session is no longer valid' });
  } catch (err) {
    logger.error('session check failed', { err });
    return res.status(503).json({ success: false, message: 'Service unavailable' });
  }

  req.auth = user;
  next();
}
