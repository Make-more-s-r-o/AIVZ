import { useQuery } from '@tanstack/react-query';
import { getProductMatch } from '../lib/api';
import { cn } from '../lib/cn';
import { Check, X } from 'lucide-react';

interface ProductMatchViewProps {
  tenderId: string;
}

export default function ProductMatchView({ tenderId }: ProductMatchViewProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['product-match', tenderId],
    queryFn: () => getProductMatch(tenderId),
  });

  if (isLoading) return <div className="py-8 text-center text-gray-500">Načítám produkty...</div>;
  if (error) return <div className="py-8 text-center text-gray-500">Produkty zatím nejsou k dispozici. Spusťte krok "Produkty".</div>;
  if (!data) return null;

  const match = data as any;

  return (
    <div className="space-y-6">
      {match.oduvodneni_vyberu && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <span className="font-medium">Odůvodnění výběru:</span> {match.oduvodneni_vyberu}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {match.kandidati?.map((product: any, i: number) => (
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
              <div className="text-lg font-bold text-gray-900">
                {product.cena_bez_dph?.toLocaleString('cs-CZ')} Kč
              </div>
              <div className="text-xs text-gray-500">
                s DPH: {product.cena_s_dph?.toLocaleString('cs-CZ')} Kč
              </div>
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
        ))}
      </div>
    </div>
  );
}
