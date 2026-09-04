import { z } from 'zod';

import {
  AGENT_FORBIDDEN_TARGET_STATES,
  agentForbiddenReason,
} from '../lib/agent-identity.js';
import { isConcreteProductUrl } from '../lib/types.js';

export type McpToolKind = 'read' | 'write';
export type AgentRestOperationId = keyof typeof AGENT_REST_OPERATIONS;

const httpUrl = z.string().trim().url().refine((value) => {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}, 'URL musí používat HTTP(S)');

export const concreteProductUrlSchema = httpUrl.refine(
  (value) => isConcreteProductUrl(value),
  'Doklad ceny musí odkazovat na konkrétní produktovou stránku, ne na vyhledávání',
);

export const tenderIdSchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'Neplatné ID zakázky')
  .refine((value) => !value.includes('..'), 'Neplatné ID zakázky');

export const jobIdSchema = z.string().trim().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'Neplatné ID jobu')
  .refine((value) => !value.includes('..'), 'Neplatné ID jobu');

const pathTenderId = z.object({ id: tenderIdSchema }).strict();
const pathFeedId = z.object({ id: z.string().trim().regex(/^\d+$/, 'Neplatné ID feedu') }).strict();
const pathJobId = z.object({ jobId: jobIdSchema }).strict();

export const priceProposalInputSchema = z.object({
  tenderId: tenderIdSchema,
  itemIndex: z.number().int().nonnegative().optional()
    .describe('Pozice v polozky_match; vynech jen u legacy jednopoložkové zakázky'),
  nakupniCenaBezDph: z.number().finite().nonnegative(),
  nabidkovaCenaBezDph: z.number().finite().nonnegative(),
  sazbaDph: z.number().finite().min(0).max(100).default(21),
  zdrojUrl: concreteProductUrlSchema
    .describe('Konkrétní produktová stránka, nikdy výsledky vyhledávání'),
  zjistenoAt: z.string().datetime({ offset: true })
    .describe('Datum a čas zjištění ceny v ISO 8601 s časovou zónou'),
  dodavatel: z.string().trim().min(1).max(200).optional(),
  poznamka: z.string().trim().max(1000).optional(),
}).strict();

/**
 * Jediný strojově čitelný popis REST operací, které MCP smí obalit. Runtime klient
 * z něj skládá metodu/cestu a stejný registr generuje docs/agent/openapi.json.
 */
export const AGENT_REST_OPERATIONS = {
  monitoringSync: {
    method: 'POST',
    path: '/api/monitoring/sync',
    summary: 'Synchronizuje monitoring podporovaného zdroje.',
    bodySchema: z.object({
      zdroj: z.enum(['nen', 'hlidac']),
      q: z.string().trim().min(1),
    }).strict(),
  },
  monitoringFeed: {
    method: 'GET',
    path: '/api/monitoring/feed',
    summary: 'Vrátí monitoring feed pro dohledání zakázky podle zdrojového odkazu.',
    querySchema: z.object({
      stav: z.enum(['nova', 'prevzata', 'ignorovana']),
      vse: z.literal('1'),
      meta: z.literal('1'),
    }).strict(),
  },
  takeMonitoringTender: {
    method: 'POST',
    path: '/api/monitoring/{id}/prevzit',
    summary: 'Založí zakázku z monitoring feedu a stáhne její dokumentaci.',
    pathSchema: pathFeedId,
    bodySchema: z.object({
      stahnout_zd: z.literal(true),
      spustit: z.literal(false),
    }).strict(),
  },
  uploadTenderFromUrl: {
    method: 'POST',
    path: '/api/tenders/upload-url',
    summary: 'Založí zakázku stažením dokumentu z přímé HTTP(S) URL.',
    bodySchema: z.object({
      urls: z.array(httpUrl).min(1),
      tenderId: tenderIdSchema.optional(),
      metadata: z.record(z.unknown()).optional(),
    }).strict(),
  },
  uploadTenderFiles: {
    method: 'POST',
    path: '/api/tenders/{id}/upload',
    summary: 'Nahraje dokumenty do existující zakázky přes multipart/form-data.',
    pathSchema: pathTenderId,
    multipartSchema: z.object({
      files: z.array(z.string().describe('Binární soubor v multipart poli files')).min(1).max(20),
    }).strict(),
    multipartBinaryFields: ['files'],
  },
  runPipeline: {
    method: 'POST',
    path: '/api/tenders/{id}/run/all',
    summary: 'Zařadí celý pipeline zakázky; před generováním čeká na lidské potvrzení cen.',
    pathSchema: pathTenderId,
  },
  getJob: {
    method: 'GET',
    path: '/api/jobs/{jobId}',
    summary: 'Vrátí stav, logy a úplnost jednoho pipeline jobu.',
    pathSchema: pathJobId,
    querySchema: z.object({ since: z.string().regex(/^\d+$/).optional() }).strict(),
  },
  listJobs: {
    method: 'GET',
    path: '/api/jobs',
    summary: 'Vrátí joby zakázky pro bezpečnou kontrolu souběhu.',
    querySchema: z.object({ tenderId: tenderIdSchema }).strict(),
  },
  getTenderStatus: {
    method: 'GET',
    path: '/api/tenders/{id}/status',
    summary: 'Vrátí stav pipeline a kontrakt úplnosti zakázky.',
    pathSchema: pathTenderId,
  },
  getTenderAnalysis: {
    method: 'GET',
    path: '/api/tenders/{id}/analysis',
    summary: 'Vrátí strukturovanou analýzu zakázky.',
    pathSchema: pathTenderId,
  },
  getTenderParts: {
    method: 'GET',
    path: '/api/tenders/{id}/parts',
    summary: 'Vrátí části zakázky a jejich aktuální výběr.',
    pathSchema: pathTenderId,
  },
  getTenderItems: {
    method: 'GET',
    path: '/api/tenders/{id}/product-match',
    summary: 'Vrátí položky, kandidáty a rozpracované ceny zakázky.',
    pathSchema: pathTenderId,
  },
} as const;

