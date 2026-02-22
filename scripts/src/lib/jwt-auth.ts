import jwt from 'jsonwebtoken';
import type { SafeUser } from './user-store.js';

const JWT_EXPIRY = '7d';

// Read lazily so dotenv has time to load in serve-api.ts
function getSecret(): string | undefined {
  return process.env.JWT_SECRET;
}

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
}

export function isJwtEnabled(): boolean {
  return !!getSecret();
}

export function signToken(user: SafeUser): string {
  const secret = getSecret();
  if (!secret) {
    throw new Error('JWT_SECRET not configured');
  }
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
  };
  return jwt.sign(payload, secret, { expiresIn: JWT_EXPIRY });
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
