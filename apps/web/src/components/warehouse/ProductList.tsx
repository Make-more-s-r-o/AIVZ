import { useState, useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getWarehouseProducts, getWarehouseCategories, getWarehouseManufacturers,
  getWarehouseProduct,
} from '../../lib/api';
import ProductCard from './ProductCard';

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

function PriceAgeDot({ fetchedAt }: { fetchedAt?: string | null }) {
  if (!fetchedAt) return null;
  const days = Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 86400000);
  const color = days < 7 ? 'bg-green-500' : days < 30 ? 'bg-yellow-500' : 'bg-red-500';
  const title = days < 7 ? `${days}d - aktuální` : days < 30 ? `${days}d - stárnoucí` : `${days}d - zastaralé`;
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} title={title} />;
}

function SortableHeader({ label, field, current, dir, onChange }: {
  label: string; field: string; current: string; dir: string;
  onChange: (field: string, dir: string) => void;
}) {
  return (
    <th
      className="px-4 py-3 text-left font-medium text-gray-600 cursor-pointer hover:text-gray-900 select-none"
      onClick={() => onChange(field, current === field && dir === 'asc' ? 'desc' : 'asc')}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {current === field && (
          <span className="text-blue-500">{dir === 'asc' ? '↑' : '↓'}</span>
        )}
      </span>
    </th>
  );
}

const formatPrice = (price: number | null | undefined) => {
  if (!price) return '-';
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(price);
};

export default function ProductList({
  query, categoryId, manufacturer, priceMin, priceMax,
  sortBy, sortDir, page, viewMode, onParamsChange, onProductClick,
}: ProductListProps) {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState(query);
  const [priceMinInput, setPriceMinInput] = useState(priceMin?.toString() || '');
  const [priceMaxInput, setPriceMaxInput] = useState(priceMax?.toString() || '');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const priceDebounceRef = useRef<ReturnType<typeof setTimeout>>();

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

  const { data, isLoading } = useQuery({
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
    if (field === 'price_min') setPriceMinInput(value);
    else setPriceMaxInput(value);
    clearTimeout(priceDebounceRef.current);
    priceDebounceRef.current = setTimeout(() => {
      onParamsChange({ [field]: value || null, p: null });
    }, 500);
  };

  const handleSort = (field: string, dir: string) => {
    onParamsChange({ sort: field, dir, p: null });
  };

  return (
    <div>
      {/* Sticky filtry */}
      <div className="sticky top-0 z-10 bg-white pb-4 border-b mb-4">
        <div className="flex flex-wrap gap-3">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Hledat produkty..."
            className="flex-1 min-w-[200px] rounded-md border px-3 py-2 text-sm"
          />
          <select
            value={categoryId ?? ''}
            onChange={(e) => onParamsChange({ cat: e.target.value || null, p: null })}
            className="rounded-md border px-3 py-2 text-sm"
          >
            <option value="">Všechny kategorie</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.parent_id ? '\u00A0\u00A0' : ''}{c.nazev}
              </option>
            ))}
          </select>
          <select
            value={manufacturer ?? ''}
            onChange={(e) => onParamsChange({ mfr: e.target.value || null, p: null })}
            className="rounded-md border px-3 py-2 text-sm"
          >
            <option value="">Všichni výrobci</option>
            {manufacturers.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
          <input
            type="number"
            value={priceMinInput}
            onChange={(e) => handlePriceChange('price_min', e.target.value)}
            placeholder="Cena od"
            className="w-24 rounded-md border px-3 py-2 text-sm"
            min={0}
          />
          <input
            type="number"
            value={priceMaxInput}
            onChange={(e) => handlePriceChange('price_max', e.target.value)}
            placeholder="Cena do"
            className="w-24 rounded-md border px-3 py-2 text-sm"
            min={0}
          />
        </div>
      </div>

      {/* Grid nebo List */}
      {viewMode === 'grid' ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {isLoading ? (
            <div className="col-span-full text-center py-8 text-gray-400">Načítám...</div>
          ) : products.length === 0 ? (
            <div className="col-span-full text-center py-8 text-gray-400">
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
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <SortableHeader label="Výrobce" field="name" current={sortBy} dir={sortDir} onChange={handleSort} />
                <th className="px-4 py-3 text-left font-medium text-gray-600">Model</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">Kategorie</th>
                <th className="px-4 py-3 text-left font-medium text-gray-600">P/N</th>
                <SortableHeader label="Cena" field="price" current={sortBy} dir={sortDir} onChange={handleSort} />
                <th className="px-4 py-3 text-left font-medium text-gray-600">Zdroj</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {isLoading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Načítám...</td></tr>
              ) : products.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  {query ? 'Nic nenalezeno' : 'Sklad je prázdný. Importujte produkty.'}
                </td></tr>
              ) : (
                products.map((p) => (
                  <tr
                    key={p.id}
                    className="cursor-pointer hover:bg-blue-50"
                    onClick={() => onProductClick(p.id)}
                    onMouseEnter={() => queryClient.prefetchQuery({
                      queryKey: ['warehouse-product', p.id],
                      queryFn: () => getWarehouseProduct(p.id),
                      staleTime: 60000,
                    })}
                  >
                    <td className="px-4 py-3 font-medium">{p.manufacturer}</td>
                    <td className="px-4 py-3 max-w-xs truncate" title={p.model}>{p.model}</td>
                    <td className="px-4 py-3 text-gray-500">{p.category_nazev || '-'}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.part_number || '-'}</td>
                    <td className="px-4 py-3 text-right font-medium">
                      <span className="inline-flex items-center gap-1.5">
                        {formatPrice(p.best_price)}
                        <PriceAgeDot fetchedAt={p.best_price_fetched_at} />
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{p.best_price_source || '-'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Paginace */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>{total} produktů celkem</span>
          <div className="flex gap-2">
            <button
              onClick={() => onParamsChange({ p: String(Math.max(0, page - 1)) })}
              disabled={page === 0}
              className="rounded border px-3 py-1 disabled:opacity-30"
            >
              Předchozí
            </button>
            <span className="px-2 py-1">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => onParamsChange({ p: String(Math.min(totalPages - 1, page + 1)) })}
              disabled={page >= totalPages - 1}
              className="rounded border px-3 py-1 disabled:opacity-30"
            >
              Další
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
