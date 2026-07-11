/**
 * Sdílený deterministický submit-gate: rozhodne, zda je nabídka připravená k podání.
 * Jediný zdroj pravdy pro `validate-bid.ts` (nastavuje ready_to_submit) i pro endpoint
 * `POST /tenders/:id/finalize` (zamezí finalizaci nekompletní nabídky).
 *
 * Kontroluje (nad output adresářem zakázky):
 *  - tvrdé price-sanity nálezy (strop, nulová cena, prodej pod nákupní cenou),
 *  - price-sanity varování, která neblokují podání,
 *  - field-validaci vygenerovaných dokumentů (musí projít),
 *  - zbytkové placeholdery ve vygenerovaných .docx ("doplní účastník", "______").
 */
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import type { ProductMatch, PolozkaMatch } from './types.js';
import { checkPriceSanity } from './price-sanity.js';
import { docHasResidualPlaceholders } from './template-engine.js';
import {
  assertPartsSelectionUnchanged,
  hasPartsSelectionSnapshot,
  readPartsSelectionSnapshot,
} from './parts-selection-guard.js';

export interface SubmitGateResult {
  ready: boolean;
  problems: string[];
  warnings: string[];
}

/**
 * Vrátí množinu vybraných částí (parts-selection.json). Null = zakázka bez částí (jedna
 * část) → filtrování se neuplatní. Chybějící/nečitelný soubor u vícečástové zakázky ⇒
 * bereme všechny části (konzervativně, jako validate-bid).
 */
async function loadSelectedPartIds(outputDir: string, items: PolozkaMatch[]): Promise<Set<string> | null> {
  const castIds = new Set(items.map((i) => (i as any).cast_id).filter(Boolean));
  if (castIds.size <= 1) return null; // jedna nebo žádná část → nefiltruj
  try {
    const sel = JSON.parse(await readFile(join(outputDir, 'parts-selection.json'), 'utf-8'));
    const selected = new Set<string>(sel.selected_parts || []);
    return selected.size > 0 ? selected : castIds;
  } catch {
    return castIds;
  }
}

function filterBySelectedParts(items: PolozkaMatch[], selected: Set<string> | null): PolozkaMatch[] {
  if (!selected) return items;
  return items.filter((pm) => {
    const castId = (pm as any).cast_id;
    return !castId || selected.has(castId);
  });
}

export async function computeSubmitGate(outputDir: string): Promise<SubmitGateResult> {
  const problems: string[] = [];
  const warnings: string[] = [];

  // Cenové kontroly pro multi-item zakázky vždy přepočítáme z aktuálních dat.
  let productMatchRaw: string | null = null;
  try {
    productMatchRaw = await readFile(join(outputDir, 'product-match.json'), 'utf-8');
  } catch {
    // Soubor chybí = single-product zakázka nebo krok match ještě neproběhl → cenové
    // kontroly se přeskočí (ENOENT je legitimní). Jiné chyby čtení řešíme níž fail-closed.
    productMatchRaw = null;
  }
  if (productMatchRaw !== null) {
    let pm: ProductMatch;
    try {
      pm = JSON.parse(productMatchRaw);
    } catch (err) {
      // Poškozený product-match.json NESMÍ tiše propustit money gate (fail-closed).
      return { ready: false, problems: [`Nelze načíst cenová data (product-match.json je poškozený): ${err}`], warnings };
    }
    const allItems = pm.polozky_match || [];
    if (hasPartsSelectionSnapshot(pm)) {
      try {
        const current = await readPartsSelectionSnapshot(outputDir);
        const allPartIds = [...new Set(allItems.map((item) => item.cast_id).filter((id): id is string => Boolean(id)))];
        assertPartsSelectionUnchanged(pm, current, allPartIds);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    // Filtruj jen položky vybraných částí — u vícečástových zakázek se podává jedna část
    // a položky ostatních částí zůstanou nepotvrzené (jinak by gate byl navždy ready=false).
    const items = filterBySelectedParts(allItems, await loadSelectedPartIds(outputDir, allItems));
    const sanityFindings = checkPriceSanity(items, {});
    const names = new Map(items.map((item) => [item.polozka_index, item.polozka_nazev]));
    for (const finding of sanityFindings) {
      const itemName = names.get(finding.polozka_index) ?? `Položka #${finding.polozka_index + 1}`;
      const detail = `Položka „${itemName}“: ${finding.message}`;
      if (finding.level === 'hard') problems.push(detail);
      else warnings.push(detail);
    }

    // Potvrzení člověkem je samostatná tvrdá podmínka NAD sanity kontrolami: sanity
    // pracuje i s cenou kandidáta (fallback), ale podat lze jen položky s cenou,
    // kterou operátor explicitně potvrdil. Kryje i scénář „přepnutí kandidáta smazalo
    // potvrzenou cenu, dokumenty zůstaly stale" — dřívější kontrola (cenova_uprava > 0)
    // tohle chytala a nesmí se ztratit.
    const unconfirmed = items.filter((i) => !i.cenova_uprava?.potvrzeno);
    if (unconfirmed.length > 0) {
      const preview = unconfirmed.slice(0, 5).map((i) => i.polozka_nazev).join(', ');
      problems.push(
        `${unconfirmed.length} z ${items.length} položek nemá potvrzenou cenu` +
        `${unconfirmed.length > 5 ? ` (mj. ${preview}, …)` : ` (${preview})`}.`,
      );
    }
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

  return { ready: problems.length === 0, problems, warnings };
}
