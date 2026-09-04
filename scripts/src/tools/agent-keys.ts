/**
 * CLI sprava agentnich API klicu.
 *
 *   node --import tsx src/tools/agent-keys.ts create --name "Hermes" --purpose "monitoring" --daily-limit-czk 100
 *   node --import tsx src/tools/agent-keys.ts list [--json]
 *   node --import tsx src/tools/agent-keys.ts revoke --id a_...
 *   node --import tsx src/tools/agent-keys.ts set-budget --id a_... --daily-limit-czk 50
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { config } from 'dotenv';

import {
  AGENT_ROLES,
  createAgentKey,
  listAgentKeys,
  revokeAgentKey,
  setAgentDailyLimit,
  type AgentRole,
} from '../lib/agent-identity.js';
import { closePool } from '../lib/db.js';
import { runMigrations } from '../lib/db-migrate.js';

config({ path: new URL('../../../.env', import.meta.url).pathname });

const USAGE = `Pouziti:
  agent-keys.ts create --name <jmeno> --purpose <ucel> --daily-limit-czk <Kc> [--role analytik|viewer]
  agent-keys.ts list [--json]
  agent-keys.ts revoke --id <agent-id>
  agent-keys.ts set-budget --id <agent-id> --daily-limit-czk <Kc>`;

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Chybi --${name}.\n${USAGE}`);
  return value.trim();
}

function parseMoney(value: string | undefined): number {
  const raw = required(value, 'daily-limit-czk');
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('--daily-limit-czk musi byt nezaporne konecne cislo.');
  }
  return parsed;
}

function parseRole(value: string | undefined): AgentRole {
  const role = value ?? 'analytik';
  if (!AGENT_ROLES.includes(role as AgentRole)) {
    throw new Error('--role musi byt analytik nebo viewer.');
  }
  return role as AgentRole;
}

export async function runAgentKeysCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      id: { type: 'string' },
      name: { type: 'string' },
      purpose: { type: 'string' },
      role: { type: 'string' },
      'daily-limit-czk': { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });

  if (positionals.length !== 1) throw new Error(USAGE);
  const command = positionals[0];

  if (command === 'create') {
    const created = await createAgentKey({
      name: required(values.name, 'name'),
      purpose: required(values.purpose, 'purpose'),
      role: parseRole(values.role),
      dailyLimitCzk: parseMoney(values['daily-limit-czk']),
    });
    console.log('Agentni klic byl vytvoren. Tajna hodnota se zobrazuje pouze v tomto vystupu.');
    // Raw klic je zamerne vypsan prave jednou a neni soucasti zadne dalsi operace/listingu.
    console.log(JSON.stringify({ agent: created.agent, key: created.key }, null, 2));
    return;
  }

  if (command === 'list') {
    const agents = await listAgentKeys();
    if (values.json) {
      console.log(JSON.stringify(agents, null, 2));
      return;
    }
    console.table(agents.map((agent) => ({
      id: agent.id,
      name: agent.name,
      purpose: agent.purpose,
      role: agent.role,
      status: agent.revokedAt ? 'revoked' : 'active',
      dailyLimitCzk: agent.budget.limitCzk,
      spentCzk: agent.budget.spentCzk,
      remainingCzk: agent.budget.remainingCzk,
      lastUsedAt: agent.lastUsedAt ?? '-',
    })));
    return;
  }

  if (command === 'revoke') {
    const id = required(values.id, 'id');
    const revoked = await revokeAgentKey(id);
    if (!revoked) throw new Error(`Aktivni agentni klic ${id} nebyl nalezen.`);
    console.log(`Agentni klic ${id} byl odvolan.`);
    return;
  }

  if (command === 'set-budget') {
    const id = required(values.id, 'id');
    const agent = await setAgentDailyLimit(id, parseMoney(values['daily-limit-czk']));
    if (!agent) throw new Error(`Agentni klic ${id} nebyl nalezen.`);
    console.log(JSON.stringify({ id: agent.id, dailyLimitCzk: agent.dailyLimitCzk }, null, 2));
    return;
  }

  throw new Error(`Neznamy prikaz: ${command}.\n${USAGE}`);
}

async function main(): Promise<void> {
  try {
    await runMigrations();
    await runAgentKeysCli();
  } finally {
    await closePool();
  }
}

const invokedPath = process.argv[1];
const isDirectRun = invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Chyba spravy agentnich klicu: ${message}`);
    process.exitCode = 1;
  });
}
