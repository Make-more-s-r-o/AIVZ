import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import {
  agentForbiddenReason,
  authenticateAgentKey,
  isPotentialAgentKey,
  type AgentBudget,
  type AgentIdentity,
} from './agent-identity.js';
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
 * Autoritativni identita requestu. Agent je zamerne samostatny druh identity;
 * legacy API_TOKEN zustava rozlisitelny a nikdy se nevydava za uzivatele.
 */
export type RequestIdentity =
  | { type: 'user'; payload: JwtPayload }
  | { type: 'agent'; agent: AgentIdentity }
  | { type: 'legacy' };

export type BearerIdentityResult =
  | {
    authenticated: true;
    identity: RequestIdentity;
    agentBudget: AgentBudget | null;
    agentKeyAttempted: boolean;
  }
  | {
    authenticated: false;
    identity: null;
    agentBudget: null;
    agentKeyAttempted: boolean;
  };

type RequestWithIdentity = Request & {
  authIdentity?: RequestIdentity;
  agentBudget?: AgentBudget;
  user?: JwtPayload;
};

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

/**
 * Agent-aware bearer resolver. JWT a legacy chovani deleguje puvodnimu synchronnimu
 * helperu, zatimco agentni klic overuje pri kazdem requestu znovu v databazi.
 */
export async function authenticateBearerIdentity(
  authorization: string | undefined,
  staticApiToken?: string,
): Promise<BearerIdentityResult> {
  const standardAuth = authenticateBearer(authorization, staticApiToken);
  if (standardAuth.authenticated && standardAuth.payload) {
    return {
      authenticated: true,
      identity: { type: 'user', payload: standardAuth.payload },
      agentBudget: null,
      agentKeyAttempted: false,
    };
  }
  if (standardAuth.authenticated) {
    return {
      authenticated: true,
      identity: { type: 'legacy' },
      agentBudget: null,
      agentKeyAttempted: false,
    };
  }

  const rawToken = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  if (isPotentialAgentKey(rawToken)) {
    const agentAuth = await authenticateAgentKey(rawToken);
    if (agentAuth.authenticated) {
      return {
        authenticated: true,
        identity: { type: 'agent', agent: agentAuth.identity },
        agentBudget: agentAuth.budget,
        agentKeyAttempted: true,
      };
    }
    // Rezervovany agentni prefix je fail-closed: neznamy ci revokovany klic
    // nesmi propadnout do dev bypassu ani se zkusit vydavat za legacy token.
    return {
      authenticated: false,
      identity: null,
      agentBudget: null,
      agentKeyAttempted: true,
    };
  }

  return {
    authenticated: false,
    identity: null,
    agentBudget: null,
    agentKeyAttempted: false,
  };
}

export function getRequestIdentity(req: Request): RequestIdentity | undefined {
  return (req as RequestWithIdentity).authIdentity;
}

/** Nastavi serverem overenou identitu; req.user je vyhrazen vyhradne lidskemu JWT. */
export function setRequestIdentity(req: Request, identity: RequestIdentity): void {
  const target = req as RequestWithIdentity;
  target.authIdentity = identity;
  if (identity.type === 'user') {
    target.user = identity.payload;
    delete target.agentBudget;
    return;
  }
  delete target.user;
  if (identity.type === 'agent') target.agentBudget = identity.agent.budget;
  else delete target.agentBudget;
}

/** Globální agentní guard; musí běžet po autentizaci a před budgetem i RBAC. */
export function agentMoneyPathGuard(req: Request, res: Response, next: NextFunction) {
  const identity = getRequestIdentity(req);
  if (identity?.type !== 'agent') return next();
  const reason = agentForbiddenReason(req.method, req.path, req.body);
  if (!reason) return next();
  return res.status(403).json({ error: 'agent_money_path_forbidden', reason });
}

export async function requireJwtBearer(req: Request, res: Response, next: NextFunction) {
  const existingIdentity = getRequestIdentity(req);
  if (existingIdentity?.type === 'user' || existingIdentity?.type === 'agent') {
    return next();
  }
  if (existingIdentity?.type === 'legacy') {
    return res.status(401).json({ error: 'Unauthorized — JWT required' });
  }

  try {
    const bearerAuth = await authenticateBearerIdentity(req.headers.authorization);
    if (bearerAuth.authenticated
      && (bearerAuth.identity.type === 'user' || bearerAuth.identity.type === 'agent')) {
      setRequestIdentity(req, bearerAuth.identity);
      return next();
    }
    if (bearerAuth.agentKeyAttempted) {
      return res.status(401).json({ error: 'Unauthorized — invalid or revoked agent key' });
    }
  } catch {
    return res.status(503).json({
      error: 'authentication_unavailable',
      reason: 'Overeni agentni identity je docasne nedostupne.',
    });
  }
  return res.status(401).json({ error: 'Unauthorized — JWT required' });
}