export interface McpToolDefinition {
  name: string;
  title: string;
  description: string;
  kind: McpToolKind;
  inputSchema: z.ZodTypeAny;
  restOperations: readonly AgentRestOperationId[];
  localEffect?: 'upload_ticket' | 'price_proposal';
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const readAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const writeAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

export const MCP_TOOL_DEFINITIONS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: 'zakazka_z_odkazu',
    title: 'Najít nebo založit zakázku z odkazu',
    description: 'Použij jako první krok, když máš odkaz na detail zakázky v NEN či Hlídači státu nebo přímý odkaz na dokument. Server dohledá existující záznam, případně založí zakázku a dokumenty stáhne sám.',
    kind: 'write',
    inputSchema: z.object({ url: httpUrl.describe('Odkaz na detail zakázky nebo přímý dokument') }).strict(),
    restOperations: ['monitoringSync', 'monitoringFeed', 'takeMonitoringTender', 'uploadTenderFromUrl'],
    annotations: { ...writeAnnotations, openWorldHint: true },
  },
  {
    name: 'vydej_upload_listek',
    title: 'Vydat upload lístek',
    description: 'Použij jen když portál neumí server stáhnout a soubor už máš lokálně. Vrátí krátkodobou jednorázovou HTTP cestu pro multipart POST; binární data ani base64 neposílej jako argument nástroje.',
    kind: 'write',
    inputSchema: z.object({ tenderId: tenderIdSchema.describe('ID existující zakázky') }).strict(),
    restOperations: ['uploadTenderFiles'],
    localEffect: 'upload_ticket',
    annotations: writeAnnotations,
  },
  {
    name: 'spust_pipeline',
    title: 'Spustit pipeline',
    description: 'Použij po úspěšném příjmu dokumentů. Zařadí celý pipeline a vrátí jobId; pak stav zjišťuj nástrojem zjisti_stav_jobu.',
    kind: 'write',
    inputSchema: z.object({ tenderId: tenderIdSchema }).strict(),
    restOperations: ['runPipeline'],
    annotations: writeAnnotations,
  },
  {
    name: 'zjisti_stav_jobu',
    title: 'Zjistit stav jobu',
    description: 'Použij pro polling vráceného jobId. Skonči při done/error/waiting_approval/budget_paused/interrupted; waiting_approval znamená, že musí pokračovat člověk.',
    kind: 'read',
    inputSchema: z.object({ jobId: jobIdSchema, since: z.number().int().nonnegative().default(0) }).strict(),
    restOperations: ['getJob'],
    annotations: readAnnotations,
  },
  {
    name: 'cti_analyzu',
    title: 'Číst analýzu',
    description: 'Použij po dokončení kroku analyze pro čtení strukturované analýzy zakázky.',
    kind: 'read',
    inputSchema: z.object({ tenderId: tenderIdSchema }).strict(),
    restOperations: ['getTenderAnalysis'],
    annotations: readAnnotations,
  },
  {
    name: 'cti_casti',
    title: 'Číst části',
    description: 'Použij pro zjištění částí zakázky a aktuálně vybraných částí.',
    kind: 'read',
    inputSchema: z.object({ tenderId: tenderIdSchema }).strict(),
    restOperations: ['getTenderParts'],
    annotations: readAnnotations,
  },
  {
    name: 'cti_polozky',
    title: 'Číst položky',
    description: 'Použij po dokončení match pro položky, produktové kandidáty a stav cenových návrhů.',
    kind: 'read',
    inputSchema: z.object({ tenderId: tenderIdSchema }).strict(),
    restOperations: ['getTenderItems'],
    annotations: readAnnotations,
  },
  {
    name: 'cti_uplnost',
    title: 'Číst úplnost',
    description: 'Použij po příjmu i po každém kroku. Vrací kontrakt kroků se stavy uplne, castecne nebo selhalo; částečný či selhaný krok nesmíš vydávat za hotový.',
    kind: 'read',
    inputSchema: z.object({ tenderId: tenderIdSchema }).strict(),
    restOperations: ['getTenderStatus'],
    annotations: readAnnotations,
  },
  {
    name: 'navrhni_cenu',
    title: 'Navrhnout cenu s proveniencí',
    description: 'Použij po přečtení položek, když znáš nákupní i nabídkovou cenu a konkrétní produktovou URL. Uloží pouze nepotvrzený návrh s datem zjištění; potvrzení ceny vždy provádí člověk.',
    kind: 'write',
    inputSchema: priceProposalInputSchema,
    restOperations: ['listJobs', 'getTenderItems'],
    localEffect: 'price_proposal',
    annotations: writeAnnotations,
  },
]);

