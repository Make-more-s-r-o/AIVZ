import jwt from 'jsonwebtoken';
import type { SafeUser } from './user-store.js';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = '7d';

export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
}

export function isJwtEnabled(): boolean {
  return !!JWT_SECRET;
}

export function signToken(user: SafeUser): string {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET not configured');
  }
  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    name: user.name,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

export function verifyToken(token: string): JwtPayload | null {
  if (!JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as JwtPayload;
    return decoded;
  } catch {
    return null;
  }
}
