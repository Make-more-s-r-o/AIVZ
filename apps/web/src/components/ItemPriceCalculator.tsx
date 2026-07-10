import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { PriceOverrideData } from '../lib/api';
import type { ProductCandidate, PriceOverride } from '../types/tender';
import { getErrorMessage } from '../types/tender';
import { Input } from './ui';
import { calculateItemPrice, roundCurrency } from '../lib/price-calculator';

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
}

export default function ItemPriceCalculator({
  selectedProduct,
  existingOverride,
  budget,
  onConfirm,
  label,
  mnozstvi,
  jednotka,
}: ItemPriceCalculatorProps) {
  const [nakupniCena, setNakupniCena] = useState<number>(0);
  const [marzeProcent, setMarzeProcent] = useState<number>(0);
  const [poznamka, setPoznamka] = useState<string>('');
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmHover, setConfirmHover] = useState(false);

  useEffect(() => {
    if (existingOverride) {
      setNakupniCena(existingOverride.nakupni_cena_bez_dph);
      setMarzeProcent(existingOverride.marze_procent);
      setPoznamka(existingOverride.poznamka || '');
      setIsConfirmed(existingOverride.potvrzeno);
    } else if (selectedProduct) {
      setNakupniCena(selectedProduct.cena_bez_dph);
      setMarzeProcent(0);
    }
  }, [existingOverride, selectedProduct]);

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

  return (
    <div
      className="rounded-lg border-2 p-4"
      style={isConfirmed
        ? { borderColor: 'var(--success-bg)', background: 'var(--success-soft-bg)' }
        : { borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          {label || 'Cenová kalkulace'}
        </h3>
        {isConfirmed && (
          <div className="flex items-center gap-1 text-xs font-medium" style={{ color: 'var(--success-fg)' }}>
            <CheckCircle2 className="h-3.5 w-3.5" />
            Potvrzeno
          </div>
        )}
      </div>

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
            Marže (%)
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
          <span>Marže 0 % — nabídka bez zisku</span>
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
