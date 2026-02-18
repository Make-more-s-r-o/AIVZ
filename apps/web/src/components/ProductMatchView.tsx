import { useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getProductMatch, getAnalysis, updatePriceOverride, type PriceOverrideData } from '../lib/api';
import { cn } from '../lib/cn';
import { Check, X, AlertTriangle, CheckCircle2 } from 'lucide-react';

interface ProductMatchViewProps {
  tenderId: string;
}

const CONFIDENCE_LABELS: Record<string, { label: string; color: string }> = {
  vysoka: { label: 'Vysoká', color: 'bg-green-100 text-green-800' },
  stredni: { label: 'Střední', color: 'bg-yellow-100 text-yellow-800' },
  nizka: { label: 'Nízká', color: 'bg-red-100 text-red-800' },
};

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

  const match = data as any;
  const analysis = analysisData as any;
  const budget = analysis?.zakazka?.predpokladana_hodnota as number | undefined;

  const selectedProduct = match?.kandidati?.[match?.vybrany_index];
  const existingOverride = match?.cenova_uprava;

  // Price form state
  const [nakupniCena, setNakupniCena] = useState<number>(0);
  const [marzeProcent, setMarzeProcent] = useState<number>(0);
  const [poznamka, setPoznamka] = useState<string>('');
  const [isConfirmed, setIsConfirmed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Initialize form from existing data or AI estimate
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

  // Calculated prices
  const nabidkovaCenaBezDph = Math.round(nakupniCena * (1 + marzeProcent / 100));
  const nabidkovaCenaSdph = Math.round(nabidkovaCenaBezDph * 1.21);
  const nakupniCenaSdph = Math.round(nakupniCena * 1.21);

  const handleConfirm = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const priceData: PriceOverrideData = {
        nakupni_cena_bez_dph: nakupniCena,
        nakupni_cena_s_dph: nakupniCenaSdph,
        marze_procent: marzeProcent,
        nabidkova_cena_bez_dph: nabidkovaCenaBezDph,
        nabidkova_cena_s_dph: nabidkovaCenaSdph,
        potvrzeno: true,
        poznamka: poznamka || undefined,
      };
      await updatePriceOverride(tenderId, priceData);
      setIsConfirmed(true);
      queryClient.invalidateQueries({ queryKey: ['product-match', tenderId] });
    } catch (err: any) {
      setSaveError(err.message || 'Nepodařilo se uložit ceny');
    } finally {
      setIsSaving(false);
    }
  }, [nakupniCena, nakupniCenaSdph, marzeProcent, nabidkovaCenaBezDph, nabidkovaCenaSdph, poznamka, tenderId, queryClient]);

  if (isLoading) return <div className="py-8 text-center text-gray-500">Načítám produkty...</div>;
  if (error) return <div className="py-8 text-center text-gray-500">Produkty zatím nejsou k dispozici. Spusťte krok "Produkty".</div>;
  if (!data) return null;

  return (
    <div className="space-y-6">
      {match.oduvodneni_vyberu && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <span className="font-medium">Odůvodnění výběru:</span> {match.oduvodneni_vyberu}
        </div>
      )}

      {/* Product candidate cards */}
      <div className="grid gap-4 lg:grid-cols-3">
        {match.kandidati?.map((product: any, i: number) => {
          const confidence = CONFIDENCE_LABELS[product.cena_spolehlivost as string] ?? { label: 'Nízká', color: 'bg-red-100 text-red-800' };
          return (
            <div
              key={i}
              className={cn(
                'rounded-lg border p-4',
                i === match.vybrany_index
                  ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
                  : 'bg-white'
              )}
            >
              {i === match.vybrany_index && (
                <div className="mb-2 inline-block rounded bg-blue-600 px-2 py-0.5 text-xs font-bold text-white">
                  VYBRANÝ
                </div>
              )}
              <h4 className="font-semibold">{product.vyrobce} {product.model}</h4>
              <p className="mt-1 text-sm text-gray-600">{product.popis}</p>

              <div className="mt-3 border-t pt-3">
                <div className="flex items-center gap-2">
                  <div className="text-lg font-bold text-gray-900">
                    {product.cena_bez_dph?.toLocaleString('cs-CZ')} Kč
                  </div>
                  <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', confidence.color)}>
                    {confidence.label}
                  </span>
                </div>
                <div className="text-xs text-gray-500">
                  s DPH: {product.cena_s_dph?.toLocaleString('cs-CZ')} Kč
                </div>
                {product.cena_komentar && (
                  <div className="mt-1 flex items-start gap-1 text-xs text-amber-700">
                    <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{product.cena_komentar}</span>
                  </div>
                )}
              </div>

              {product.parametry && (
                <div className="mt-3 border-t pt-3">
                  <div className="text-xs font-medium text-gray-500">Parametry</div>
                  <div className="mt-1 space-y-1">
                    {Object.entries(product.parametry).map(([key, val]) => (
                      <div key={key} className="flex justify-between text-xs">
                        <span className="text-gray-600">{key}</span>
                        <span className="font-medium">{val as string}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {product.shoda_s_pozadavky?.length > 0 && (
                <div className="mt-3 border-t pt-3">
                  <div className="text-xs font-medium text-gray-500">Shoda s požadavky</div>
                  <div className="mt-1 space-y-1">
                    {product.shoda_s_pozadavky.map((s: any, j: number) => (
                      <div key={j} className="flex items-start gap-1 text-xs">
                        {s.splneno ? (
                          <Check className="mt-0.5 h-3 w-3 shrink-0 text-green-500" />
                        ) : (
                          <X className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
                        )}
                        <span>{s.pozadavek}: {s.hodnota}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {product.dodavatele?.length > 0 && (
                <div className="mt-3 text-xs text-gray-500">
                  Dodavatelé: {product.dodavatele.join(', ')}
                </div>
              )}
              {product.dostupnost && (
                <div className="text-xs text-gray-500">Dostupnost: {product.dostupnost}</div>
              )}
            </div>
          );
        })}
      </div>

      {/* Price calculation panel */}
      {selectedProduct && (
        <div className={cn(
          'rounded-lg border-2 p-6',
          isConfirmed ? 'border-green-300 bg-green-50' : 'border-gray-200 bg-white'
        )}>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">Cenová kalkulace</h3>
            {isConfirmed && (
              <div className="flex items-center gap-1 text-green-700 text-sm font-medium">
                <CheckCircle2 className="h-4 w-4" />
                Ceny potvrzeny
              </div>
            )}
          </div>

          {/* Reference prices */}
          <div className="grid gap-3 sm:grid-cols-2 mb-6">
            <div className="rounded-md bg-gray-50 p-3">
              <div className="text-xs text-gray-500">AI odhad (vybraný produkt)</div>
              <div className="text-sm font-medium">
                {selectedProduct.cena_bez_dph?.toLocaleString('cs-CZ')} Kč bez DPH
              </div>
              {selectedProduct.cena_spolehlivost && (() => {
                const conf = CONFIDENCE_LABELS[selectedProduct.cena_spolehlivost as string] ?? { label: 'Nízká', color: 'bg-red-100 text-red-800' };
                return (
                  <span className={cn(
                    'mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium',
                    conf.color
                  )}>
                    Spolehlivost: {conf.label}
                  </span>
                );
              })()}
            </div>
            {budget && (
              <div className="rounded-md bg-gray-50 p-3">
                <div className="text-xs text-gray-500">Rozpočet zakázky (předpokládaná hodnota)</div>
                <div className="text-sm font-medium">
                  {budget.toLocaleString('cs-CZ')} Kč bez DPH
                </div>
              </div>
            )}
          </div>

          {/* Price inputs */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-4">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Nákupní cena bez DPH (Kč)
              </label>
              <input
                type="number"
                value={nakupniCena || ''}
                onChange={(e) => {
                  setNakupniCena(Number(e.target.value));
                  setIsConfirmed(false);
                }}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                min={0}
              />
              <div className="mt-0.5 text-xs text-gray-400">
                s DPH: {nakupniCenaSdph.toLocaleString('cs-CZ')} Kč
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Marže (%)
              </label>
              <input
                type="number"
                value={marzeProcent}
                onChange={(e) => {
                  setMarzeProcent(Number(e.target.value));
                  setIsConfirmed(false);
                }}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
                max={50}
                step={1}
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Nabídková cena bez DPH
              </label>
              <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-sm font-semibold text-blue-900">
                {nabidkovaCenaBezDph.toLocaleString('cs-CZ')} Kč
              </div>
              <div className="mt-0.5 text-xs text-gray-400">
                s DPH: {nabidkovaCenaSdph.toLocaleString('cs-CZ')} Kč
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Poznámka (volitelné)
              </label>
              <input
                type="text"
                value={poznamka}
                onChange={(e) => setPoznamka(e.target.value)}
                placeholder="např. cena dle nabídky dodavatele"
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Budget comparison warning */}
          {budget && nabidkovaCenaBezDph > budget && (
            <div className="mb-4 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                Nabídková cena ({nabidkovaCenaBezDph.toLocaleString('cs-CZ')} Kč) překračuje rozpočet zakázky ({budget.toLocaleString('cs-CZ')} Kč).
              </span>
            </div>
          )}

          {saveError && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {saveError}
            </div>
          )}

          {/* Confirm button */}
          <button
            onClick={handleConfirm}
            disabled={isSaving || nakupniCena <= 0}
            className={cn(
              'rounded-md px-6 py-2 text-sm font-medium transition-colors',
              isConfirmed
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-blue-600 text-white hover:bg-blue-700',
              (isSaving || nakupniCena <= 0) && 'opacity-50 cursor-not-allowed'
            )}
          >
            {isSaving ? 'Ukládám...' : isConfirmed ? 'Aktualizovat ceny' : 'Potvrdit ceny'}
          </button>
          {!isConfirmed && (
            <p className="mt-2 text-xs text-gray-500">
              Ceny musí být potvrzeny před generováním dokumentů.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
