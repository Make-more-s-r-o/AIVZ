import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, FileText, ArrowRight, Radar, ExternalLink, RefreshCw, Check, X } from 'lucide-react';
import FileUpload from '../components/FileUpload';
import { Button, Card, useToast } from '../components/ui';
import { StageBadge } from '../components/crm';
import { DecisionPill } from '../components/crm/DecisionPill';
import {
  getTenders, uploadFiles,
  syncMonitoring, getMonitoringFeed, prevzitMonitoring, ignorovatMonitoring,
  type TenderSummary, type MonitoringFeedItem, type MonitoringStav,
} from '../lib/api';
import { effectiveStage } from '../lib/crm-adapters';
import type { Decision } from '../lib/crm-adapters';
import { fmtCZK } from '../lib/format';

export interface MonitoringPageProps {
  onOpen?: (id: string) => void;
}

const STEP_LABELS: Array<{ key: keyof TenderSummary['steps']; label: string }> = [
  { key: 'extract', label: 'Extrakce' },
  { key: 'analyze', label: 'Analýza' },
  { key: 'match', label: 'Ocenění' },
  { key: 'generate', label: 'Generování' },
  { key: 'validate', label: 'Validace' },
];

// Stav kroku do tooltipu (a11y — stav nesmí být rozlišen jen barvou tečky).
const STEP_STATUS_LABEL: Record<string, string> = {
  done: 'hotovo', running: 'probíhá', error: 'chyba', pending: 'čeká',
};

const STAV_TABS: Array<{ key: MonitoringStav; label: string }> = [
  { key: 'nova', label: 'Nové' },
  { key: 'prevzata', label: 'Převzaté' },
  { key: 'ignorovana', label: 'Ignorované' },
];

/**
 * Monitoring: operátor ráno vidí NOVÉ veřejné zakázky (feed ze zdroje NEN / Hlídač)
 * s go/no-go skóre a jedním klikem z nich založí zakázku v systému.
 */
