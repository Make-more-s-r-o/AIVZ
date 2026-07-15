import { useState, type CSSProperties, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Filter, ListChecks } from 'lucide-react';
import { getTendersSummary, getUsers, setTenderStatus, type SafeUser, type TenderSummary } from '../lib/api';
import { effectiveStage, normalizeDecision, type Decision } from '../lib/crm-adapters';
import { canTransition } from '../lib/stage-machine';
import { STAGES, STAGE_LABELS, type StageKey } from '../lib/stages';
import { fmtCZK, fmtMil } from '../lib/format';
import { Avatar, Badge, Button, useToast } from '../components/ui';
import { DecisionPill, DeadlineCountdown } from '../components/crm';

export interface PipelinePageProps {
  onOpen?: (id: string) => void;
}

// Reachable lifecycle columns (first 7 of the 10-stage model). Terminal výsledky
// (vyhráno / prohráno / nepodáno) nepatří do aktivního trychtýře.
const COLUMNS: StageKey[] = STAGES.slice(0, 7).map((s) => s.key);

interface EnrichedTender {
  tender: TenderSummary;
  nazev: string;
  stage: StageKey;
  zadavatel: string | null;
  hodnota: number | null;
  lhuta: string | null;
  decision: Decision | null;
  assignee: string | null;
  tasks: { done: number; total: number } | null;
}

/**
 * Pipeline (Kanban) — zakázky rozdělené dle efektivní fáze (persistovaný `status`
 * má přednost před fází odvozenou z pipeline kroků). Hodnota, zadavatel, lhůta
 * a doporučení se dotahují z analýzy (degraduje na „—", když chybí).
 *
 * Přetažením karty mezi sloupci se mění fáze (M2). Cíl ověří frontend state-machine
 * guard (canTransition); na zákaz se zobrazí toast a karta zůstane. Při povoleném
 * přechodu se stav persistuje přes setTenderStatus — bez DB (dev) degraduje na toast.
 */
