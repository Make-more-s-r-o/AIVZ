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
import type { ProductMatch, PolozkaMatch } from './types.js';
import { checkPriceSanity } from './price-sanity.js';
import { docHasResidualPlaceholders } from './template-engine.js';
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

export interface SubmitGateOptions {
  now?: Date;
  getCompanyManifest?: (companyId: string) => Promise<DocManifest>;
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
      if (!pm.cenova_uprava?.potvrzeno) {
        problems.push('Položka nemá potvrzenou cenu.');
      } else if (!pm.cenova_uprava.zkontrolovano_at || !pm.cenova_uprava.zkontrolovano_kym) {
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
