import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AGENT_FORBIDDEN_ROUTES,
  AGENT_FORBIDDEN_TARGET_STATES,
  auditActorForIdentity,
  authenticateAgentKey,
  hashAgentKey,
  isAgentForbiddenRoute,
  isPotentialAgentKey,
} from '../src/lib/agent-identity.js';
import {
  agentMoneyPathGuard,
  authenticateBearerIdentity,
  setRequestIdentity,
  signToken,
  type RequestIdentity,
} from '../src/lib/jwt-auth.js';

// Záměrně neplatný testovací vzor. Není generovaný a nesmí být použit jako ostrý klíč.
const TEST_ONLY_KEY = 'vza_obviously-invalid-test-only';
const NOW = new Date('2026-07-13T10:00:00.000Z');

function activeAgentRow() {
  return {
    id: 'agent-test-1',
    name: 'Testovací robot',
    purpose: 'Pouze automatické testy',
    role: 'analytik',
    daily_limit_czk: '100',
    spent_czk: '25',
  };
}

test('sabotáž 5: ověření hledá pouze hash klíče a nikdy neposílá otevřený klíč do DB', async () => {
  assert.equal(isPotentialAgentKey(TEST_ONLY_KEY), true);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const result = await authenticateAgentKey(TEST_ONLY_KEY, {
    now: NOW,
    queryFn: async (sql, params = []) => {
      calls.push({ sql, params });
      return { rows: [activeAgentRow()] };
    },
  });

  assert.equal(result.authenticated, true);
  if (!result.authenticated) assert.fail('testovací agent měl být ověřen');
  assert.equal(result.identity.id, 'agent-test-1');
  assert.equal(result.identity.sub, 'agent:agent-test-1');
  assert.deepEqual(result.identity.budget, {
    day: '2026-07-13',
    limitCzk: 100,
    spentCzk: 25,
    remainingCzk: 75,
    exhausted: false,
  });
  assert.deepEqual(result.budget, result.identity.budget);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.params[0], hashAgentKey(TEST_ONLY_KEY));
  assert.equal(calls[0]!.params.includes(TEST_ONLY_KEY), false, 'plaintext klíč nesmí být SQL parametr');
  assert.doesNotMatch(calls[0]!.sql, /plain(?:text)?_?key/i);
  assert.match(String(calls[0]!.params[0]), /^[a-f0-9]{64}$/);
});

test('sabotáž 1: revokace platí okamžitě a stejné ověření znovu čte DB', async () => {
  let revoked = false;
  let queryCount = 0;
  const queryFn = async (sql: string) => {
    queryCount += 1;
    // Fake DB respektuje stav revokace jen tehdy, když produkční dotaz skutečně
    // obsahuje fail-closed filtr. Sabotáž odstraněním filtru tak vrátí řádek a test zčervená.
    const filtersRevoked = /revoked_at\s+IS\s+NULL/i.test(sql);
    return { rows: revoked && filtersRevoked ? [] : [activeAgentRow()] };
  };

  const before = await authenticateAgentKey(TEST_ONLY_KEY, { now: NOW, queryFn });
  revoked = true;
  const after = await authenticateAgentKey(TEST_ONLY_KEY, { now: NOW, queryFn });

  assert.equal(before.authenticated, true);
  assert.deepEqual(after, { authenticated: false, identity: null, budget: null });
  assert.equal(queryCount, 2, 'výsledek ověření se nesmí cachovat přes další request');
});

test('sabotáž 3: audit aktéra používá autoritativní agentní principal, nikdy klientské jméno', async () => {
  const identity = {
    type: 'agent',
    kind: 'agent',
    sub: 'agent:agent-test-1',
    agentId: 'agent-test-1',
    name: 'Testovací robot',
    purpose: 'Pouze automatické testy',
    role: 'analytik',
    actor: 'podvrzeny-clovek-z-requestu',
  };

  assert.equal(auditActorForIdentity(identity), 'agent:agent-test-1');
  assert.notEqual(auditActorForIdentity(identity), null);
  assert.notEqual(auditActorForIdentity(identity), identity.actor);

  const source = await readFile(new URL('../src/serve-api.ts', import.meta.url), 'utf-8');
  const routeStart = source.indexOf("app.post('/api/monitoring/:id/prevzit'");
  const routeEnd = source.indexOf("app.post('/api/monitoring/:id/ignorovat'", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, 'monitoring převzetí musí být v API zapojené');
  const route = source.slice(routeStart, routeEnd);
  assert.match(route, /const auditActor = auditActorForRequest\(req\)/);
  assert.match(route, /const actor = auditActor\.id/);
  assert.match(route, /actor_type:\s*auditActor\.type/);
  assert.match(route, /actor_name:\s*auditActor\.name/);
});

