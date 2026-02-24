import { useState, useCallback } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  getProductMatch,
  getAnalysis,
  updatePriceOverride,
  updateItemPriceOverride,
  type PriceOverrideData,
} from '../lib/api';
import { cn } from '../lib/cn';
import { ChevronDown, ChevronRight, Package, Wrench, Mouse } from 'lucide-react';
import ProductCandidateCard from './ProductCandidateCard';
import ItemPriceCalculator from './ItemPriceCalculator';
import type { ProductMatch, TenderAnalysis, PolozkaMatch, ProductCandidate } from '../types/tender';

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

  if (isMultiItem) {
    return (
      <MultiItemView
        match={match}
        tenderId={tenderId}
        budget={budget}
        queryClient={queryClient}
        casti={casti}
      />
    );
  }

  return (
    <SingleItemView
      match={match}
      tenderId={tenderId}
      budget={budget}
      queryClient={queryClient}
    />
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

      {selectedProduct && (
        <ItemPriceCalculator
          selectedProduct={selectedProduct}
          existingOverride={existingOverride}
          budget={budget}
          onConfirm={handleConfirm}
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
  const [expandedItems, setExpandedItems] = useState<Set<number>>(() => new Set([0]));

  const toggleItem = (index: number) => {
    setExpandedItems(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
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
            {/* Accordion header */}
            <button
              onClick={() => toggleItem(idx)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 transition-colors rounded-lg"
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

                {selectedProduct && (
                  <ItemPriceCalculator
                    selectedProduct={selectedProduct}
                    existingOverride={pm.cenova_uprava}
                    budget={undefined}
                    onConfirm={(data) => handleItemConfirm(idx, data)}
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
