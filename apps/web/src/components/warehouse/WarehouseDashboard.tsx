import { useState, useEffect } from 'react';
import { getWarehouseStats, getWarehouseSources, type WarehouseStats } from '../../lib/api';
import ProductList from './ProductList';
import ImportWizard from './ImportWizard';

type Tab = 'products' | 'import' | 'sources';

export default function WarehouseDashboard() {
  const [tab, setTab] = useState<Tab>('products');
  const [stats, setStats] = useState<WarehouseStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getWarehouseStats()
      .then(setStats)
      .catch((err) => setError(err.message));
  }, [tab]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-red-700">Cenový sklad není dostupný</p>
        <p className="mt-1 text-sm text-red-500">{error}</p>
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'products', label: 'Produkty' },
    { id: 'import', label: 'Import' },
    { id: 'sources', label: 'Zdroje dat' },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Cenový sklad</h2>
          {stats && (
            <p className="mt-1 text-sm text-gray-500">
              {stats.products_active} aktivních produktů | {stats.prices} cen | {stats.sources} zdrojů
            </p>
          )}
        </div>
      </div>

      <div className="mb-4 border-b">
        <nav className="-mb-px flex gap-4">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`border-b-2 px-1 py-2 text-sm font-medium ${
                tab === t.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'products' && <ProductList />}
      {tab === 'import' && <ImportWizard onImportDone={() => setTab('products')} />}
      {tab === 'sources' && <SourceList />}
    </div>
  );
}

function SourceList() {
  const [sources, setSources] = useState<any[]>([]);

  useEffect(() => {
    getWarehouseSources().then(setSources);
  }, []);

  return (
    <div className="rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Zdroj</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Typ</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">URL</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Poslední scraping</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {sources.map((s) => (
            <tr key={s.id} className="hover:bg-gray-50">
              <td className="px-4 py-3 font-medium">{s.name}</td>
              <td className="px-4 py-3">
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">{s.type}</span>
              </td>
              <td className="px-4 py-3 text-gray-500">{s.base_url || '-'}</td>
              <td className="px-4 py-3 text-gray-500">
                {s.last_scraped_at
                  ? new Date(s.last_scraped_at).toLocaleDateString('cs')
                  : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
