import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticateBearer, requireJwtBearer, signToken } from '../src/lib/jwt-auth.js';

test('JWT v query stringu je odmítnut, JWT v Authorization hlavičce projde', async (t) => {
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

  const runRequest = (authorization?: string, query: Record<string, string> = {}) => {
    let status = 200;
    let body: unknown;
    let nextCalled = false;
    const req = { headers: { authorization }, query } as any;
    const res = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; return this; },
    } as any;
    requireJwtBearer(req, res, () => { nextCalled = true; });
    return { status, body, nextCalled, user: req.user };
  };

  const queryResponse = runRequest(undefined, { token });
  assert.equal(queryResponse.status, 401);
  assert.equal(queryResponse.nextCalled, false);

  const headerResponse = runRequest(`Bearer ${token}`);
  assert.equal(headerResponse.status, 200);
  assert.equal(headerResponse.nextCalled, true);
  assert.equal(headerResponse.user.sub, 'test-user');
});

test('statický API_TOKEN zůstává podporovaný v Authorization hlavičce', () => {
  assert.deepEqual(authenticateBearer('Bearer script-token', 'script-token'), {
    authenticated: true,
    payload: null,
  });
  assert.equal(authenticateBearer(undefined, 'script-token').authenticated, false);
});
