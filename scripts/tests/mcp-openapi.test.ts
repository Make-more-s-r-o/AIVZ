import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AGENT_FORBIDDEN_TARGET_STATES,
  agentForbiddenReason,
} from '../src/lib/agent-identity.js';
import {
  AGENT_REST_OPERATIONS,
  assertAgentRestOperationsSafe,
} from '../src/mcp/definitions.js';
import {
  generateAgentOpenApi,
  serializeAgentOpenApi,
} from '../src/mcp/openapi.js';

const OPENAPI_PATH = new URL('../../docs/agent/openapi.json', import.meta.url);
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;

interface DocumentedOperation {
  method: string;
  path: string;
  operationId: string;
  security?: unknown;
}

function documentedOperations(document: any): DocumentedOperation[] {
  return Object.entries(document.paths as Record<string, Record<string, any>>)
    .flatMap(([path, pathItem]) => HTTP_METHODS.flatMap((method) => {
      const operation = pathItem[method];
      return operation ? [{
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId,
        security: operation.security,
      }] : [];
    }))
    .sort((left, right) => `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`));
}

function declaredOperations(): DocumentedOperation[] {
  return Object.entries(AGENT_REST_OPERATIONS)
    .map(([operationId, operation]) => ({
      method: operation.method,
      path: operation.path,
      operationId,
      security: [{ AgentBearer: [] }],
    }))
    .sort((left, right) => `${left.path} ${left.method}`.localeCompare(`${right.path} ${right.method}`));
}

test('generovaný OpenAPI dokument je byte-for-byte synchronní s docs/agent/openapi.json', async () => {
  const committed = await readFile(OPENAPI_PATH, 'utf8');
  assert.equal(serializeAgentOpenApi(), committed);
});

test('OpenAPI používá Bearer auth a obsahuje právě deklarované agentní REST operace', () => {
  const document = generateAgentOpenApi() as any;
  const serialized = serializeAgentOpenApi();

  assert.equal(document.openapi, '3.0.3');
  assert.doesNotMatch(serialized, /"const"\s*:/, 'OpenAPI 3.0 Schema Object nesmí obsahovat draft-7 const');
  const bearer = document.components.securitySchemes.AgentBearer;
  assert.equal(bearer.type, 'http');
  assert.equal(bearer.scheme, 'bearer');
  assert.equal(bearer.bearerFormat, 'VZ agent key');
  assert.deepEqual(documentedOperations(document), declaredOperations());
  for (const operation of documentedOperations(document)) {
    assert.deepEqual(operation.security, [{ AgentBearer: [] }], `${operation.method} ${operation.path}`);
  }
});

test('OpenAPI registr neobsahuje money-path cesty ani zakázané cílové stavy', () => {
  const document = generateAgentOpenApi() as any;
  const serialized = serializeAgentOpenApi();

  assert.doesNotThrow(() => assertAgentRestOperationsSafe());
  for (const operation of documentedOperations(document)) {
    const policyPath = operation.path.replace(/\{[^}]+\}/g, 'policy-probe');
    assert.equal(agentForbiddenReason(operation.method, policyPath), null);
    for (const status of AGENT_FORBIDDEN_TARGET_STATES) {
      assert.equal(
        agentForbiddenReason(operation.method, policyPath, { status }),
        null,
        `${operation.method} ${operation.path} nesmí povolit stav ${status}`,
      );
    }
  }
  for (const status of AGENT_FORBIDDEN_TARGET_STATES) {
    assert.equal(serialized.includes(`\"${status}\"`), false, `OpenAPI nesmí deklarovat stav ${status}`);
  }

  assert.throws(
    () => assertAgentRestOperationsSafe({
      forbiddenFinalize: { method: 'POST', path: '/api/tenders/{id}/finalize' },
    }),
    /money-path/,
  );
  assert.throws(
    () => assertAgentRestOperationsSafe({
      forbiddenStatus: { method: 'PATCH', path: '/api/tenders/{id}/status' },
    }),
    /money-path/,
  );
});
