/** Čistá logika Outcome Watcheru a parser veřejné NEN podstránky `/vysledek`. */
import { load } from 'cheerio';
import { fetchAllowedNenUrl, isAllowedNenUrl } from './monitoring/nen-client.js';

export interface TenderProSledovani {
  tender_id: string;
  zdroj_id: string;
  nazev: string;
  zadavatel: string | null;
  url: string;
}

export interface OutcomeCandidateInput {
  tender_id: string;
  zdroj: 'nen';
  zdroj_id: string;
  vitez_nazev: string | null;
  vitez_ico: string | null;
  vitezna_cena_bez_dph: number | null;
  pocet_uchazecu: number | null;
  url: string;
  shoda_skore: number;
  raw: Record<string, unknown>;
}

export interface NenOutcome {
  vitez_nazev: string | null;
  vitezna_cena_bez_dph: number | null;
  pocet_uchazecu: number | null;
  ucastnici: string[];
}

/** Již lidsky uložený výsledek watcher nikdy znovu nezpracovává. */
export function isWatcherEligible(status: string, hasConfirmedOutcome: boolean): boolean {
  return status === 'odeslana' && !hasConfirmedOutcome;
}

function text(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function cena(value: string): number | null {
  const normalized = text(value).replace(/\s/g, '').replace(',', '.').replace(/[^\d.-]/g, '');
  const parsed = Number(normalized);
  return normalized && Number.isFinite(parsed) ? parsed : null;
}

/** Parsuje pouze veřejně zobrazené tabulky; chybějící výsledek vrátí jako null. */
export function parseNenOutcome(html: string): NenOutcome | null {
  const $ = load(html);
  let vitezNazev: string | null = null;
  let viteznaCena: number | null = null;
  const ucastnici: string[] = [];

  $('h2, h3').each((_, heading) => {
    const title = text($(heading).text());
    // NEN tabulku podle verze šablony buď vloží přímo, nebo do obalového <div>.
    const siblings = $(heading).nextAll();
    const table = siblings.filter('table').add(siblings.find('table')).first();
    if (!table.length) return;
    if (/Dodavatelé, s nimiž byla smlouva uzavřena/i.test(title)) {
      const row = table.find('tbody tr').first();
      if (!row.length) return;
      vitezNazev = text(row.find('[data-title="Úřední název"]').text()) || null;
      viteznaCena = cena(row.find('[data-title="Smluvní cena bez DPH"]').text());
    }
    if (/Seznam účastníků/i.test(title)) {
      table.find('tbody tr').each((__, row) => {
        const name = text($(row).find('[data-title="Úřední název"]').text());
        if (name) ucastnici.push(name);
        const selected = text($(row).find('[data-title="Dodavatel byl vybrán"]').text());
        if (!vitezNazev && /^Ano$/i.test(selected)) {
          vitezNazev = name || null;
          viteznaCena = cena($(row).find('[data-title="Nabídková cena bez DPH"]').text());
        }
      });
    }
  });
  if (!vitezNazev && viteznaCena == null && ucastnici.length === 0) return null;
  return { vitez_nazev: vitezNazev, vitezna_cena_bez_dph: viteznaCena, pocet_uchazecu: ucastnici.length || null, ucastnici };
}

function tokens(value: string): Set<string> {
  const normalized = value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  return new Set(normalized.split(/[^a-z0-9]+/).filter((part) => part.length >= 3));
}

/** Jaccard názvu (80 %) + shoda zadavatele (20 %); výsledek 0–1. */
export function scoreOutcomeMatch(
  tender: Pick<TenderProSledovani, 'nazev' | 'zadavatel'>,
  source: { nazev: string; zadavatel: string | null },
): number {
  const a = tokens(tender.nazev); const b = tokens(source.nazev);
  const intersection = [...a].filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  const titleScore = union ? intersection / union : 0;
  const zadavatelScore = tender.zadavatel && source.zadavatel
    ? text(tender.zadavatel).localeCompare(text(source.zadavatel), 'cs', { sensitivity: 'base' }) === 0 ? 1 : 0
    : 0;
  return Math.round((titleScore * 0.8 + zadavatelScore * 0.2) * 1000) / 1000;
}

export function nenOutcomeUrl(detailUrl: string): string | null {
  if (!isAllowedNenUrl(detailUrl)) return null;
  const url = new URL(detailUrl);
  const match = url.pathname.match(/^(\/verejne-zakazky\/detail-zakazky\/[^/]+)/);
  if (!match) return null;
  url.pathname = `${match[1]}/vysledek`;
  url.search = '';
  return url.toString();
}

export async function findNenOutcome(tender: TenderProSledovani, fetchFn: typeof fetch = fetch): Promise<OutcomeCandidateInput | null> {
  const url = nenOutcomeUrl(tender.url);
  if (!url) return null;
  try {
    const response = await fetchAllowedNenUrl(url, fetchFn, { headers: { Accept: 'text/html', 'User-Agent': 'vz-ai-tool/outcome-watcher' } });
    if (!response.ok) return null;
    const parsed = parseNenOutcome(await response.text());
    if (!parsed?.vitez_nazev) return null;
    return {
      tender_id: tender.tender_id, zdroj: 'nen', zdroj_id: tender.zdroj_id,
      vitez_nazev: parsed.vitez_nazev, vitez_ico: null,
      vitezna_cena_bez_dph: parsed.vitezna_cena_bez_dph,
      pocet_uchazecu: parsed.pocet_uchazecu, url,
      shoda_skore: 1, raw: { ucastnici: parsed.ucastnici },
    };
  } catch { return null; }
}
