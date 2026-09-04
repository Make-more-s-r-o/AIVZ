import { Readable } from 'node:stream';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';

import { agentDailyLimitBlock } from '../lib/ai-budget.js';
import type { AgentIdentity } from '../lib/agent-identity.js';
import {
  authenticateBearerIdentity,
  type BearerIdentityResult,
} from '../lib/jwt-auth.js';
import {
  createMcpAgentServices,
  type McpAgentServices,
  type WithSnapshotMutation,
} from './services.js';
import { createAgentMcpServer } from './tools.js';
import {
  UploadTicketError,
  UploadTicketStore,
} from './upload-tickets.js';

export type McpAuthenticator = (authorization: string | undefined) => Promise<BearerIdentityResult>;

export class McpHttpError extends Error {
  constructor(readonly status: 401 | 429 | 503, readonly code: string, message: string) {
    super(message);
  }
}

/** MCP přijímá výhradně DB agentní klíč; JWT ani legacy API_TOKEN nejsou agentní identita. */
export async function authenticateMcpAgent(
  authorization: string | undefined,
  authenticate: McpAuthenticator = (header) => authenticateBearerIdentity(header),
): Promise<AgentIdentity> {
  let result: BearerIdentityResult;
  try {
    result = await authenticate(authorization);
  } catch {
    throw new McpHttpError(
      503,
      'authentication_unavailable',
      'Ověření agentní identity je dočasně nedostupné.',
    );
  }
  if (!result.authenticated || result.identity.type !== 'agent') {
    throw new McpHttpError(401, 'unauthorized', 'Neplatný nebo odvolaný agentní klíč.');
  }
  const budgetReason = agentDailyLimitBlock(result.identity.agent.budget);
  if (budgetReason) throw new McpHttpError(429, 'agent_budget_exhausted', budgetReason);
  return result.identity.agent;
}

interface McpRequestLocals {
  agent: AgentIdentity;
  authorization: string;
}

export interface CreateMcpRouterOptions {
  restBaseUrl: string;
  outputDir: string;
  authenticate?: McpAuthenticator;
  fetchFn?: typeof fetch;
  uploadFetchFn?: typeof fetch;
  uploadTickets?: UploadTicketStore;
  servicesFactory?: (input: {
    agent: AgentIdentity;
    authorization: string;
  }) => McpAgentServices;
  withSnapshotMutation?: WithSnapshotMutation;
  isDraining?: () => boolean;
  uploadBasePath?: string;
}

function copyUpstreamResponseHeaders(response: Response, res: express.Response): void {
  for (const name of ['content-type', 'content-length']) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
}

/** Express 4 router pro stateless MCP Streamable HTTP a jednorázové upload cesty. */
export function createMcpRouter(options: CreateMcpRouterOptions): express.Router {
  if (!options.servicesFactory && !options.withSnapshotMutation) {
    throw new Error('MCP cenový návrh vyžaduje sdílenou rezervaci tender snapshotu.');
  }
  const router = express.Router();
  const authenticate = options.authenticate ?? ((header) => authenticateBearerIdentity(header));
  const uploadTickets = options.uploadTickets ?? new UploadTicketStore();
  const uploadFetch = options.uploadFetchFn ?? options.fetchFn ?? fetch;

  router.use(async (req, res, next) => {
    try {
      const agent = await authenticateMcpAgent(req.headers.authorization, authenticate);
      (res.locals as McpRequestLocals).agent = agent;
      (res.locals as McpRequestLocals).authorization = req.headers.authorization!;
      next();
    } catch (error) {
      if (error instanceof McpHttpError) {
        return res.status(error.status).json({ error: error.code, reason: error.message });
      }
      return res.status(503).json({
        error: 'authentication_unavailable',
        reason: 'Ověření agentní identity je dočasně nedostupné.',
      });
    }
  });

  router.post('/uploads/:ticket', async (req, res) => {
    const locals = res.locals as McpRequestLocals;
    if (locals.agent.role === 'viewer') {
      return res.status(403).json({ error: 'forbidden_role', reason: 'Agent s rolí viewer nesmí nahrávat soubory.' });
    }
    if (options.isDraining?.()) {
      return res.status(503).json({ error: 'draining' });
    }
    let tenderId: string;
    try {
      tenderId = uploadTickets.consume(req.params.ticket, locals.agent.id).tenderId;
    } catch (error) {
      if (error instanceof UploadTicketError) {
        const status = error.code === 'wrong_agent' ? 403 : 410;
        return res.status(status).json({ error: `upload_ticket_${error.code}`, reason: error.message });
      }
      return res.status(410).json({ error: 'upload_ticket_invalid' });
    }

    const upstreamUrl = new URL(
      `/api/tenders/${encodeURIComponent(tenderId)}/upload`,
      options.restBaseUrl,
    );
    const headers: Record<string, string> = {
      Authorization: locals.authorization,
      Accept: 'application/json',
    };
    const contentType = req.headers['content-type'];
    if (contentType) headers['Content-Type'] = contentType;
    const contentLength = req.headers['content-length'];
    if (contentLength) headers['Content-Length'] = contentLength;

    try {
      const upstream = await uploadFetch(upstreamUrl, {
        method: 'POST',
        headers,
        body: req as unknown as BodyInit,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      copyUpstreamResponseHeaders(upstream, res);
      res.status(upstream.status);
      if (!upstream.body) return res.end();
      return Readable.fromWeb(upstream.body as any).pipe(res);
    } catch {
      return res.status(502).json({
        error: 'upload_proxy_failed',
        reason: 'Upload se nepodařilo předat existujícímu REST handleru.',
      });
    }
  });

  router.post('/', async (req, res) => {
    const locals = res.locals as McpRequestLocals;
    const services = options.servicesFactory?.(locals) ?? createMcpAgentServices({
      restBaseUrl: options.restBaseUrl,
      authorization: locals.authorization,
      outputDir: options.outputDir,
      fetchFn: options.fetchFn,
      withSnapshotMutation: options.withSnapshotMutation!,
    });
    const server = createAgentMcpServer({
      agent: locals.agent,
      services,
      uploadTickets,
      uploadBasePath: options.uploadBasePath ?? '/mcp',
      isDraining: options.isDraining,
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    } finally {
      await server.close().catch(() => {});
    }
  });

  router.get('/', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });
  router.delete('/', (_req, res) => {
    res.setHeader('Allow', 'POST');
    res.status(405).json({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  });

  return router;
}
