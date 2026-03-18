import { useState, useEffect, useCallback } from 'react';
import {
  getWarehouseProducts, getWarehouseCategories, getWarehouseManufacturers,
  getWarehouseProduct,
  type WarehouseProduct, type WarehouseCategory,
} from '../../lib/api';

const PAGE_SIZE = 25;

export default function ProductList() {
  const [products, setProducts] = useState<WarehouseProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [query, setQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [categoryId, setCategoryId] = useState<number | undefined>();
  const [manufacturer, setManufacturer] = useState<string | undefined>();
  const [categories, setCategories] = useState<WarehouseCategory[]>([]);
  const [manufacturers, setManufacturers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    getWarehouseCategories().then(setCategories).catch(() => {});
    getWarehouseManufacturers().then(setManufacturers).catch(() => {});
  }, []);

  const loadProducts = useCallback(async () => {
    setLoading(true);
    try {
      const result = await getWarehouseProducts({
        q: query || undefined,
        category_id: categoryId,
        manufacturer,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        sort_by: query ? 'relevance' : 'name',
      });
      setProducts(result.items);
      setTotal(result.total);
    } catch (err) {
      console.error('Failed to load products', err);
    } finally {
      setLoading(false);
    }
  }, [query, categoryId, manufacturer, page]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(0);
    setQuery(searchInput);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  const formatPrice = (price: number | null | undefined) => {
    if (!price) return '-';
    return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(price);
  };

  return (
    <div>
      {/* Filtry */}
      <div className="mb-4 flex flex-wrap gap-3">
        <form onSubmit={handleSearch} className="flex flex-1 gap-2">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Hledat produkty..."
            className="flex-1 rounded-md border px-3 py-2 text-sm"
          />
          <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
            Hledat
          </button>
        </form>
        <select
          value={categoryId ?? ''}
          onChange={(e) => { setCategoryId(e.target.value ? Number(e.target.value) : undefined); setPage(0); }}
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
          onChange={(e) => { setManufacturer(e.target.value || undefined); setPage(0); }}
          className="rounded-md border px-3 py-2 text-sm"
        >
          <option value="">Všichni výrobci</option>
          {manufacturers.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      </div>

      {/* Tabulka */}
      <div className="rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Výrobce</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Model</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Kategorie</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">P/N</th>
              <th className="px-4 py-3 text-right font-medium text-gray-600">Cena</th>
              <th className="px-4 py-3 text-left font-medium text-gray-600">Zdroj</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">Nacitam...</td></tr>
            ) : products.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                {query ? 'Nic nenalezeno' : 'Sklad je prazdny. Importujte produkty.'}
              </td></tr>
            ) : (
              products.map((p) => (
                <tr
                  key={p.id}
                  className={`cursor-pointer hover:bg-blue-50 ${selectedId === p.id ? 'bg-blue-50' : ''}`}
                  onClick={() => setSelectedId(selectedId === p.id ? null : p.id)}
                >
                  <td className="px-4 py-3 font-medium">{p.manufacturer}</td>
                  <td className="px-4 py-3">{p.model}</td>
                  <td className="px-4 py-3 text-gray-500">{p.category_nazev || '-'}</td>
                  <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.part_number || '-'}</td>
                  <td className="px-4 py-3 text-right font-medium">
                    {formatPrice(p.best_price)}
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{p.best_price_source || '-'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Detail produktu */}
      {selectedId && <ProductDetail productId={selectedId} />}

      {/* Paginace */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
          <span>{total} produktu celkem</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="rounded border px-3 py-1 disabled:opacity-30"
            >
              Predchozi
            </button>
            <span className="px-2 py-1">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="rounded border px-3 py-1 disabled:opacity-30"
            >
              Dalsi
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ProductDetail({ productId }: { productId: string }) {
  const [product, setProduct] = useState<any>(null);

  useEffect(() => {
    getWarehouseProduct(productId).then(setProduct);
  }, [productId]);

  if (!product) return <div className="mt-4 rounded-lg border p-4 text-center text-gray-400">Nacitam detail...</div>;

  return (
    <div className="mt-4 rounded-lg border p-4">
      <h3 className="text-lg font-semibold">{product.manufacturer} {product.model}</h3>
      {product.description && (
        <p className="mt-1 text-sm text-gray-600">{product.description}</p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
        {product.ean && <div><span className="text-gray-500">EAN:</span> {product.ean}</div>}
        {product.part_number && <div><span className="text-gray-500">P/N:</span> {product.part_number}</div>}
        {product.category_nazev && <div><span className="text-gray-500">Kategorie:</span> {product.category_nazev}</div>}
        {product.zdroj_dat && <div><span className="text-gray-500">Zdroj:</span> {product.zdroj_dat}</div>}
      </div>

      {/* Parametry */}
      {product.parameters_normalized && Object.keys(product.parameters_normalized).length > 0 && (
        <div className="mt-3">
          <h4 className="text-sm font-medium text-gray-700">Parametry</h4>
          <div className="mt-1 flex flex-wrap gap-2">
            {Object.entries(product.parameters_normalized).map(([k, v]) => (
              <span key={k} className="rounded bg-gray-100 px-2 py-1 text-xs">
                {k}: {String(v)}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Ceny */}
      {product.prices && product.prices.length > 0 && (
        <div className="mt-3">
          <h4 className="text-sm font-medium text-gray-700">Ceny</h4>
          <table className="mt-1 w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1">Zdroj</th>
                <th className="py-1 text-right">Bez DPH</th>
                <th className="py-1 text-right">S DPH</th>
                <th className="py-1">Dostupnost</th>
                <th className="py-1">Aktualizace</th>
              </tr>
            </thead>
            <tbody>
              {product.prices.map((price: any, i: number) => (
                <tr key={i} className="border-t">
                  <td className="py-1">{price.source_name}</td>
                  <td className="py-1 text-right font-medium">
                    {Number(price.price_bez_dph).toLocaleString('cs')} CZK
                  </td>
                  <td className="py-1 text-right">
                    {price.price_s_dph ? `${Number(price.price_s_dph).toLocaleString('cs')} CZK` : '-'}
                  </td>
                  <td className="py-1">{price.availability || '-'}</td>
                  <td className="py-1 text-gray-500">
                    {new Date(price.fetched_at).toLocaleDateString('cs')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
