import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getWarehouseProducts, getWarehouseCategories, getWarehouseManufacturers,
  getWarehouseProduct, type WarehouseProduct,
} from '../../lib/api';
import ProductCard from './ProductCard';
import { PriceAgeDot, formatPrice } from './shared';
import { Input, Select } from '../ui';

const PAGE_SIZE = 25;

interface ProductListProps {
  query: string;
  categoryId: number | undefined;
  manufacturer: string | undefined;
  priceMin: number | undefined;
  priceMax: number | undefined;
  sortBy: string;
  sortDir: string;
  page: number;
  viewMode: 'list' | 'grid';
  onParamsChange: (params: Record<string, string | null>) => void;
  onProductClick: (productId: string) => void;
}

function SortableHeader({ label, field, current, dir, onChange }: {
  label: string; field: string; current: string; dir: string;
  onChange: (field: string, dir: string) => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <th
      className="px-4 py-3 text-left font-medium cursor-pointer select-none"
      style={{ color: hover ? 'var(--text-primary)' : 'var(--text-secondary)' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onChange(field, current === field && dir === 'asc' ? 'desc' : 'asc')}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {current === field && (
          <span style={{ color: 'var(--accent)' }}>{dir === 'asc' ? '↑' : '↓'}</span>
        )}
      </span>
    </th>
  );
}

function ProductRow({ product, onClick, onMouseEnter }: {
  product: WarehouseProduct; onClick: () => void; onMouseEnter: () => void;
}) {
  const [hover, setHover] = useState(false);
  return (
    <tr
      className="cursor-pointer"
      style={{ background: hover ? 'var(--accent-soft-bg)' : 'transparent' }}
      onClick={onClick}
      onMouseEnter={() => { setHover(true); onMouseEnter(); }}
      onMouseLeave={() => setHover(false)}
    >
      <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>{product.manufacturer}</td>
      <td className="px-4 py-3 max-w-xs truncate" style={{ color: 'var(--text-primary)' }} title={product.model}>{product.model}</td>
      <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>{product.category_nazev || '-'}</td>
      <td className="px-4 py-3 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{product.part_number || '-'}</td>
      <td className="px-4 py-3 text-right font-medium" style={{ color: 'var(--text-primary)' }}>
        <span className="inline-flex items-center gap-1.5">
          {formatPrice(product.best_price)}
          <PriceAgeDot fetchedAt={product.best_price_fetched_at} />
        </span>
      </td>
      <td className="px-4 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{product.best_price_source || '-'}</td>
    </tr>
  );
}

export default function ProductList({
  query, categoryId, manufacturer, priceMin, priceMax,
  sortBy, sortDir, page, viewMode, onParamsChange, onProductClick,
}: ProductListProps) {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState(query);
  const [priceMinInput, setPriceMinInput] = useState(priceMin?.toString() || '');
  const [priceMaxInput, setPriceMaxInput] = useState(priceMax?.toString() || '');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  // Samostatný debounce timer pro každé pole ceny — jinak by rychlá změna obou polí
  // zrušila pending update prvního pole a jeho hodnota by se ztratila.
  const priceMinDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  const priceMaxDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Cleanup debounce timers na unmount
  useEffect(() => {
    return () => {
      clearTimeout(debounceRef.current);
      clearTimeout(priceMinDebounceRef.current);
      clearTimeout(priceMaxDebounceRef.current);
    };
  }, []);

  // Sync props to local input state
  useEffect(() => { setSearchInput(query); }, [query]);
  useEffect(() => { setPriceMinInput(priceMin?.toString() || ''); }, [priceMin]);
  useEffect(() => { setPriceMaxInput(priceMax?.toString() || ''); }, [priceMax]);

  const { data: categoriesData } = useQuery({
    queryKey: ['warehouse-categories'],
    queryFn: () => getWarehouseCategories(),
    staleTime: 300000,
  });
  const categories = categoriesData || [];

  const { data: manufacturersData } = useQuery({
    queryKey: ['warehouse-manufacturers'],
    queryFn: () => getWarehouseManufacturers(),
    staleTime: 300000,
  });
  const manufacturers = manufacturersData || [];

  const { data, isLoading, error } = useQuery({
    queryKey: ['warehouse-products', { q: query, categoryId, manufacturer, priceMin, priceMax, sortBy, sortDir, page }],
    queryFn: () => getWarehouseProducts({
      q: query || undefined,
      category_id: categoryId,
      manufacturer,
      price_min: priceMin,
      price_max: priceMax,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
      sort_by: sortBy || (query ? 'relevance' : 'name'),
      sort_dir: sortDir,
    }),
  });

  const products = data?.items || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  const handleSearchChange = (value: string) => {
    setSearchInput(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onParamsChange({ q: value || null, p: null });
    }, 300);
  };

  const handlePriceChange = (field: 'price_min' | 'price_max', value: string) => {
    const ref = field === 'price_min' ? priceMinDebounceRef : priceMaxDebounceRef;
    if (field === 'price_min') setPriceMinInput(value);
    else setPriceMaxInput(value);
    clearTimeout(ref.current);
    ref.current = setTimeout(() => {
      onParamsChange({ [field]: value || null, p: null });
    }, 500);
  };

  const handleSort = (field: string, dir: string) => {
    onParamsChange({ sort: field, dir, p: null });
  };

  const categoryOptions = [
    { value: '', label: 'Všechny kategorie' },
    ...categories.map((c) => ({ value: String(c.id), label: `${c.parent_id ? '  ' : ''}${c.nazev}` })),
  ];
  const manufacturerOptions = [
    { value: '', label: 'Všichni výrobci' },
    ...manufacturers.map((m) => ({ value: m, label: m })),
  ];

  return (
    <div>
      {/* Sticky filtry */}
      <div className="sticky top-0 z-10 pb-4 mb-4" style={{ background: 'var(--surface-card)', borderBottom: '1px solid var(--border-default)' }}>
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[200px]">
            <Input
              type="text"
              value={searchInput}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Hledat produkty..."
            />
          </div>
          <div className="w-48">
            <Select
              value={categoryId != null ? String(categoryId) : ''}
              onChange={(e) => onParamsChange({ cat: e.target.value || null, p: null })}
              options={categoryOptions}
            />
          </div>
          <div className="w-48">
            <Select
              value={manufacturer ?? ''}
              onChange={(e) => onParamsChange({ mfr: e.target.value || null, p: null })}
              options={manufacturerOptions}
            />
          </div>
          <div className="w-24">
            <Input
              type="number"
              value={priceMinInput}
              onChange={(e) => handlePriceChange('price_min', e.target.value)}
              placeholder="Cena od"
              min={0}
            />
          </div>
          <div className="w-24">
            <Input
              type="number"
              value={priceMaxInput}
              onChange={(e) => handlePriceChange('price_max', e.target.value)}
              placeholder="Cena do"
              min={0}
            />
          </div>
        </div>
        {priceMin != null && priceMax != null && priceMin > priceMax && (
          <p className="mt-1 text-xs" style={{ color: 'var(--danger-solid)' }}>Min cena musí být menší než max</p>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div className="mb-4 rounded-lg p-4 text-sm" style={{ border: '1px solid var(--danger-bg)', background: 'var(--danger-soft-bg)', color: 'var(--danger-fg)' }}>
          Chyba při načítání produktů: {(error as Error).message}
        </div>
      )}

      {/* Grid nebo List */}
      {viewMode === 'grid' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {isLoading ? (
            <div className="col-span-full text-center py-8" style={{ color: 'var(--text-tertiary)' }}>Načítám...</div>
          ) : products.length === 0 ? (
            <div className="col-span-full text-center py-8" style={{ color: 'var(--text-tertiary)' }}>
              {query ? 'Nic nenalezeno' : 'Sklad je prázdný. Importujte produkty.'}
            </div>
          ) : (
            products.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                onClick={() => onProductClick(p.id)}
                onMouseEnter={() => queryClient.prefetchQuery({
                  queryKey: ['warehouse-product', p.id],
                  queryFn: () => getWarehouseProduct(p.id),
                  staleTime: 60000,
                })}
              />
            ))
          )}
        </div>
      ) : (
        <div className="rounded-lg" style={{ border: '1px solid var(--border-default)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--surface-sunken)' }}>
              <tr>
                <SortableHeader label="Výrobce" field="name" current={sortBy} dir={sortDir} onChange={handleSort} />
                <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Model</th>
                <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Kategorie</th>
                <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>P/N</th>
                <SortableHeader label="Cena" field="price" current={sortBy} dir={sortDir} onChange={handleSort} />
                <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Zdroj</th>
              </tr>
            </thead>
            <tbody style={{ borderTop: '1px solid var(--border-default)' }}>
              {isLoading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center" style={{ color: 'var(--text-tertiary)' }}>Načítám...</td></tr>
              ) : products.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center" style={{ color: 'var(--text-tertiary)' }}>
                  {query ? 'Nic nenalezeno' : 'Sklad je prázdný. Importujte produkty.'}
                </td></tr>
              ) : (
                products.map((p) => (
                  <ProductRow
                    key={p.id}
                    product={p}
                    onClick={() => onProductClick(p.id)}
                    onMouseEnter={() => queryClient.prefetchQuery({
                      queryKey: ['warehouse-product', p.id],
                      queryFn: () => getWarehouseProduct(p.id),
                      staleTime: 60000,
                    })}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Paginace */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm" style={{ color: 'var(--text-secondary)' }}>
          <span>{total} produktů celkem</span>
          <div className="flex gap-2">
            <button
              onClick={() => { onParamsChange({ p: String(Math.max(0, page - 1)) }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
              disabled={page === 0}
              className="rounded px-3 py-1"
              style={{ border: '1px solid var(--border-default)', opacity: page === 0 ? 0.3 : 1 }}
            >
              Předchozí
            </button>
            <span className="px-2 py-1">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => { onParamsChange({ p: String(Math.min(totalPages - 1, page + 1)) }); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
              disabled={page >= totalPages - 1}
              className="rounded px-3 py-1"
              style={{ border: '1px solid var(--border-default)', opacity: page >= totalPages - 1 ? 0.3 : 1 }}
            >
              Další
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
