import { agentForbiddenReason } from '../lib/agent-identity.js';
import {
  AGENT_REST_OPERATIONS,
  type AgentRestOperationId,
} from './definitions.js';

export interface AgentRestRequest {
  path?: Record<string, string>;
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export class AgentRestError extends Error {
  constructor(
    readonly status: number,
    readonly response: unknown,
  ) {
    super(response && typeof response === 'object' && 'error' in response
      ? String((response as { error: unknown }).error)
      : `REST operace selhala (HTTP ${status}).`);
  }
}

function renderPath(template: string, values: Record<string, string>): string {
  const used = new Set<string>();
  const path = template.replace(/\{([^}]+)\}/g, (_match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`Chybí parametr REST cesty ${key}.`);
    used.add(key);
    return encodeURIComponent(value);
  });
  const extras = Object.keys(values).filter((key) => !used.has(key));
  if (extras.length > 0) throw new Error(`Nadbytečné parametry REST cesty: ${extras.join(', ')}.`);
  return path;
}

function responseBody(contentType: string | null, text: string): unknown {
  if (!text) return null;
  if (contentType?.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return { error: 'REST server vrátil neplatný JSON.' };
    }
  }
  return text;
}

/**
 * Tenký loopback adaptér. Obchodní logika zůstává v existujících REST handlerech;
 * každý request znovu prochází jejich auth, budgetem, governance a money-path guardem.
 */
export class AgentRestClient {
  constructor(
    private readonly baseUrl: string,
    private readonly authorization: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request(operationId: AgentRestOperationId, options: AgentRestRequest = {}): Promise<any> {
    const operation = AGENT_REST_OPERATIONS[operationId] as {
      method: 'GET' | 'POST';
      path: string;
      pathSchema?: { parse(value: unknown): Record<string, string> };
      querySchema?: { parse(value: unknown): Record<string, string | undefined> };
      bodySchema?: { parse(value: unknown): unknown };
    };
    const pathValues = operation.pathSchema?.parse(options.path ?? {}) ?? {};
    const path = renderPath(operation.path, pathValues);
    const queryValues = operation.querySchema?.parse(options.query ?? {}) ?? {};
    const body = operation.bodySchema ? operation.bodySchema.parse(options.body) : options.body;

    const forbidden = agentForbiddenReason(operation.method, path, body);
    if (forbidden) {
      throw new Error(`MCP odmítl zakázanou money-path REST operaci: ${forbidden}`);
    }

    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(queryValues)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: this.authorization,
    };
    let serializedBody: string | undefined;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      serializedBody = JSON.stringify(body);
    }

    const response = await this.fetchFn(url, {
      method: operation.method,
      headers,
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
    });
    const text = await response.text();
    const parsed = responseBody(response.headers.get('content-type'), text);
    if (!response.ok) throw new AgentRestError(response.status, parsed);
    return parsed;
  }
}
