import { useState, useCallback, useEffect, useRef } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  getProductMatch,
  getAnalysis,
  getPricingDefaults,
  updatePriceOverride,
  updateItemPriceOverride,
  bulkUpdateItemPriceOverride,
  resumeRunAll,
  selectProductCandidate,
  verifyPrices,
  getJobStatus,
  JobNotFoundError,
  type PriceOverrideData,
  type WinPriceBand,
} from '../lib/api';
import { cn } from '../lib/cn';
import { AlertTriangle, ChevronDown, ChevronRight, Package, Wrench, Mouse, Globe, ExternalLink, Loader2, CheckCheck } from 'lucide-react';
import ProductCandidateCard from './ProductCandidateCard';
import ItemPriceCalculator from './ItemPriceCalculator';
import { useToast } from './ui';
import { getErrorMessage } from '../types/tender';
import type { ProductMatch, TenderAnalysis, PolozkaMatch, ProductCandidate, OvereniCeny, PriceOverride } from '../types/tender';
import { safeHttpUrl } from '../lib/url';
import { calculateItemPrice, roundCurrency, DEFAULT_MARZE_PROCENT } from '../lib/price-calculator';
import { invalidatePriceDerivedQueries } from '../lib/product-match-invalidation';
import { buildDraftFromWeb, webPriceInputFromVerification, withPriceDraft } from '../lib/web-price';

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

  // Výchozí marže z nastavení firmy zakázky. staleTime Infinity — mění se jen
  // v Nastavení firmy; do načtení (nebo při chybě) platí zrcadlený fallback 10 %.
  const { data: pricingDefaults } = useQuery({
    queryKey: ['pricing-defaults', tenderId],
    queryFn: () => getPricingDefaults(tenderId),
    staleTime: Infinity,
  });
  const defaultMarze = pricingDefaults?.default_marze_procent ?? DEFAULT_MARZE_PROCENT;

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
          defaultMarze={defaultMarze}
        />
      ) : (
        <SingleItemView
          match={match}
          tenderId={tenderId}
          budget={budget}
          queryClient={queryClient}
          historySubject={analysis?.polozky?.[0]?.nazev ?? analysis?.zakazka?.predmet}
          defaultMarze={defaultMarze}
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

// Kolik po sobě jdoucích síťových výpadků pollingu tolerovat, než spinner vzdáme
// (2500 ms interval → ~75 s). Stejný princip jako v PipelineStatus.
const MAX_FAILED_POLLS = 30;

function VerifyPricesHeader({ tenderId, queryClient }: VerifyPricesHeaderProps) {
  const { toast } = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>('');
  const logSeenRef = useRef(0);
  // Počítadlo po sobě jdoucích síťových výpadků pollingu (úspěšný poll ho vynuluje),
  // ať spinner netočí donekonečna při delším výpadku spojení.
  const failedPollsRef = useRef(0);

  // Polling běžícího jobu (vzor PipelineStatus): inkrementální logy, poslední řádek = progress.
  useEffect(() => {
    if (!jobId) return;

    const interval = setInterval(async () => {
      try {
        const job = await getJobStatus(jobId, logSeenRef.current);
        failedPollsRef.current = 0; // úspěšný poll → vynuluj počítadlo výpadků
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
      } catch (err) {
        // Zastav spinner a vyčisti stav (společné pro oba fatální případy níže).
        const giveUp = (message: string) => {
          clearInterval(interval);
          setJobId(null);
          setProgress('');
          failedPollsRef.current = 0;
          toast(message, 'danger');
        };

        if (err instanceof JobNotFoundError) {
          // 404 — úloha zmizela ze serveru (nejčastěji restart/deploy během běhu). Dřív to
          // bare catch spolkl a tlačítko viselo na „Ověřuji ceny…" navždy. Teď zastav a nabídni restart.
          giveUp('Ověření cen bylo ztraceno — server se pravděpodobně restartoval (deploy). Spusťte ověření znovu.');
          return;
        }

        // Síťová chyba — pollovat dál, ale s limitem, ať spinner netočí donekonečna.
        failedPollsRef.current += 1;
        if (failedPollsRef.current >= MAX_FAILED_POLLS) {
          giveUp('Ztráta spojení se serverem během ověřování cen. Spusťte ověření znovu.');
        }
      }
    }, 2500);

    return () => clearInterval(interval);
  }, [jobId, tenderId, queryClient, toast]);

  const running = !!jobId;

  const handleVerify = useCallback(async () => {
    if (running) return; // Druhé kliknutí během běhu ignoruj.
    logSeenRef.current = 0;
    failedPollsRef.current = 0;
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
 * Sestaví data pro potvrzení ceny jedné položky (pro hromadné „Potvrdit"). Zdroj v pořadí priority:
 * web-draft (pokud si operátor „Použít" web cenu) → již existující cenova_uprava → AI odhad
 * (cena_bez_dph vybraného kandidáta). Počítá stejně jako ItemPriceCalculator (jednotný
 * money-path). Vrací null, pokud položku nelze ocenit (chybí kandidát nebo nákupní
 * cena ≤ 0) — takovou hromadné potvrzení přeskočí.
 *
 * Marže se resolvuje takto:
 *  - draft má přednost (draft z webu teď nese výchozí marži firmy, ne 0),
 *  - potvrzenou existující marži respektuj i když je 0 — tu operátor potvrdil vědomě,
 *  - NEpotvrzená nula je „otrávený default" (AI-prefill ve starých prod datech),
 *    ne rozhodnutí operátora → nahraď ji výchozí marží firmy,
 *  - nepotvrzená kladná marže se respektuje (operátor ji nastavil, jen nepotvrdil),
 *  - bez existující úpravy → výchozí marže firmy.
 */
function buildConfirmData(
  pm: PolozkaMatch,
  draft: PriceOverride | undefined,
  defaultMarze: number,
): PriceOverrideData | null {
  const product = pm.kandidati[pm.vybrany_index] as ProductCandidate | undefined;
  const existing = pm.cenova_uprava;
  const nakupni = draft?.nakupni_cena_bez_dph ?? existing?.nakupni_cena_bez_dph ?? product?.cena_bez_dph ?? 0;
  if (!(nakupni > 0)) return null;
  let marze: number;
  if (draft) {
    marze = draft.marze_procent;
  } else if (existing) {
    marze = !existing.potvrzeno && existing.marze_procent === 0
      ? defaultMarze
      : existing.marze_procent;
  } else {
    marze = defaultMarze;
  }
  const calculatedPrice = calculateItemPrice(nakupni, marze);
  return {
    ...calculatedPrice,
    potvrzeno: true,
    poznamka: draft?.poznamka ?? existing?.poznamka ?? undefined,
    zdroj_nakupu: draft?.zdroj_nakupu ?? existing?.zdroj_nakupu,
    override_pod_nakupem: draft?.override_pod_nakupem ?? existing?.override_pod_nakupem,
  };
}

// --- Kompaktní chip s ověřenou webovou cenou + tlačítko „Použít" ---
interface OvereniCenyChipProps {
  overeni: OvereniCeny;
  onUse: () => void;
}

function OvereniCenyChip({ overeni, onUse }: OvereniCenyChipProps) {
  if (overeni.stav === 'nalezeno' || overeni.stav === 'ekvivalent') {
    const cenaSdph = overeni.web_cena_s_dph
      ?? (overeni.web_cena_bez_dph != null ? calculateItemPrice(overeni.web_cena_bez_dph, 0).nakupni_cena_s_dph : undefined);
    return (
      <div className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-xs',
        overeni.prekracuje_strop ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'
      )}>
        <Globe className="h-3.5 w-3.5 shrink-0 text-gray-500" />
        <span className="font-medium text-gray-800">
          Web: {cenaSdph != null ? `${cenaSdph.toLocaleString('cs-CZ')} Kč s DPH` : '—'}
        </span>
        {overeni.shoda_typ === 'ekvivalent' && (
          <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">EKVIVALENT</span>
        )}
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
        {!overeni.zdroje?.length && (
          <button
            onClick={onUse}
            className="ml-auto rounded border border-blue-300 bg-white px-2 py-0.5 text-[11px] font-medium text-blue-700 hover:bg-blue-50"
          >
            Použít
          </button>
        )}
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
  historySubject?: string;
  defaultMarze: number;
}

function SingleItemView({ match, tenderId, budget, queryClient, historySubject, defaultMarze }: SingleItemViewProps) {
  const { toast } = useToast();
  const selectedProduct = match?.kandidati?.[match?.vybrany_index ?? 0];
  const existingOverride = match?.cenova_uprava;
  const overeni = match?.overeni_ceny;
  // Návrh ceny z webu předvyplněný přes „Použít"; přednost před cenova_uprava do potvrzení.
  const [webDraft, setWebDraft] = useState<PriceOverride | null>(null);
  const [selecting, setSelecting] = useState(false);

  const handleConfirm = useCallback(async (priceData: PriceOverrideData) => {
    await updatePriceOverride(tenderId, priceData);
    await invalidatePriceDerivedQueries(queryClient, tenderId);
  }, [tenderId, queryClient]);

  // Legacy single-product: itemIndex se na backendu ignoruje, posíláme -1 (konvence jako verify-prices).
  const handleSelect = useCallback(async (candidateIndex: number) => {
    if (selecting) return;
    setSelecting(true);
    try {
      const { priceCleared } = await selectProductCandidate(tenderId, -1, candidateIndex);
      await invalidatePriceDerivedQueries(queryClient, tenderId);
      if (priceCleared) toast('Vybrán jiný produkt — cenu je potřeba znovu potvrdit', 'info');
    } catch (err: unknown) {
      toast(getErrorMessage(err), 'danger');
    } finally {
      setSelecting(false);
    }
  }, [selecting, tenderId, queryClient, toast]);

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
            onSelect={() => handleSelect(i)}
            selecting={selecting}
          />
        ))}
      </div>

      {overeni && (
        <OvereniCenyChip
          overeni={overeni}
          onUse={() => setWebDraft(buildDraftFromWeb(webPriceInputFromVerification(overeni), defaultMarze))}
        />
      )}

      {selectedProduct && (
        <ItemPriceCalculator
          selectedProduct={selectedProduct}
          existingOverride={webDraft ?? existingOverride}
          budget={budget}
          onConfirm={async (data) => { await handleConfirm(data); setWebDraft(null); }}
          label="Cenová kalkulace"
          historySubject={historySubject ?? `${selectedProduct.vyrobce} ${selectedProduct.model}`}
          historyCacheKey={`${tenderId}:single`}
          defaultMarzeProcent={defaultMarze}
          overeniCeny={overeni}
          onSourceApplied={setWebDraft}
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
  defaultMarze: number;
}

function MultiItemView({ match, tenderId, budget, queryClient, casti, defaultMarze }: MultiItemViewProps) {
  const { toast } = useToast();
  const [expandedItems, setExpandedItems] = useState<Set<number>>(() => new Set([0]));
  // Návrhy cen z webu předvyplněné přes „Použít" — mají přednost před perzistovanou
  // cenova_uprava v panelu, dokud je uživatel nepotvrdí (pak se draft zahodí).
  const [priceDrafts, setPriceDrafts] = useState<Map<number, PriceOverride>>(() => new Map());
  // Hromadné potvrzení cen: výběr řádků (checkboxy) + probíhající uložení.
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const [bulkSaving, setBulkSaving] = useState(false);
  // Právě ukládaný výběr kandidáta — klíč = polozka_index (backend klíčuje stejně).
  const [selectingItem, setSelectingItem] = useState<number | null>(null);
  const [winPriceBands, setWinPriceBands] = useState<Map<string, { subject: string; band: WinPriceBand }>>(
    () => new Map(),
  );

  const handleWinPriceBandLoaded = useCallback((cacheKey: string, subject: string, band: WinPriceBand) => {
    setWinPriceBands((previous) => {
      const current = previous.get(cacheKey);
      if (current?.subject === subject && current.band === band) return previous;
      return new Map(previous).set(cacheKey, { subject, band });
    });
  }, []);

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
    setPriceDrafts(prev => withPriceDraft(
      prev,
      itemIndex,
      buildDraftFromWeb(webPriceInputFromVerification(overeni), defaultMarze),
    ));
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
    await invalidatePriceDerivedQueries(queryClient, tenderId);
  }, [tenderId, queryClient]);

  // Ruční přepnutí kandidáta. Klíčujeme přes `polozka_index` (ne pozici v poli) — backend hledá
  // položku stejně. Když měla položka potvrzenou cenu, backend ji smaže → upozorni operátora.
  const handleSelectCandidate = useCallback(async (polozkaIndex: number, candidateIndex: number) => {
    if (selectingItem !== null) return;
    setSelectingItem(polozkaIndex);
    try {
      const { priceCleared } = await selectProductCandidate(tenderId, polozkaIndex, candidateIndex);
      await invalidatePriceDerivedQueries(queryClient, tenderId);
      if (priceCleared) toast('Vybrán jiný produkt — cenu je potřeba znovu potvrdit', 'info');
    } catch (err: unknown) {
      toast(getErrorMessage(err), 'danger');
    } finally {
      setSelectingItem(null);
    }
  }, [selectingItem, tenderId, queryClient, toast]);

  const polozky = match.polozky_match!;

  // Souhrn money-pathu: nákup a nabídka se váží množstvím každé položky.
  const totalBezDph = roundCurrency(polozky.reduce((sum: number, pm: PolozkaMatch) => {
    const product = pm.kandidati[pm.vybrany_index] as ProductCandidate | undefined;
    const override = pm.cenova_uprava;
    const price = override?.nabidkova_cena_bez_dph ?? product?.cena_bez_dph ?? 0;
    const mnozstvi = pm.mnozstvi || 1;
    return sum + price * mnozstvi;
  }, 0));
  const totalNakupniBezDph = roundCurrency(polozky.reduce((sum: number, pm: PolozkaMatch) => {
    const product = pm.kandidati[pm.vybrany_index] as ProductCandidate | undefined;
    const purchasePrice = pm.cenova_uprava?.nakupni_cena_bez_dph ?? product?.cena_bez_dph ?? 0;
    return sum + purchasePrice * (pm.mnozstvi || 1);
  }, 0));
  const totalSdph = roundCurrency(totalBezDph * 1.21);
  const totalMarzeKc = roundCurrency(totalBezDph - totalNakupniBezDph);
  const totalMarzeProcent = totalNakupniBezDph > 0
    ? roundCurrency(totalMarzeKc / totalNakupniBezDph * 100)
    : 0;

  // Srovnání používá stejné množství jako celková nabídka. Data se načítají výhradně po
  // kliknutí na „Historie cen"; upozornění se ukáže až při pokrytí alespoň poloviny položek.
  const historicalBands = polozky.flatMap((pm, index) => {
    const cacheKey = `${tenderId}:${index}`;
    const loaded = winPriceBands.get(cacheKey);
    if (!loaded || loaded.subject !== pm.polozka_nazev || loaded.band.n <= 0
      || loaded.band.median_bez_dph === undefined) return [];
    return [{ median: loaded.band.median_bez_dph, quantity: pm.mnozstvi || 1 }];
  });
  const historicalMedianTotal = historicalBands.reduce(
    (sum, item) => sum + item.median * item.quantity,
    0,
  );
  const hasHistoricalCoverage = polozky.length > 0 && historicalBands.length / polozky.length >= 0.5;
  const isMarkedlyAboveHistory = hasHistoricalCoverage
    && historicalMedianTotal > 0
    && totalBezDph > historicalMedianTotal * 1.5;

  const allConfirmed = polozky.every((pm) => pm.cenova_uprava?.potvrzeno);
  const confirmedCount = polozky.filter((pm) => pm.cenova_uprava?.potvrzeno).length;
  const belowMarketCount = polozky.filter((pm, index) => {
    const market = pm.overeni_ceny?.realita?.nejlevnejsi_bez_dph;
    if (market == null) return false;
    const confirmation = buildConfirmData(pm, priceDrafts.get(index), defaultMarze);
    return confirmation != null && confirmation.nabidkova_cena_bez_dph < market;
  }).length;

  // Indexy nepotvrzených položek (pořadí = index v poli polozky, což používá i per-item confirm).
  const unconfirmedIndices = polozky
    .map((pm, i) => (pm.cenova_uprava?.potvrzeno ? -1 : i))
    .filter((i) => i >= 0);

  // Hromadné potvrzení: pro každou vybranou položku dopočítá cenu (buildConfirmData) a pošle
  // JEDNÍM requestem (bulk endpoint, transakčně nad souborem). Položky bez ceny nebo s HARD
  // sanity nálezem přeskočí; backend stejnou podmínku znovu autoritativně ověří.
  const confirmBulk = useCallback(async (indices: number[]) => {
    if (bulkSaving) return;
    const payload: Array<{ itemIndex: number; cenova_uprava: PriceOverrideData }> = [];
    let skippedWithoutPrice = 0;
    let skippedHard = 0;
    for (const idx of indices) {
      const pm = polozky[idx];
      if (!pm) continue;
      if (pm.sanity_flags?.some((finding) => finding.level === 'hard')) {
        skippedHard++;
        continue;
      }
      const data = buildConfirmData(pm, priceDrafts.get(idx), defaultMarze);
      if (!data) { skippedWithoutPrice++; continue; }
      payload.push({ itemIndex: idx, cenova_uprava: data });
    }
    if (payload.length === 0) {
      const reasons = [
        skippedHard > 0 ? `${skippedHard} přeskočeno kvůli blokujícímu cenovému nálezu` : null,
        skippedWithoutPrice > 0 ? `${skippedWithoutPrice} přeskočeno kvůli chybějící ceně` : null,
      ].filter(Boolean).join(', ');
      toast(reasons || 'Není co potvrdit', 'danger');
      return;
    }
    setBulkSaving(true);
    try {
      const { updated, warnings, can_resume_run_all } = await bulkUpdateItemPriceOverride(tenderId, payload);
      // Web-drafty potvrzených položek zahoď (stejně jako po per-item potvrzení).
      setPriceDrafts((prev) => {
        const next = new Map(prev);
        for (const p of payload) next.delete(p.itemIndex);
        return next;
      });
      setSelected(new Set());
      await invalidatePriceDerivedQueries(queryClient, tenderId);
      const skippedParts = [
        skippedHard > 0 ? `${skippedHard} přeskočeno — blokující cenový nález` : null,
        skippedWithoutPrice > 0 ? `${skippedWithoutPrice} přeskočeno — bez ceny` : null,
      ].filter(Boolean);
      const warningPart = warnings.length > 0 ? `, ${warnings.length} varování ke kontrole` : '';
      // Pozastavený run-all řetězec čeká na potvrzení cen → nabídni pokračování.
      // Money-gate zůstává lidský: generování spustí až klik na tlačítko, nic automaticky.
      if (can_resume_run_all) {
        toast('Ceny potvrzeny — pipeline čeká na generování dokumentů.', 'success', {
          action: {
            label: 'Pokračovat v generování',
            onClick: async () => {
              try {
                await resumeRunAll(tenderId);
                await queryClient.invalidateQueries({ queryKey: ['tender-status', tenderId] });
                toast('Generování dokumentů spuštěno.', 'success');
              } catch (err: unknown) {
                toast(getErrorMessage(err), 'danger');
              }
            },
          },
        });
      } else {
        toast(`Potvrzeno ${updated} položek${skippedParts.length ? ` (${skippedParts.join(', ')})` : ''}${warningPart}`, 'success');
      }
    } catch (err: unknown) {
      toast(getErrorMessage(err), 'danger');
    } finally {
      setBulkSaving(false);
    }
  }, [bulkSaving, polozky, priceDrafts, defaultMarze, tenderId, queryClient, toast]);

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
          <div className="text-xs font-medium text-gray-600">
            Celková přirážka: {totalMarzeKc.toLocaleString('cs-CZ')} Kč ({totalMarzeProcent.toLocaleString('cs-CZ')} % z nákladů)
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

      {isMarkedlyAboveHistory && (
        <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Nabídka je výrazně nad historickými cenami — zkontrolujte konkurenceschopnost</span>
        </div>
      )}

      {belowMarketCount > 0 && (
        <div className="flex items-start gap-2 rounded-md border border-red-300 bg-orange-50 px-3 py-2 text-sm font-semibold text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />
          <span>{belowMarketCount} {belowMarketCount === 1 ? 'položka má' : 'položek má'} nabídkovou cenu pod reálným nákupem — bez auditovaného důvodu hromadné potvrzení neprojde.</span>
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
                  {pm.sanity_flags && pm.sanity_flags.length > 0 && (
                    <div className="mt-1 flex max-w-2xl flex-wrap gap-1">
                      {pm.sanity_flags.map((finding) => (
                        <span
                          key={finding.code}
                          className={cn(
                            'rounded border px-2 py-0.5 text-[10px] font-semibold whitespace-normal',
                            finding.level === 'hard'
                              ? 'border-red-200 bg-red-100 text-red-800'
                              : 'border-orange-200 bg-orange-100 text-orange-800'
                          )}
                        >
                          {finding.level === 'hard' ? 'BLOKUJE' : 'ZKONTROLUJTE'}: {finding.message}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-3">
                {(pm.overeni_ceny?.stav === 'nalezeno' || pm.overeni_ceny?.stav === 'ekvivalent') && pm.overeni_ceny.prekracuje_strop && (
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
                      onSelect={() => handleSelectCandidate(pm.polozka_index, i)}
                      selecting={selectingItem === pm.polozka_index}
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
                    historySubject={pm.polozka_nazev}
                    historyCacheKey={`${tenderId}:${idx}`}
                    onWinPriceBandLoaded={handleWinPriceBandLoaded}
                    defaultMarzeProcent={defaultMarze}
                    overeniCeny={pm.overeni_ceny}
                    onSourceApplied={(draft) => setPriceDrafts((previous) => withPriceDraft(previous, idx, draft))}
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
