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
import type { ProductMatch } from './types.js';
import { checkPriceSanity } from './price-sanity.js';
import { docHasResidualPlaceholders } from './template-engine.js';

export interface SubmitGateResult {
  ready: boolean;
  problems: string[];
  warnings: string[];
}

export async function computeSubmitGate(outputDir: string): Promise<SubmitGateResult> {
  const problems: string[] = [];
  const warnings: string[] = [];

  // Cenové kontroly pro multi-item zakázky vždy přepočítáme z aktuálních dat.
  try {
    const pm: ProductMatch = JSON.parse(await readFile(join(outputDir, 'product-match.json'), 'utf-8'));
    const items = pm.polozky_match || [];
    const sanityFindings = checkPriceSanity(items, {});
    const names = new Map(items.map((item) => [item.polozka_index, item.polozka_nazev]));
    for (const finding of sanityFindings) {
      const itemName = names.get(finding.polozka_index) ?? `Položka #${finding.polozka_index + 1}`;
      const detail = `Položka „${itemName}“: ${finding.message}`;
      if (finding.level === 'hard') problems.push(detail);
      else warnings.push(detail);
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

  return { ready: problems.length === 0, problems, warnings };
}
