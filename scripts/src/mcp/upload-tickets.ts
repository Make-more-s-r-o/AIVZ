import { randomBytes } from 'node:crypto';

export const DEFAULT_UPLOAD_TICKET_TTL_MS = 5 * 60 * 1000;
export const MAX_ACTIVE_UPLOAD_TICKETS = 1_000;

interface UploadTicket {
  agentId: string;
  tenderId: string;
  expiresAtMs: number;
}

export interface IssuedUploadTicket {
  token: string;
  tenderId: string;
  expiresAt: string;
}

export class UploadTicketError extends Error {
  constructor(readonly code: 'invalid' | 'expired' | 'wrong_agent' | 'capacity') {
    super({
      invalid: 'Upload lístek neexistuje nebo už byl použit.',
      expired: 'Upload lístek vypršel; vyžádej nový.',
      wrong_agent: 'Upload lístek patří jiné agentní identitě.',
      capacity: 'Server má příliš mnoho aktivních upload lístků.',
    }[code]);
  }
}

export interface UploadTicketStoreOptions {
  ttlMs?: number;
  now?: () => number;
  randomToken?: () => string;
}

/** Krátkodobé lístky jsou pouze v paměti, jednorázové a svázané s agentním DB id. */
export class UploadTicketStore {
  private readonly tickets = new Map<string, UploadTicket>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly randomToken: () => string;

  constructor(options: UploadTicketStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_UPLOAD_TICKET_TTL_MS;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 15 * 60 * 1000) {
      throw new Error('Neplatná životnost upload lístku.');
    }
    this.now = options.now ?? Date.now;
    this.randomToken = options.randomToken ?? (() => randomBytes(24).toString('base64url'));
  }

  issue(agentId: string, tenderId: string): IssuedUploadTicket {
    const now = this.now();
    this.removeExpired(now);
    if (this.tickets.size >= MAX_ACTIVE_UPLOAD_TICKETS) throw new UploadTicketError('capacity');
    let token = this.randomToken();
    while (!token || this.tickets.has(token)) token = this.randomToken();
    const expiresAtMs = now + this.ttlMs;
    this.tickets.set(token, { agentId, tenderId, expiresAtMs });
    return { token, tenderId, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  consume(token: string, agentId: string): { tenderId: string } {
    const ticket = this.tickets.get(token);
    if (!ticket) throw new UploadTicketError('invalid');
    if (ticket.expiresAtMs <= this.now()) {
      this.tickets.delete(token);
      throw new UploadTicketError('expired');
    }
    if (ticket.agentId !== agentId) throw new UploadTicketError('wrong_agent');
    this.tickets.delete(token);
    return { tenderId: ticket.tenderId };
  }

  private removeExpired(now: number): void {
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAtMs <= now) this.tickets.delete(token);
    }
  }
}
