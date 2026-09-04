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
import { readFile, readdir, stat } from 'fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'path';
import type { Cast, ProductMatch, PolozkaMatch } from './types.js';
import { findUnconfirmedPrices } from './price-confirmation.js';
import { checkPriceSanity } from './price-sanity.js';
import { calculateTenderPriceRecap } from './price-calculator.js';
import { buildPartPriceCapValidationChecks } from './validation-deterministic.js';
import { docHasResidualPlaceholders } from './template-engine.js';
import { splitFillProblems, type FillReport } from './fill-report.js';
import { isStale } from './stale-check.js';
import {
  assertPartsSelectionUnchanged,
  hasPartsSelectionSnapshot,
  readPartsSelectionSnapshot,
} from './parts-selection-guard.js';
import { getDocManifest } from './company-store.js';
import type { DocManifest } from './doc-slots.js';
import { buildPrilohaChecklist, isValidKvalifikaceVyjimka, type KvalifikaceVyjimky } from './priloha-checklist.js';
import {
  buildBalikChecklist, isValidBalikPotvrzeni, isValidBalikZamitnuti, isValidPrevzetiUplnosti,
  pozadavekFingerprint, type BalikPotvrzeniMap,
  type PozadovanyDokument,
} from './balik-uplnost.js';

export interface SubmitGateResult {
  ready: boolean;
  problems: string[];
  warnings: string[];
}

export const STALE_DOCUMENTS_MESSAGE = 'Dokumenty neodpovídají aktuálním cenám — spusťte znovu Generování a Kontrolu.';
export const BLOCK_PART_PRICE_CAP_ENV = 'BLOCK_PART_PRICE_CAP_EXCEEDED';

export function isPartPriceCapBlockingEnabled(
  configuredValue = process.env[BLOCK_PART_PRICE_CAP_ENV] ?? '',
): boolean {
  return /^(?:1|true|yes|on)$/i.test(configuredValue);
}

/**
 * Vrátí množinu vybraných částí (parts-selection.json). Null = zakázka bez částí (jedna
 * část) → filtrování se neuplatní. Chybějící/nečitelný soubor u vícečástové zakázky ⇒
 * bereme všechny části (konzervativně, jako validate-bid).
 */
