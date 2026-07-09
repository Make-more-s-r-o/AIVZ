/**
 * Sdílený deterministický submit-gate: rozhodne, zda je nabídka připravená k podání.
 * Jediný zdroj pravdy pro `validate-bid.ts` (nastavuje ready_to_submit) i pro endpoint
 * `POST /tenders/:id/finalize` (zamezí finalizaci nekompletní nabídky).
 *
 * Kontroluje (nad output adresářem zakázky):
 *  - cenový strop za kus (cena_max_s_dph) — žádná položka ho nesmí překročit,
 *  - úplnost nacenění — každá položka soupisu musí mít nabídkovou cenu > 0,
 *  - field-validaci vygenerovaných dokumentů (musí projít),
 *  - zbytkové placeholdery ve vygenerovaných .docx ("doplní účastník", "______").
 */
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import type { ProductMatch } from './types.js';
import { docHasResidualPlaceholders } from './template-engine.js';

export interface SubmitGateResult {
  ready: boolean;
  problems: string[];
}

export async function computeSubmitGate(outputDir: string): Promise<SubmitGateResult> {
  const problems: string[] = [];

  // Cenový strop + úplnost nacenění (jen u multi-item zakázek s product-match).
  try {
    const pm: ProductMatch = JSON.parse(await readFile(join(outputDir, 'product-match.json'), 'utf-8'));
    const items = pm.polozky_match || [];
    const overCap = items.filter(
      (i) => i.cena_max_s_dph != null && (i.cenova_uprava?.nabidkova_cena_s_dph ?? 0) > (i.cena_max_s_dph as number),
    );
    const unpriced = items.filter((i) => (i.cenova_uprava?.nabidkova_cena_s_dph ?? 0) <= 0);
    if (overCap.length) {
      // Skutečný per-item strop z dat (ne hardcoded 39 999) — u každé položky vypiš její limit.
      const detail = overCap
        .map((i) => `#${i.polozka_index + 1} (max ${Number(i.cena_max_s_dph).toLocaleString('cs-CZ')} Kč s DPH)`)
        .join(', ');
      problems.push(`${overCap.length} položek překračuje cenový strop: ${detail}`);
    }
    if (unpriced.length) {
      problems.push(`${unpriced.length} z ${items.length} položek nemá nabídkovou cenu.`);
    }
  } catch {
    // Bez product-match (single-product zakázka) — cenové kontroly se přeskočí.
  }

  // Field-validace dokumentů musí projít (chybějící soubor = neprošlo).
  try {
    const fv = JSON.parse(await readFile(join(outputDir, 'field-validation.json'), 'utf-8'));
    if (!(Array.isArray(fv) && fv.every((r: { overall?: string }) => r.overall === 'pass'))) {
      problems.push('Field-validace dokumentů neprošla (chybějící nebo nesprávná pole).');
    }
  } catch {
    problems.push('Chybí field-validace dokumentů — spusťte krok Validace.');
  }

  // Zbytkové placeholdery ve vygenerovaných .docx.
  try {
    const docx = (await readdir(outputDir)).filter((f) => f.toLowerCase().endsWith('.docx'));
    const withPlaceholders: string[] = [];
    for (const f of docx) {
      if (await docHasResidualPlaceholders(join(outputDir, f))) withPlaceholders.push(f);
    }
    if (withPlaceholders.length) {
      problems.push(`Nevyplněné placeholdery („doplní účastník") v: ${withPlaceholders.join(', ')}`);
    }
  } catch {
    // Nelze číst output — ostatní kontroly platí.
  }

  return { ready: problems.length === 0, problems };
}
