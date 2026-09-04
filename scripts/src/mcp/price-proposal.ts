import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { z } from 'zod';

import type { AgentIdentity } from '../lib/agent-identity.js';
import { candidateFingerprint } from '../lib/candidate-fingerprint.js';
import { validateServerPriceWrite, type ServerPriceTarget } from '../lib/price-confirmation.js';
import { roundCurrency } from '../lib/price-calculator.js';
import { PriceOverrideSchema, PriceProvenanceSchema } from '../lib/types.js';
import { priceProposalInputSchema } from './definitions.js';

export type PriceProposalInput = z.infer<typeof priceProposalInputSchema>;

type ProposalTarget = ServerPriceTarget;

const tenderLocks = new Map<string, Promise<void>>();

async function withTenderLock<T>(tenderId: string, operation: () => Promise<T>): Promise<T> {
  const previous = tenderLocks.get(tenderId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  tenderLocks.set(tenderId, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (tenderLocks.get(tenderId) === queued) tenderLocks.delete(tenderId);
  }
}

function proposalTarget(productMatch: any, itemIndex: number | undefined): {
  target: ProposalTarget;
  itemIndex: number | null;
} {
  if (Array.isArray(productMatch?.polozky_match)) {
    if (itemIndex === undefined) {
      throw new Error('U vícepoložkové zakázky je itemIndex povinný.');
    }
    const target = productMatch.polozky_match[itemIndex];
    if (!target) throw new Error(`Položka na pozici ${itemIndex} neexistuje.`);
    return { target, itemIndex };
  }
  if (itemIndex !== undefined && itemIndex !== 0) {
    throw new Error('Legacy jednopoložková zakázka přijímá jen itemIndex 0 nebo žádný index.');
  }
  return { target: productMatch as ProposalTarget, itemIndex: null };
}

function selectedCandidate(target: ProposalTarget): {
  candidate: { vyrobce: string; model: string };
  index: number;
} {
  if (!Array.isArray(target.kandidati) || target.kandidati.length === 0) {
    throw new Error('Cenu nelze navrhnout bez produktového kandidáta; nejdřív dokonči match.');
  }
  const requested = target.vybrany_index;
  const index = Number.isInteger(requested) && Number(requested) >= 0
    && Number(requested) < target.kandidati.length ? Number(requested) : 0;
  const candidate = target.kandidati[index];
  if (!candidate || typeof candidate.vyrobce !== 'string' || typeof candidate.model !== 'string') {
    throw new Error('Vybraný kandidát nemá identitu potřebnou pro provenienci ceny.');
  }
  return { candidate, index };
}

function marginPercent(purchase: number, offer: number): number {
  if (purchase === 0) return 0;
  return Math.round((((offer / purchase) - 1) * 100) * 10_000) / 10_000;
}

export interface PersistPriceProposalOptions {
  outputDir: string;
  now?: () => Date;
}

/**
 * Jediná nová zápisová služba E5. Přijímá úzký vstup bez `potvrzeno` a bez
 * klientské provenience; server vytvoří snapshot a vždy uloží potvrzeno=false.
 */
export async function persistPriceProposal(
  rawInput: unknown,
  agent: AgentIdentity,
  options: PersistPriceProposalOptions,
): Promise<Record<string, unknown>> {
  const input = priceProposalInputSchema.parse(rawInput);
  return withTenderLock(input.tenderId, async () => {
    const matchPath = join(options.outputDir, input.tenderId, 'product-match.json');
    const raw = await readFile(matchPath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new Error('product-match.json neexistuje; nejdřív dokonči match.');
      }
      throw error;
    });
    const productMatch = JSON.parse(raw);
    const selected = proposalTarget(productMatch, input.itemIndex);
    if (selected.target.cenova_uprava?.potvrzeno === true) {
      throw new Error('Již potvrzenou cenu smí změnit pouze člověk.');
    }
    const candidate = selectedCandidate(selected.target);
    const purchaseWithVat = roundCurrency(input.nakupniCenaBezDph * (1 + input.sazbaDph / 100));
    const offerWithVat = roundCurrency(input.nabidkovaCenaBezDph * (1 + input.sazbaDph / 100));
    const source = {
      url: input.zdrojUrl,
      dodavatel: input.dodavatel ?? null,
    };

    // Autoritativní cenový validátor REST cesty odstraní auditní pole a ověří celý
    // cenový tvar. Potvrzení je natvrdo false a nelze je dodat v MCP argumentu.
    const draft = validateServerPriceWrite({
      nakupni_cena_bez_dph: input.nakupniCenaBezDph,
      nakupni_cena_s_dph: purchaseWithVat,
      marze_procent: marginPercent(input.nakupniCenaBezDph, input.nabidkovaCenaBezDph),
      nabidkova_cena_bez_dph: input.nabidkovaCenaBezDph,
      nabidkova_cena_s_dph: offerWithVat,
      potvrzeno: false,
      zdroj_nakupu: source,
      ...(input.poznamka ? { poznamka: input.poznamka } : {}),
    }, selected.target, undefined, input.zjistenoAt);

    const provenance = PriceProvenanceSchema.parse({
      verze: 1,
      typ: 'overeny_eshop',
      stav: 'dolozena',
      url: input.zdrojUrl,
      zjisteno_at: input.zjistenoAt,
      cena_v_okamziku: {
        bez_dph: input.nakupniCenaBezDph,
        s_dph: purchaseWithVat,
        mena: 'CZK',
        sazba_dph: input.sazbaDph,
        baleni_ks: 1,
      },
      zjistil: { typ: 'web_agent', id: agent.sub },
      ...(input.dodavatel ? { dodavatel: input.dodavatel } : {}),
      kandidat_fingerprint: candidateFingerprint(candidate.candidate, candidate.index),
      ...(input.poznamka ? { poznamka: input.poznamka } : {}),
    });
    const proposal = PriceOverrideSchema.parse({
      ...draft,
      potvrzeno: false,
      price_provenance: provenance,
    });

    if (selected.itemIndex === null) productMatch.cenova_uprava = proposal;
    else productMatch.polozky_match[selected.itemIndex].cenova_uprava = proposal;
    const savedAt = (options.now?.() ?? new Date()).toISOString();
    productMatch.prices_updated_at = savedAt;

    const temporaryPath = `${matchPath}.mcp-proposal-${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(productMatch, null, 2), { encoding: 'utf8', flag: 'wx' });
      // Nezapisuj přes novější snapshot, který mezitím změnil člověk nebo pipeline.
      if (await readFile(matchPath, 'utf8') !== raw) {
        throw new Error('Cenový snapshot se souběžně změnil; načti položky znovu a návrh opakuj.');
      }
      await rename(temporaryPath, matchPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }

    return {
      tenderId: input.tenderId,
      itemIndex: selected.itemIndex,
      potvrzeno: false,
      ulozenoAt: savedAt,
      cenova_uprava: proposal,
      dalsiKrok: 'Návrh musí zkontrolovat a potvrdit člověk.',
    };
  });
}
