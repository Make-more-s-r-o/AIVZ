import { writeFile } from 'node:fs/promises';
import type { PathLike } from 'node:fs';

import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import type { AnyObjectSchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';

import { AGENT_REST_OPERATIONS, MCP_TOOL_DEFINITIONS } from './definitions.js';

type JsonSchema = Record<string, any>;

function normalizeOpenApi30Schema(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeOpenApi30Schema);
  if (!value || typeof value !== 'object') return value;
  const normalized: Record<string, any> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'const') normalized.enum = [normalizeOpenApi30Schema(child)];
    else normalized[key] = normalizeOpenApi30Schema(child);
  }
  return normalized;
}

function schemaFor(value: unknown): JsonSchema {
  const schema = toJsonSchemaCompat(value as AnyObjectSchema, { target: 'draft-7' }) as JsonSchema;
  delete schema.$schema;
  return normalizeOpenApi30Schema(schema);
}

function parameterSchemas(schema: unknown, location: 'path' | 'query'): JsonSchema[] {
  const objectSchema = schemaFor(schema);
  const properties = objectSchema.properties ?? {};
  const required = new Set<string>(objectSchema.required ?? []);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    required: location === 'path' || required.has(name),
    schema: property,
  }));
}

function errorResponses(): Record<string, unknown> {
  return {
    '400': { description: 'Neplatný vstup.' },
    '401': { description: 'Chybějící, neplatný nebo odvolaný credential.' },
    '403': { description: 'Operace není pro danou identitu povolena.' },
    '404': { description: 'Zakázka, job nebo artefakt nebyl nalezen.' },
    '409': { description: 'Konflikt se stavem zakázky nebo běžícím jobem.' },
    '429': { description: 'Agent vyčerpal denní limit.' },
    '503': { description: 'Závislost nebo řízení provozu není dostupné.' },
  };
}

/** OpenAPI vzniká přímo z registru, který používá runtime REST adapter MCP. */
export function generateAgentOpenApi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [operationId, rawOperation] of Object.entries(AGENT_REST_OPERATIONS)) {
    const operation = rawOperation as typeof rawOperation & {
      pathSchema?: unknown;
      querySchema?: unknown;
      bodySchema?: unknown;
      multipartSchema?: unknown;
      multipartBinaryFields?: readonly string[];
    };
    const parameters = [
      ...(operation.pathSchema ? parameterSchemas(operation.pathSchema, 'path') : []),
      ...(operation.querySchema ? parameterSchemas(operation.querySchema, 'query') : []),
    ];
    const method = operation.method.toLowerCase();
    const entry: Record<string, unknown> = {
      operationId,
      summary: operation.summary,
      tags: ['Agentní cesta'],
      security: [{ AgentBearer: [] }],
      ...(parameters.length > 0 ? { parameters } : {}),
      responses: {
        '200': {
          description: 'Úspěšná odpověď existující REST cesty.',
          content: { 'application/json': { schema: {} } },
        },
        ...errorResponses(),
      },
    };
    if (operation.bodySchema) {
      entry.requestBody = {
        required: true,
        content: { 'application/json': { schema: schemaFor(operation.bodySchema) } },
      };
    } else if (operation.multipartSchema) {
      const multipart = schemaFor(operation.multipartSchema);
      for (const field of operation.multipartBinaryFields ?? []) {
        const property = multipart.properties?.[field];
        if (property?.items) property.items.format = 'binary';
      }
      entry.requestBody = {
        required: true,
        content: { 'multipart/form-data': { schema: multipart } },
      };
    }
    paths[operation.path] ??= {};
    paths[operation.path][method] = entry;
  }

  return {
    openapi: '3.0.3',
    info: {
      title: 'VZ agentní REST cesta',
      version: '1.0.0',
      description: 'Vedlejší OpenAPI popis REST operací, které obaluje primární MCP rozhraní. Cenový návrh je záměrně MCP-only omezená operace a lidské money-path endpointy zde nejsou.',
    },
    servers: [{ url: '/' }],
    paths,
    components: {
      securitySchemes: {
        AgentBearer: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'VZ agent key',
          description: 'Agentní klíč s prefixem vza_; server uchovává pouze jeho hash a ověřuje revokaci při každém requestu.',
        },
      },
    },
    'x-generated-from': 'scripts/src/mcp/definitions.ts',
    'x-mcp-tools': MCP_TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      type: tool.kind,
      wraps: tool.restOperations,
      ...(tool.localEffect ? { localEffect: tool.localEffect } : {}),
    })),
  };
}

export function serializeAgentOpenApi(): string {
  return `${JSON.stringify(generateAgentOpenApi(), null, 2)}\n`;
}

export function writeAgentOpenApi(path: PathLike): Promise<void> {
  return writeFile(path, serializeAgentOpenApi(), 'utf8');
}