test('sabotáž 2: jediný centrální výčet blokuje všechny explicitní money-path cesty', async () => {
  assert.ok(Array.isArray(AGENT_FORBIDDEN_ROUTES));
  assert.ok(AGENT_FORBIDDEN_ROUTES.length > 0, 'centrální výčet nesmí být prázdný');
  assert.equal(Object.isFrozen(AGENT_FORBIDDEN_ROUTES), true);
  assert.equal(Object.isFrozen(AGENT_FORBIDDEN_TARGET_STATES), true);
  assert.deepEqual([...AGENT_FORBIDDEN_TARGET_STATES], [
    'odeslana', 'vyhodnocena', 'vyhrano', 'prohrano', 'nepodano',
  ]);

  const forbidden: Array<[method: string, path: string]> = [
    ['PUT', '/api/tenders/t-1/product-match/price'],
    ['PUT', '/api/tenders/t-1/product-match/price/bulk'],
    ['PUT', '/api/tenders/t-1/product-match/price/4'],
    ['POST', '/api/tenders/t-1/finalize'],
    ['POST', '/api/inbox/bulk-finalize'],
    ['POST', '/api/inbox/bulk/finalize'],
    ['POST', '/api/tenders/t-1/podano'],
    ['POST', '/api/tenders/t-1/balik/potvrdit'],
    ['POST', '/api/tenders/t-1/balik/prevzit-uplnost'],
    ['POST', '/api/tenders/t-1/balik/zamitnout-pozadavek'],
    ['POST', '/api/tenders/t-1/kvalifikace/vyjimka'],
    ['DELETE', '/api/tenders/t-1'],
    ['POST', '/api/tenders/t-1/purge'],
  ];

  for (const [method, path] of forbidden) {
    assert.equal(isAgentForbiddenRoute(method, path), true, `${method} ${path} musí vrátit 403`);
  }
  assert.equal(
    isAgentForbiddenRoute('post', '/api/tenders/t-1/finalize/?from=test'),
    true,
    'matcher musí být case-insensitive pro metodu a ignorovat query/trailing slash',
  );
  assert.equal(
    isAgentForbiddenRoute('patch', '/api/tenders/t-1/status/?from=test', { status: 'odeslana' }),
    true,
    'podmíněný PATCH matcher musí číst cílový stav z body',
  );

  const source = await readFile(new URL('../src/serve-api.ts', import.meta.url), 'utf-8');
  assert.match(
    source,
    /app\.use\(agentMoneyPathGuard\)/,
    'centrální matcher musí být zapojen do globálního middleware',
  );
  const middlewareSource = await readFile(new URL('../src/lib/jwt-auth.ts', import.meta.url), 'utf-8');
  assert.match(middlewareSource, /error:\s*'agent_money_path_forbidden'/);
});

test('regrese 8: agent smí monitoring převzít, nahrát dokumenty a spustit či obnovit pipeline', () => {
  const allowed: Array<[method: string, path: string]> = [
    ['GET', '/api/tenders/t-1'],
    ['POST', '/api/monitoring/feed-1/prevzit'],
    ['POST', '/api/tenders/upload'],
    ['POST', '/api/tenders/upload-url'],
    ['POST', '/api/tenders/t-1/attachments'],
    ['POST', '/api/tenders/t-1/run/all'],
    ['POST', '/api/tenders/t-1/run/analyze'],
    ['POST', '/api/tenders/t-1/run-all/resume'],
  ];

  for (const [method, path] of allowed) {
    assert.equal(isAgentForbiddenRoute(method, path), false, `${method} ${path} musí být agentovi dovoleno`);
  }
});

const TEST_AGENT_IDENTITY: RequestIdentity = {
  type: 'agent',
  agent: {
    type: 'agent',
    kind: 'agent',
    sub: 'agent:agent-test-1',
    id: 'agent-test-1',
    agentId: 'agent-test-1',
    name: 'Testovací robot',
    purpose: 'Pouze automatické testy',
    role: 'analytik',
    budget: {
      day: '2026-07-13',
      limitCzk: 100,
      spentCzk: 0,
      remainingCzk: 100,
      exhausted: false,
    },
  },
};

type PolicyAuth =
  | { identity: RequestIdentity }
  | { authorization: string; staticApiToken?: string };

interface PolicyResponse {
  status: number;
  body: Record<string, unknown> | null;
  nextCalled: boolean;
}

