import assert from 'node:assert/strict';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { AgentIdentity, AgentRole } from '../src/lib/agent-identity.js';
import type { McpExecutionContext } from '../src/mcp/tools.js';
import { createAgentMcpServer } from '../src/mcp/tools.js';
import type { McpAgentServices } from '../src/mcp/services.js';
import { UploadTicketStore } from '../src/mcp/upload-tickets.js';

const EXPECTED_TOOLS = [
  'zakazka_z_odkazu',
  'vydej_upload_listek',
  'spust_pipeline',
  'zjisti_stav_jobu',
  'cti_analyzu',
  'cti_casti',
  'cti_polozky',
  'cti_uplnost',
  'navrhni_cenu',
] as const;

const WRITE_TOOLS = new Set([
  'zakazka_z_odkazu',
  'vydej_upload_listek',
  'spust_pipeline',
  'navrhni_cenu',
]);

const VALID_PRICE_INPUT = {
  tenderId: 'tender-1',
  itemIndex: 0,
  nakupniCenaBezDph: 1_000,
  nabidkovaCenaBezDph: 1_150,
  sazbaDph: 21,
  zdrojUrl: 'https://shop.example.cz/produkt/tiskarna-123',
  zjistenoAt: '2026-09-04T10:00:00.000Z',
  dodavatel: 'Example shop',
};

type PriceInput = Parameters<McpAgentServices['proposePrice']>[0];

interface ServiceCalls {
  findOrCreateTender: Array<{ url: string }>;
  startPipeline: Array<{ tenderId: string }>;
  getJob: Array<{ jobId: string; since: number }>;
  readAnalysis: Array<{ tenderId: string }>;
  readParts: Array<{ tenderId: string }>;
  readItems: Array<{ tenderId: string }>;
  readCompleteness: Array<{ tenderId: string }>;
  proposePrice: Array<{ input: PriceInput; agent: AgentIdentity }>;
}

function createFakeServices(): { services: McpAgentServices; calls: ServiceCalls } {
  const calls: ServiceCalls = {
    findOrCreateTender: [],
    startPipeline: [],
    getJob: [],
    readAnalysis: [],
    readParts: [],
    readItems: [],
    readCompleteness: [],
    proposePrice: [],
  };
  const services: McpAgentServices = {
    async findOrCreateTender(input) {
      calls.findOrCreateTender.push(input);
      return { tenderId: 'tender-1', existing: false, source: 'nen' };
    },
    async startPipeline(input) {
      calls.startPipeline.push(input);
      return { jobId: 'job-1', status: 'queued' };
    },
    async getJob(input) {
      calls.getJob.push(input);
      return { id: input.jobId, status: 'done', logs: ['hotovo'] };
    },
    async readAnalysis(input) {
      calls.readAnalysis.push(input);
      return { tenderId: input.tenderId, zakazka: { predmet: 'Testovaci zakazka' } };
    },
    async readParts(input) {
      calls.readParts.push(input);
      return { tenderId: input.tenderId, casti: [{ id: 'cast-1', vybrana: true }] };
    },
    async readItems(input) {
      calls.readItems.push(input);
      return { tenderId: input.tenderId, polozky: [{ pozice: 0, nazev: 'Tiskarna' }] };
    },
    async readCompleteness(input) {
      calls.readCompleteness.push(input);
      return { tenderId: input.tenderId, uplnost: { analyze: { stav: 'uplne' } } };
    },
    async proposePrice(input, agent) {
      calls.proposePrice.push({ input, agent });
      return { tenderId: input.tenderId, proposalId: 'proposal-1', confirmed: false };
    },
  };
  return { services, calls };
}

function createAgent(role: AgentRole = 'analytik'): AgentIdentity {
  return {
    type: 'agent',
    kind: 'agent',
    sub: 'agent:agent-mcp-test',
    id: 'agent-mcp-test',
    agentId: 'agent-mcp-test',
    name: 'MCP test agent',
    purpose: 'Automaticke testy MCP nastroju',
    role,
    budget: {
      day: '2026-09-04',
      limitCzk: 500,
      spentCzk: 25,
      remainingCzk: 475,
      exhausted: false,
    },
  };
}

function createContext(options: {
  role?: AgentRole;
  draining?: boolean;
} = {}) {
  const fake = createFakeServices();
  let issuedTicketCount = 0;
  const uploadTickets = new UploadTicketStore({
    now: () => Date.parse('2026-09-04T10:00:00.000Z'),
    ttlMs: 60_000,
    randomToken: () => `test-ticket-${++issuedTicketCount}`,
  });
  const context: McpExecutionContext = {
    agent: createAgent(options.role),
    services: fake.services,
    uploadTickets,
    uploadBasePath: '/mcp',
    isDraining: () => options.draining ?? false,
  };
  return {
    context,
    calls: fake.calls,
    issuedTicketCount: () => issuedTicketCount,
  };
}

