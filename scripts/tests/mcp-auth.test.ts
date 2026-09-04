import assert from 'node:assert/strict';
import test from 'node:test';

import type { AgentIdentity } from '../src/lib/agent-identity.js';
import type { BearerIdentityResult } from '../src/lib/jwt-auth.js';
import {
  authenticateMcpAgent,
  McpHttpError,
  type McpAuthenticator,
} from '../src/mcp/server.js';

const TEST_AUTHORIZATION = 'Bearer vza_test-only-never-use';

const activeAgent: AgentIdentity = {
  type: 'agent',
  kind: 'agent',
  sub: 'agent:agent-mcp-test',
  id: 'agent-mcp-test',
  agentId: 'agent-mcp-test',
  name: 'MCP test agent',
  purpose: 'Ověření autentizace MCP',
  role: 'analytik',
  budget: {
    day: '2026-09-04',
    limitCzk: 1_000,
    spentCzk: 100,
    remainingCzk: 900,
    exhausted: false,
  },
};

function expectMcpHttpError(status: 401 | 429 | 503, code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof McpHttpError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  };
}

test('sabotáž 1: MCP ověřuje agentní klíč při každém requestu a revokaci uplatní okamžitě', async () => {
  let revoked = false;
  let calls = 0;
  const authenticate: McpAuthenticator = async (authorization) => {
    calls += 1;
    assert.equal(authorization, TEST_AUTHORIZATION);
    if (revoked) {
      return {
        authenticated: false,
        identity: null,
        agentBudget: null,
        agentKeyAttempted: true,
      };
    }
    return {
      authenticated: true,
      identity: { type: 'agent', agent: activeAgent },
      agentBudget: activeAgent.budget,
      agentKeyAttempted: true,
    };
  };

  assert.equal(await authenticateMcpAgent(TEST_AUTHORIZATION, authenticate), activeAgent);
  revoked = true;
  await assert.rejects(
    authenticateMcpAgent(TEST_AUTHORIZATION, authenticate),
    expectMcpHttpError(401, 'unauthorized'),
  );
  assert.equal(calls, 2, 'výsledek autentizace se nesmí cachovat mezi MCP requesty');
});

test('MCP odmítá lidské JWT i legacy API token, přestože jsou platné pro REST', async () => {
  const nonAgentResults: BearerIdentityResult[] = [
    {
      authenticated: true,
      identity: {
        type: 'user',
        payload: {
          sub: 'user-1',
          email: 'user@example.test',
          name: 'Test User',
        },
      },
      agentBudget: null,
      agentKeyAttempted: false,
    },
    {
      authenticated: true,
      identity: { type: 'legacy' },
      agentBudget: null,
      agentKeyAttempted: false,
    },
  ];

  for (const result of nonAgentResults) {
    await assert.rejects(
      authenticateMcpAgent(TEST_AUTHORIZATION, async () => result),
      expectMcpHttpError(401, 'unauthorized'),
    );
  }
});

test('výpadek ověřovače se fail-closed mapuje na MCP HTTP 503 bez úniku interní chyby', async () => {
  const internalMessage = 'database password appeared in an internal exception';

  await assert.rejects(
    authenticateMcpAgent(TEST_AUTHORIZATION, async () => {
      throw new Error(internalMessage);
    }),
    (error: unknown) => {
      assert.ok(expectMcpHttpError(503, 'authentication_unavailable')(error));
      assert.doesNotMatch((error as Error).message, new RegExp(internalMessage));
      return true;
    },
  );
});
