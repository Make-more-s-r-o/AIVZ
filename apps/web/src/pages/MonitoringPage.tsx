import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, RefreshCw, Search, Settings2, Sparkles, X } from 'lucide-react';
import FileUpload from '../components/FileUpload';
import { DeadlineCountdown, DecisionPill } from '../components/crm';
import { Badge, Button, Card, Input, Select, useToast } from '../components/ui';
import {
  getMonitoringConfig,
  getMonitoringFeed,
  ignorovatMonitoring,
  prevzitMonitoring,
  syncMonitoring,
  uploadFiles,
  type MonitoringFeedItem,
  type MonitoringKategorie,
  type MonitoringStav,
} from '../lib/api';
import { deadlineDays, type Decision } from '../lib/crm-adapters';
import { fmtCZK } from '../lib/format';
import { MONITORING_CATEGORIES, MONITORING_CATEGORY_LABEL } from '../lib/monitoring';

export interface MonitoringPageProps {
  onOpen?: (id: string) => void;
}

const STAV_TABS: Array<{ key: MonitoringStav; label: string }> = [
  { key: 'nova', label: 'Nové' },
  { key: 'prevzata', label: 'Převzaté' },
  { key: 'ignorovana', label: 'Ignorované' },
];
const LAST_SYNC_KEY = 'monitoring_last_sync';

