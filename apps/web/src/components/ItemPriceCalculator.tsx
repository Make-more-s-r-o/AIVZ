import { useState, useEffect, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ExternalLink, History, Loader2 } from 'lucide-react';
import { getWinPriceBand, type PriceOverrideData, type WinPriceBand } from '../lib/api';
import type { ProductCandidate, PriceOverride } from '../types/tender';
import { getErrorMessage } from '../types/tender';
import { Input } from './ui';
import { calculateItemPrice, roundCurrency } from '../lib/price-calculator';
import { safeHttpUrl } from '../lib/url';

const CONFIDENCE_LABELS: Record<string, { label: string; bg: string; fg: string }> = {
  vysoka: { label: 'Vysoká', bg: 'var(--success-bg)', fg: 'var(--success-fg)' },
  stredni: { label: 'Střední', bg: 'var(--warning-bg)', fg: 'var(--warning-fg)' },
  nizka: { label: 'Nízká', bg: 'var(--danger-bg)', fg: 'var(--danger-fg)' },
};

interface ItemPriceCalculatorProps {
  selectedProduct: ProductCandidate;
  existingOverride?: PriceOverride;
  budget?: number;
  onConfirm: (data: PriceOverrideData) => Promise<void>;
  label?: string;
  mnozstvi?: number;
  jednotka?: string;
  historySubject?: string;
  historyCacheKey?: string;
  onWinPriceBandLoaded?: (cacheKey: string, subject: string, band: WinPriceBand) => void;
  /** Výchozí marže (%) z nastavení firmy — předvyplní se místo dřívější nuly. */
  defaultMarzeProcent: number;
}