export default function MonitoringPage({ onOpen }: MonitoringPageProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [stavFilter, setStavFilter] = useState<MonitoringStav>('nova');
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: tenders = [], isLoading } = useQuery({ queryKey: ['tenders'], queryFn: getTenders });
  const { data: feed = [], isLoading: feedLoading } = useQuery({
    queryKey: ['monitoring-feed', stavFilter],
    queryFn: () => getMonitoringFeed(stavFilter),
  });

  // Nezpracované (analýza není hotová) nahoru — to je fronta k vyřízení.
  const ordered = useMemo(() => {
    const pending = tenders.filter((t) => t.steps.analyze !== 'done');
    const done = tenders.filter((t) => t.steps.analyze === 'done');
    return { pending, done };
  }, [tenders]);

  async function handleUpload(files: File[]) {
    if (uploading || files.length === 0) return;
    setUploading(true);
    try {
      const created = await uploadFiles(files);
      await qc.invalidateQueries({ queryKey: ['tenders'] });
      toast(`Nahráno ${files.length} soubor(ů) — zakázka připravena ke zpracování`, 'success');
      if (created?.id && onOpen) onOpen(created.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Nahrání selhalo', 'danger');
    } finally {
      setUploading(false);
    }
  }

  async function handleSync() {
    if (syncing) return;
    setSyncing(true);
    try {
      const r = await syncMonitoring({ zdroj: 'nen' });
      await qc.invalidateQueries({ queryKey: ['monitoring-feed'] });
      toast(r.novych > 0 ? `Načteno ${r.novych} nových zakázek (${r.nalezeno} celkem)` : `Žádné nové zakázky (${r.nalezeno} zkontrolováno)`, 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Synchronizace selhala', 'danger');
    } finally {
      setSyncing(false);
    }
  }

  async function handlePrevzit(item: MonitoringFeedItem) {
    if (busyId) return;
    setBusyId(item.id);
    try {
      const r = await prevzitMonitoring(item.id);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['monitoring-feed'] }),
        qc.invalidateQueries({ queryKey: ['tenders'] }),
      ]);
      toast(
        r.alreadyTaken ? 'Zakázka už byla převzata — otevírám detail' : 'Zakázka založena — otevírám detail, nahrajte zadávací dokumentaci',
        'success',
      );
      if (r.tender_id && onOpen) onOpen(r.tender_id);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Převzetí selhalo', 'danger');
    } finally {
      setBusyId(null);
    }
  }

  async function handleIgnorovat(item: MonitoringFeedItem) {
    if (busyId) return;
    setBusyId(item.id);
    try {
      await ignorovatMonitoring(item.id);
      await qc.invalidateQueries({ queryKey: ['monitoring-feed'] });
      toast('Zakázka skryta z feedu', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Akce selhala', 'danger');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <div>
        <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--weight-bold)', color: 'var(--text-primary)', margin: 0 }}>
          Monitoring
        </h1>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
          Synchronizujte nové veřejné zakázky ze zdroje, nebo nahrajte zadávací dokumentaci ručně.
        </p>
      </div>

      {/* Feed nových zakázek ze zdroje */}
      <div style={{ marginTop: 20 }}>
        <Card
          title="Feed veřejných zakázek"
          action={(
            <Button variant="primary" size="sm" iconLeft={<RefreshCw size={15} />} onClick={handleSync} disabled={syncing}>
              {syncing ? 'Synchronizuji…' : 'Synchronizovat'}
            </Button>
          )}
        >
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {STAV_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setStavFilter(tab.key)}
                style={{
                  padding: '4px 12px', borderRadius: 'var(--radius-full)', border: '1px solid',
                  fontSize: 'var(--font-size-sm)', cursor: 'pointer',
                  borderColor: stavFilter === tab.key ? 'var(--accent)' : 'var(--border-default)',
                  background: stavFilter === tab.key ? 'var(--accent-soft-bg)' : 'transparent',
                  color: stavFilter === tab.key ? 'var(--accent)' : 'var(--text-secondary)',
                  fontWeight: stavFilter === tab.key ? 'var(--weight-semibold)' : 'var(--weight-regular)',
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {feedLoading ? (
            <Muted>Načítám…</Muted>
          ) : feed.length === 0 ? (
            <EmptyFeed stav={stavFilter} />
          ) : (
            <FeedTable
              items={feed}
              stav={stavFilter}
              busyId={busyId}
              onPrevzit={handlePrevzit}
              onIgnorovat={handleIgnorovat}
            />
          )}
        </Card>
      </div>

      {/* Ruční upload */}
      <div style={{ marginTop: 20 }}>
        <Card title="Nahrát zakázku ručně">
          <FileUpload onUpload={handleUpload} isUploading={uploading} />
        </Card>
      </div>

      {/* Fronta ke zpracování */}
      <div style={{ marginTop: 20 }}>
        <SectionTitle>Čeká na zpracování {ordered.pending.length > 0 && <Count n={ordered.pending.length} />}</SectionTitle>
        {isLoading ? (
          <Muted>Načítám…</Muted>
        ) : ordered.pending.length === 0 ? (
          <EmptyInbox hasTenders={tenders.length > 0} />
        ) : (
          <CardGrid>
            {ordered.pending.map((t) => <TenderCard key={t.id} t={t} onOpen={onOpen} />)}
          </CardGrid>
        )}
      </div>

      {/* Zpracované */}
      {ordered.done.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <SectionTitle>Zpracované <Count n={ordered.done.length} /></SectionTitle>
          <CardGrid>
            {ordered.done.map((t) => <TenderCard key={t.id} t={t} onOpen={onOpen} />)}
          </CardGrid>
        </div>
      )}
    </div>
  );
}

function FeedTable({ items, stav, busyId, onPrevzit, onIgnorovat }: {
  items: MonitoringFeedItem[];
  stav: MonitoringStav;
  busyId: string | null;
  onPrevzit: (item: MonitoringFeedItem) => void;
  onIgnorovat: (item: MonitoringFeedItem) => void;
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-sm)' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: 'var(--text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
            <Th>Zakázka</Th>
            <Th>Zadavatel</Th>
            <Th align="right">Hodnota</Th>
            <Th>Lhůta</Th>
            <Th>Skóre</Th>
            <Th align="right">Akce</Th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} style={{ borderTop: '1px solid var(--border-default)' }}>
              <Td>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 360 }}>
                  <span style={{ fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>{item.nazev}</span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--font-size-2xs)', color: 'var(--text-tertiary)' }}>
                    {item.zdroj.toUpperCase()} · {item.zdroj_id}
                    {item.url && (
                      <a href={item.url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', color: 'var(--accent)' }} aria-label="Otevřít u zdroje">
                        <ExternalLink size={11} />
                      </a>
                    )}
                  </span>
                </div>
              </Td>
              <Td><span style={{ color: 'var(--text-secondary)' }}>{item.zadavatel || '—'}</span></Td>
              <Td align="right">{item.predpokladana_hodnota != null ? fmtCZK(item.predpokladana_hodnota) : '—'}</Td>
              <Td>{item.lhuta_nabidek || '—'}</Td>
              <Td>
                <DecisionPill
                  decision={item.go_no_go.doporuceni as Decision}
                  score={item.go_no_go.score}
                  reasons={item.go_no_go.duvody}
                  style={{ padding: '3px 10px', fontSize: 'var(--font-size-xs)' }}
                />
              </Td>
              <Td align="right">
                {stav === 'nova' ? (
                  <div style={{ display: 'inline-flex', gap: 6 }}>
                    <Button size="sm" variant="primary" iconLeft={<Check size={14} />} disabled={busyId === item.id} onClick={() => onPrevzit(item)}>
                      Převzít
                    </Button>
                    <Button size="sm" variant="ghost" iconLeft={<X size={14} />} disabled={busyId === item.id} onClick={() => onIgnorovat(item)}>
                      Ignorovat
                    </Button>
                  </div>
                ) : stav === 'prevzata' && item.tender_id ? (
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>{item.tender_id}</span>
                ) : (
                  <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>—</span>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <th style={{ padding: '6px 10px', textAlign: align, fontWeight: 'var(--weight-medium)' }}>{children}</th>;
}
function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return <td style={{ padding: '10px', textAlign: align, verticalAlign: 'middle' }}>{children}</td>;
}

function EmptyFeed({ stav }: { stav: MonitoringStav }) {
  const msg = stav === 'nova'
    ? 'Feed je prázdný — klikněte na Synchronizovat pro načtení nových zakázek ze zdroje.'
    : stav === 'prevzata'
      ? 'Zatím žádné převzaté zakázky.'
      : 'Zatím žádné ignorované zakázky.';
  return (
    <div style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
      <Radar size={24} style={{ color: 'var(--text-tertiary)', marginBottom: 8 }} />
      <div>{msg}</div>
    </div>
  );
}

function TenderCard({ t, onOpen }: { t: TenderSummary; onOpen?: (id: string) => void }) {
  const [hover, setHover] = useState(false);
  const stage = effectiveStage({ status: t.status, steps: t.steps });
  const nazev = t.name || t.tenderId || t.id;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(t.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(t.id); } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', flexDirection: 'column', gap: 10, padding: 14, cursor: 'pointer', textAlign: 'left',
        background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)',
        boxShadow: hover ? 'var(--shadow-sm)' : 'none', transition: 'box-shadow var(--duration-fast), border-color var(--duration-fast)',
        borderColor: hover ? 'var(--border-strong)' : 'var(--border-default)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{
          flexShrink: 0, width: 32, height: 32, borderRadius: 'var(--radius-md)', background: 'var(--surface-sunken)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)',
        }}>
          <FileText size={16} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {nazev}
          </div>
          <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--text-tertiary)', marginTop: 1 }}>
            {t.inputFiles.length} {filesPlural(t.inputFiles.length)}
          </div>
        </div>
        <ArrowRight size={15} style={{ color: hover ? 'var(--accent)' : 'var(--text-tertiary)', flexShrink: 0 }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <StageBadge status={stage} size="sm" />
        <div style={{ display: 'flex', gap: 4 }}>
          {STEP_LABELS.map((s) => {
            const st = t.steps[s.key];
            const color = st === 'done' ? 'var(--success-solid)' : st === 'running' ? 'var(--accent)' : st === 'error' ? 'var(--danger-solid)' : 'var(--border-strong)';
            return <span key={s.key} title={`${s.label}: ${STEP_STATUS_LABEL[st] ?? st}`} style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />;
          })}
        </div>
      </div>
    </div>
  );
}

function filesPlural(n: number): string {
  if (n === 1) return 'soubor';
  if (n >= 2 && n <= 4) return 'soubory';
  return 'souborů';
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <h2 style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', margin: 0 }}>
        {children}
      </h2>
    </div>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 20, height: 20, padding: '0 6px',
      fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-secondary)',
      background: 'var(--surface-sunken)', borderRadius: 'var(--radius-full)',
    }}>{n}</span>
  );
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>{children}</div>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)', padding: '8px 0' }}>{children}</div>;
}

function EmptyInbox({ hasTenders }: { hasTenders: boolean }) {
  return (
    <div style={{
      padding: '40px 24px', textAlign: 'center', background: 'var(--surface-card)',
      border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-lg)',
    }}>
      <Inbox size={26} style={{ color: 'var(--text-tertiary)', marginBottom: 8 }} />
      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
        {hasTenders
          ? 'Fronta je prázdná — všechny nahrané zakázky mají hotovou analýzu.'
          : 'Zatím žádné zakázky — nahrajte první zadávací dokumentaci výše.'}
      </div>
    </div>
  );
}