/** Operátorský pohled: relevance a rychlá triáž mají přednost před technickým stavem zdroje. */
export default function MonitoringPage({ onOpen }: MonitoringPageProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [stav, setStav] = useState<MonitoringStav>('nova');
  const [category, setCategory] = useState<MonitoringKategorie | undefined>();
  const [minScore, setMinScore] = useState('0');
  const [search, setSearch] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(() => localStorage.getItem(LAST_SYNC_KEY));

  const { data: config } = useQuery({ queryKey: ['monitoring-config'], queryFn: getMonitoringConfig });
  const { data: feed = [], isLoading } = useQuery({
    queryKey: ['monitoring-feed', stav, category ?? 'vse'],
    queryFn: () => getMonitoringFeed(stav, { kategorie: category }),
  });

  const filtered = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase('cs');
    const threshold = Number(minScore);
    return feed.filter((item) => item.go_no_go.score >= threshold
      && (!needle
        || item.nazev.toLocaleLowerCase('cs').includes(needle)
        || (item.zadavatel ?? '').toLocaleLowerCase('cs').includes(needle)));
  }, [feed, minScore, search]);

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      const result = await syncMonitoring();
      localStorage.setItem(LAST_SYNC_KEY, result.synchronizovano_at);
      setLastSync(result.synchronizovano_at);
      await qc.invalidateQueries({ queryKey: ['monitoring-feed'] });
      const summary = result.novych > 0
        ? `Načteno ${result.novych} nových zakázek (${result.nalezeno} unikátních).`
        : `Žádné nové zakázky (${result.nalezeno} unikátních zkontrolováno).`;
      // varovani ze /sync je informativní (typicky „NEN prázdný, doplněno z Hlídače"), sync
      // samotný přitom uspěl (HTTP 200) — nezobrazovat jako chybu.
      if (result.varovani) toast(`${summary} ${result.varovani}`, 'info');
      else toast(summary, 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Synchronizace selhala.', 'danger');
    } finally {
      setSyncing(false);
    }
  }

  async function handlePrevzit(item: MonitoringFeedItem, process = false) {
    if (busyId) return;
    setBusyId(item.id);
    try {
      const result = await prevzitMonitoring(item.id, process
        ? { stahnout_zd: true }
        : { spustit: false });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['monitoring-feed'] }),
        qc.invalidateQueries({ queryKey: ['tenders'] }),
      ]);
      if (result.varovani?.length) toast(result.varovani.join(' '), 'danger');
      toast(process && result.spusteno ? 'Zakázka převzata a zpracování spuštěno.' : 'Zakázka byla převzata.', 'success');
      if (result.tender_id && onOpen) onOpen(result.tender_id);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Převzetí selhalo.', 'danger');
    } finally {
      setBusyId(null);
    }
  }

  async function handleIgnore(item: MonitoringFeedItem) {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await ignorovatMonitoring(item.id);
      await qc.invalidateQueries({ queryKey: ['monitoring-feed'] });
      toast('Zakázka byla skryta z aktivního feedu.', 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Akce selhala.', 'danger');
    } finally {
      setBusyId(null);
    }
  }

  async function handleUpload(files: File[]) {
    if (uploading || files.length === 0) return;
    setUploading(true);
    try {
      const created = await uploadFiles(files);
      await qc.invalidateQueries({ queryKey: ['tenders'] });
      toast('Zakázka byla nahrána a je připravena ke zpracování.', 'success');
      if (created.id && onOpen) onOpen(created.id);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Nahrání selhalo.', 'danger');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1440, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 'var(--font-size-xl)', fontWeight: 'var(--weight-bold)' }}>Monitoring</h1>
          <p style={{ margin: '3px 0 0', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>Veřejné zakázky seřazené podle obchodní relevance.</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
            Poslední synchronizace: {lastSync ? formatSyncTime(lastSync) : 'zatím neproběhla'}
          </span>
          <a href="#/settings/monitoring" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--accent)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-medium)', textDecoration: 'none' }}>
            <Settings2 size={15} /> Nastavení zájmu
          </a>
          <Button iconLeft={<RefreshCw size={15} className={syncing ? 'animate-spin' : ''} />} disabled={syncing} onClick={handleSync}>
            {syncing ? 'Synchronizuji…' : 'Synchronizovat'}
          </Button>
        </div>
      </header>

      <Card style={{ marginTop: 20 }} padding={0}>
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-default)', display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {STAV_TABS.map((tab) => <FilterChip key={tab.key} active={stav === tab.key} onClick={() => setStav(tab.key)}>{tab.label}</FilterChip>)}
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <FilterChip active={!category} onClick={() => setCategory(undefined)}>Všechny kategorie</FilterChip>
            {MONITORING_CATEGORIES.map((item) => (
              <FilterChip key={item.value} active={category === item.value} onClick={() => setCategory(category === item.value ? undefined : item.value)}>{item.label}</FilterChip>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(240px, 1fr) 190px', gap: 10, maxWidth: 650 }}>
            <Input iconLeft={<Search size={15} />} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Hledat v názvu zakázky nebo zadavateli…" />
            <Select value={minScore} onChange={(event) => setMinScore(event.target.value)} options={[
              { value: '0', label: 'Všechna skóre' },
              { value: '45', label: 'Skóre alespoň 45' },
              { value: '75', label: 'Pouze GO (75+)' },
            ]} />
          </div>
        </div>

        {isLoading ? (
          <Muted>Načítám relevantní zakázky…</Muted>
        ) : filtered.length === 0 ? (
          <EmptyState hasSearchTerms={(config?.klicova_slova.length ?? 0) > 0} filtered={feed.length > 0} />
        ) : (
          <FeedTable items={filtered} stav={stav} busyId={busyId} onPrevzit={handlePrevzit} onIgnore={handleIgnore} />
        )}
      </Card>

      <Card title="Nahrát zadávací dokumentaci ručně" style={{ marginTop: 20 }}>
        <FileUpload onUpload={handleUpload} isUploading={uploading} />
      </Card>
    </div>
  );
}

function FeedTable({ items, stav, busyId, onPrevzit, onIgnore }: {
  items: MonitoringFeedItem[];
  stav: MonitoringStav;
  busyId: string | null;
  onPrevzit: (item: MonitoringFeedItem, process?: boolean) => void;
  onIgnore: (item: MonitoringFeedItem) => void;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', minWidth: 1120, borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
        <thead style={{ background: 'var(--surface-sunken)' }}>
          <tr style={{ color: 'var(--text-tertiary)', textAlign: 'left', fontSize: 'var(--font-size-xs)' }}>
            <Th>Skóre</Th><Th>Kategorie</Th><Th>Zakázka</Th><Th>Zadavatel</Th><Th align="right">Hodnota</Th><Th>Lhůta</Th><Th align="right">Akce</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const days = deadlineDays(item.lhuta_nabidek);
            return (
              <tr key={item.id} style={{ borderTop: '1px solid var(--border-default)' }}>
                <Td><DecisionPill decision={item.go_no_go.doporuceni as Decision} score={item.go_no_go.score} reasons={item.go_no_go.duvody} /></Td>
                <Td><Badge tone="outline" size="sm">{MONITORING_CATEGORY_LABEL[item.kategorie]}</Badge></Td>
                <Td>
                  <div style={{ display: 'grid', gap: 3, maxWidth: 410 }}>
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'flex-start', gap: 5, color: 'var(--text-primary)', fontWeight: 'var(--weight-semibold)', textDecoration: 'none' }}>
                        {item.nazev}<ExternalLink size={12} style={{ marginTop: 3, color: 'var(--accent)', flexShrink: 0 }} />
                      </a>
                    ) : <span style={{ color: 'var(--text-primary)', fontWeight: 'var(--weight-semibold)' }}>{item.nazev}</span>}
                    <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--font-size-2xs)' }}>{item.zdroj.toUpperCase()} · {item.zdroj_id}</span>
                  </div>
                </Td>
                <Td><span style={{ color: 'var(--text-secondary)' }}>{item.zadavatel || '—'}</span></Td>
                <Td align="right"><span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{item.predpokladana_hodnota != null ? fmtCZK(item.predpokladana_hodnota) : '—'}</span></Td>
                <Td><DeadlineCountdown date={item.lhuta_nabidek} style={days != null && days >= 0 && days <= 2 ? { color: 'var(--danger-solid)' } : undefined} /></Td>
                <Td align="right">
                  {stav === 'nova' ? (
                    <div style={{ display: 'inline-flex', gap: 5 }}>
                      {item.zdroj === 'nen' && <Button size="sm" iconLeft={<Sparkles size={13} />} disabled={busyId === item.id} onClick={() => onPrevzit(item, true)}>Převzít a zpracovat</Button>}
                      <Button size="sm" variant="secondary" iconLeft={<Check size={13} />} disabled={busyId === item.id} onClick={() => onPrevzit(item)}>Převzít</Button>
                      <Button size="sm" variant="ghost" iconLeft={<X size={13} />} disabled={busyId === item.id} onClick={() => onIgnore(item)}>Ignorovat</Button>
                    </div>
                  ) : stav === 'prevzata' && item.tender_id ? <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--font-size-xs)' }}>{item.tender_id}</span> : '—'}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} style={{ padding: '5px 10px', borderRadius: 'var(--radius-full)', border: `1px solid ${active ? 'var(--accent)' : 'var(--border-default)'}`, background: active ? 'var(--accent-soft-bg)' : 'var(--surface-card)', color: active ? 'var(--accent)' : 'var(--text-secondary)', fontSize: 'var(--font-size-xs)', fontWeight: active ? 'var(--weight-semibold)' : 'var(--weight-regular)', cursor: 'pointer' }}>
      {children}
    </button>
  );
}