export default function ItemPriceCalculator({
  selectedProduct,
  existingOverride,
  budget,
  onConfirm,
  label,
  mnozstvi,
  jednotka,
  historySubject,
  historyCacheKey,
  onWinPriceBandLoaded,
  defaultMarzeProcent,
}: ItemPriceCalculatorProps) {
  const [nakupniCena, setNakupniCena] = useState<number>(0);
  const [marzeProcent, setMarzeProcent] = useState<number>(0);
  const [poznamka, setPoznamka] = useState<string>('');
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmHover, setConfirmHover] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const normalizedHistorySubject = historySubject?.trim() ?? '';
  const normalizedHistoryCacheKey = historyCacheKey ?? normalizedHistorySubject;
  const historyQuery = useQuery({
    queryKey: ['winprice-band', normalizedHistoryCacheKey, normalizedHistorySubject],
    queryFn: () => getWinPriceBand(normalizedHistorySubject),
    enabled: false,
    staleTime: 30 * 60 * 1000,
  });

  useEffect(() => {
    if (existingOverride) {
      setNakupniCena(existingOverride.nakupni_cena_bez_dph);
      // NEpotvrzená nula = otrávený default (AI-prefill ve starých prod datech),
      // ne rozhodnutí operátora → předvyplň výchozí marži firmy. Potvrzenou nulu
      // respektuj — tu operátor potvrdil vědomě.
      setMarzeProcent(
        !existingOverride.potvrzeno && existingOverride.marze_procent === 0
          ? defaultMarzeProcent
          : existingOverride.marze_procent,
      );
      setPoznamka(existingOverride.poznamka || '');
      setIsConfirmed(existingOverride.potvrzeno);
    } else if (selectedProduct) {
      setNakupniCena(selectedProduct.cena_bez_dph);
      setMarzeProcent(defaultMarzeProcent);
    }
  }, [existingOverride, selectedProduct, defaultMarzeProcent]);

  useEffect(() => {
    if (historyQuery.data && normalizedHistorySubject && onWinPriceBandLoaded) {
      onWinPriceBandLoaded(normalizedHistoryCacheKey, normalizedHistorySubject, historyQuery.data);
    }
  }, [historyQuery.data, normalizedHistoryCacheKey, normalizedHistorySubject, onWinPriceBandLoaded]);

  const calculatedPrice = calculateItemPrice(nakupniCena, marzeProcent);
  const nabidkovaCenaBezDph = calculatedPrice.nabidkova_cena_bez_dph;
  const nabidkovaCenaSdph = calculatedPrice.nabidkova_cena_s_dph;
  const nakupniCenaSdph = calculatedPrice.nakupni_cena_s_dph;
  const hasZeroMargin = nakupniCena > 0 && nabidkovaCenaBezDph === roundCurrency(nakupniCena);

  const handleConfirm = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await onConfirm({
        nakupni_cena_bez_dph: nakupniCena,
        nakupni_cena_s_dph: nakupniCenaSdph,
        marze_procent: marzeProcent,
        nabidkova_cena_bez_dph: nabidkovaCenaBezDph,
        nabidkova_cena_s_dph: nabidkovaCenaSdph,
        potvrzeno: true,
        poznamka: poznamka || undefined,
      });
      setIsConfirmed(true);
    } catch (err: unknown) {
      setSaveError(getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }, [nakupniCena, nakupniCenaSdph, marzeProcent, nabidkovaCenaBezDph, nabidkovaCenaSdph, poznamka, onConfirm]);

  const handleHistoryToggle = useCallback(() => {
    const nextOpen = !historyOpen;
    setHistoryOpen(nextOpen);
    if (nextOpen && normalizedHistorySubject && !historyQuery.data && !historyQuery.isFetching) {
      void historyQuery.refetch();
    }
  }, [historyOpen, normalizedHistorySubject, historyQuery]);

  return (
    <div
      className="rounded-lg border-2 p-4"
      style={isConfirmed
        ? { borderColor: 'var(--success-bg)', background: 'var(--success-soft-bg)' }
        : { borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}
    >
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {label || 'Cenová kalkulace'}
        </h3>
        <div className="flex items-center gap-2">
          {normalizedHistorySubject && (
            <button
              type="button"
              onClick={handleHistoryToggle}
              aria-expanded={historyOpen}
              className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-medium text-indigo-700 transition-colors hover:bg-indigo-100"
            >
              {historyQuery.isFetching
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <History className="h-3 w-3" />}
              Historie cen
            </button>
          )}
          {isConfirmed && (
            <div className="flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--success-fg)' }}>
              <CheckCircle2 className="h-3.5 w-3.5" />
              Potvrzeno
            </div>
          )}
        </div>
      </div>

      {historyOpen && (
        <div className="mb-4 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-950">
          {historyQuery.isFetching ? (
            <div className="inline-flex items-center gap-1.5 text-indigo-700">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Načítám historické ceny…
            </div>
          ) : historyQuery.isError ? (
            <span className="text-amber-800">Historii cen se nepodařilo načíst.</span>
          ) : historyQuery.data?.n === 0 ? (
            <span className="text-gray-600">Bez historických dat</span>
          ) : historyQuery.data && historyQuery.data.median_bez_dph !== undefined
            && historyQuery.data.p25 !== undefined && historyQuery.data.p75 !== undefined ? (
            <div className="space-y-2">
              <div>
                <span className="font-semibold">Historicky:</span>{' '}
                medián {historyQuery.data.median_bez_dph.toLocaleString('cs-CZ')} Kč bez DPH
                {' '}(n={historyQuery.data.n}, P25–P75:{' '}
                {historyQuery.data.p25.toLocaleString('cs-CZ')}–{historyQuery.data.p75.toLocaleString('cs-CZ')} Kč)
              </div>
              {historyQuery.data.samples && historyQuery.data.samples.length > 0 && (
                <div className="space-y-1 border-t border-indigo-200 pt-2">
                  {historyQuery.data.samples.slice(0, 3).map((sample, index) => {
                    const safeUrl = safeHttpUrl(sample.url);
                    const content = (
                      <>
                        <span className="font-medium">{sample.predmet}</span>
                        {' — '}{sample.cena_bez_dph.toLocaleString('cs-CZ')} Kč
                        {sample.dodavatel_nazev ? ` · ${sample.dodavatel_nazev}` : ''}
                        {sample.datum ? ` · ${sample.datum}` : ''}
                      </>
                    );
                    return safeUrl ? (
                      <a
                        key={`${sample.predmet}-${index}`}
                        href={safeUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-start gap-1 text-indigo-700 hover:underline"
                      >
                        <span>{content}</span>
                        <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" />
                      </a>
                    ) : (
                      <div key={`${sample.predmet}-${index}`} className="text-gray-700">{content}</div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <span className="text-gray-600">Bez historických dat</span>
          )}
        </div>
      )}

      {/* Reference prices */}
      <div className="grid gap-2 sm:grid-cols-2 mb-4">
        <div className="rounded-md p-2" style={{ background: 'var(--surface-sunken)' }}>
          <div className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>AI odhad</div>
          <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
            {selectedProduct.cena_bez_dph?.toLocaleString('cs-CZ')} Kč bez DPH
          </div>
          {selectedProduct.cena_spolehlivost && (() => {
            const conf = CONFIDENCE_LABELS[selectedProduct.cena_spolehlivost] ?? CONFIDENCE_LABELS.nizka!;
            return (
              <span
                className="mt-0.5 inline-block rounded px-1 py-0.5 text-[9px] font-medium"
                style={{ background: conf.bg, color: conf.fg }}
              >
                {conf.label}
              </span>
            );
          })()}
        </div>
        {budget !== undefined && budget > 0 && (
          <div className="rounded-md p-2" style={{ background: 'var(--surface-sunken)' }}>
            <div className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>Rozpočet zakázky</div>
            <div className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
              {budget.toLocaleString('cs-CZ')} Kč bez DPH
            </div>
          </div>
        )}
      </div>

      {/* Price inputs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-3">
        <div>
          <label className="block text-[10px] font-medium mb-0.5" style={{ color: 'var(--text-secondary)' }}>
            Nákupní cena bez DPH (Kč)
          </label>
          <Input
            type="number"
            size="sm"
            value={nakupniCena || ''}
            onChange={(e) => {
              setNakupniCena(Number(e.target.value));
              setIsConfirmed(false);
            }}
            min={0}
          />
          <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            s DPH: {nakupniCenaSdph.toLocaleString('cs-CZ')} Kč
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-medium mb-0.5" style={{ color: 'var(--text-secondary)' }}>
            Přirážka k nákupu (%)
          </label>
          <Input
            type="number"
            size="sm"
            value={marzeProcent}
            onChange={(e) => {
              setMarzeProcent(Number(e.target.value));
              setIsConfirmed(false);
            }}
            min={0}
            max={100}
            step={1}
          />
          <input
            type="range"
            value={marzeProcent}
            onChange={(e) => {
              setMarzeProcent(Number(e.target.value));
              setIsConfirmed(false);
            }}
            className="mt-1 w-full"
            min={0}
            max={100}
            step={1}
          />
        </div>

        <div>
          <label className="block text-[10px] font-medium mb-0.5" style={{ color: 'var(--text-secondary)' }}>
            Nabídková cena bez DPH
          </label>
          <div
            className="rounded-md px-2 py-1.5 text-sm font-semibold"
            style={{ background: 'var(--info-soft-bg)', border: '1px solid var(--info-bg)', color: 'var(--info-fg)' }}
          >
            {nabidkovaCenaBezDph.toLocaleString('cs-CZ')} Kč
          </div>
          <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
            s DPH: {nabidkovaCenaSdph.toLocaleString('cs-CZ')} Kč
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-medium mb-0.5" style={{ color: 'var(--text-secondary)' }}>
            Poznámka
          </label>
          <Input
            type="text"
            size="sm"
            value={poznamka}
            onChange={(e) => setPoznamka(e.target.value)}
            placeholder="např. cena dle nabídky"
          />
        </div>
      </div>

      {hasZeroMargin && (
        <div
          className="mb-3 flex items-start gap-2 rounded-md px-2 py-1.5 text-xs"
          style={{ border: '1px solid var(--warning-bg)', background: 'var(--warning-soft-bg)', color: 'var(--warning-fg)' }}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>Přirážka 0 % — nabídka bez zisku</span>
        </div>
      )}

      {/* Line total for qty > 1 */}
      {mnozstvi && mnozstvi > 1 && (
        <div className="mb-3 rounded-md px-3 py-2" style={{ border: '1px solid var(--indigo-100)', background: 'var(--indigo-50)' }}>
          <div className="text-xs font-semibold" style={{ color: 'var(--indigo-900)' }}>
            Celkem za {mnozstvi} {jednotka || 'ks'}:{' '}
            {(nabidkovaCenaBezDph * mnozstvi).toLocaleString('cs-CZ')} Kč bez DPH
            {' / '}
            {(nabidkovaCenaSdph * mnozstvi).toLocaleString('cs-CZ')} Kč s DPH
          </div>
        </div>
      )}

      {/* Budget warning */}
      {budget !== undefined && budget > 0 && nabidkovaCenaBezDph > budget && (
        <div
          className="mb-3 flex items-start gap-2 rounded-md px-2 py-1.5 text-xs"
          style={{ border: '1px solid var(--warning-bg)', background: 'var(--warning-soft-bg)', color: 'var(--warning-fg)' }}
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Nabídková cena ({nabidkovaCenaBezDph.toLocaleString('cs-CZ')} Kč) překračuje rozpočet ({budget.toLocaleString('cs-CZ')} Kč).
          </span>
        </div>
      )}

      {saveError && (
        <div
          className="mb-3 rounded-md px-2 py-1.5 text-xs"
          style={{ border: '1px solid var(--danger-bg)', background: 'var(--danger-soft-bg)', color: 'var(--danger-fg)' }}
        >
          {saveError}
        </div>
      )}

      <button
        onClick={handleConfirm}
        disabled={isSaving || nakupniCena <= 0}
        onMouseEnter={() => setConfirmHover(true)}
        onMouseLeave={() => setConfirmHover(false)}
        className="rounded-md px-4 py-1.5 text-sm font-medium transition-colors"
        style={{
          background: isConfirmed
            ? (confirmHover ? 'var(--green-700)' : 'var(--success-solid)')
            : (confirmHover ? 'var(--accent-hover)' : 'var(--accent)'),
          color: 'var(--text-on-accent)',
          opacity: (isSaving || nakupniCena <= 0) ? 0.5 : 1,
          cursor: (isSaving || nakupniCena <= 0) ? 'not-allowed' : 'pointer',
        }}
      >
        {isSaving ? 'Ukládám...' : isConfirmed ? 'Aktualizovat' : 'Potvrdit ceny'}
      </button>
      {!isConfirmed && (
        <p className="mt-1 text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          Ceny musí být potvrzeny před generováním dokumentů.
        </p>
      )}
    </div>
  );
}
