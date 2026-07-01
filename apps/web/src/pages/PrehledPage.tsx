import type { ReactNode } from 'react';
import { useQuery, useQueries } from '@tanstack/react-query';
import { Target, TrendingUp, Coins, FileText, Sparkles, ListChecks, Bell, GitBranch, UserPlus, History } from 'lucide-react';
import {
  getTenders, getAnalysis, getCost, getRecentActivity, getUsers, getMyTasks,
  type TenderSummary, type CostSummary, type Task,
} from '../lib/api';
import type { TenderAnalysis } from '../types/tender';
import { getStoredUser } from '../lib/auth';
import { effectiveStage, deadlineDays } from '../lib/crm-adapters';
import { STAGES, STAGE_PROBABILITY, STAGE_LABELS, isTerminalStage, type StageKey } from '../lib/stages';
import { fmtCZK } from '../lib/format';
import { KpiCard, DeadlineCountdown } from '../components/crm';
import { Card, Badge } from '../components/ui';

export interface PrehledPageProps {
  onOpen?: (id: string) => void;
  currentUserId?: string;
}

interface Row {
  tender: TenderSummary;
  analysis: TenderAnalysis | undefined;
  cost: CostSummary | undefined;
  stage: StageKey;
}

// Abbreviated millions, value only (unit rendered separately in KpiCard). "38,2"
function milValue(n: number): string {
  return (n / 1e6).toLocaleString('cs-CZ', { maximumFractionDigits: 1 });
}

// Priorita úkolu → tón odznaku + český popisek.
const priorityTone: Record<Task['priorita'], 'danger' | 'warning' | 'neutral'> = {
  vysoka: 'danger', stredni: 'warning', nizka: 'neutral',
};
const priorityLabel: Record<Task['priorita'], string> = {
  nizka: 'Nízká', stredni: 'Střední', vysoka: 'Vysoká',
};

/**
 * Přehled (Dashboard) — stav portfolia nabídek. KPI strip, trychtýř pipeline,
 * blížící se lhůty. Všechna čísla jsou počítána POUZE z reálných dat;
 * metriky bez zdroje (úspěšnost, win-rate) zobrazují '—' /
 * poctivý prázdný stav, nikdy vymyšlená čísla.
 */