function EmptyState({ hasSearchTerms, filtered }: { hasSearchTerms: boolean; filtered: boolean }) {
  const text = filtered
    ? 'Aktuálním filtrům neodpovídá žádná zakázka.'
    : hasSearchTerms
      ? 'Pro nastavený zájem zatím nejsou ve feedu žádné zakázky. Zkuste synchronizaci.'
      : 'Nejdřív nastavte klíčová slova a kategorie, které chcete sledovat.';
  return (
    <div style={{ padding: '48px 24px', textAlign: 'center' }}>
      <Settings2 size={28} style={{ color: 'var(--text-tertiary)', marginBottom: 9 }} />
      <p style={{ margin: '0 0 14px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>{text}</p>
      <a href="#/settings/monitoring" style={{ color: 'var(--accent)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', textDecoration: 'none' }}>Nastavit zájem monitoringu</a>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th style={{ padding: '9px 10px', textAlign: align, fontWeight: 'var(--weight-medium)', whiteSpace: 'nowrap' }}>{children}</th>;
}
function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <td style={{ padding: '11px 10px', textAlign: align, verticalAlign: 'middle' }}>{children}</td>;
}
function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ padding: 32, color: 'var(--text-secondary)', textAlign: 'center', fontSize: 'var(--font-size-sm)' }}>{children}</div>;
}
function formatSyncTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'neznámá';
  return new Intl.DateTimeFormat('cs-CZ', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}
