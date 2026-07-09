import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  getProductMatch,
  getAnalysis,
  updatePriceOverride,
  updateItemPriceOverride,
  bulkUpdateItemPriceOverride,
  verifyPrices,
  getJobStatus,
  type PriceOverrideData,
} from '../lib/api';
import { cn } from '../lib/cn';
import { ChevronDown, ChevronRight, Package, Wrench, Mouse, Globe, ExternalLink, Loader2, CheckCheck } from 'lucide-react';
import ProductCandidateCard from './ProductCandidateCard';
import ItemPriceCalculator from './ItemPriceCalculator';
import { useToast } from './ui';
import { getErrorMessage } from '../types/tender';
import type { ProductMatch, TenderAnalysis, PolozkaMatch, ProductCandidate, OvereniCeny, PriceOverride } from '../types/tender';

interface ProductMatchViewProps {
  tenderId: string;
}

export default function ProductMatchView({ tenderId }: ProductMatchViewProps) {
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['product-match', tenderId],
    queryFn: () => getProductMatch(tenderId),
  });

  const { data: analysisData } = useQuery({
    queryKey: ['analysis', tenderId],
    queryFn: () => getAnalysis(tenderId),
  });

  const match = data as ProductMatch;
  const analysis = analysisData as TenderAnalysis | undefined;
  const budget = analysis?.zakazka?.predpokladana_hodnota ?? undefined;

  const isMultiItem = !!match?.polozky_match;
  const casti = analysis?.casti;

  if (isLoading) return <div className="py-8 text-center text-gray-500">Načítám produkty...</div>;
  if (error) return <div className="py-8 text-center text-gray-500">Produkty zatím nejsou k dispozici. Spusťte krok "Produkty".</div>;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <VerifyPricesHeader tenderId={tenderId} queryClient={queryClient} />
      {isMultiItem ? (
        <MultiItemView
          match={match}
          tenderId={tenderId}
          budget={budget}
          queryClient={queryClient}
          casti={casti}
        />
      ) : (
        <SingleItemView
          match={match}
          tenderId={tenderId}
          budget={budget}
          queryClient={queryClient}
        />
      )}
    </div>
  );
}

// --- Ověření cen web-searchem: hlavička s tlačítkem + polling jobu ---
interface VerifyPricesHeaderProps {
  tenderId: string;
  queryClient: QueryClient;
}