async function connect(context: McpExecutionContext) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createAgentMcpServer(context);
  const client = new Client({ name: 'mcp-tools-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function resultText(result: { content?: unknown }): string {
  if (!Array.isArray(result.content)) return '';
  return result.content
    .filter((item): item is { type: 'text'; text: string } => (
      Boolean(item) && typeof item === 'object'
      && (item as { type?: unknown }).type === 'text'
      && typeof (item as { text?: unknown }).text === 'string'
    ))
    .map((item) => item.text)
    .join('\n');
}

const WRITE_CALLS = [
  {
    name: 'zakazka_z_odkazu',
    arguments: { url: 'https://nen.nipez.cz/verejne-zakazky/detail-zakazky/N006-26-V00012345' },
  },
  { name: 'vydej_upload_listek', arguments: { tenderId: 'tender-1' } },
  { name: 'spust_pipeline', arguments: { tenderId: 'tender-1' } },
  { name: 'navrhni_cenu', arguments: VALID_PRICE_INPUT },
] as const;

test('MCP publikuje presne devet popsanych nastroju se spravnymi annotations', async () => {
  const fixture = createContext();
  const connection = await connect(fixture.context);
  try {
    const listed = await connection.client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), EXPECTED_TOOLS);

    for (const tool of listed.tools) {
      assert.ok(tool.description?.trim(), `${tool.name} musi mit neprázdny popis`);
      assert.ok(tool.annotations, `${tool.name} musi mit annotations`);
      const isWrite = WRITE_TOOLS.has(tool.name);
      assert.equal(tool.annotations?.readOnlyHint, !isWrite, `${tool.name}: readOnlyHint`);
      assert.equal(tool.annotations?.destructiveHint, false, `${tool.name}: destructiveHint`);
      assert.equal(tool.annotations?.idempotentHint, !isWrite, `${tool.name}: idempotentHint`);
      assert.equal(
        tool.annotations?.openWorldHint,
        tool.name === 'zakazka_z_odkazu',
        `${tool.name}: openWorldHint`,
      );
    }

    const uploadTool = listed.tools.find((tool) => tool.name === 'vydej_upload_listek');
    assert.ok(uploadTool);
    assert.doesNotMatch(
      JSON.stringify(uploadTool.inputSchema),
      /base64/i,
      'upload nastroj nesmi inzerovat base64 argument',
    );
  } finally {
    await connection.close();
  }
});

test('platny analytik projde celou povolenou MCP cestou vcetne upload listku bez base64', async () => {
  const fixture = createContext();
  const connection = await connect(fixture.context);
  try {
    const fromUrl = await connection.client.callTool({
      name: 'zakazka_z_odkazu',
      arguments: WRITE_CALLS[0].arguments,
    });
    assert.notEqual(fromUrl.isError, true);
    assert.equal(record(fromUrl.structuredContent).tenderId, 'tender-1');

    const uploadTicket = await connection.client.callTool({
      name: 'vydej_upload_listek',
      arguments: { tenderId: 'tender-1' },
    });
    assert.notEqual(uploadTicket.isError, true);
    const upload = record(uploadTicket.structuredContent);
    assert.equal(upload.base64Pouzit, false);
    assert.equal(upload.method, 'POST');
    assert.equal(upload.contentType, 'multipart/form-data');
    assert.equal(upload.fileField, 'files');
    assert.equal(upload.uploadUrl, '/mcp/uploads/test-ticket-1');

    const pipeline = await connection.client.callTool({
      name: 'spust_pipeline',
      arguments: { tenderId: 'tender-1' },
    });
    assert.notEqual(pipeline.isError, true);
    assert.equal(record(pipeline.structuredContent).jobId, 'job-1');

    const job = await connection.client.callTool({
      name: 'zjisti_stav_jobu',
      arguments: { jobId: 'job-1' },
    });
    assert.notEqual(job.isError, true);
    assert.equal(record(job.structuredContent).status, 'done');

    for (const name of ['cti_analyzu', 'cti_casti', 'cti_polozky', 'cti_uplnost'] as const) {
      const result = await connection.client.callTool({
        name,
        arguments: { tenderId: 'tender-1' },
      });
      assert.notEqual(result.isError, true, `${name} mel uspet`);
      assert.equal(record(result.structuredContent).tenderId, 'tender-1');
    }

    const proposal = await connection.client.callTool({
      name: 'navrhni_cenu',
      arguments: VALID_PRICE_INPUT,
    });
    assert.notEqual(proposal.isError, true);
    assert.equal(record(proposal.structuredContent).confirmed, false);

    assert.deepEqual(fixture.calls.findOrCreateTender, [WRITE_CALLS[0].arguments]);
    assert.deepEqual(fixture.calls.startPipeline, [{ tenderId: 'tender-1' }]);
    assert.deepEqual(fixture.calls.getJob, [{ jobId: 'job-1', since: 0 }]);
    assert.deepEqual(fixture.calls.readAnalysis, [{ tenderId: 'tender-1' }]);
    assert.deepEqual(fixture.calls.readParts, [{ tenderId: 'tender-1' }]);
    assert.deepEqual(fixture.calls.readItems, [{ tenderId: 'tender-1' }]);
    assert.deepEqual(fixture.calls.readCompleteness, [{ tenderId: 'tender-1' }]);
    assert.equal(fixture.calls.proposePrice.length, 1);
    assert.deepEqual(fixture.calls.proposePrice[0]?.input, VALID_PRICE_INPUT);
    assert.equal(fixture.calls.proposePrice[0]?.agent.id, 'agent-mcp-test');
    assert.equal(fixture.issuedTicketCount(), 1);
  } finally {
    await connection.close();
  }
});

