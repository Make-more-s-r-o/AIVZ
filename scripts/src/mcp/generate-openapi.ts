import { mkdir } from 'node:fs/promises';

import { writeAgentOpenApi } from './openapi.js';

const target = new URL('../../../docs/agent/openapi.json', import.meta.url);
await mkdir(new URL('./', target), { recursive: true });
await writeAgentOpenApi(target);