async function loadSelectedPartIds(
  outputDir: string,
  items: PolozkaMatch[],
  declaredParts: readonly Cast[] = [],
): Promise<Set<string> | null> {
  const castIds = new Set(
    (declaredParts.length > 1 ? declaredParts.map((part) => part.id) : items.map((item) => item.cast_id))
      .filter((id): id is string => Boolean(id)),
  );
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

export interface SubmitGateOptions {
  now?: Date;
  getCompanyManifest?: (companyId: string) => Promise<DocManifest>;
  /** Výchozí false; produkčně lze zapnout také přes BLOCK_PART_PRICE_CAP_EXCEEDED. */
  blockPartPriceCapExceeded?: boolean;
}

export async function computeSubmitGate(
  outputDir: string,
  options: SubmitGateOptions = {},
): Promise<SubmitGateResult> {
  const problems: string[] = [];
  const warnings: string[] = [];
  let pricesUpdatedAt: string | null = null;

  // Úplnost celého balíku vůči explicitním požadavkům ZD.
  try {
    const analysis = JSON.parse(await readFile(join(outputDir, 'analysis.json'), 'utf-8'));
    let potvrzeni: BalikPotvrzeniMap = {};
    try { potvrzeni = JSON.parse(await readFile(join(outputDir, 'balik-potvrzeni.json'), 'utf-8')); } catch {}
    if (!Object.prototype.hasOwnProperty.call(analysis, 'pozadovane_dokumenty')) {
      if (isValidPrevzetiUplnosti(potvrzeni.__cela_zakazka__)) {
        warnings.push(`Úplnost celé zakázky převzal/a ${potvrzeni.__cela_zakazka__.kdo}: ${potvrzeni.__cela_zakazka__.duvod}.`);
      } else {
        problems.push('Analýza je z předchozí verze a neobsahuje seznam požadovaných dokumentů — projděte zadávací dokumentaci ručně a převezměte odpovědnost, nebo spusťte analýzu znovu.');
      }
    } else if (Array.isArray(analysis.pozadovane_dokumenty)) {
      const meta = await readFile(join(outputDir, 'tender-meta.json'), 'utf-8')
        .then((raw) => JSON.parse(raw)).catch(() => null);
      const manifest = typeof meta?.company_id === 'string'
        ? await (options.getCompanyManifest ?? getDocManifest)(meta.company_id).catch(() => ({ version: 1, entries: [] }))
        : { version: 1, entries: [] };
      const files = await readdir(outputDir);
      const vygenerovaneSoubory = files.filter((file) =>
        ['.docx', '.xlsx', '.pdf'].some((extension) => file.toLowerCase().endsWith(extension)));
      const prilohyZakazky = await readdir(join(outputDir, 'prilohy')).catch(() => [] as string[]);
      const checklist = buildBalikChecklist({
        pozadovaneDokumenty: analysis.pozadovane_dokumenty as PozadovanyDokument[],
        vygenerovaneSoubory,
        prilohyZakazky,
        firemniDoklady: manifest.entries,
      });
      for (const item of checklist) {
        const zaznam = potvrzeni[item.klic];
        if (isValidBalikZamitnuti(zaznam, item)) {
          warnings.push(`Požadavek „${item.nazev}“ operátor zamítl: ${zaznam.duvod}.`);
          continue;
        }
        if (!item.povinny || item.status === 'pokryto') continue;
        const audit = potvrzeni[item.klic];
        let platnePotvrzeni = false;
        if (item.status === 'nejiste' && item.soubor && isValidBalikPotvrzeni(audit)) {
          try {
            const data = await readFile(join(outputDir, item.soubor));
            const hash = createHash('sha256').update(data).digest('hex');
            platnePotvrzeni = audit.soubor === item.soubor && audit.sha256 === hash
              && audit.pozadavek_fingerprint === pozadavekFingerprint(item);
          } catch {}
        }
        if (platnePotvrzeni && isValidBalikPotvrzeni(audit)) {
          warnings.push(`Ruční potvrzení pokrytí dokumentu „${item.nazev}“ (${audit.potvrdil}).`);
        } else if (item.status === 'nejiste') {
          const propadlo = isValidBalikPotvrzeni(audit) ? ' Potvrzení propadlo, dokumenty se změnily.' : '';
          problems.push(`Nelze spolehlivě ověřit požadovaný dokument „${item.nazev}“ — potvrďte ručně, že je pokryt.${propadlo}`);
        } else {
          problems.push(`Chybí povinný dokument požadovaný zadáním: ${item.nazev}.${item.poznamka ? ` ${item.poznamka}.` : ''}`);
        }
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      problems.push(`Nelze ověřit úplnost balíku: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Požadované kvalifikační sloty jsou součástí submit-gate, nejen informativního
  // checklistu v UI. Expirovaný firemní doklad proto blokuje finalizaci fail-closed.
  try {
    const analysis = JSON.parse(await readFile(join(outputDir, 'analysis.json'), 'utf-8'));
    const kvalifikace = analysis?.kvalifikace ?? analysis?.kvalifikacni_pozadavky;
    if (Array.isArray(kvalifikace) && kvalifikace.length > 0) {
      const meta = JSON.parse(await readFile(join(outputDir, 'tender-meta.json'), 'utf-8'));
      const companyId = typeof meta?.company_id === 'string' ? meta.company_id : null;
      const manifest = companyId
        ? await (options.getCompanyManifest ?? getDocManifest)(companyId)
        : { version: 1, entries: [] };
      let attachments: string[] = [];
      try { attachments = await readdir(join(outputDir, 'prilohy')); } catch {}
      // Manifest sám není součástí ZIPu. Metadata firemního dokladu použijeme jen
      // tehdy, když copy flow zanechal fyzický soubor v přílohách zakázky.
      const packagedManifest = { ...manifest, entries: manifest.entries.filter((entry) => attachments.includes(entry.filename)) };
      let vyjimky: KvalifikaceVyjimky = {};
      try { vyjimky = JSON.parse(await readFile(join(outputDir, 'kvalifikace-vyjimky.json'), 'utf-8')); } catch {}
      for (const item of buildPrilohaChecklist({ kvalifikace, manifest: packagedManifest, attachments, now: options.now })) {
        if (!item.povinny || (item.status !== 'chybi' && item.status !== 'po_platnosti')) continue;
        const vyjimka = vyjimky[item.slot];
        if (isValidKvalifikaceVyjimka(vyjimka)) {
          warnings.push(`Výjimka pro povinný kvalifikační doklad ${item.label}: ${vyjimka.duvod} (schválil ${vyjimka.schvalil}).`);
        } else if (item.status === 'chybi') {
          problems.push(`Chybí povinný kvalifikační doklad: ${item.label}.`);
        } else {
          problems.push(`Doklad ${item.label} je po platnosti.`);
        }
      }
    }
  } catch (error) {
    // Chybějící analýza znamená, že checklist nemá požadované sloty. Pokud ale
    // soubory existují a jsou nečitelné/poškozené, raději finalizaci zablokujeme.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      problems.push(`Nelze ověřit platnost kvalifikačních dokladů: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

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
    pricesUpdatedAt = typeof (pm as any).prices_updated_at === 'string'
      ? (pm as any).prices_updated_at
      : null;
    const allItems = pm.polozky_match || [];
    let declaredParts: Cast[] = [];
    try {
      const analysis = JSON.parse(await readFile(join(outputDir, 'analysis.json'), 'utf-8'));
      if (Array.isArray(analysis?.casti)) declaredParts = analysis.casti;
    } catch {
      // Chybějící analýzu řeší ostatní kontroly; bez ní nelze strop části vymýšlet.
    }
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
    const selectedPartIds = await loadSelectedPartIds(outputDir, allItems, declaredParts);
    const items = filterBySelectedParts(allItems, selectedPartIds);
    const recap = calculateTenderPriceRecap(pm, declaredParts, selectedPartIds);
    for (const item of recap.polozky_bez_cast_id) {
      warnings.push(`Položka „${item.polozka_nazev}“ (#${item.polozka_index + 1}) nemá u dělené zakázky cast_id a není zahrnuta v rekapitulaci žádné části.`);
    }
    const blockPartPriceCap = options.blockPartPriceCapExceeded ?? isPartPriceCapBlockingEnabled();
    const submittedParts = selectedPartIds
      ? declaredParts.filter((part) => selectedPartIds.has(part.id))
      : declaredParts;
    const submittedPartIds = new Set(submittedParts.map((part) => part.id));
    const submittedRecaps = recap.casti.filter((part) => submittedPartIds.has(part.id));
    for (const check of buildPartPriceCapValidationChecks(submittedParts, submittedRecaps, blockPartPriceCap)) {
      if (check.status === 'fail') problems.push(`${check.kontrola}: ${check.detail}`);
      else warnings.push(`${check.kontrola}: ${check.detail}`);
    }
    const sanityFindings = checkPriceSanity(items, {});
    const names = new Map(items.map((item) => [item.polozka_index, item.polozka_nazev]));
    for (const finding of sanityFindings) {
      const itemName = names.get(finding.polozka_index) ?? `Položka #${finding.polozka_index + 1}`;
      const detail = `Položka „${itemName}“: ${finding.message}`;
      if (finding.level === 'hard') problems.push(detail);
      else warnings.push(detail);
    }

    // Stejný money-gate jako přímé generate: každou vadnou položku vypíše
    // samostatně včetně konkrétního důvodu (potvrzení, doklad, typ, platnost).
    const priceGate = findUnconfirmedPrices(
      { ...pm, polozky_match: items },
      null,
      options.now ?? new Date(),
    );
    for (const issue of priceGate.issues) {
      problems.push(`Položka „${issue.name}“: ${issue.reasons.join('; ')}.`);
    }
    const confirmed = items.filter((i) => i.cenova_uprava?.potvrzeno);
    const legacyConfirmed = confirmed.filter((i) => !i.cenova_uprava?.zkontrolovano_at || !i.cenova_uprava?.zkontrolovano_kym);
    if (legacyConfirmed.length > 0) {
      // Starý soubor poznáme jen tehdy, když auditní stopa chybí u všech potvrzených
      // položek. Smí doběhnout, ale operátor dostane viditelné varování.
      if (confirmed.length > 0 && legacyConfirmed.length === confirmed.length) {
        warnings.push(`Legacy potvrzení: ${legacyConfirmed.length} položek nemá novou auditní stopu lidské kontroly.`);
      } else {
        problems.push(`${legacyConfirmed.length} potvrzených položek nemá úplnou auditní stopu lidské kontroly.`);
      }
    }
    if (!pm.polozky_match) {
      const singlePriceGate = findUnconfirmedPrices(pm, null, options.now ?? new Date());
      for (const issue of singlePriceGate.issues) {
        problems.push(`Položka „${issue.name}“: ${issue.reasons.join('; ')}.`);
      }
      if (pm.cenova_uprava?.potvrzeno
        && (!pm.cenova_uprava.zkontrolovano_at || !pm.cenova_uprava.zkontrolovano_kym)) {
        warnings.push('Legacy potvrzení: položka nemá novou auditní stopu lidské kontroly.');
      }
    }
  }

  // Stejný freshness princip jako GET status: poslední změna ceny nesmí být novější
  // než nejstarší dokument z generované dávky. Jinak by závazný ZIP obsahoval staré ceny.
  if (pricesUpdatedAt) {
    try {
      const generated = (await readdir(outputDir))
        .filter((file) => ['.docx', '.xlsx', '.pdf'].some((ext) => file.toLowerCase().endsWith(ext)));
      let oldestDocumentMs: number | null = null;
      for (const file of generated) {
        const fileStat = await stat(join(outputDir, file));
        if (oldestDocumentMs === null || fileStat.mtimeMs < oldestDocumentMs) {
          oldestDocumentMs = fileStat.mtimeMs;
        }
      }
      if (isStale(oldestDocumentMs, pricesUpdatedAt)) {
        problems.push(STALE_DOCUMENTS_MESSAGE);
      }
    } catch {
      // Chybějící dokumenty řeší field-validace; freshness zde nevyrábí falešné pozitivum.
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

  let structuredFillReport: FillReport | null = null;
  try {
    structuredFillReport = JSON.parse(await readFile(join(outputDir, 'fill-report.json'), 'utf-8')) as FillReport;
  } catch {
    // Starý výstup: níže použijeme původní obecnou kontrolu placeholderů.
  }

  // Zbytkové placeholdery ve vygenerovaných .docx. U nového strukturovaného
  // reportu rozhoduje klasifikace povinný/volitelný, aby volitelné pole neblokovalo.
  try {
    const docx = structuredFillReport ? [] : (await readdir(outputDir)).filter((f) => f.toLowerCase().endsWith('.docx'));
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

  // Strukturovaný report rozlišuje povinná a volitelná pole. Pokud u starého
  // výstupu neexistuje, zachováme původní kontroly výše beze změny.
  if (structuredFillReport) {
    const fillProblems = splitFillProblems(structuredFillReport);
    if (fillProblems.required.length) {
      problems.push(`Nevyplněná povinná pole: ${fillProblems.required.map((slot) => `${slot.dokument}: ${slot.klic}`).join(', ')}`);
    }
    if (fillProblems.optional.length) {
      warnings.push(`Nevyplněná volitelná pole: ${fillProblems.optional.map((slot) => `${slot.dokument}: ${slot.klic}`).join(', ')}`);
    }
  }

  return { ready: problems.length === 0, problems, warnings };
}
