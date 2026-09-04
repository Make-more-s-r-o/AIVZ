import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { query } from './db.js';
import type { StageKey } from './stage-machine.js';

export const AGENT_KEY_PREFIX = 'vza_';
export const AGENT_ROLES = ['analytik', 'viewer'] as const;
export type AgentRole = (typeof AGENT_ROLES)[number];

export interface AgentQueryResult {
  rows: any[];
  rowCount?: number | null;
}

export type AgentQueryFn = (
  sql: string,
  params?: unknown[],
) => Promise<AgentQueryResult>;

export interface AgentStoreOptions {
  queryFn?: AgentQueryFn;
  now?: Date | (() => Date);
}

export interface AgentKeyInfo {
  id: string;
  name: string;
  purpose: string;
  role: AgentRole;
  dailyLimitCzk: number;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface AgentBudget {
  day: string;
  limitCzk: number;
  spentCzk: number;
  remainingCzk: number;
  exhausted: boolean;
}

export interface AgentIdentity {
  type: 'agent';
  kind: 'agent';
  sub: string;
  id: string;
  agentId: string;
  name: string;
  purpose: string;
  role: AgentRole;
  budget: AgentBudget;
}

export interface AgentAccess {
  identity: AgentIdentity;
  budget: AgentBudget;
}

export type AgentAuthResult =
  | { authenticated: true; identity: AgentIdentity; budget: AgentBudget }
  | { authenticated: false; identity: null; budget: null };

export interface CreateAgentKeyInput {
  name: string;
  purpose: string;
  role?: AgentRole;
  dailyLimitCzk: number;
}

export interface CreateAgentKeyOptions extends AgentStoreOptions {
  randomBytesFn?: (size: number) => Buffer;
  randomUuidFn?: () => string;
}

export interface CreatedAgentKey {
  agent: AgentKeyInfo;
  /** Zobrazuje se pouze jako bezprostredni vysledek create; v DB ani list API neni. */
  key: string;
}

export interface RecordAgentSpendInput {
  agentKeyId: string;
  chargeId: string;
  day: string;
  amountCzk: number;
}

export interface AgentForbiddenRoute {
  method: 'DELETE' | 'PATCH' | 'POST' | 'PUT';
  path: string;
  forbiddenTargetStates?: readonly AgentForbiddenTargetState[];
}

/** Stavy podání a výsledku jsou pro agentní identitu vždy lidské rozhodnutí. */
export const AGENT_FORBIDDEN_TARGET_STATES = Object.freeze([
  'odeslana',
  'vyhodnocena',
  'vyhrano',
  'prohrano',
  'nepodano',
] as const satisfies readonly StageKey[]);
export type AgentForbiddenTargetState = (typeof AGENT_FORBIDDEN_TARGET_STATES)[number];

/** Jediný autoritativní výčet money-path pravidel, na které agent nesmí. */
export const AGENT_FORBIDDEN_ROUTES: readonly AgentForbiddenRoute[] = Object.freeze([
  { method: 'PUT', path: '/api/tenders/:id/product-match/price' },
  { method: 'PUT', path: '/api/tenders/:id/product-match/price/bulk' },
  { method: 'PUT', path: '/api/tenders/:id/product-match/price/:itemIndex' },
  {
    method: 'PATCH',
    path: '/api/tenders/:id/status',
    forbiddenTargetStates: AGENT_FORBIDDEN_TARGET_STATES,
  },
  { method: 'POST', path: '/api/tenders/:id/finalize' },
  { method: 'POST', path: '/api/inbox/bulk-finalize' },
  { method: 'POST', path: '/api/inbox/bulk/finalize' },
  { method: 'POST', path: '/api/tenders/:id/podano' },
  { method: 'POST', path: '/api/tenders/:id/balik/potvrdit' },
  { method: 'POST', path: '/api/tenders/:id/balik/prevzit-uplnost' },
  { method: 'POST', path: '/api/tenders/:id/balik/zamitnout-pozadavek' },
  { method: 'POST', path: '/api/tenders/:id/kvalifikace/vyjimka' },
  { method: 'DELETE', path: '/api/tenders/:id' },
  { method: 'POST', path: '/api/tenders/:id/purge' },
]);

const KEY_COLUMNS = `id, name, purpose, role,
  daily_limit_czk::float8 AS daily_limit_czk,
  created_at, last_used_at, revoked_at`;

function defaultQueryFn(sql: string, params?: unknown[]): Promise<AgentQueryResult> {
  return query(sql, params);
}

function queryFn(options: AgentStoreOptions): AgentQueryFn {
  return options.queryFn ?? defaultQueryFn;
}

function currentTime(options: AgentStoreOptions): Date {
  const value = typeof options.now === 'function' ? options.now() : (options.now ?? new Date());
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error('invalid_now');
  return value;
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function assertDay(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('invalid_spend_day');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error('invalid_spend_day');
  }
  return value;
}

function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field}_required`);
  return normalized;
}

function requireMoney(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`invalid_${field}`);
  return value;
}

function numberFromDb(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`invalid_${field}_in_database`);
  return parsed;
}

function timestampFromDb(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return String(value);
}

function roleFromDb(value: unknown): AgentRole {
  if (value === 'analytik' || value === 'viewer') return value;
  throw new Error('invalid_agent_role_in_database');
}

function keyInfoFromRow(row: any): AgentKeyInfo {
  return {
    id: String(row.id),
    name: String(row.name),
    purpose: String(row.purpose),
    role: roleFromDb(row.role),
    dailyLimitCzk: numberFromDb(row.daily_limit_czk, 'daily_limit_czk'),
    createdAt: timestampFromDb(row.created_at) ?? '',
    lastUsedAt: timestampFromDb(row.last_used_at),
    revokedAt: timestampFromDb(row.revoked_at),
  };
}

function identityFromRow(row: any, budget: AgentBudget): AgentIdentity {
  const agentId = String(row.id);
  return {
    type: 'agent',
    kind: 'agent',
    sub: `agent:${agentId}`,
    id: agentId,
    agentId,
    name: String(row.name),
    purpose: String(row.purpose),
    role: roleFromDb(row.role),
    budget,
  };
}

function budgetFromRow(row: any, day: string): AgentBudget {
  const limitCzk = numberFromDb(row.daily_limit_czk, 'daily_limit_czk');
  const spentCzk = numberFromDb(row.spent_czk ?? 0, 'spent_czk');
  return {
    day,
    limitCzk,
    spentCzk,
    remainingCzk: Math.max(0, limitCzk - spentCzk),
    exhausted: spentCzk >= limitCzk,
  };
}

function accessFromRow(row: any, day: string): AgentAccess {
  const budget = budgetFromRow(row, day);
  return { identity: identityFromRow(row, budget), budget };
}

/** SHA-256 je vhodny pro CLI-generovany nahodny 256bit klic a umoznuje indexovany lookup. */
export function hashAgentKey(rawKey: string): string {
  return createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

/** Pouze rozliseni bearer typu; plnou autoritu vzdy urci az hash lookup v DB. */
export function isPotentialAgentKey(value: unknown): value is string {
  return typeof value === 'string'
    && value.startsWith(AGENT_KEY_PREFIX)
    && value.length > AGENT_KEY_PREFIX.length
    && value.length <= 256;
}

export async function createAgentKey(
  input: CreateAgentKeyInput,
  options: CreateAgentKeyOptions = {},
): Promise<CreatedAgentKey> {
  const name = requireNonBlank(input.name, 'name');
  const purpose = requireNonBlank(input.purpose, 'purpose');
  const role = input.role ?? 'analytik';
  if (!AGENT_ROLES.includes(role)) throw new Error('invalid_agent_role');
  const dailyLimitCzk = requireMoney(input.dailyLimitCzk, 'daily_limit_czk');

  const id = `a_${(options.randomUuidFn ?? randomUUID)()}`;
  const secret = (options.randomBytesFn ?? randomBytes)(32).toString('base64url');
  const rawKey = `${AGENT_KEY_PREFIX}${secret}`;
  const keyHash = hashAgentKey(rawKey);
  const result = await queryFn(options)(
    `INSERT INTO agent_api_keys (id, name, purpose, key_hash, role, daily_limit_czk)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${KEY_COLUMNS}`,
    [id, name, purpose, keyHash, role, dailyLimitCzk],
  );
  const row = result.rows[0];
  if (!row) throw new Error('agent_key_create_failed');
  return { agent: keyInfoFromRow(row), key: rawKey };
}

export async function listAgentKeys(options: AgentStoreOptions = {}): Promise<Array<AgentKeyInfo & { budget: AgentBudget }>> {
  const day = utcDay(currentTime(options));
  const result = await queryFn(options)(
    `SELECT ${KEY_COLUMNS},
       COALESCE((
         SELECT SUM(s.amount_czk)::float8 FROM agent_ai_spend s
         WHERE s.agent_key_id = k.id AND s.spent_on = $1::date
       ), 0)::float8 AS spent_czk
     FROM agent_api_keys k
     ORDER BY k.created_at ASC, k.id ASC`,
    [day],
  );
  return result.rows.map((row) => ({ ...keyInfoFromRow(row), budget: budgetFromRow(row, day) }));
}

export async function revokeAgentKey(id: string, options: AgentStoreOptions = {}): Promise<boolean> {
  const normalizedId = requireNonBlank(id, 'agent_id');
  const result = await queryFn(options)(
    `UPDATE agent_api_keys SET revoked_at = $2::timestamptz
     WHERE id = $1 AND revoked_at IS NULL
     RETURNING id`,
    [normalizedId, currentTime(options).toISOString()],
  );
  return result.rows.length > 0;
}

export async function setAgentDailyLimit(
  id: string,
  dailyLimitCzk: number,
  options: AgentStoreOptions = {},
): Promise<AgentKeyInfo | null> {
  const normalizedId = requireNonBlank(id, 'agent_id');
  const limit = requireMoney(dailyLimitCzk, 'daily_limit_czk');
  const result = await queryFn(options)(
    `UPDATE agent_api_keys SET daily_limit_czk = $2
     WHERE id = $1
     RETURNING ${KEY_COLUMNS}`,
    [normalizedId, limit],
  );
  return result.rows[0] ? keyInfoFromRow(result.rows[0]) : null;
}

export async function authenticateAgentKey(
  rawKey: string,
  options: AgentStoreOptions = {},
): Promise<AgentAuthResult> {
  if (!isPotentialAgentKey(rawKey)) {
    return { authenticated: false, identity: null, budget: null };
  }
  const now = currentTime(options);
  const day = utcDay(now);
  const keyHash = hashAgentKey(rawKey);
  const result = await queryFn(options)(
    `WITH authenticated AS (
       UPDATE agent_api_keys
       SET last_used_at = $2::timestamptz
       WHERE key_hash = $1 AND revoked_at IS NULL
       RETURNING id, name, purpose, role, daily_limit_czk
     )
     SELECT a.*,
       COALESCE((
         SELECT SUM(s.amount_czk)::float8 FROM agent_ai_spend s
         WHERE s.agent_key_id = a.id AND s.spent_on = $3::date
       ), 0)::float8 AS spent_czk
     FROM authenticated a`,
    [keyHash, now.toISOString(), day],
  );
  const row = result.rows[0];
  if (!row) return { authenticated: false, identity: null, budget: null };
  const access = accessFromRow(row, day);
  return { authenticated: true, ...access };
}

/** Aktualni aktivni agent; pouzitelne pro okamzity refresh role/revokace za behu. */
export async function getAgentAccessById(
  id: string,
  options: AgentStoreOptions = {},
): Promise<AgentAccess | null> {
  if (!id.trim()) return null;
  const day = utcDay(currentTime(options));
  const result = await queryFn(options)(
    `SELECT k.id, k.name, k.purpose, k.role, k.daily_limit_czk::float8 AS daily_limit_czk,
       COALESCE((
         SELECT SUM(s.amount_czk)::float8 FROM agent_ai_spend s
         WHERE s.agent_key_id = k.id AND s.spent_on = $2::date
       ), 0)::float8 AS spent_czk
     FROM agent_api_keys k
     WHERE k.id = $1 AND k.revoked_at IS NULL`,
    [id.trim(), day],
  );
  return result.rows[0] ? accessFromRow(result.rows[0], day) : null;
}

export async function getAgentBudget(
  id: string,
  options: AgentStoreOptions = {},
): Promise<AgentBudget | null> {
  const access = await getAgentAccessById(id, options);
  return access?.budget ?? null;
}

export async function getTotalAgentSpend(
  day?: string,
  options: AgentStoreOptions = {},
): Promise<number> {
  const targetDay = day ? assertDay(day) : utcDay(currentTime(options));
  const result = await queryFn(options)(
    `SELECT COALESCE(SUM(amount_czk), 0)::float8 AS total_czk
     FROM agent_ai_spend WHERE spent_on = $1::date`,
    [targetDay],
  );
  return numberFromDb(result.rows[0]?.total_czk ?? 0, 'total_agent_spend');
}

/** Append-only a idempotentni: stejny charge_id se podruhe nezauctuje. */
export async function recordAgentSpend(
  input: RecordAgentSpendInput,
  options: AgentStoreOptions = {},
): Promise<boolean> {
  const agentKeyId = requireNonBlank(input.agentKeyId, 'agent_id');
  const chargeId = requireNonBlank(input.chargeId, 'charge_id');
  const day = assertDay(input.day);
  const amountCzk = requireMoney(input.amountCzk, 'amount_czk');
  const result = await queryFn(options)(
    `INSERT INTO agent_ai_spend (charge_id, agent_key_id, spent_on, amount_czk)
     VALUES ($1, $2, $3::date, $4)
     ON CONFLICT (charge_id) DO NOTHING
     RETURNING charge_id`,
    [chargeId, agentKeyId, day, amountCzk],
  );
  return result.rows.length > 0;
}

/** Actor se odvozuje vyhradne z jiz overene request identity, nikdy z request body. */
export function auditActorForIdentity(identity: unknown): string | null {
  if (!identity || typeof identity !== 'object') return null;
  const value = identity as Record<string, unknown>;
  if (value.type === 'agent' || value.kind === 'agent') {
    if (typeof value.agentId === 'string' && value.agentId.trim()) return `agent:${value.agentId.trim()}`;
    if (typeof value.sub === 'string' && value.sub.startsWith('agent:')) return value.sub;
    return null;
  }
  return typeof value.sub === 'string' && value.sub.trim() ? value.sub.trim() : null;
}

function normalizedPath(path: string): string {
  const withoutQuery = path.split(/[?#]/, 1)[0] || '/';
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
}

function pathMatches(pattern: string, actualPath: string): boolean {
  const expected = normalizedPath(pattern).split('/');
  const actual = normalizedPath(actualPath).split('/');
  return expected.length === actual.length && expected.every((segment, index) => (
    segment.startsWith(':') ? actual[index].length > 0 : segment === actual[index]
  ));
}

function requestTargetState(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const target = (body as Record<string, unknown>).status;
  return typeof target === 'string' ? target : undefined;
}

/** Vrátí důvod pouze tehdy, kdy celý request odpovídá deklarovanému zákazu. */
export function agentForbiddenReason(method: string, path: string, body?: unknown): string | null {
  const normalizedMethod = method.toUpperCase();
  const route = AGENT_FORBIDDEN_ROUTES.find((candidate) => (
    candidate.method === normalizedMethod && pathMatches(candidate.path, path)
  ));
  if (!route) return null;
  if (!route.forbiddenTargetStates) {
    return 'Agentní identita nesmí provádět finanční, schvalovací ani destruktivní akce zakázky.';
  }
  const target = requestTargetState(body);
  if (!target || !route.forbiddenTargetStates.includes(target as AgentForbiddenTargetState)) {
    return null;
  }
  return `Agentní identita nesmí změnit stav zakázky na stav podání nebo výsledku „${target}“.`;
}

export function isAgentForbiddenRoute(method: string, path: string, body?: unknown): boolean {
  return agentForbiddenReason(method, path, body) !== null;
}
