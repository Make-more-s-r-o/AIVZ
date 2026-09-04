import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticateBearer,
  authenticateBearerIdentity,
  requireJwtBearer,
  signToken,
} from '../src/lib/jwt-auth.js';

test('regrese 6: člověk s JWT se chová stejně — query je odmítnuta a Authorization projde', async (t) => {
  const previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-only-jwt-secret';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousSecret;
  });

  const token = signToken({
    id: 'test-user',
    email: 'test@example.com',
    name: 'Test User',
    role: 'admin',
    createdAt: '2026-07-13T00:00:00.000Z',
    lastLoginAt: null,
  });

  const runRequest = async (authorization?: string, query: Record<string, string> = {}) => {
    let status = 200;
    let body: unknown;
    let nextCalled = false;
    const req = { headers: { authorization }, query } as any;
    const res = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as any;
    await requireJwtBearer(req, res, () => { nextCalled = true; });
    return { status, body, nextCalled, user: req.user };
  };

  const queryResponse = await runRequest(undefined, { token });
  assert.equal(queryResponse.status, 401);
  assert.equal(queryResponse.nextCalled, false);

  const headerResponse = await runRequest(`Bearer ${token}`);
  assert.equal(headerResponse.status, 200);
  assert.equal(headerResponse.nextCalled, true);
  assert.equal(headerResponse.user.sub, 'test-user');
});

test('regrese 7: statický API_TOKEN zůstává podporovaný v Authorization hlavičce', async () => {
  assert.deepEqual(authenticateBearer('Bearer script-token', 'script-token'), {
    authenticated: true,
    payload: null,
  });
  assert.equal(authenticateBearer(undefined, 'script-token').authenticated, false);
  assert.deepEqual(
    await authenticateBearerIdentity('Bearer script-token', 'script-token'),
    {
      authenticated: true,
      identity: { type: 'legacy' },
      agentBudget: null,
      agentKeyAttempted: false,
    },
  );
  assert.equal(
    (await authenticateBearerIdentity('Bearer vza_legacy-test-only', 'vza_legacy-test-only')).authenticated,
    true,
    'existující legacy token se nesmí rozbít ani při kolizi s rezervovaným prefixem',
  );
});

test('regrese 8: ověřený agent projde requireJwt jako vlastní identita, ne jako podvržený uživatel', async () => {
  let status = 200;
  let body: unknown;
  let nextCalled = false;
  const req = {
    headers: {},
    authIdentity: {
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
          day: '2026-07-13', limitCzk: 100, spentCzk: 0, remainingCzk: 100, exhausted: false,
        },
      },
    },
  } as any;
  const res = {
    status(code: number) { status = code; return this; },
    json(value: unknown) { body = value; return this; },
  } as any;

  await requireJwtBearer(req, res, () => { nextCalled = true; });

  assert.equal(status, 200);
  assert.equal(body, undefined);
  assert.equal(nextCalled, true);
  assert.equal(req.user, undefined, 'agent nesmí být vložen do req.user jako člověk');
  assert.equal(req.authIdentity.type, 'agent');
});
