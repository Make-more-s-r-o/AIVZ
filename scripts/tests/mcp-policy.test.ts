import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_FORBIDDEN_TARGET_STATES,
  agentForbiddenReason,
} from '../src/lib/agent-identity.js';
import {
  AGENT_REST_OPERATIONS,
  MCP_TOOL_DEFINITIONS,
  assertMcpToolDefinitionsSafe,
  type McpToolDefinition,
} from '../src/mcp/definitions.js';

const EXPECTED_TOOLS = [
  ['zakazka_z_odkazu', 'write'],
  ['vydej_upload_listek', 'write'],
  ['spust_pipeline', 'write'],
  ['zjisti_stav_jobu', 'read'],
  ['cti_analyzu', 'read'],
  ['cti_casti', 'read'],
  ['cti_polozky', 'read'],
  ['cti_uplnost', 'read'],
  ['navrhni_cenu', 'write'],
] as const;

function materializePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, 'policy-test');
}

test('sabotáž 2: MCP zveřejní jen devět bezpečných nástrojů a odmítne fake finalize definici', () => {
  assert.deepEqual(
    MCP_TOOL_DEFINITIONS.map(({ name, kind }) => [name, kind]),
    EXPECTED_TOOLS,
    'allowlist MCP nástrojů nebo jejich read/write klasifikace se změnila',
  );

  for (const definition of MCP_TOOL_DEFINITIONS) {
    assert.ok(definition.title.trim().length > 0, `${definition.name} musí mít title`);
    assert.ok(definition.description.trim().length >= 40, `${definition.name} musí mít užitečný popis`);
    assert.equal(
      definition.annotations.readOnlyHint,
      definition.kind === 'read',
      `${definition.name} musí anotací odpovídat read/write klasifikaci`,
    );
    assert.equal(definition.annotations.destructiveHint, false);

    for (const operationId of definition.restOperations) {
      const operation = AGENT_REST_OPERATIONS[operationId];
      const path = materializePath(operation.path);
      assert.equal(
        agentForbiddenReason(operation.method, path),
        null,
        `${definition.name} nesmí obalit zakázanou REST cestu ${operation.method} ${path}`,
      );
      for (const status of AGENT_FORBIDDEN_TARGET_STATES) {
        assert.equal(
          agentForbiddenReason(operation.method, path, { status }),
          null,
          `${definition.name} nesmí obalit zakázaný přechod do stavu ${status}`,
        );
      }
    }
  }
  assert.doesNotThrow(() => assertMcpToolDefinitionsSafe());

  const testOperationId = '__test_forbidden_finalize';
  const mutableOperations = AGENT_REST_OPERATIONS as unknown as Record<
    string,
    { method: string; path: string; summary: string }
  >;
  mutableOperations[testOperationId] = {
    method: 'POST',
    path: '/api/tenders/{id}/finalize',
    summary: 'Pouze sabotážní test zakázané operace.',
  };
  const fakeFinalizeDefinition = {
    name: 'fake_finalize',
    title: 'Zakázané dokončení',
    description: 'Záměrně nebezpečná testovací definice pro ověření fail-closed policy.',
    kind: 'write',
    inputSchema: MCP_TOOL_DEFINITIONS[0]!.inputSchema,
    restOperations: [testOperationId],
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  } as unknown as McpToolDefinition;

  try {
    assert.throws(
      () => assertMcpToolDefinitionsSafe([...MCP_TOOL_DEFINITIONS, fakeFinalizeDefinition]),
      /obchází money-path/,
    );
  } finally {
    delete mutableOperations[testOperationId];
  }
});