export default function PipelinePage({ onOpen }: PipelinePageProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  // Jeden request se souhrnem analýzy embednutým na každé zakázce (zrušení N+1 getAnalysis).
  const { data: tenders = [] } = useQuery({ queryKey: ['tenders', 'summary'], queryFn: () => getTendersSummary() });

  // Řešitelé pro avatar na kartě (degraduje na holé ID / dashed kolečko, když chybí).
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: getUsers, retry: false, staleTime: 60_000 });
  const usersMap = new Map<string, SafeUser>(users.map((u) => [u.id, u]));

  // Sloupec, nad kterým se právě vznáší tažená karta (drop-zone zvýraznění).
  const [overCol, setOverCol] = useState<StageKey | null>(null);

  const enriched: EnrichedTender[] = tenders.map((tender) => {
    const analysis = tender.analysis;
    return {
      tender,
      nazev: analysis?.nazev || tender.name || tender.id,
      stage: effectiveStage({ status: tender.status, steps: tender.steps }),
      zadavatel: analysis?.zadavatel_nazev ?? null,
      hodnota: analysis?.predpokladana_hodnota ?? null,
      lhuta: analysis?.lhuta_nabidek ?? null,
      decision: normalizeDecision(analysis?.rozhodnuti ?? undefined),
      assignee: tender.assignee ?? null,
      tasks: tender.tasks ?? null,
    };
  });

  async function handleDrop(e: DragEvent<HTMLDivElement>, target: StageKey) {
    e.preventDefault();
    setOverCol(null);
    const raw = e.dataTransfer.getData('application/json');
    if (!raw) return;
    let payload: { id: string; from: StageKey };
    try {
      payload = JSON.parse(raw) as { id: string; from: StageKey };
    } catch {
      return;
    }
    const { id, from } = payload;
    if (!id || !from || target === from) return;

    const dragged = enriched.find((x) => x.tender.id === id);
    const check = canTransition(from, target, dragged?.tender.steps);
    if (!check.ok) {
      toast(check.reason ?? 'Tuto změnu stavu nelze provést.', 'danger');
      return;
    }

    try {
      await setTenderStatus(id, target);
      await queryClient.invalidateQueries({ queryKey: ['tenders'] });
      toast(`Přesunuto do ${STAGE_LABELS[target]}`, 'success');
    } catch (err) {
      const m = err instanceof Error ? err.message : 'Chyba';
      toast(
        m === 'db_unavailable'
          ? 'Perzistence stavu vyžaduje databázi (běží jen na hlavním serveru).'
          : m,
        'danger',
      );
      // Invalidace i při chybě — karta se vrátí (snap back) na svou původní fázi.
      queryClient.invalidateQueries({ queryKey: ['tenders'] });
    }
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--text-primary)' }}>Pipeline</h1>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
            Přetažením karty změníte fázi · platí stavové guardy
          </p>
        </div>
        <Button variant="ghost" size="sm" iconLeft={<Filter size={15} strokeWidth={2} />}>
          Filtry
        </Button>
      </div>

      <div
        className="vz-scroll"
        style={{ display: 'flex', gap: 14, overflowX: 'auto', marginTop: 18, alignItems: 'flex-start', paddingBottom: 8 }}
      >
        {COLUMNS.map((key) => {
          const items = enriched.filter((e) => e.stage === key);
          const vals = items.map((e) => e.hodnota).filter((v): v is number => v != null);
          const sum = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
          const label = STAGES.find((s) => s.key === key)?.label ?? key;
          const isOver = overCol === key;
          return (
            <div key={key} style={{ width: 280, flexShrink: 0 }}>
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                  borderRadius: 'var(--radius-md)', background: `var(--stage-${key}-bg)`, marginBottom: 10,
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--stage-${key}-dot)`, flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: `var(--stage-${key}-fg)` }}>
                  {label}
                </span>
                <span style={{ fontSize: 'var(--font-size-xs)', color: `var(--stage-${key}-fg)`, opacity: 0.7 }}>
                  · {items.length}
                </span>
                <span
                  className="tnum"
                  style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', fontWeight: 600, color: `var(--stage-${key}-fg)` }}
                >
                  {fmtMil(sum)}
                </span>
              </div>

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (overCol !== key) setOverCol(key);
                }}
                onDrop={(e) => handleDrop(e, key)}
                style={{
                  display: 'flex', flexDirection: 'column', gap: 10, minHeight: 64, padding: 4,
                  borderRadius: 'var(--radius-lg)',
                  outline: isOver ? '2px dashed var(--accent)' : '2px dashed transparent',
                  outlineOffset: -2,
                  background: isOver ? 'var(--surface-selected)' : 'transparent',
                  transition: 'background var(--duration-fast) var(--ease-standard)',
                }}
              >
                {items.length === 0 ? (
                  <div
                    style={{
                      border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-lg)',
                      padding: '20px 12px', textAlign: 'center', fontSize: 'var(--font-size-xs)',
                      color: 'var(--text-tertiary)',
                    }}
                  >
                    Žádné zakázky v této fázi
                  </div>
                ) : (
                  items.map((e) => (
                    <PipelineCard
                      key={e.tender.id}
                      item={e}
                      onOpen={onOpen}
                      usersMap={usersMap}
                      onDragEndClear={() => setOverCol(null)}
                    />
                  ))
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PipelineCard({
  item,
  onOpen,
  usersMap,
  onDragEndClear,
}: {
  item: EnrichedTender;
  onOpen?: (id: string) => void;
  usersMap: Map<string, SafeUser>;
  onDragEndClear: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [dragging, setDragging] = useState(false);
  const assignee = item.assignee;
  const css: CSSProperties = {
    textAlign: 'left', width: '100%', display: 'block',
    background: 'var(--surface-card)', border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)', padding: 12, cursor: 'grab',
    opacity: dragging ? 0.5 : 1,
    boxShadow: hover && !dragging ? 'var(--shadow-md)' : 'none',
    transition: 'box-shadow var(--duration-fast) var(--ease-standard), opacity var(--duration-fast) var(--ease-standard)',
  };
  return (
    <div
      role="button"
      tabIndex={0}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/json', JSON.stringify({ id: item.tender.id, from: item.stage }));
        e.dataTransfer.effectAllowed = 'move';
        setDragging(true);
      }}
      onDragEnd={() => {
        setDragging(false);
        onDragEndClear();
      }}
      onClick={() => onOpen?.(item.tender.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen?.(item.tender.id);
        }
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={css}
    >
      <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.35 }}>
        {item.nazev}
      </div>

      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, marginTop: 6,
          fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)',
        }}
      >
        <Building2 size={13} strokeWidth={2} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.zadavatel ?? '—'}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <span className="tnum" style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>
          {fmtCZK(item.hodnota)}
        </span>
        {item.decision && (
          <DecisionPill decision={item.decision} style={{ padding: '2px 8px', fontSize: 'var(--font-size-xs)' }} />
        )}
        {item.tasks && item.tasks.total > 0 && (
          <Badge tone="primary" size="sm">
            <ListChecks size={12} strokeWidth={2} style={{ marginRight: 4, verticalAlign: '-2px' }} />
            Úkoly {item.tasks.done}/{item.tasks.total}
          </Badge>
        )}
      </div>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '10px 0' }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <DeadlineCountdown date={item.lhuta} />
        {assignee ? (
          <Avatar name={usersMap.get(assignee)?.name ?? assignee} size={24} />
        ) : (
          <span
            title="Nepřiřazeno"
            style={{
              width: 24, height: 24, borderRadius: 'var(--radius-full)', flexShrink: 0,
              border: '1px dashed var(--border-strong)',
            }}
          />
        )}
      </div>
    </div>
  );
}
