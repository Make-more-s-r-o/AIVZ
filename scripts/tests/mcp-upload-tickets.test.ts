import assert from 'node:assert/strict';
import test from 'node:test';

import {
  UploadTicketError,
  UploadTicketStore,
} from '../src/mcp/upload-tickets.js';

function hasCode(code: UploadTicketError['code']): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(error instanceof UploadTicketError);
    assert.equal(error.code, code);
    return true;
  };
}

test('upload lístek platí jen po nastavené TTL a na hranici expirace zanikne', () => {
  let now = Date.parse('2026-09-04T10:00:00.000Z');
  const store = new UploadTicketStore({
    ttlMs: 1_000,
    now: () => now,
    randomToken: () => 'ttl-ticket',
  });
  const issued = store.issue('agent-a', 'tender-1');

  assert.deepEqual(issued, {
    token: 'ttl-ticket',
    tenderId: 'tender-1',
    expiresAt: '2026-09-04T10:00:01.000Z',
  });
  now += 1_000;
  assert.throws(() => store.consume(issued.token, 'agent-a'), hasCode('expired'));
  assert.throws(() => store.consume(issued.token, 'agent-a'), hasCode('invalid'));
});

test('upload lístek je jednorázový', () => {
  const store = new UploadTicketStore({
    ttlMs: 60_000,
    now: () => Date.parse('2026-09-04T10:00:00.000Z'),
    randomToken: () => 'single-use-ticket',
  });
  const issued = store.issue('agent-a', 'tender-1');

  assert.deepEqual(store.consume(issued.token, 'agent-a'), { tenderId: 'tender-1' });
  assert.throws(() => store.consume(issued.token, 'agent-a'), hasCode('invalid'));
});

test('upload lístek je svázán s agentem a cizí pokus ho nespotřebuje', () => {
  const store = new UploadTicketStore({
    ttlMs: 60_000,
    now: () => Date.parse('2026-09-04T10:00:00.000Z'),
    randomToken: () => 'bound-ticket',
  });
  const issued = store.issue('agent-a', 'tender-1');

  assert.throws(() => store.consume(issued.token, 'agent-b'), hasCode('wrong_agent'));
  assert.deepEqual(store.consume(issued.token, 'agent-a'), { tenderId: 'tender-1' });
  assert.throws(() => store.consume(issued.token, 'agent-a'), hasCode('invalid'));
});
