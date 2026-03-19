import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getWarehouseStats, getWarehouseQualityStats, getWarehouseSources,
  getScrapeJobs, startScraping, enrichWithIcecat,
  type WarehouseStats,
} from '../../lib/api';
import ProductList from './ProductList';
import ImportWizard from './ImportWizard';
import { useHashParams } from '../../hooks/useHashParams';
import { formatPrice, FreshnessDot, JobStatusBadge } from './shared';

type Tab = 'dashboard' | 'products' | 'import' | 'sources' | 'scraping';

const TAB_PATHS: Record<Tab, string> = {
  dashboard: '/warehouse',
  products: '/warehouse/products',
  import: '/warehouse/import',
  scraping: '/warehouse/scraping',
  sources: '/warehouse/sources',
};

function navigate(path: string) {
  window.location.hash = path;
}

interface WarehouseDashboardProps {
  initialTab?: Tab;
}

export default function WarehouseDashboard({ initialTab = 'dashboard' }: WarehouseDashboardProps) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const { getParam, setParams } = useHashParams();
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(() =>
    (localStorage.getItem('warehouse_view_mode') as 'list' | 'grid') || 'list'
  );

  // Sync tab s URL při změně z App.tsx
  useEffect(() => { setTab(initialTab); }, [initialTab]);

  const handleTabChange = useCallback((newTab: Tab) => {
    setTab(newTab);
    // Zachovat query params při přepnutí na products
    const hash = window.location.hash.slice(1) || '/';
    const qIdx = hash.indexOf('?');
    const qs = qIdx !== -1 ? hash.slice(qIdx) : '';
    navigate(newTab === 'products' ? `${TAB_PATHS[newTab]}${qs}` : TAB_PATHS[newTab]);
  }, []);

  const { data: stats, error, isLoading: isStatsLoading } = useQuery({
    queryKey: ['warehouse-stats'],
    queryFn: getWarehouseStats,
    staleTime: 30000,
  });

  // URL params -> filter state
  const query = getParam('q') || '';
  const categoryId = getParam('cat') ? Number(getParam('cat')) : undefined;
  const manufacturer = getParam('mfr') || undefined;
  const priceMin = getParam('price_min') ? Number(getParam('price_min')) : undefined;
  const priceMax = getParam('price_max') ? Number(getParam('price_max')) : undefined;
  const sortBy = getParam('sort') || '';
  const sortDir = getParam('dir') || 'asc';
  const page = getParam('p') ? Number(getParam('p')) : 0;

  const handleParamsChange = useCallback((updates: Record<string, string | null>) => {
    setParams(prev => {
      const next = new URLSearchParams(prev);
      for (const [k, v] of Object.entries(updates)) {
        if (v === null || v === '') next.delete(k);
        else next.set(k, v);
      }
      return next;
    });
  }, [setParams]);

  const handleProductClick = useCallback((productId: string) => {
    navigate(`/warehouse/product/${productId}`);
  }, []);

  const handleViewModeChange = (mode: 'list' | 'grid') => {
    setViewMode(mode);
    localStorage.setItem('warehouse_view_mode', mode);
  };

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-6 text-center">
        <p className="text-red-700">Cenový sklad není dostupný</p>
        <p className="mt-1 text-sm text-red-500">{(error as Error).message}</p>
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'dashboard', label: 'Přehled' },
    { id: 'products', label: 'Produkty' },
    { id: 'import', label: 'Import' },
    { id: 'scraping', label: 'Scraping' },
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
        {tab === 'products' && (
          <div className="flex items-center gap-1 rounded-md border p-0.5">
            <button
              onClick={() => handleViewModeChange('list')}
              className={`rounded px-2 py-1 text-xs ${viewMode === 'list' ? 'bg-gray-100 font-medium' : 'text-gray-500'}`}
              title="Seznam"
            >
              |||
            </button>
            <button
              onClick={() => handleViewModeChange('grid')}
              className={`rounded px-2 py-1 text-xs ${viewMode === 'grid' ? 'bg-gray-100 font-medium' : 'text-gray-500'}`}
              title="Mřížka"
            >
              :::
            </button>
          </div>
        )}
      </div>

      <div className="mb-4 border-b">
        <nav className="-mb-px flex gap-4">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => handleTabChange(t.id)}
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

      {tab === 'dashboard' && <DashboardPanel stats={stats} isStatsLoading={isStatsLoading} />}
      {tab === 'products' && (
        <ProductList
          query={query}
          categoryId={categoryId}
          manufacturer={manufacturer}
          priceMin={priceMin}
          priceMax={priceMax}
          sortBy={sortBy}
          sortDir={sortDir}
          page={page}
          viewMode={viewMode}
          onParamsChange={handleParamsChange}
          onProductClick={handleProductClick}
        />
      )}
      {tab === 'import' && <ImportWizard onImportDone={() => setTab('products')} />}
      {tab === 'scraping' && <ScrapingPanel />}
      {tab === 'sources' && <SourceList />}
    </div>
  );
}