function VerifyPricesHeader({ tenderId, queryClient }: VerifyPricesHeaderProps) {
  const { toast } = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const logSeenRef = useRef(0);

  // Polling běžícího jobu (vzor PipelineStatus): inkrementální logy, poslední řádek = progress.
  useEffect(() => {
    if (!jobId) return;

    const interval = setInterval(async () => {
      try {
        const job = await getJobStatus(jobId, logSeenRef.current);
        if (job.logs.length > 0) {
          logSeenRef.current = job.totalLogLines;
          const tail = job.logs[job.logs.length - 1];
          if (tail) setProgress(tail);
        }

        if (job.status === 'done') {
          clearInterval(interval);
          setJobId(null);
          setProgress('');
          queryClient.invalidateQueries({ queryKey: ['product-match', tenderId] });
          toast('Ceny ověřeny z webu', 'success');
        } else if (job.status === 'error') {
          clearInterval(interval);
          setJobId(null);
          setProgress('');
          toast(job.error || 'Ověření cen selhalo', 'danger');
        }
      } catch {
        // Síťová chyba — pokračuj v pollingu.
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [jobId, tenderId, queryClient, toast]);

  const running = !!jobId;

  const handleVerify = useCallback(async () => {
    if (running) return; // Druhé kliknutí během běhu ignoruj.
    logSeenRef.current = 0;
    setProgress('Spouštím ověření cen…');
    try {
      const { jobId: id } = await verifyPrices(tenderId);
      setJobId(id);
    } catch (err: unknown) {
      setProgress('');
      toast(getErrorMessage(err), 'danger');
    }
  }, [running, tenderId, toast]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-xs text-gray-500">
        {running ? (
          <span className="inline-flex items-center gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            {progress || 'Ověřuji ceny…'}
          </span>
        ) : (
          'Dohledá aktuální tržní ceny položek na webu jako podklad — ceny potvrzujete ručně.'
        )}
      </div>
      <button
        onClick={handleVerify}
        disabled={running}
        className={cn(
          'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
          running
            ? 'cursor-not-allowed border-gray-200 bg-gray-50 text-gray-400'
            : 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
        )}
      >
        {running
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <Globe className="h-3.5 w-3.5" />}
        {running ? 'Ověřuji ceny…' : 'Ověřit ceny (web)'}
      </button>
    </div>
  );
}

/**
 * Sanitizace URL pro render jako href / skládání do textu. Backend `zdroj_url` už čistí
 * u zdroje (price-verifier.ts), tohle je druhá vrstva (defense-in-depth) — cokoli, co není
 * absolutní http(s) URL (např. `javascript:`), zahodíme, aby se nedalo zneužít k XSS.
 */
function safeHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

/**
 * Sestaví cenový návrh (PriceOverride) z web ceny pro předvyplnění cenového panelu.
 * potvrzeno=false — potvrzení dělá uživatel ručně jako dnes. Chybí-li bez DPH, dopočítá se
 * z ceny s DPH (a naopak) sazbou 21 %.
 */
function buildDraftFromWeb(overeni: OvereniCeny): PriceOverride {
  const bez = overeni.web_cena_bez_dph
    ?? (overeni.web_cena_s_dph != null ? Math.round(overeni.web_cena_s_dph / 1.21) : 0);
  const sdph = overeni.web_cena_s_dph ?? Math.round(bez * 1.21);
  const safeUrl = safeHttpUrl(overeni.zdroj_url);
  return {
    nakupni_cena_bez_dph: bez,
    nakupni_cena_s_dph: sdph,
    marze_procent: 0,
    nabidkova_cena_bez_dph: bez,
    nabidkova_cena_s_dph: sdph,
    potvrzeno: false,
    poznamka: safeUrl ? `Cena z webu: ${safeUrl}` : 'Cena z webu',
  };
}

/**
 * Sestaví data pro potvrzení ceny jedné položky (pro hromadné „Potvrdit"). Zdroj v pořadí priority:
 * web-draft (pokud si operátor „Použít" web cenu) → již existující cenova_uprava → AI odhad
 * (cena_bez_dph vybraného kandidáta). Marže se přebírá z draftu/úpravy, jinak 0. Počítá stejně
 * jako ItemPriceCalculator (jednotný money-path). Vrací null, pokud položku nelze ocenit
 * (chybí kandidát nebo nákupní cena ≤ 0) — takovou hromadné potvrzení přeskočí.
 */
function buildConfirmData(pm: PolozkaMatch, draft?: PriceOverride): PriceOverrideData | null {
  const product = pm.kandidati[pm.vybrany_index] as ProductCandidate | undefined;
  const existing = pm.cenova_uprava;
  const nakupni = draft?.nakupni_cena_bez_dph ?? existing?.nakupni_cena_bez_dph ?? product?.cena_bez_dph ?? 0;
  if (!(nakupni > 0)) return null;
  const marze = draft?.marze_procent ?? existing?.marze_procent ?? 0;
  const nabidkovaBez = Math.round(nakupni * (1 + marze / 100));
  return {
    nakupni_cena_bez_dph: nakupni,
    nakupni_cena_s_dph: Math.round(nakupni * 1.21),
    marze_procent: marze,
    nabidkova_cena_bez_dph: nabidkovaBez,
    nabidkova_cena_s_dph: Math.round(nabidkovaBez * 1.21),
    potvrzeno: true,
    poznamka: draft?.poznamka ?? existing?.poznamka ?? undefined,
  };
}

// --- Kompaktní chip s ověřenou webovou cenou + tlačítko „Použít" ---
interface OvereniCenyChipProps {
  overeni: OvereniCeny;
  onUse: () => void;
}

function OvereniCenyChip({ overeni, onUse }: OvereniCenyChipProps) {
  if (overeni.stav === 'nalezeno') {
    const cenaSdph = overeni.web_cena_s_dph
      ?? (overeni.web_cena_bez_dph != null ? Math.round(overeni.web_cena_bez_dph * 1.21) : undefined);
    return (
      <div className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-xs',
        overeni.prekracuje_strop ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'
      )}>
        <Globe className="h-3.5 w-3.5 shrink-0 text-gray-500" />
        <span className="font-medium text-gray-800">
          Web: {cenaSdph != null ? `${cenaSdph.toLocaleString('cs-CZ')} Kč s DPH` : '—'}
        </span>
        {overeni.dodavatel && <span className="text-gray-500">· {overeni.dodavatel}</span>}
        {overeni.dostupnost && <span className="text-gray-500">· {overeni.dostupnost}</span>}
        {overeni.prekracuje_strop && (
          <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
            NAD STROP
          </span>
        )}
        {safeHttpUrl(overeni.zdroj_url) && (
          <a
            href={safeHttpUrl(overeni.zdroj_url)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-blue-600 hover:underline"
          >
            zdroj <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <button
          onClick={onUse}
          className="ml-auto rounded border border-blue-300 bg-white px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-50"
        >
          Použít
        </button>
      </div>
    );
  }

  // nenalezeno → šedý chip, chyba → žlutý chip
  const isChyba = overeni.stav === 'chyba';
  return (
    <div className={cn(
      'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-xs',
      isChyba ? 'border-amber-200 bg-amber-50 text-amber-800' : 'border-gray-200 bg-gray-50 text-gray-500'
    )}>
      <Globe className="h-3.5 w-3.5 shrink-0" />
      <span>{isChyba ? 'Ověření ceny selhalo' : 'Cena na webu nenalezena'}</span>
      {overeni.poznamka && <span>· {overeni.poznamka}</span>}
    </div>
  );
}

// --- Single item (legacy) view ---
interface SingleItemViewProps {
  match: ProductMatch;
  tenderId: string;
  budget?: number;
  queryClient: QueryClient;
}

function SingleItemView({ match, tenderId, budget, queryClient }: SingleItemViewProps) {
  const selectedProduct = match?.kandidati?.[match?.vybrany_index ?? 0];
  const existingOverride = match?.cenova_uprava;
  const overeni = match?.overeni_ceny;
  // Návrh ceny z webu předvyplněný přes „Použít"; přednost před cenova_uprava do potvrzení.
  const [webDraft, setWebDraft] = useState<PriceOverride | null>(null);

  const handleConfirm = useCallback(async (priceData: PriceOverrideData) => {
    await updatePriceOverride(tenderId, priceData);
    queryClient.invalidateQueries({ queryKey: ['product-match', tenderId] });
  }, [tenderId, queryClient]);

  return (
    <div className="space-y-6">
      {match.oduvodneni_vyberu && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <span className="font-medium">Odůvodnění výběru:</span> {match.oduvodneni_vyberu}
        </div>
      )}

      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {match.kandidati?.map((product: ProductCandidate, i: number) => (
          <ProductCandidateCard
            key={i}
            product={product}
            isSelected={i === match.vybrany_index}
          />
        ))}
      </div>

      {overeni && (
        <OvereniCenyChip
          overeni={overeni}
          onUse={() => setWebDraft(buildDraftFromWeb(overeni))}
        />
      )}

      {selectedProduct && (
        <ItemPriceCalculator
          selectedProduct={selectedProduct}
          existingOverride={webDraft ?? existingOverride}
          budget={budget}
          onConfirm={async (data) => { await handleConfirm(data); setWebDraft(null); }}
          label="Cenová kalkulace"
        />
      )}
    </div>
  );
}

// --- Multi-item (polozky_match) view ---
interface MultiItemViewProps {
  match: ProductMatch;
  tenderId: string;
  budget?: number;
  queryClient: QueryClient;
  casti?: TenderAnalysis['casti'];
}

function MultiItemView({ match, tenderId, budget, queryClient, casti }: MultiItemViewProps) {
  const { toast } = useToast();
  const [expandedItems, setExpandedItems] = useState<Set<number>>(() => new Set([0]));
  // Návrhy cen z webu předvyplněné přes „Použít" — mají přednost před perzistovanou
  // cenova_uprava v panelu, dokud je uživatel nepotvrdí (pak se draft zahodí).
  const [priceDrafts, setPriceDrafts] = useState<Map<number, PriceOverride>>(() => new Map());
  // Hromadné potvrzení cen: výběr řádků (checkboxy) + probíhající uložení.
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [bulkSaving, setBulkSaving] = useState(false);

  const toggleSelect = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleItem = (index: number) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleUseWebPrice = (itemIndex: number, overeni: OvereniCeny) => {
    setPriceDrafts(prev => new Map(prev).set(itemIndex, buildDraftFromWeb(overeni)));
    setExpandedItems(prev => new Set(prev).add(itemIndex)); // rozbal, ať je panel vidět
  };

  const clearDraft = (itemIndex: number) => {
    setPriceDrafts(prev => {
      if (!prev.has(itemIndex)) return prev;
      const next = new Map(prev);
      next.delete(itemIndex);
      return next;
    });
  };

  const handleItemConfirm = useCallback(async (itemIndex: number, priceData: PriceOverrideData) => {
    await updateItemPriceOverride(tenderId, itemIndex, priceData);
    queryClient.invalidateQueries({ queryKey: ['product-match', tenderId] });
  }, [tenderId, queryClient]);

  const polozky = match.polozky_match!;

  // Total confirmed price
  const totalBezDph = polozky.reduce((sum: number, pm: PolozkaMatch) => {
    const product = pm.kandidati[pm.vybrany_index] as ProductCandidate | undefined;
    const override = pm.cenova_uprava;
    const price = override?.nabidkova_cena_bez_dph ?? product?.cena_bez_dph ?? 0;
    const mnozstvi = pm.mnozstvi || 1;
    return sum + price * mnozstvi;
  }, 0);
  const totalSdph = Math.round(totalBezDph * 1.21);

  const allConfirmed = polozky.every((pm) => pm.cenova_uprava?.potvrzeno);
  const confirmedCount = polozky.filter((pm) => pm.cenova_uprava?.potvrzeno).length;

  // Indexy nepotvrzených položek (pořadí = index v poli polozky, což používá i per-item confirm).
  const unconfirmedIndices = polozky
    .map((pm, i) => (pm.cenova_uprava?.potvrzeno ? -1 : i))
    .filter((i) => i >= 0);

  // Hromadné potvrzení: pro každou vybranou položku dopočítá cenu (buildConfirmData) a pošle
  // JEDNÍM requestem (bulk endpoint, transakčně nad souborem). Položky bez ceny přeskočí.
  const confirmBulk = useCallback(async (indices: number[]) => {
    if (bulkSaving) return;
    const payload: Array<{ itemIndex: number; cenova_uprava: PriceOverrideData }> = [];
    let skipped = 0;
    for (const idx of indices) {
      const pm = polozky[idx];
      if (!pm) continue;
      const data = buildConfirmData(pm, priceDrafts.get(idx));
      if (!data) { skipped++; continue; }
      payload.push({ itemIndex: idx, cenova_uprava: data });
    }
    if (payload.length === 0) {
      toast(skipped > 0 ? 'Vybrané položky nelze automaticky ocenit (chybí cena)' : 'Není co potvrdit', 'danger');
      return;
    }
    setBulkSaving(true);
    try {
      const { updated } = await bulkUpdateItemPriceOverride(tenderId, payload);
      // Web-drafty potvrzených položek zahoď (stejně jako po per-item potvrzení).
      setPriceDrafts((prev) => {
        const next = new Map(prev);
        for (const p of payload) next.delete(p.itemIndex);
        return next;
      });
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['product-match', tenderId] });
      toast(`Potvrzeno ${updated} položek${skipped ? ` (${skipped} přeskočeno — bez ceny)` : ''}`, 'success');
    } catch (err: unknown) {
      toast(getErrorMessage(err), 'danger');
    } finally {
      setBulkSaving(false);
    }
  }, [bulkSaving, polozky, priceDrafts, tenderId, queryClient, toast]);

  // Group items by part if multi-part
  const hasPartGroups = casti && casti.length > 1 && polozky.some((pm) => pm.cast_id);
  const castiMap = new Map(casti?.map(c => [c.id, c]) || []);

  // Build grouped structure: [{castId, castName, items: [{pm, globalIdx}]}]
  let groups: Array<{ castId: string | null; castName: string | null; items: Array<{ pm: PolozkaMatch; globalIdx: number }> }>;
  if (hasPartGroups) {
    const groupMap = new Map<string, Array<{ pm: PolozkaMatch; globalIdx: number }>>();
    const order: string[] = [];
    for (let idx = 0; idx < polozky.length; idx++) {
      const pm = polozky[idx]!;
      const key = pm.cast_id || '__none__';
      if (!groupMap.has(key)) {
        groupMap.set(key, []);
        order.push(key);
      }
      groupMap.get(key)!.push({ pm, globalIdx: idx });
    }
    groups = order.map(key => ({
      castId: key === '__none__' ? null : key,
      castName: key === '__none__' ? null : (castiMap.get(key)?.nazev || `Část ${key}`),
      items: groupMap.get(key)!,
    }));
  } else {
    groups = [{ castId: null, castName: null, items: polozky.map((pm, idx) => ({ pm, globalIdx: idx })) }];
  }

  return (
    <div className="space-y-4">
      {/* Summary bar */}
      <div className={cn(
        'rounded-lg border px-4 py-3 flex items-center justify-between',
        allConfirmed ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-gray-50'
      )}>
        <div className="flex items-center gap-3">
          <Package className="h-5 w-5 text-gray-500" />
          <div>
            <div className="text-sm font-medium">
              {polozky.length} {polozky.length === 1 ? 'položka' : polozky.length < 5 ? 'položky' : 'položek'}
            </div>
            <div className="text-xs text-gray-500">
              Potvrzeno: {confirmedCount}/{polozky.length}
            </div>
          </div>
        </div>
        <div className="text-right">
          <div className="text-xs text-gray-500">Celková cena</div>
          <div className="text-lg font-bold">
            {totalBezDph.toLocaleString('cs-CZ')} Kč
          </div>
          <div className="text-xs text-gray-500">
            s DPH: {totalSdph.toLocaleString('cs-CZ')} Kč
          </div>
        </div>
      </div>

      {/* Budget comparison */}
      {budget && totalBezDph > budget && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>
            Celková cena ({totalBezDph.toLocaleString('cs-CZ')} Kč) překračuje rozpočet zakázky ({budget.toLocaleString('cs-CZ')} Kč).
          </span>
        </div>
      )}

      {/* Hromadné potvrzení cen — zobraz jen dokud zbývá nepotvrzená položka. */}
      {!allConfirmed && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2">
          <span className="text-xs font-medium text-gray-700">
            {selected.size > 0
              ? `Vybráno ${selected.size} z ${polozky.length}`
              : `Nepotvrzeno ${unconfirmedIndices.length} položek`}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {selected.size > 0 && (
              <button
                onClick={() => setSelected(new Set())}
                disabled={bulkSaving}
                className="rounded-md border border-gray-300 bg-white px-2.5 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
              >
                Zrušit výběr
              </button>
            )}
            <button
              onClick={() => confirmBulk([...selected])}
              disabled={bulkSaving || selected.size === 0}
              className="inline-flex items-center gap-1.5 rounded-md border border-blue-300 bg-white px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bulkSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              Potvrdit vybrané ({selected.size})
            </button>
            <button
              onClick={() => confirmBulk(unconfirmedIndices)}
              disabled={bulkSaving || unconfirmedIndices.length === 0}
              className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {bulkSaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
              Potvrdit vše ({unconfirmedIndices.length})
            </button>
          </div>
        </div>
      )}

      {/* Grouped accordion items */}
      {groups.map((group, gi) => (
        <div key={gi} className="space-y-2">
          {group.castName && (
            <div className="flex items-center gap-2 border-b border-gray-200 pb-1 pt-2">
              <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-800">
                {group.castName}
              </span>
              <span className="text-xs text-gray-500">
                ({group.items.length} {group.items.length === 1 ? 'položka' : group.items.length < 5 ? 'položky' : 'položek'})
              </span>
            </div>
          )}
      {group.items.map(({ pm, globalIdx: idx }) => {
        const isExpanded = expandedItems.has(idx);
        const selectedProduct = pm.kandidati[pm.vybrany_index];
        const isItemConfirmed = pm.cenova_uprava?.potvrzeno;
        const itemType = pm.typ || 'produkt';
        const TypeIcon = itemType === 'sluzba' ? Wrench : itemType === 'prislusenstvi' ? Mouse : Package;
        const typeBadge = itemType === 'sluzba' ? 'Služba' : itemType === 'prislusenstvi' ? 'Příslušenství' : null;
        const typeBadgeColor = itemType === 'sluzba' ? 'bg-purple-100 text-purple-700' : 'bg-cyan-100 text-cyan-700';

        return (
          <div key={idx} className={cn(
            'rounded-lg border',
            isItemConfirmed ? 'border-green-200' : 'border-gray-200'
          )}>
            {/* Accordion header + checkbox pro hromadné potvrzení (mimo <button>, aby klik
                na checkbox nerozbaloval řádek) */}
            <div className="flex items-center">
            <input
              type="checkbox"
              checked={selected.has(idx)}
              onChange={() => toggleSelect(idx)}
              aria-label={`Vybrat položku ${pm.polozka_nazev}`}
              className="ml-4 h-4 w-4 shrink-0 cursor-pointer accent-blue-600"
            />
            <button
              onClick={() => toggleItem(idx)}
              className="flex-1 flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors rounded-lg"
            >
              <div className="flex items-center gap-3">
                {isExpanded
                  ? <ChevronDown className="h-4 w-4 text-gray-400" />
                  : <ChevronRight className="h-4 w-4 text-gray-400" />
                }
                <TypeIcon className="h-4 w-4 text-gray-400" />
                <div className="text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{pm.polozka_nazev}</span>
                    {typeBadge && (
                      <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', typeBadgeColor)}>
                        {typeBadge}
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-gray-500">
                    {pm.mnozstvi ? `${pm.mnozstvi} ${pm.jednotka || 'ks'}` : ''}
                    {selectedProduct && itemType !== 'sluzba' && ` — ${selectedProduct.vyrobce} ${selectedProduct.model}`}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {pm.overeni_ceny?.stav === 'nalezeno' && pm.overeni_ceny.prekracuje_strop && (
                  <span className="rounded bg-red-100 px-2 py-0.5 text-[10px] font-semibold text-red-700">
                    NAD STROP
                  </span>
                )}
                {isItemConfirmed && (
                  <span className="rounded bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-800">
                    Potvrzeno
                  </span>
                )}
                <div className="text-right">
                  {pm.mnozstvi && pm.mnozstvi > 1 ? (
                    <>
                      <div className="text-sm font-semibold">
                        {((pm.cenova_uprava?.nabidkova_cena_bez_dph ?? selectedProduct?.cena_bez_dph ?? 0) * pm.mnozstvi).toLocaleString('cs-CZ')} Kč
                      </div>
                      <div className="text-[10px] text-gray-400">
                        {(pm.cenova_uprava?.nabidkova_cena_bez_dph ?? selectedProduct?.cena_bez_dph)?.toLocaleString('cs-CZ')}/{pm.jednotka || 'ks'} × {pm.mnozstvi}
                      </div>
                    </>
                  ) : (
                    <div className="text-sm font-semibold">
                      {(pm.cenova_uprava?.nabidkova_cena_bez_dph ?? selectedProduct?.cena_bez_dph)?.toLocaleString('cs-CZ')} Kč
                    </div>
                  )}
                </div>
              </div>
            </button>
            </div>

            {/* Accordion content */}
            {isExpanded && (
              <div className="border-t px-4 py-4 space-y-4">
                {pm.oduvodneni_vyberu && (
                  <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800">
                    <span className="font-medium">Odůvodnění:</span> {pm.oduvodneni_vyberu}
                  </div>
                )}

                <div className="grid gap-3 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                  {pm.kandidati.map((product: ProductCandidate, i: number) => (
                    <ProductCandidateCard
                      key={i}
                      product={product}
                      isSelected={i === pm.vybrany_index}
                    />
                  ))}
                </div>

                {pm.overeni_ceny && (
                  <OvereniCenyChip
                    overeni={pm.overeni_ceny}
                    onUse={() => handleUseWebPrice(idx, pm.overeni_ceny!)}
                  />
                )}

                {selectedProduct && (
                  <ItemPriceCalculator
                    selectedProduct={selectedProduct}
                    existingOverride={priceDrafts.get(idx) ?? pm.cenova_uprava}
                    budget={undefined}
                    onConfirm={async (data) => { await handleItemConfirm(idx, data); clearDraft(idx); }}
                    label={`Cenová kalkulace: ${pm.polozka_nazev}`}
                    mnozstvi={pm.mnozstvi}
                    jednotka={pm.jednotka}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
        </div>
      ))}
    </div>
  );
}
