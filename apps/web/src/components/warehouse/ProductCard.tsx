import { useState } from 'react';
import type { WarehouseProduct } from '../../lib/api';
import { PriceAgeDot, formatPrice } from './shared';

interface ProductCardProps {
  product: WarehouseProduct;
  onClick: () => void;
  onMouseEnter?: () => void;
}

export default function ProductCard({ product, onClick, onMouseEnter }: ProductCardProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      className="cursor-pointer rounded-lg p-3 transition-all"
      style={{
        border: `1px solid ${hover ? 'var(--blue-300)' : 'var(--border-default)'}`,
        background: 'var(--surface-card)',
        boxShadow: hover ? 'var(--shadow-xs)' : 'none',
      }}
      onClick={onClick}
      onMouseEnter={() => { setHover(true); onMouseEnter?.(); }}
      onMouseLeave={() => setHover(false)}
    >
      {/* Obrázek */}
      <div className="mb-2 flex h-32 items-center justify-center rounded overflow-hidden" style={{ background: 'var(--surface-sunken)' }}>
        {product.image_url ? (
          <img src={product.image_url} alt={product.model} className="max-h-full max-w-full object-contain" />
        ) : (
          <span className="text-3xl" style={{ color: 'var(--gray-300)' }}>📦</span>
        )}
      </div>

      {/* Výrobce + model */}
      <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{product.manufacturer}</div>
      <div className="text-sm font-medium line-clamp-2 min-h-[2.5rem]" style={{ color: 'var(--text-primary)' }} title={product.model}>
        {product.model}
      </div>

      {/* Kategorie */}
      {product.category_nazev && (
        <span className="mt-1 inline-block rounded px-1.5 py-0.5 text-xs" style={{ background: 'var(--gray-100)', color: 'var(--text-secondary)' }}>
          {product.category_nazev}
        </span>
      )}

      {/* Cena + stáří */}
      <div className="mt-2 flex items-center justify-between">
        <span className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{formatPrice(product.best_price)}</span>
        <PriceAgeDot fetchedAt={product.best_price_fetched_at} />
      </div>

      {/* Zdroj */}
      {product.best_price_source && (
        <div className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{product.best_price_source}</div>
      )}
    </div>
  );
}
