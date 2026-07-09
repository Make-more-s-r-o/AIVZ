import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getWarehouseProduct, type ProductPrice } from '../../lib/api';
import { PriceAgeDot, formatPrice } from './shared';
import { safeHttpUrl } from '../../lib/url';

interface ProductDetailPageProps {
  productId: string;
  onBack: () => void;
}

export default function ProductDetailPage({ productId, onBack }: ProductDetailPageProps) {
  // Všechny hooky musí běžet při každém renderu ve stejném pořadí (Rules of Hooks),
  // proto jsou deklarované nad podmíněnými early returny níže.
  const { data: product, isLoading, error } = useQuery({
    queryKey: ['warehouse-product', productId],
    queryFn: () => getWarehouseProduct(productId),
  });
  const [copied, setCopied] = useState(false);

  if (isLoading) {
    return <div className="py-12 text-center" style={{ color: 'var(--text-tertiary)' }}>Načítám detail produktu...</div>;
  }

  if (error || !product) {
    return (
      <div className="py-12 text-center">
        <p style={{ color: 'var(--danger-solid)' }}>Produkt nenalezen</p>
        <button onClick={onBack} className="mt-2 text-sm" style={{ color: 'var(--accent)' }}>
          ← Zpět na seznam
        </button>
      </div>
    );
  }

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      {/* Breadcrumb */}
      <nav className="mb-4 flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
        <button onClick={onBack} style={{ color: 'var(--text-secondary)' }}>Cenový sklad</button>
        <span>›</span>
        {product.category_nazev && (
          <>
            <span>{product.category_nazev}</span>
            <span>›</span>
          </>
        )}
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{product.manufacturer} {product.model}</span>
      </nav>

      {/* Header */}
      <div className="flex gap-6 mb-6">
        {/* Obrázek */}
        <div
          className="flex-shrink-0 w-48 h-48 rounded-lg flex items-center justify-center overflow-hidden"
          style={{ border: '1px solid var(--border-default)', background: 'var(--surface-sunken)' }}
        >
          {product.image_url ? (
            <img src={product.image_url} alt={product.model} className="max-w-full max-h-full object-contain" />
          ) : (
            <div className="text-4xl" style={{ color: 'var(--gray-300)' }}>📦</div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1">
          <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{product.manufacturer} {product.model}</h2>
          {product.description && product.description !== product.model && (
            <p className="mt-1 text-sm line-clamp-2" style={{ color: 'var(--text-secondary)' }}>{product.description}</p>
          )}

          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm" style={{ color: 'var(--text-primary)' }}>
            {product.ean && (
              <div><span style={{ color: 'var(--text-secondary)' }}>EAN:</span> <span className="font-mono">{product.ean}</span></div>
            )}
            {product.part_number && (
              <div><span style={{ color: 'var(--text-secondary)' }}>P/N:</span> <span className="font-mono">{product.part_number}</span></div>
            )}
            {product.category_nazev && (
              <div><span style={{ color: 'var(--text-secondary)' }}>Kategorie:</span> {product.category_nazev}</div>
            )}
          </div>

          <div className="mt-3 flex gap-2">
            <button
              onClick={handleCopyLink}
              className="rounded px-3 py-1.5 text-xs"
              style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
            >
              {copied ? 'Zkopírováno!' : 'Kopírovat link'}
            </button>
            <button
              onClick={onBack}
              className="rounded px-3 py-1.5 text-xs"
              style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
            >
              ← Zpět na seznam
            </button>
          </div>
        </div>
      </div>

      {/* Cenová tabulka */}
      {product.prices?.length > 0 && (
        <div className="mb-6">
          <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Ceny</h3>
          <div className="rounded-lg" style={{ border: '1px solid var(--border-default)' }}>
            <table className="w-full text-sm">
              <thead style={{ background: 'var(--surface-sunken)' }}>
                <tr>
                  <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Zdroj</th>
                  <th className="px-4 py-3 text-right font-medium" style={{ color: 'var(--text-secondary)' }}>Bez DPH</th>
                  <th className="px-4 py-3 text-right font-medium" style={{ color: 'var(--text-secondary)' }}>S DPH</th>
                  <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Dostupnost</th>
                  <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>E-shop</th>
                  <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Aktualizace</th>
                  <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Stáří</th>
                </tr>
              </thead>
              <tbody style={{ borderTop: '1px solid var(--border-default)' }}>
                {product.prices.map((price, i) => (
                  <PriceRow key={i} price={price} />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Parametry */}
      {product.parameters_normalized && Object.keys(product.parameters_normalized).length > 0 && (
        <ParametersTable parameters={product.parameters_normalized} />
      )}
    </div>
  );
}

function PriceRow({ price }: { price: ProductPrice }) {
  const [hover, setHover] = useState(false);
  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ background: hover ? 'var(--surface-hover)' : 'transparent', borderBottom: '1px solid var(--border-subtle)' }}
    >
      <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>{price.source_name}</td>
      <td className="px-4 py-3 text-right font-medium" style={{ color: 'var(--text-primary)' }}>
        {formatPrice(price.price_bez_dph)}
      </td>
      <td className="px-4 py-3 text-right" style={{ color: 'var(--text-secondary)' }}>
        {price.price_s_dph ? formatPrice(price.price_s_dph) : '-'}
      </td>
      <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>{price.availability || '-'}</td>
      <td className="px-4 py-3">
        {safeHttpUrl(price.source_url) ? (
          <a
            href={safeHttpUrl(price.source_url)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs"
            style={{ color: 'var(--accent)' }}
          >
            Zobrazit →
          </a>
        ) : (
          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>-</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>
        {price.fetched_at ? new Date(price.fetched_at).toLocaleDateString('cs') : '-'}
      </td>
      <td className="px-4 py-3">
        <PriceAgeDot fetchedAt={price.fetched_at} variant="dot-with-label" />
      </td>
    </tr>
  );
}

const PARAMS_COLLAPSE_THRESHOLD = 15;

function ParametersTable({ parameters }: { parameters: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const [toggleHover, setToggleHover] = useState(false);
  const entries = Object.entries(parameters);
  const needsCollapse = entries.length > PARAMS_COLLAPSE_THRESHOLD;
  const visible = needsCollapse && !expanded ? entries.slice(0, PARAMS_COLLAPSE_THRESHOLD) : entries;

  return (
    <div className="mb-6">
      <h3 className="text-lg font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Technické parametry</h3>
      <div className="rounded-lg" style={{ border: '1px solid var(--border-default)' }}>
        <table className="w-full text-sm">
          <tbody>
            {visible.map(([key, value]) => (
              <ParamRow key={key} paramKey={key} value={value} />
            ))}
          </tbody>
        </table>
        {needsCollapse && (
          <button
            onClick={() => setExpanded(!expanded)}
            onMouseEnter={() => setToggleHover(true)}
            onMouseLeave={() => setToggleHover(false)}
            className="w-full px-4 py-2 text-sm"
            style={{
              borderTop: '1px solid var(--border-default)', color: 'var(--accent)',
              background: toggleHover ? 'var(--surface-hover)' : 'transparent',
            }}
          >
            {expanded ? 'Skrýt' : `Zobrazit všech ${entries.length} parametrů`}
          </button>
        )}
      </div>
    </div>
  );
}

function ParamRow({ paramKey, value }: { paramKey: string; value: unknown }) {
  const [hover, setHover] = useState(false);
  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ background: hover ? 'var(--surface-hover)' : 'transparent', borderBottom: '1px solid var(--border-subtle)' }}
    >
      <td className="px-4 py-2 font-medium w-1/3" style={{ color: 'var(--text-secondary)' }}>{paramKey}</td>
      <td className="px-4 py-2" style={{ color: 'var(--text-primary)' }}>{String(value)}</td>
    </tr>
  );
}