export default function PrehledPage({ onOpen, currentUserId }: PrehledPageProps) {
  const { data: tenders = [], isLoading } = useQuery({ queryKey: ['tenders'], queryFn: getTenders });

  const analysisQueries = useQueries({
    queries: tenders.map((t) => ({
      queryKey: ['analysis', t.id],
      queryFn: () => getAnalysis(t.id),
      retry: false,
      enabled: t.steps.analyze === 'done',
      staleTime: 60_000,
    })),
  });

  const costQueries = useQueries({
    queries: tenders.map((t) => ({
      queryKey: ['cost', t.id],
      queryFn: () => getCost(t.id),
      retry: false,
      enabled: t.steps.analyze === 'done',
      staleTime: 60_000,
    })),
  });

  const { data: activity = [] } = useQuery({
    queryKey: ['recent-activity'], queryFn: getRecentActivity, retry: false, staleTime: 30_000,
  });
  const { data: users = [] } = useQuery({
    queryKey: ['users'], queryFn: getUsers, retry: false, staleTime: 5 * 60_000,
  });

  // Aktuální uživatel: přednostně prop z App, jinak lokálně uložený uživatel.
  const me = currentUserId ?? getStoredUser()?.id ?? '';
  const { data: myTasks = [] } = useQuery({
    queryKey: ['my-tasks', me || 'anon'],
    queryFn: () => getMyTasks(me),
    enabled: !!me,
    retry: false,
    staleTime: 30_000,
  });

  const rows: Row[] = tenders.map((t, i) => ({
    tender: t,
    analysis: analysisQueries[i]?.data,
    cost: costQueries[i]?.data,
    stage: effectiveStage({ status: t.status, steps: t.steps }),
  }));

  const tenderName = (id: string): string => tenders.find((t) => t.id === id)?.name ?? id;
  const userName = (id: string | null | undefined): string | null =>
    id ? users.find((u) => u.id === id)?.name ?? id : null;

  // --- KPI agregace (jen z reálných dat) ---
  let pipelineSum = 0;
  let pipelineHas = false;
  let weightedSum = 0;
  let weightedHas = false;
  let costSum = 0;
  let costHas = false;
  let pripravene = 0;

  for (const r of rows) {
    if (r.stage === 'pripravena') pripravene += 1;
    const v = r.analysis?.zakazka.predpokladana_hodnota;
    if (typeof v === 'number' && !Number.isNaN(v)) {
      if (!isTerminalStage(r.stage)) {
        pipelineSum += v;
        pipelineHas = true;
      }
      weightedSum += v * STAGE_PROBABILITY[r.stage];
      weightedHas = true;
    }
    const c = r.cost?.totalCZK;
    if (typeof c === 'number' && !Number.isNaN(c)) {
      costSum += c;
      costHas = true;
    }
  }

  const kpis: Array<{ label: string; value: string; unit?: string; icon: ReactNode }> = [
    { label: 'Úspěšnost nabídek', value: '—', icon: <Target size={16} strokeWidth={2} /> },
    {
      label: 'Hodnota pipeline',
      value: pipelineHas ? milValue(pipelineSum) : '—',
      unit: pipelineHas ? 'mil. Kč' : undefined,
      icon: <Coins size={16} strokeWidth={2} />,
    },
    {
      label: 'Vážená hodnota',
      value: weightedHas ? milValue(weightedSum) : '—',
      unit: weightedHas ? 'mil. Kč' : undefined,
      icon: <TrendingUp size={16} strokeWidth={2} />,
    },
    { label: 'Připravené nabídky', value: String(pripravene), icon: <FileText size={16} strokeWidth={2} /> },
    { label: 'AI náklady', value: costHas ? fmtCZK(costSum) : '—', icon: <Sparkles size={16} strokeWidth={2} /> },
  ];

  // --- Trychtýř pipeline (počty dle odvozené fáze) ---
  const funnel = STAGES.map((s) => ({
    key: s.key,
    label: s.label,
    n: rows.filter((r) => r.stage === s.key).length,
  }));
  const maxN = Math.max(1, ...funnel.map((f) => f.n));

  // --- Blížící se lhůty (jen zakázky s analyzovanou lhůtou) ---
  const deadlines = rows
    .map((r) => ({ r, days: deadlineDays(r.analysis?.terminy.lhuta_nabidek ?? null) }))
    .filter((x) => x.days != null)
    .sort((a, b) => (a.days ?? 0) - (b.days ?? 0))
    .slice(0, 6);

  if (isLoading) {
    return (
      <div style={{ maxWidth: 1280, margin: '0 auto', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
        Načítání…
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header */}
      <div>
        <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Přehled</h1>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
          Stav portfolia nabídek · {tenders.length} zakázek
        </p>
      </div>

      {/* KPI strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 16 }}>
        {kpis.map((k) => (
          <KpiCard key={k.label} label={k.label} value={k.value} unit={k.unit} icon={k.icon} />
        ))}
      </div>

      {/* Trychtýř + Lhůty */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 24, alignItems: 'start' }}>
        <Card title="Trychtýř pipeline">
          {rows.length === 0 ? (
            <EmptyText>Zatím žádné zakázky.</EmptyText>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {funnel.map((f) => (
                <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{
                    width: 150, flexShrink: 0, fontSize: 'var(--font-size-xs)',
                    color: 'var(--text-secondary)', textAlign: 'right',
                  }}>{f.label}</span>
                  <div style={{ flex: 1, height: 22, background: 'var(--surface-sunken)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                    <div style={{
                      width: `${(f.n / maxN) * 100}%`, height: '100%',
                      background: `var(--stage-${f.key}-dot)`, opacity: f.n ? 0.9 : 0,
                      transition: 'width var(--duration-normal) var(--ease-standard)',
                    }} />
                  </div>
                  <span style={{
                    width: 24, flexShrink: 0, fontWeight: 'var(--weight-semibold)',
                    color: 'var(--text-primary)', textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                  }}>{f.n}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Blížící se lhůty">
          {deadlines.length === 0 ? (
            <EmptyText>Žádné blížící se lhůty</EmptyText>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {deadlines.map(({ r, days }, idx) => {
                const nazev = r.tender.name ?? r.analysis?.zakazka.nazev ?? r.tender.tenderId;
                const zadavatel = r.analysis?.zakazka.zadavatel.nazev;
                return (
                  <div
                    key={r.tender.id}
                    onClick={() => onOpen?.(r.tender.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(r.tender.id); }}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
                      padding: '10px 4px', cursor: onOpen ? 'pointer' : 'default',
                      borderTop: idx === 0 ? 'none' : '1px solid var(--border-default)',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{
                        fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{nazev}</div>
                      <div style={{
                        fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{zadavatel ?? '—'}</div>
                    </div>
                    <DeadlineCountdown days={days} size="md" style={{ flexShrink: 0 }} />
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Úkoly + Aktivita */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
        <Card title="Moje úkoly" padding={myTasks.length ? 0 : 16}>
          {myTasks.length === 0 ? (
            <EmptyState icon={<ListChecks size={20} strokeWidth={2} />}>Zatím žádné úkoly.</EmptyState>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {myTasks.slice(0, 8).map((task, i) => (
                <div
                  key={task.id}
                  onClick={() => onOpen?.(task.tender_id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(task.tender_id); }
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 11, padding: '11px 16px', cursor: 'pointer',
                    borderTop: i ? '1px solid var(--border-subtle)' : 'none',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      title={task.title}
                      style={{
                        fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}
                    >{task.title}</div>
                    <div style={{
                      fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginTop: 1,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{tenderName(task.tender_id)}</div>
                  </div>
                  <Badge tone={priorityTone[task.priorita]} size="sm">{priorityLabel[task.priorita]}</Badge>
                  {task.due_date && <DeadlineCountdown date={task.due_date} size="md" style={{ flexShrink: 0 }} />}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title="Nedávná aktivita" padding={activity.length ? 0 : 16}>
          {activity.length === 0 ? (
            <EmptyState icon={<Bell size={20} strokeWidth={2} />}>Zatím žádná aktivita.</EmptyState>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {activity.slice(0, 8).map((a, i) => {
                const p = (a.payload ?? {}) as Record<string, unknown>;
                const actor = typeof p.actor_name === 'string' && p.actor_name ? p.actor_name : 'Systém';
                return (
                  <div
                    key={a.id}
                    onClick={() => onOpen?.(a.tender_id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === 'Enter') onOpen?.(a.tender_id); }}
                    style={{
                      display: 'flex', gap: 11, padding: '11px 16px', cursor: 'pointer',
                      borderTop: i ? '1px solid var(--border-subtle)' : 'none',
                    }}
                  >
                    <span style={{
                      width: 28, height: 28, borderRadius: 'var(--radius-md)', flexShrink: 0,
                      background: 'var(--surface-sunken)', color: 'var(--text-secondary)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <ActivityIcon type={a.type} />
                    </span>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)', lineHeight: 1.4 }}>
                        <b style={{ fontWeight: 'var(--weight-semibold)' }}>{actor}</b> {activityText(a.type, p, userName)}{' '}
                        <span style={{ color: 'var(--text-secondary)' }}>· {tenderName(a.tender_id)}</span>
                      </div>
                      <div
                        title={new Date(a.created_at).toLocaleString('cs-CZ')}
                        style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', marginTop: 1 }}
                      >
                        {relativeTime(a.created_at)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function EmptyText({ children }: { children: ReactNode }) {
  return (
    <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: 0 }}>{children}</p>
  );
}

// Relativní český čas z ISO (app-side, běží v prohlížeči).
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return 'právě teď';
  if (min < 60) return `před ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `před ${h} h`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'včera';
  if (d < 7) return `před ${d} dny`;
  return new Date(iso).toLocaleDateString('cs-CZ');
}

function activityText(
  type: string,
  p: Record<string, unknown>,
  userName: (id: string | null | undefined) => string | null,
): string {
  if (type === 'status_change') {
    const label = typeof p.new === 'string' ? STAGE_LABELS[p.new as StageKey] ?? p.new : '';
    const reason = typeof p.reason === 'string' && p.reason ? ` — ${p.reason}` : '';
    return `změnil(a) stav na ${label}${reason}`;
  }
  if (type === 'assignment') {
    const a = typeof p.assignee === 'string' ? p.assignee : null;
    return a ? `přiřadil(a) řešitele ${userName(a) ?? ''}`.trim() : 'odebral(a) řešitele';
  }
  return type;
}

function ActivityIcon({ type }: { type: string }) {
  if (type === 'status_change') return <GitBranch size={15} />;
  if (type === 'assignment') return <UserPlus size={15} />;
  return <History size={15} />;
}

function EmptyState({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 8, padding: '24px 0', color: 'var(--text-tertiary)', textAlign: 'center',
    }}>
      <span style={{ color: 'var(--text-tertiary)' }}>{icon}</span>
      <span style={{ fontSize: 'var(--font-size-sm)' }}>{children}</span>
    </div>
  );
}
