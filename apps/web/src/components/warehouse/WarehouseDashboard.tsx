import { useState, useEffect } from 'react';
import {
  getWarehouseStats, getWarehouseSources, getScrapeJobs, startScraping, enrichWithIcecat,
  type WarehouseStats,
} from '../../lib/api';
import ProductList from './ProductList';
import ImportWizard from './ImportWizard';

type Tab = 'products' | 'import' | 'sources' | 'scraping';

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
        <p className="text-red-700">Cenovy sklad neni dostupny</p>
        <p className="mt-1 text-sm text-red-500">{error}</p>
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'products', label: 'Produkty' },
    { id: 'import', label: 'Import' },
    { id: 'scraping', label: 'Scraping' },
    { id: 'sources', label: 'Zdroje dat' },
  ];

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Cenovy sklad</h2>
          {stats && (
            <p className="mt-1 text-sm text-gray-500">
              {stats.products_active} aktivnich produktu | {stats.prices} cen | {stats.sources} zdroju
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
      {tab === 'scraping' && <ScrapingPanel />}
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
            <th className="px-4 py-3 text-left font-medium text-gray-600">Posledni scraping</th>
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

function ScrapingPanel() {
  const [sources, setSources] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [selectedSource, setSelectedSource] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [maxItems, setMaxItems] = useState(100);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    getWarehouseSources().then(s => setSources(s.filter((x: any) => x.type === 'eshop' || x.type === 'apify')));
    loadJobs();
  }, []);

  const loadJobs = () => getScrapeJobs(20).then(setJobs).catch(() => {});

  const handleStartScrape = async () => {
    if (!selectedSource) return;
    setLoading(true);
    setMessage(null);
    try {
      const result = await startScraping({
        source_id: selectedSource,
        query: searchQuery || undefined,
        max_items: maxItems,
      });
      setMessage(`Scraping spusten: ${result.source}`);
      setTimeout(loadJobs, 3000);
    } catch (err: any) {
      setMessage(`Chyba: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleIcecatEnrich = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const result = await enrichWithIcecat(50);
      setMessage(`Icecat: obohaceno ${result.enriched} produktu, nenalezeno ${result.not_found}`);
    } catch (err: any) {
      setMessage(`Chyba: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const statusColors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    running: 'bg-blue-100 text-blue-700',
    done: 'bg-green-100 text-green-700',
    error: 'bg-red-100 text-red-700',
  };

  return (
    <div className="space-y-6">
      {/* Spustit scraping */}
      <div className="rounded-lg border p-4">
        <h3 className="mb-3 text-lg font-semibold">Spustit scraping</h3>
        <div className="flex flex-wrap gap-3">
          <select
            value={selectedSource ?? ''}
            onChange={(e) => setSelectedSource(e.target.value ? Number(e.target.value) : null)}
            className="rounded border px-3 py-2 text-sm"
          >
            <option value="">Vyberte zdroj...</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Hledany vyraz (volitelne)"
            className="flex-1 rounded border px-3 py-2 text-sm"
          />
          <input
            type="number"
            value={maxItems}
            onChange={(e) => setMaxItems(Number(e.target.value))}
            className="w-24 rounded border px-3 py-2 text-sm"
            min={10}
            max={1000}
          />
          <button
            onClick={handleStartScrape}
            disabled={!selectedSource || loading}
            className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {loading ? 'Spoustim...' : 'Scrape'}
          </button>
          <button
            onClick={handleIcecatEnrich}
            disabled={loading}
            className="rounded border px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Icecat enrichment
          </button>
        </div>
        {message && (
          <p className={`mt-2 text-sm ${message.startsWith('Chyba') ? 'text-red-600' : 'text-green-600'}`}>
            {message}
          </p>
        )}
      </div>

      {/* Joby */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Scraping joby</h3>
          <button onClick={loadJobs} className="text-sm text-blue-600 hover:text-blue-800">
            Obnovit
          </button>
        </div>
        <div className="rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Zdroj</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Dotaz</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Stav</th>
                <th className="px-4 py-2 text-right font-medium text-gray-600">Nalezeno</th>
                <th className="px-4 py-2 text-right font-medium text-gray-600">Novych</th>
                <th className="px-4 py-2 text-right font-medium text-gray-600">Aktual.</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Cas</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {jobs.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">Zadne joby</td></tr>
              ) : jobs.map((j) => (
                <tr key={j.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">{j.source_name}</td>
                  <td className="px-4 py-2 text-gray-500">{j.query || '-'}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${statusColors[j.status] || 'bg-gray-100'}`}>
                      {j.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">{j.items_found ?? '-'}</td>
                  <td className="px-4 py-2 text-right text-green-600">{j.items_new ?? '-'}</td>
                  <td className="px-4 py-2 text-right text-blue-600">{j.items_updated ?? '-'}</td>
                  <td className="px-4 py-2 text-gray-500">
                    {j.duration_ms ? `${(j.duration_ms / 1000).toFixed(1)}s` : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