test('viewer ma pres MCP blokovane vsechny zapisove nastroje, cteni zustava povolene', async () => {
  const fixture = createContext({ role: 'viewer' });
  const connection = await connect(fixture.context);
  try {
    for (const call of WRITE_CALLS) {
      const result = await connection.client.callTool(call);
      assert.equal(result.isError, true, `${call.name} mel byt pro viewer blokovan`);
      assert.match(resultText(result), /viewer/i);
    }

    const read = await connection.client.callTool({
      name: 'cti_analyzu',
      arguments: { tenderId: 'tender-1' },
    });
    assert.notEqual(read.isError, true);
    assert.equal(fixture.calls.readAnalysis.length, 1);
    assert.equal(fixture.calls.findOrCreateTender.length, 0);
    assert.equal(fixture.calls.startPipeline.length, 0);
    assert.equal(fixture.calls.proposePrice.length, 0);
    assert.equal(fixture.issuedTicketCount(), 0);
  } finally {
    await connection.close();
  }
});

test('draining blokuje pres MCP vsechny zapisy, ale dovoluje stavove cteni', async () => {
  const fixture = createContext({ draining: true });
  const connection = await connect(fixture.context);
  try {
    for (const call of WRITE_CALLS) {
      const result = await connection.client.callTool(call);
      assert.equal(result.isError, true, `${call.name} mel byt pri draining blokovan`);
      assert.match(resultText(result), /zastaven|nasazen/i);
    }

    const read = await connection.client.callTool({
      name: 'zjisti_stav_jobu',
      arguments: { jobId: 'job-1', since: 3 },
    });
    assert.notEqual(read.isError, true);
    assert.deepEqual(fixture.calls.getJob, [{ jobId: 'job-1', since: 3 }]);
    assert.equal(fixture.calls.findOrCreateTender.length, 0);
    assert.equal(fixture.calls.startPipeline.length, 0);
    assert.equal(fixture.calls.proposePrice.length, 0);
    assert.equal(fixture.issuedTicketCount(), 0);
  } finally {
    await connection.close();
  }
});

test('sabotáž 3: vyhledavaci URL se k cenovemu navrhu nedostane, konkretni produkt ano', async () => {
  const fixture = createContext();
  const connection = await connect(fixture.context);
  try {
    const rejected = await connection.client.callTool({
      name: 'navrhni_cenu',
      arguments: {
        ...VALID_PRICE_INPUT,
        zdrojUrl: 'https://www.alza.cz/search?q=tiskarna',
      },
    });
    assert.equal(rejected.isError, true);
    assert.match(resultText(rejected), /produktovou stránku|vyhledávání/i);
    assert.equal(
      fixture.calls.proposePrice.length,
      0,
      'schema musi vyhledavaci URL odmitnout pred volanim persistence service',
    );

    const accepted = await connection.client.callTool({
      name: 'navrhni_cenu',
      arguments: VALID_PRICE_INPUT,
    });
    assert.notEqual(accepted.isError, true);
    assert.equal(fixture.calls.proposePrice.length, 1);
    assert.equal(fixture.calls.proposePrice[0]?.input.zdrojUrl, VALID_PRICE_INPUT.zdrojUrl);
  } finally {
    await connection.close();
  }
});
