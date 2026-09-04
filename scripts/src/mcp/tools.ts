import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { agentDailyLimitBlock } from '../lib/ai-budget.js';
import type { AgentIdentity } from '../lib/agent-identity.js';
import {
  MCP_TOOL_DEFINITIONS,
  assertMcpToolDefinitionsSafe,
  type McpToolDefinition,
} from './definitions.js';
import { AgentRestError } from './rest-client.js';
import type { McpAgentServices } from './services.js';
import { UploadTicketStore } from './upload-tickets.js';

export interface McpExecutionContext {
  agent: AgentIdentity;
  services: McpAgentServices;
  uploadTickets: UploadTicketStore;
  uploadBasePath?: string;
  isDraining?: () => boolean;
}

function successResult(value: unknown) {
  const structuredContent = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { result: value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof AgentRestError) return `REST HTTP ${error.status}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: errorMessage(error) }],
  };
}

function definitionFor(name: string): McpToolDefinition | undefined {
  return MCP_TOOL_DEFINITIONS.find((definition) => definition.name === name);
}

export async function executeMcpTool(
  name: string,
  rawInput: unknown,
  context: McpExecutionContext,
) {
  const definition = definitionFor(name);
  if (!definition) return errorResult(new Error(`Neznámý MCP nástroj ${name}.`));
  try {
    const budgetReason = agentDailyLimitBlock(context.agent.budget);
    if (budgetReason) throw new Error(budgetReason);
    if (definition.kind === 'write' && context.agent.role === 'viewer') {
      throw new Error('Agent s rolí viewer nesmí používat zápisové MCP nástroje.');
    }
    if (definition.kind === 'write' && context.isDraining?.()) {
      throw new Error('Server se připravuje na nasazení; zápisové MCP nástroje jsou dočasně zastavené.');
    }
    const input = definition.inputSchema.parse(rawInput) as any;

    switch (name) {
      case 'zakazka_z_odkazu':
        return successResult(await context.services.findOrCreateTender(input));
      case 'vydej_upload_listek': {
        const ticket = context.uploadTickets.issue(context.agent.id, input.tenderId);
        const basePath = (context.uploadBasePath ?? '/mcp').replace(/\/+$/, '');
        return successResult({
          tenderId: ticket.tenderId,
          uploadUrl: `${basePath}/uploads/${encodeURIComponent(ticket.token)}`,
          method: 'POST',
          contentType: 'multipart/form-data',
          fileField: 'files',
          expiresAt: ticket.expiresAt,
          oneTime: true,
          authorization: 'Použij stejnou hlavičku Authorization: Bearer <VZ_AGENT_KEY>.',
          base64Pouzit: false,
        });
      }
      case 'spust_pipeline':
        return successResult(await context.services.startPipeline(input));
      case 'zjisti_stav_jobu':
        return successResult(await context.services.getJob(input));
      case 'cti_analyzu':
        return successResult(await context.services.readAnalysis(input));
      case 'cti_casti':
        return successResult(await context.services.readParts(input));
      case 'cti_polozky':
        return successResult(await context.services.readItems(input));
      case 'cti_uplnost':
        return successResult(await context.services.readCompleteness(input));
      case 'navrhni_cenu':
        return successResult(await context.services.proposePrice(input, context.agent));
      default:
        return errorResult(new Error(`MCP nástroj ${name} nemá implementaci.`));
    }
  } catch (error) {
    return errorResult(error);
  }
}

/** Vytvoří jednu serverovou instanci pro právě jeden stateless HTTP request. */
export function createAgentMcpServer(context: McpExecutionContext): McpServer {
  assertMcpToolDefinitionsSafe();
  const server = new McpServer({ name: 'vz-agent', version: '1.0.0' });
  for (const definition of MCP_TOOL_DEFINITIONS) {
    // SDK 1.30 používá vlastní vnořený Zod >=3.25, zatímco aplikace má Zod 3.24.
    // Runtime schémata jsou kompatibilní; úzký cast na SDK hranici brání TS2589.
    (server.registerTool as any)(definition.name, {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
      annotations: definition.annotations,
    }, async (input: unknown) => executeMcpTool(definition.name, input, context));
  }
  return server;
}
