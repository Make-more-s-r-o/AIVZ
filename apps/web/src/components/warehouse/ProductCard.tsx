import type { WarehouseProduct } from '../../lib/api';

interface ProductCardProps {
  product: WarehouseProduct;
  onClick: () => void;
  onMouseEnter?: () => void;
}

function PriceAgeDot({ fetchedAt }: { fetchedAt?: string | null }) {
  if (!fetchedAt) return null;
  const days = Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 86400000);
  const color = days < 7 ? 'bg-green-500' : days < 30 ? 'bg-yellow-500' : 'bg-red-500';
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} title={`${days}d`} />;
}

const formatPrice = (price: number | null | undefined) => {
  if (!price) return '-';
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(price);
};

export default function ProductCard({ product, onClick, onMouseEnter }: ProductCardProps) {
  return (
    <div
      className="cursor-pointer rounded-lg border bg-white p-3 hover:border-blue-300 hover:shadow-sm transition-all"
      onClick={onClick}
      onMouseEnter={onMouseEnter}
    >
      {/* Obrázek */}
      <div className="mb-2 flex h-32 items-center justify-center rounded bg-gray-50 overflow-hidden">
        {product.image_url ? (
          <img src={product.image_url} alt={product.model} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-3xl text-gray-300">📦</span>
        )}
      </div>

      {/* Výrobce + model */}
      <div className="text-xs font-medium text-gray-500">{product.manufacturer}</div>
      <div className="text-sm font-medium text-gray-900 line-clamp-2 min-h-[2.5rem]" title={product.model}>
        {product.model}
      </div>

      {/* Kategorie */}
      {product.category_nazev && (
        <span className="mt-1 inline-block rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600">
          {product.category_nazev}
        </span>
      )}

      {/* Cena + stáří */}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-sm font-bold text-gray-900">{formatPrice(product.best_price)}</span>
        <PriceAgeDot fetchedAt={product.best_price_fetched_at} />
      </div>

      {/* Zdroj */}
      {product.best_price_source && (
        <div className="mt-0.5 text-xs text-gray-400">{product.best_price_source}</div>
      )}
    </div>
  );
}
