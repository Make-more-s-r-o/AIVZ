import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import type { SafeUser, UserRole } from './user-store.js';

// Read lazily so dotenv has time to load in serve-api.ts
function getSecret(): string | undefined {
  return process.env.JWT_SECRET;
}

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role?: UserRole;
}

export function isJwtEnabled(): boolean {
  return !!getSecret();
}

export function signToken(user: SafeUser, rememberMe?: boolean): string {
  const secret = getSecret();
  if (!secret) {
    throw new Error('JWT_SECRET not configured');
  }
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
  };
  const expiresIn = rememberMe ? '30d' : '12h';
  return jwt.sign(payload, secret, { expiresIn });
}

export function verifyToken(token: string): JwtPayload | null {
  const secret = getSecret();
  if (!secret) return null;
  try {
    const decoded = jwt.verify(token, secret) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}

export type BearerAuthResult =
  | { authenticated: true; payload: JwtPayload | null }
  | { authenticated: false; payload: null };

/**
 * Authenticate only credentials carried in the Authorization header.
 * Query-string tokens are intentionally not accepted because URLs are commonly logged.
 */
export function authenticateBearer(
  authorization: string | undefined,
  staticApiToken?: string,
): BearerAuthResult {
  if (!authorization?.startsWith('Bearer ')) {
    return { authenticated: false, payload: null };
  }

  const token = authorization.slice(7);
  const payload = verifyToken(token);
  if (payload) return { authenticated: true, payload };
  if (staticApiToken && token === staticApiToken) {
    return { authenticated: true, payload: null };
  }
  return { authenticated: false, payload: null };
}

export function requireJwtBearer(req: Request, res: Response, next: NextFunction) {
  const bearerAuth = authenticateBearer(req.headers.authorization);
  if (bearerAuth.authenticated && bearerAuth.payload) {
    (req as any).user = bearerAuth.payload;
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized — JWT required' });
}
