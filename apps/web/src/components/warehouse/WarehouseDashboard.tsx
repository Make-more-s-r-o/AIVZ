import { useState, useEffect, useRef, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getWarehouseStats, getWarehouseQualityStats, getWarehouseSources,
  getScrapeJobs, startScraping, enrichWithIcecat,
  type WarehouseStats, type DataSourceWithDetails,
} from '../../lib/api';
import ProductList from './ProductList';
import ImportWizard from './ImportWizard';
import { useHashParams } from '../../hooks/useHashParams';
import { formatPrice, FreshnessDot, JobStatusBadge } from './shared';
import { Select, Input } from '../ui';

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
      <div className="rounded-lg p-6 text-center" style={{ border: '1px solid var(--danger-bg)', background: 'var(--danger-soft-bg)' }}>
        <p style={{ color: 'var(--danger-fg)' }}>Cenový sklad není dostupný</p>
        <p className="mt-1 text-sm" style={{ color: 'var(--danger-solid)' }}>{(error as Error).message}</p>
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
          <h2 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>Cenový sklad</h2>
          {stats && (
            <p className="mt-1 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {stats.products_active} aktivních produktů | {stats.prices} cen | {stats.sources} zdrojů
            </p>
          )}
        </div>
        {tab === 'products' && (
          <div className="flex items-center gap-1 rounded-md p-0.5" style={{ border: '1px solid var(--border-default)' }}>
            <button
              onClick={() => handleViewModeChange('list')}
              className="rounded px-2 py-1 text-xs"
              style={viewMode === 'list'
                ? { background: 'var(--gray-100)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }
                : { color: 'var(--text-secondary)' }}
              title="Seznam"
            >
              |||
            </button>
            <button
              onClick={() => handleViewModeChange('grid')}
              className="rounded px-2 py-1 text-xs"
              style={viewMode === 'grid'
                ? { background: 'var(--gray-100)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }
                : { color: 'var(--text-secondary)' }}
              title="Mřížka"
            >
              :::
            </button>
          </div>
        )}
      </div>

      <div className="mb-4" style={{ borderBottom: '1px solid var(--border-default)' }}>
        <nav className="-mb-px flex gap-4">
          {tabs.map((t) => (
            <TabButton key={t.id} active={tab === t.id} label={t.label} onClick={() => handleTabChange(t.id)} />
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

function TabButton({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="px-1 py-2 text-sm font-medium"
      style={{
        borderBottom: `2px solid ${active ? 'var(--accent)' : hover ? 'var(--border-strong)' : 'transparent'}`,
        color: active ? 'var(--accent)' : hover ? 'var(--text-primary)' : 'var(--text-secondary)',
      }}
    >
      {label}
    </button>
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
            <div key={i} className="rounded-lg p-4 animate-pulse" style={{ border: '1px solid var(--border-default)' }}>
              <div className="h-3 w-20 rounded mb-2" style={{ background: 'var(--gray-200)' }} />
              <div className="h-7 w-16 rounded" style={{ background: 'var(--gray-200)' }} />
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
        <div className="rounded-lg border p-4" style={{ background: 'var(--surface-card)', borderColor: 'var(--border-default)' }}>
          <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Kvalita dat</h3>
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
        <div className="rounded-lg border" style={{ background: 'var(--surface-card)', borderColor: 'var(--border-default)' }}>
          <h3 className="px-4 py-3 text-sm font-semibold" style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-default)' }}>Rozložení kategorií</h3>
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--surface-sunken)' }}>
              <tr>
                <th className="px-4 py-2 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Kategorie</th>
                <th className="px-4 py-2 text-right font-medium" style={{ color: 'var(--text-secondary)' }}>Produktů</th>
                <th className="px-4 py-2 text-right font-medium" style={{ color: 'var(--text-secondary)' }}>Průměrná cena</th>
              </tr>
            </thead>
            <tbody>
              {quality.categories_breakdown.map((c) => (
                <HoverRow key={c.category_id}>
                  <td className="px-4 py-2" style={{ color: 'var(--text-primary)' }}>{c.category_nazev || 'Bez kategorie'}</td>
                  <td className="px-4 py-2 text-right font-medium" style={{ color: 'var(--text-primary)' }}>{c.product_count}</td>
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--text-secondary)' }}>{formatPrice(c.avg_price)}</td>
                </HoverRow>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Poslední scraping joby */}
      {jobs && jobs.length > 0 && (
        <div className="rounded-lg border" style={{ background: 'var(--surface-card)', borderColor: 'var(--border-default)' }}>
          <h3 className="px-4 py-3 text-sm font-semibold" style={{ color: 'var(--text-secondary)', borderBottom: '1px solid var(--border-default)' }}>Posledních 5 scraping jobů</h3>
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--surface-sunken)' }}>
              <tr>
                <th className="px-4 py-2 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Zdroj</th>
                <th className="px-4 py-2 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Stav</th>
                <th className="px-4 py-2 text-right font-medium" style={{ color: 'var(--text-secondary)' }}>Nalezeno</th>
                <th className="px-4 py-2 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Čas</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <HoverRow key={j.id}>
                  <td className="px-4 py-2" style={{ color: 'var(--text-primary)' }}>{j.source_name}</td>
                  <td className="px-4 py-2">
                    <JobStatusBadge status={j.status} />
                  </td>
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--text-primary)' }}>{j.items_found ?? '-'}</td>
                  <td className="px-4 py-2" style={{ color: 'var(--text-secondary)' }}>
                    {j.duration_ms ? `${(j.duration_ms / 1000).toFixed(1)}s` : '-'}
                  </td>
                </HoverRow>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Sdílený hover-highlight řádek tabulky (nahrazuje Tailwind `hover:bg-gray-50`). */
function HoverRow({ children }: { children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ background: hover ? 'var(--surface-hover)' : 'transparent', borderTop: '1px solid var(--border-subtle)' }}
    >
      {children}
    </tr>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-lg border p-4" style={{ background: 'var(--surface-card)', borderColor: 'var(--border-default)' }}>
      <div className="text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</div>
      <div className="mt-1 text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{value}</div>
      {sub && <div className="mt-0.5 text-xs" style={{ color: 'var(--text-tertiary)' }}>{sub}</div>}
    </div>
  );
}

function QualityMetric({ label, value, color }: { label: string; value: number; color: 'green' | 'yellow' | 'red' }) {
  const styles: Record<'green' | 'yellow' | 'red', { bg: string; fg: string; border: string; dot: string }> = {
    green: { bg: 'var(--success-soft-bg)', fg: 'var(--success-fg)', border: 'var(--success-bg)', dot: 'var(--success-solid)' },
    yellow: { bg: 'var(--warning-soft-bg)', fg: 'var(--warning-fg)', border: 'var(--warning-bg)', dot: 'var(--warning-solid)' },
    red: { bg: 'var(--danger-soft-bg)', fg: 'var(--danger-fg)', border: 'var(--danger-bg)', dot: 'var(--danger-solid)' },
  };
  const s = styles[color];

  return (
    <div className="rounded-lg p-3" style={{ border: `1px solid ${s.border}`, background: s.bg, color: s.fg }}>
      <div className="flex items-center gap-1.5">
        <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.dot }} />
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

  if (!sources) return <div className="py-6 text-center" style={{ color: 'var(--text-tertiary)' }}>Načítám...</div>;

  if (sources.length === 0) {
    return (
      <div className="py-12 text-center" style={{ color: 'var(--text-tertiary)' }}>
        Žádné zdroje. Přidejte zdroj přes import.
      </div>
    );
  }

  return (
    <div className="rounded-lg" style={{ border: '1px solid var(--border-default)' }}>
      <table className="w-full text-sm">
        <thead style={{ background: 'var(--surface-sunken)' }}>
          <tr>
            <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Stav</th>
            <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Zdroj</th>
            <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Typ</th>
            <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>URL</th>
            <th className="px-4 py-3 text-right font-medium" style={{ color: 'var(--text-secondary)' }}>Cen</th>
            <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Poslední scraping</th>
            <th className="px-4 py-3 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Podpora</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s) => {
            const supported = !s.scraper_config?.unsupported;
            return (
              <SourceRow key={s.id} source={s} supported={supported} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function SourceRow({ source: s, supported }: { source: DataSourceWithDetails; supported: boolean }) {
  const [hover, setHover] = useState(false);
  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        background: hover ? 'var(--surface-hover)' : 'transparent',
        opacity: supported ? 1 : 0.6,
        borderTop: '1px solid var(--border-subtle)',
      }}
    >
      <td className="px-4 py-3">
        <FreshnessDot lastScrapedAt={s.last_scraped_at} />
      </td>
      <td className="px-4 py-3 font-medium" style={{ color: 'var(--text-primary)' }}>{s.name}</td>
      <td className="px-4 py-3">
        <span className="rounded px-2 py-0.5 text-xs" style={{ background: 'var(--gray-100)', color: 'var(--text-secondary)' }}>{s.type}</span>
      </td>
      <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>{s.base_url || '-'}</td>
      <td className="px-4 py-3 text-right font-medium" style={{ color: 'var(--text-primary)' }}>{s.price_count || 0}</td>
      <td className="px-4 py-3" style={{ color: 'var(--text-secondary)' }}>
        {s.last_scraped_at
          ? new Date(s.last_scraped_at).toLocaleDateString('cs')
          : '-'}
      </td>
      <td className="px-4 py-3">
        {supported ? (
          <span className="rounded px-2 py-0.5 text-xs" style={{ background: 'var(--success-bg)', color: 'var(--success-fg)' }}>Aktivní</span>
        ) : (
          <span
            className="rounded px-2 py-0.5 text-xs"
            style={{ background: 'var(--gray-100)', color: 'var(--text-secondary)' }}
            title={String(s.scraper_config?.reason ?? 'Nepodporováno')}
          >
            Nepodporováno
          </span>
        )}
      </td>
    </tr>
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
      setMessage(`Icecat: obohaceno ${result.enriched} produktů, nenalezeno ${result.not_found}`);
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

  const sourceOptions = sources.map((s) => ({ value: String(s.id), label: s.name }));

  return (
    <div className="space-y-6">
      {/* Info box */}
      <div className="rounded-lg" style={{ border: '1px solid var(--info-bg)', background: 'var(--info-soft-bg)' }}>
        <button
          onClick={toggleInfo}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium"
          style={{ color: 'var(--info-fg)' }}
        >
          <span>Jak funguje scraping</span>
          <span>{isInfoOpen ? '▲' : '▼'}</span>
        </button>
        {isInfoOpen && (
          <div className="px-4 pb-4 text-sm space-y-2" style={{ color: 'var(--info-fg)' }}>
            <p><strong>Odkud bereme data:</strong> Produkty a ceny sbíráme automaticky z e-shopů. Aktuálně funguje Alza.cz. CZC a Heureka vyžadují CSV import.</p>
            <p><strong>Jak to funguje:</strong> Scraping stáhne produkty, automaticky je spáruje (EAN/P/N/název) a aktualizuje ceny.</p>
            <p><strong>Icecat enrichment:</strong> Dohledá detailní technické parametry přes mezinárodní katalog.</p>
            <p><strong>Freshness:</strong> Zelená = &lt; 7 dní, žlutá = 7-30 dní, červená = starší. Pro nabídky ověřte ceny starší 7 dní.</p>
            <p><strong>CSV import:</strong> Na záložce Import nahrajte CSV/Excel. Systém automaticky namapuje sloupce.</p>
          </div>
        )}
      </div>

      {/* Spustit scraping */}
      <div className="rounded-lg p-4" style={{ border: '1px solid var(--border-default)' }}>
        <h3 className="mb-3 text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Spustit scraping</h3>
        <div className="flex flex-wrap gap-3">
          <div className="w-56">
            <Select
              value={selectedSource != null ? String(selectedSource) : ''}
              onChange={(e) => setSelectedSource(e.target.value ? Number(e.target.value) : null)}
              options={sourceOptions}
              placeholder="Vyberte zdroj..."
            />
          </div>
          <div className="flex-1 min-w-[180px]">
            <Input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Hledaný výraz (volitelné)"
            />
          </div>
          <div className="w-24">
            <Input
              type="number"
              value={maxItems}
              onChange={(e) => setMaxItems(Number(e.target.value))}
              min={10}
              max={1000}
            />
          </div>
          <button
            onClick={handleStartScrape}
            disabled={!selectedSource || loading}
            className="rounded px-4 py-2 text-sm"
            style={{ background: 'var(--accent)', color: 'var(--text-on-accent)', opacity: (!selectedSource || loading) ? 0.5 : 1 }}
          >
            {loading ? 'Spouštím...' : 'Scrape'}
          </button>
          <button
            onClick={handleIcecatEnrich}
            disabled={loading}
            className="rounded px-4 py-2 text-sm"
            style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)', opacity: loading ? 0.5 : 1 }}
          >
            Icecat enrichment
          </button>
        </div>
        {message && (
          <p className="mt-2 text-sm" style={{ color: message.startsWith('Chyba') ? 'var(--danger-solid)' : 'var(--success-fg)' }}>
            {message}
          </p>
        )}
      </div>

      {/* Joby */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Scraping joby</h3>
          <button onClick={() => refetchJobs()} className="text-sm" style={{ color: 'var(--accent)' }}>
            Obnovit
          </button>
        </div>
        <div className="rounded-lg" style={{ border: '1px solid var(--border-default)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--surface-sunken)' }}>
              <tr>
                <th className="px-4 py-2 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Zdroj</th>
                <th className="px-4 py-2 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Dotaz</th>
                <th className="px-4 py-2 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Stav</th>
                <th className="px-4 py-2 text-right font-medium" style={{ color: 'var(--text-secondary)' }}>Nalezeno</th>
                <th className="px-4 py-2 text-right font-medium" style={{ color: 'var(--text-secondary)' }}>Nových</th>
                <th className="px-4 py-2 text-right font-medium" style={{ color: 'var(--text-secondary)' }}>Aktual.</th>
                <th className="px-4 py-2 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Čas</th>
              </tr>
            </thead>
            <tbody>
              {!jobs || jobs.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-6 text-center" style={{ color: 'var(--text-tertiary)' }}>Žádné joby</td></tr>
              ) : jobs.map((j: any) => (
                <HoverRow key={j.id}>
                  <td className="px-4 py-2" style={{ color: 'var(--text-primary)' }}>{j.source_name}</td>
                  <td className="px-4 py-2" style={{ color: 'var(--text-secondary)' }}>{j.query || '-'}</td>
                  <td className="px-4 py-2">
                    <JobStatusBadge status={j.status} />
                  </td>
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--text-primary)' }}>{j.items_found ?? '-'}</td>
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--success-fg)' }}>{j.items_new ?? '-'}</td>
                  <td className="px-4 py-2 text-right" style={{ color: 'var(--info-fg)' }}>{j.items_updated ?? '-'}</td>
                  <td className="px-4 py-2" style={{ color: 'var(--text-secondary)' }}>
                    {j.duration_ms ? `${(j.duration_ms / 1000).toFixed(1)}s` : '-'}
                  </td>
                </HoverRow>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
