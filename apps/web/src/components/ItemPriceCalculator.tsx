import { useState, useEffect, useCallback } from 'react';
import { cn } from '../lib/cn';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import type { PriceOverrideData } from '../lib/api';
import type { ProductCandidate, PriceOverride } from '../types/tender';
import { getErrorMessage } from '../types/tender';

const CONFIDENCE_LABELS: Record<string, { label: string; color: string }> = {
  vysoka: { label: 'Vysoká', color: 'bg-green-100 text-green-800' },
  stredni: { label: 'Střední', color: 'bg-yellow-100 text-yellow-800' },
  nizka: { label: 'Nízká', color: 'bg-red-100 text-red-800' },
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

  const nabidkovaCenaBezDph = Math.round(nakupniCena * (1 + marzeProcent / 100));
  const nabidkovaCenaSdph = Math.round(nabidkovaCenaBezDph * 1.21);
  const nakupniCenaSdph = Math.round(nakupniCena * 1.21);

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
    <div className={cn(
      'rounded-lg border-2 p-4',
      isConfirmed ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-white'
    )}>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">
          {label || 'Cenová kalkulace'}
        </h3>
        {isConfirmed && (
          <div className="flex items-center gap-1 text-green-700 text-xs font-medium">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Potvrzeno
          </div>
        )}
      </div>

      {/* Reference prices */}
      <div className="grid gap-2 sm:grid-cols-2 mb-4">
        <div className="rounded-md bg-gray-50 p-2">
          <div className="text-[10px] text-gray-500">AI odhad</div>
          <div className="text-xs font-medium">
            {selectedProduct.cena_bez_dph?.toLocaleString('cs-CZ')} Kč bez DPH
          </div>
          {selectedProduct.cena_spolehlivost && (() => {
            const conf = CONFIDENCE_LABELS[selectedProduct.cena_spolehlivost] ?? { label: 'Nizka', color: 'bg-red-100 text-red-800' };
            return (
              <span className={cn(
                'mt-0.5 inline-block rounded px-1 py-0.5 text-[9px] font-medium',
                conf.color
              )}>
                {conf.label}
              </span>
            );
          })()}
        </div>
        {budget !== undefined && budget > 0 && (
          <div className="rounded-md bg-gray-50 p-2">
            <div className="text-[10px] text-gray-500">Rozpočet zakázky</div>
            <div className="text-xs font-medium">
              {budget.toLocaleString('cs-CZ')} Kč bez DPH
            </div>
          </div>
        )}
      </div>

      {/* Price inputs */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-3">
        <div>
          <label className="block text-[10px] font-medium text-gray-700 mb-0.5">
            Nákupní cena bez DPH (Kč)
          </label>
          <input
            type="number"
            value={nakupniCena || ''}
            onChange={(e) => {
              setNakupniCena(Number(e.target.value));
              setIsConfirmed(false);
            }}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            min={0}
          />
          <div className="mt-0.5 text-[10px] text-gray-400">
            s DPH: {nakupniCenaSdph.toLocaleString('cs-CZ')} Kč
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-medium text-gray-700 mb-0.5">
            Marže (%)
          </label>
          <input
            type="number"
            value={marzeProcent}
            onChange={(e) => {
              setMarzeProcent(Number(e.target.value));
              setIsConfirmed(false);
            }}
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
          <label className="block text-[10px] font-medium text-gray-700 mb-0.5">
            Nabídková cena bez DPH
          </label>
          <div className="rounded-md bg-blue-50 border border-blue-200 px-2 py-1.5 text-sm font-semibold text-blue-900">
            {nabidkovaCenaBezDph.toLocaleString('cs-CZ')} Kč
          </div>
          <div className="mt-0.5 text-[10px] text-gray-400">
            s DPH: {nabidkovaCenaSdph.toLocaleString('cs-CZ')} Kč
          </div>
        </div>

        <div>
          <label className="block text-[10px] font-medium text-gray-700 mb-0.5">
            Poznámka
          </label>
          <input
            type="text"
            value={poznamka}
            onChange={(e) => setPoznamka(e.target.value)}
            placeholder="např. cena dle nabídky"
            className="w-full rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
      </div>

      {/* Line total for qty > 1 */}
      {mnozstvi && mnozstvi > 1 && (
        <div className="mb-3 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2">
          <div className="text-xs font-semibold text-indigo-900">
            Celkem za {mnozstvi} {jednotka || 'ks'}:{' '}
            {(nabidkovaCenaBezDph * mnozstvi).toLocaleString('cs-CZ')} Kč bez DPH
            {' / '}
            {(nabidkovaCenaSdph * mnozstvi).toLocaleString('cs-CZ')} Kč s DPH
          </div>
        </div>
      )}

      {/* Budget warning */}
      {budget !== undefined && budget > 0 && nabidkovaCenaBezDph > budget && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Nabídková cena ({nabidkovaCenaBezDph.toLocaleString('cs-CZ')} Kč) překračuje rozpočet ({budget.toLocaleString('cs-CZ')} Kč).
          </span>
        </div>
      )}

      {saveError && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-800">
          {saveError}
        </div>
      )}

      <button
        onClick={handleConfirm}
        disabled={isSaving || nakupniCena <= 0}
        className={cn(
          'rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
          isConfirmed
            ? 'bg-green-600 text-white hover:bg-green-700'
            : 'bg-blue-600 text-white hover:bg-blue-700',
          (isSaving || nakupniCena <= 0) && 'opacity-50 cursor-not-allowed'
        )}
      >
        {isSaving ? 'Ukládám...' : isConfirmed ? 'Aktualizovat' : 'Potvrdit ceny'}
      </button>
      {!isConfirmed && (
        <p className="mt-1 text-[10px] text-gray-500">
          Ceny musí být potvrzeny před generováním dokumentů.
        </p>
      )}
    </div>
  );
}
