import { useQuery } from '@tanstack/react-query';
import { getWarehouseProduct } from '../../lib/api';

interface ProductDetailPageProps {
  productId: string;
  onBack: () => void;
}

function PriceAgeDot({ fetchedAt }: { fetchedAt?: string | null }) {
  if (!fetchedAt) return null;
  const days = Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 86400000);
  const color = days < 7 ? 'bg-green-500' : days < 30 ? 'bg-yellow-500' : 'bg-red-500';
  const label = days < 7 ? 'aktuální' : days < 30 ? 'stárnoucí' : 'zastaralé';
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />
      <span className="text-xs text-gray-500">{days}d — {label}</span>
    </span>
  );
}

const formatPrice = (price: number | null | undefined) => {
  if (price == null) return '-';
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(price);
};

export default function ProductDetailPage({ productId, onBack }: ProductDetailPageProps) {
  const { data: product, isLoading, error } = useQuery({
    queryKey: ['warehouse-product', productId],
    queryFn: () => getWarehouseProduct(productId),
  });

  if (isLoading) {
    return <div className="py-12 text-center text-gray-400">Načítám detail produktu...</div>;
  }

  if (error || !product) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-600">Produkt nenalezen</p>
        <button onClick={onBack} className="mt-2 text-sm text-blue-600 hover:text-blue-800">
          ← Zpět na seznam
        </button>
      </div>
    );
  }

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
  };

  return (
    <div>
      {/* Breadcrumb */}
      <nav className="mb-4 flex items-center gap-2 text-sm text-gray-500">
        <button onClick={onBack} className="hover:text-blue-600">Cenový sklad</button>
        <span>›</span>
        {product.category_nazev && (
          <>
            <span>{product.category_nazev}</span>
            <span>›</span>
          </>
        )}
        <span className="text-gray-900 font-medium">{product.manufacturer} {product.model}</span>
      </nav>

      {/* Header */}
      <div className="flex gap-6 mb-6">
        {/* Obrázek */}
        <div className="flex-shrink-0 w-48 h-48 rounded-lg border bg-gray-50 flex items-center justify-center overflow-hidden">
          {product.image_url ? (
            <img src={product.image_url} alt={product.model} className="max-w-full max-h-full object-contain" />
          ) : (
            <div className="text-gray-300 text-4xl">📦</div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1">
          <h2 className="text-2xl font-bold text-gray-900">{product.manufacturer} {product.model}</h2>
          {product.description && product.description !== product.model && (
            <p className="mt-1 text-sm text-gray-600 line-clamp-2">{product.description}</p>
          )}

          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
            {product.ean && (
              <div><span className="text-gray-500">EAN:</span> <span className="font-mono">{product.ean}</span></div>
            )}
            {product.part_number && (
              <div><span className="text-gray-500">P/N:</span> <span className="font-mono">{product.part_number}</span></div>
            )}
            {product.category_nazev && (
              <div><span className="text-gray-500">Kategorie:</span> {product.category_nazev}</div>
            )}
          </div>

          <div className="mt-3 flex gap-2">
            <button
              onClick={handleCopyLink}
              className="rounded border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              Kopírovat link
            </button>
            <button
              onClick={onBack}
              className="rounded border px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
            >
              ← Zpět na seznam
            </button>
          </div>
        </div>
      </div>

      {/* Cenová tabulka */}
      {product.prices && product.prices.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-2">Ceny</h3>
          <div className="rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Zdroj</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Bez DPH</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">S DPH</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Dostupnost</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">E-shop</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Aktualizace</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Stáří</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {product.prices.map((price: any, i: number) => (
                  <tr key={i} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium">{price.source_name}</td>
                    <td className="px-4 py-3 text-right font-medium text-gray-900">
                      {formatPrice(price.price_bez_dph)}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">
                      {price.price_s_dph ? formatPrice(price.price_s_dph) : '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{price.availability || '-'}</td>
                    <td className="px-4 py-3">
                      {price.source_url ? (
                        <a
                          href={price.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-800 text-xs"
                        >
                          Zobrazit →
                        </a>
                      ) : (
                        <span className="text-gray-400 text-xs">-</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {price.fetched_at ? new Date(price.fetched_at).toLocaleDateString('cs') : '-'}
                    </td>
                    <td className="px-4 py-3">
                      <PriceAgeDot fetchedAt={price.fetched_at} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Parametry */}
      {product.parameters_normalized && Object.keys(product.parameters_normalized).length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-2">Technické parametry</h3>
          <div className="rounded-lg border">
            <table className="w-full text-sm">
              <tbody className="divide-y">
                {Object.entries(product.parameters_normalized).map(([key, value]) => (
                  <tr key={key} className="hover:bg-gray-50">
                    <td className="px-4 py-2 font-medium text-gray-600 w-1/3">{key}</td>
                    <td className="px-4 py-2 text-gray-900">{String(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