// ============================================================
// Dashboard Panel
// ============================================================

function DashboardPanel({ stats, isStatsLoading }: { stats: WarehouseStats | null | undefined; isStatsLoading: boolean }) {
  const { data: quality } = useQuery({
    queryKey: ['warehouse-quality-stats'],
    queryFn: getWarehouseQualityStats,
    staleTime: 60000,
  });

  const { data: jobs } = useQuery({
    queryKey: ['warehouse-scrape-jobs', 5],
    queryFn: () => getScrapeJobs(5),
    staleTime: 30000,
  });

  return (
    <div className="space-y-6">
      {/* Stats karty */}
      {isStatsLoading ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="rounded-lg border p-4 animate-pulse">
              <div className="h-3 w-20 bg-gray-200 rounded mb-2" />
              <div className="h-7 w-16 bg-gray-200 rounded" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <StatCard label="Produkty" value={stats ? `${stats.products_active} / ${stats.products}` : '-'} sub="aktivní / celkem" />
          <StatCard label="Cenové záznamy" value={stats?.prices?.toString() || '-'} sub={quality ? `${quality.avg_prices_per_product.toFixed(1)} cen/produkt` : ''} />
          <StatCard label="Zdroje dat" value={stats?.sources?.toString() || '-'} sub="aktivních" />
          <StatCard label="Poslední import" value={stats?.last_import ? new Date(stats.last_import).toLocaleDateString('cs') : '-'} sub="" />
        </div>
      )}

      {/* Data quality metriky */}
      {quality && (
        <div className="rounded-lg border p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">Kvalita dat</h3>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
            <QualityMetric label="Ceny < 7 dní" value={quality.price_freshness.fresh} color="green" />
            <QualityMetric label="Ceny 7-30 dní" value={quality.price_freshness.aging} color="yellow" />
            <QualityMetric label="Ceny > 30 dní" value={quality.price_freshness.stale} color="red" />
            <QualityMetric label="Bez ceny" value={quality.products_without_price} color={quality.products_without_price > 0 ? 'red' : 'green'} />
            <QualityMetric label="Bez obrázku" value={quality.products_without_image} color={quality.products_without_image > 0 ? 'yellow' : 'green'} />
            <QualityMetric label="Bez popisu" value={quality.products_without_description} color={quality.products_without_description > 0 ? 'yellow' : 'green'} />
          </div>
        </div>
      )}

      {/* Rozložení kategorií */}
      {quality && quality.categories_breakdown.length > 0 && (
        <div className="rounded-lg border">
          <h3 className="px-4 py-3 text-sm font-semibold text-gray-700 border-b">Rozložení kategorií</h3>
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Kategorie</th>
                <th className="px-4 py-2 text-right font-medium text-gray-600">Produktů</th>
                <th className="px-4 py-2 text-right font-medium text-gray-600">Průměrná cena</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {quality.categories_breakdown.map((c) => (
                <tr key={c.category_id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">{c.category_nazev || 'Bez kategorie'}</td>
                  <td className="px-4 py-2 text-right font-medium">{c.product_count}</td>
                  <td className="px-4 py-2 text-right text-gray-600">{formatPrice(c.avg_price)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Poslední scraping joby */}
      {jobs && jobs.length > 0 && (
        <div className="rounded-lg border">
          <h3 className="px-4 py-3 text-sm font-semibold text-gray-700 border-b">Posledních 5 scraping jobů</h3>
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Zdroj</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Stav</th>
                <th className="px-4 py-2 text-right font-medium text-gray-600">Nalezeno</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Čas</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {jobs.map((j) => (
                <tr key={j.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">{j.source_name}</td>
                  <td className="px-4 py-2">
                    <JobStatusBadge status={j.status} />
                  </td>
                  <td className="px-4 py-2 text-right">{j.items_found ?? '-'}</td>
                  <td className="px-4 py-2 text-gray-500">
                    {j.duration_ms ? `${(j.duration_ms / 1000).toFixed(1)}s` : '-'}
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

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="mt-1 text-2xl font-bold text-gray-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-400">{sub}</div>}
    </div>
  );
}

function QualityMetric({ label, value, color }: { label: string; value: number; color: 'green' | 'yellow' | 'red' }) {
  const colors = {
    green: 'bg-green-50 text-green-700 border-green-200',
    yellow: 'bg-yellow-50 text-yellow-700 border-yellow-200',
    red: 'bg-red-50 text-red-700 border-red-200',
  };
  const dotColors = { green: 'bg-green-500', yellow: 'bg-yellow-500', red: 'bg-red-500' };

  return (
    <div className={`rounded-lg border p-3 ${colors[color]}`}>
      <div className="flex items-center gap-1.5">
        <span className={`inline-block h-2 w-2 rounded-full ${dotColors[color]}`} />
        <span className="text-xs">{label}</span>
      </div>
      <div className="mt-1 text-lg font-bold">{value}</div>
    </div>
  );
}

// ============================================================
// Source List
// ============================================================

function SourceList() {
  const { data: sources } = useQuery({
    queryKey: ['warehouse-sources'],
    queryFn: getWarehouseSources,
    staleTime: 30000,
  });

  if (!sources) return <div className="py-6 text-center text-gray-400">Načítám...</div>;

  if (sources.length === 0) {
    return (
      <div className="py-12 text-center text-gray-400">
        Žádné zdroje. Přidejte zdroj přes import.
      </div>
    );
  }

  return (
    <div className="rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Stav</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Zdroj</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Typ</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">URL</th>
            <th className="px-4 py-3 text-right font-medium text-gray-600">Cen</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Poslední scraping</th>
            <th className="px-4 py-3 text-left font-medium text-gray-600">Podpora</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {sources.map((s) => {
            const supported = !s.scraper_config?.unsupported;
            return (
              <tr key={s.id} className={`hover:bg-gray-50 ${!supported ? 'opacity-60' : ''}`}>
                <td className="px-4 py-3">
                  <FreshnessDot lastScrapedAt={s.last_scraped_at} />
                </td>
                <td className="px-4 py-3 font-medium">{s.name}</td>
                <td className="px-4 py-3">
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">{s.type}</span>
                </td>
                <td className="px-4 py-3 text-gray-500">{s.base_url || '-'}</td>
                <td className="px-4 py-3 text-right font-medium">{s.price_count || 0}</td>
                <td className="px-4 py-3 text-gray-500">
                  {s.last_scraped_at
                    ? new Date(s.last_scraped_at).toLocaleDateString('cs')
                    : '-'}
                </td>
                <td className="px-4 py-3">
                  {supported ? (
                    <span className="rounded bg-green-100 px-2 py-0.5 text-xs text-green-700">Aktivní</span>
                  ) : (
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-500" title={String(s.scraper_config?.reason ?? 'Nepodporováno')}>
                      Nepodporováno
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ============================================================
// Scraping Panel
// ============================================================

function ScrapingPanel() {
  const { data: allSources } = useQuery({
    queryKey: ['warehouse-sources'],
    queryFn: getWarehouseSources,
    staleTime: 30000,
  });

  const [selectedSource, setSelectedSource] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [maxItems, setMaxItems] = useState(100);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [isInfoOpen, setIsInfoOpen] = useState(() => localStorage.getItem('scraping_info_open') !== 'false');
  const pollingRef = useRef<ReturnType<typeof setInterval>>();

  // Filtrovat zdroje na podporovane
  const sources = (allSources || []).filter((s) => {
    if (s.type !== 'eshop' && s.type !== 'apify') return false;
    return !s.scraper_config?.unsupported;
  });

  const { data: jobs, refetch: refetchJobs } = useQuery({
    queryKey: ['warehouse-scrape-jobs', 20],
    queryFn: () => getScrapeJobs(20),
    staleTime: 5000,
  });

  // Polling dokud existuje running/pending job
  useEffect(() => {
    const hasActive = jobs?.some((j) => j.status === 'running' || j.status === 'pending');
    if (hasActive) {
      pollingRef.current = setInterval(() => refetchJobs(), 5000);
    }
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [jobs, refetchJobs]);

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
      setMessage(`Scraping spuštěn: ${result.source}`);
      refetchJobs();
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

  const toggleInfo = () => {
    const next = !isInfoOpen;
    setIsInfoOpen(next);
    localStorage.setItem('scraping_info_open', String(next));
  };

  return (
    <div className="space-y-6">
      {/* Info box */}
      <div className="rounded-lg border bg-blue-50 border-blue-200">
        <button
          onClick={toggleInfo}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-blue-700"
        >
          <span>Jak funguje scraping</span>
          <span>{isInfoOpen ? '▲' : '▼'}</span>
        </button>
        {isInfoOpen && (
          <div className="px-4 pb-4 text-sm text-blue-800 space-y-2">
            <p><strong>Odkud bereme data:</strong> Produkty a ceny sbíráme automaticky z e-shopů. Aktuálně funguje Alza.cz. CZC a Heureka vyžadují CSV import.</p>
            <p><strong>Jak to funguje:</strong> Scraping stáhne produkty, automaticky je spáruje (EAN/P/N/název) a aktualizuje ceny.</p>
            <p><strong>Icecat enrichment:</strong> Dohledá detailní technické parametry přes mezinárodní katalog.</p>
            <p><strong>Freshness:</strong> Zelená = &lt; 7 dní, žlutá = 7-30 dní, červená = starší. Pro nabídky ověřte ceny starší 7 dní.</p>
            <p><strong>CSV import:</strong> Na záložce Import nahrajte CSV/Excel. Systém automaticky namapuje sloupce.</p>
          </div>
        )}
      </div>

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
            placeholder="Hledaný výraz (volitelné)"
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
            {loading ? 'Spouštím...' : 'Scrape'}
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
          <button onClick={() => refetchJobs()} className="text-sm text-blue-600 hover:text-blue-800">
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
                <th className="px-4 py-2 text-right font-medium text-gray-600">Nových</th>
                <th className="px-4 py-2 text-right font-medium text-gray-600">Aktual.</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Čas</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {!jobs || jobs.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-400">Žádné joby</td></tr>
              ) : jobs.map((j: any) => (
                <tr key={j.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2">{j.source_name}</td>
                  <td className="px-4 py-2 text-gray-500">{j.query || '-'}</td>
                  <td className="px-4 py-2">
                    <JobStatusBadge status={j.status} />
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