function materializePolicyPath(path: string): string {
  return path.replace(/\{[^}]+\}/g, 'policy-probe');
}

function forbiddenOperationReason(operation: { method: string; path: string }): string | null {
  const policyPath = materializePolicyPath(operation.path);
  return agentForbiddenReason(operation.method, policyPath)
    ?? AGENT_FORBIDDEN_TARGET_STATES
      .map((status) => agentForbiddenReason(operation.method, policyPath, { status }))
      .find((candidate): candidate is string => candidate !== null)
    ?? null;
}

export function assertAgentRestOperationsSafe(
  operations: Record<string, { method: string; path: string }> = AGENT_REST_OPERATIONS,
): void {
  for (const [operationId, operation] of Object.entries(operations)) {
    const reason = forbiddenOperationReason(operation);
    if (reason) throw new Error(`REST operace ${operationId} obchází money-path: ${reason}`);
  }
}

/** Fail-closed invariant: žádný deklarovaný MCP nástroj nesmí obalit zakázanou REST cestu. */
export function assertMcpToolDefinitionsSafe(
  definitions: readonly McpToolDefinition[] = MCP_TOOL_DEFINITIONS,
): void {
  assertAgentRestOperationsSafe();
  const names = new Set<string>();
  for (const definition of definitions) {
    if (names.has(definition.name)) throw new Error(`Duplicitní MCP nástroj: ${definition.name}`);
    names.add(definition.name);
    if (definition.kind === 'write' && definition.restOperations.length === 0 && !definition.localEffect) {
      throw new Error(`Write MCP nástroj ${definition.name} nemá deklarovaný efekt.`);
    }
    for (const operationId of definition.restOperations) {
      const operation = AGENT_REST_OPERATIONS[operationId];
      if (!operation) throw new Error(`Neznámá REST operace ${String(operationId)}.`);
      const reason = forbiddenOperationReason(operation);
      if (reason) throw new Error(`MCP nástroj ${definition.name} obchází money-path: ${reason}`);
    }
  }
}

assertMcpToolDefinitionsSafe();