async function requestThroughAgentMoneyPathGuard(
  auth: PolicyAuth,
  method: 'PATCH' | 'POST',
  path: string,
  body: Record<string, unknown>,
): Promise<PolicyResponse> {
  const req = {
    method,
    path,
    body,
    headers: { authorization: 'authorization' in auth ? auth.authorization : undefined },
  } as any;
  if ('identity' in auth) {
    setRequestIdentity(req, auth.identity);
  } else {
    const result = await authenticateBearerIdentity(auth.authorization, auth.staticApiToken);
    assert.equal(result.authenticated, true, 'testovací credential musí být ověřený');
    if (!result.authenticated) assert.fail('testovací credential nebyl ověřen');
    setRequestIdentity(req, result.identity);
  }

  let status = 200;
  let responseBody: Record<string, unknown> | null = null;
  let nextCalled = false;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: Record<string, unknown>) { responseBody = value; return this; },
  } as any;
  agentMoneyPathGuard(req, res, () => { nextCalled = true; });
  return { status, body: responseBody, nextCalled };
}

test('E4 sabotáž 1: agent přes middleware nesmí PATCH /status na odeslana', async () => {
  const response = await requestThroughAgentMoneyPathGuard(
    { identity: TEST_AGENT_IDENTITY },
    'PATCH',
    '/api/tenders/t-1/status',
    { status: 'odeslana' },
  );

  assert.equal(response.status, 403);
  assert.equal(response.nextCalled, false);
  assert.equal(response.body?.error, 'agent_money_path_forbidden');
  assert.match(String(response.body?.reason), /odeslana/);
});

test('E4 sabotáž 2: agent přes middleware nesmí PATCH /status na nepodano', async () => {
  const response = await requestThroughAgentMoneyPathGuard(
    { identity: TEST_AGENT_IDENTITY },
    'PATCH',
    '/api/tenders/t-1/status',
    { status: 'nepodano', reason: 'Testovací důvod' },
  );

  assert.equal(response.status, 403);
  assert.equal(response.nextCalled, false);
  assert.equal(response.body?.error, 'agent_money_path_forbidden');
  assert.match(String(response.body?.reason), /nepodano/);
});

test('E4 sabotáž 3: agent přes middleware nesmí zamítnout požadavek balíku', async () => {
  const response = await requestThroughAgentMoneyPathGuard(
    { identity: TEST_AGENT_IDENTITY },
    'POST',
    '/api/tenders/t-1/balik/zamitnout-pozadavek',
    { klic: 'test-only-key', duvod: 'Testovací důvod' },
  );

  assert.equal(response.status, 403);
  assert.equal(response.nextCalled, false);
  assert.equal(response.body?.error, 'agent_money_path_forbidden');
  assert.ok(String(response.body?.reason).length > 0);
});

test('E4 regrese 4: agent přes middleware smí na analyzovana i ocenena', async () => {
  for (const status of ['analyzovana', 'ocenena']) {
    const response = await requestThroughAgentMoneyPathGuard(
      { identity: TEST_AGENT_IDENTITY },
      'PATCH',
      '/api/tenders/t-1/status',
      { status },
    );
    assert.equal(response.nextCalled, true, `agent musí smět přejít na ${status}`);
    assert.equal(response.status, 200);
  }
});

test('E4 regrese 5: člověk ověřený JWT smí přes middleware na odeslana i nepodano', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-only-e4-jwt-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });
  const token = signToken({
    id: 'e4-test-user',
    email: 'e4-test@example.com',
    name: 'E4 Test User',
    role: 'admin',
    createdAt: '2026-07-13T00:00:00.000Z',
    lastLoginAt: null,
  });

  for (const status of ['odeslana', 'nepodano']) {
    const response = await requestThroughAgentMoneyPathGuard(
      { authorization: `Bearer ${token}` },
      'PATCH',
      '/api/tenders/t-1/status',
      { status, reason: status === 'nepodano' ? 'Testovací důvod' : undefined },
    );
    assert.equal(response.nextCalled, true, `člověk s JWT musí smět přejít na ${status}`);
    assert.equal(response.status, 200);
  }
});

test('E4 regrese 6: legacy API_TOKEN přes middleware zůstává beze změny', async () => {
  const legacyToken = 'vza_legacy-test-only';
  for (const status of ['odeslana', 'nepodano']) {
    const response = await requestThroughAgentMoneyPathGuard(
      { authorization: `Bearer ${legacyToken}`, staticApiToken: legacyToken },
      'PATCH',
      '/api/tenders/t-1/status',
      { status, reason: status === 'nepodano' ? 'Testovací důvod' : undefined },
    );
    assert.equal(response.nextCalled, true, `legacy API_TOKEN musí smět přejít na ${status}`);
    assert.equal(response.status, 200);
  }
});
