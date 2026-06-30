import { useState, type CSSProperties } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Building2, Filter } from 'lucide-react';
import { getAnalysis, getTenders, type TenderSummary } from '../lib/api';
import { deriveStage, normalizeDecision, type Decision } from '../lib/crm-adapters';
import { STAGES, type StageKey } from '../lib/stages';
import { fmtCZK, fmtMil } from '../lib/format';
import { Button } from '../components/ui';
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
}

/**
 * Pipeline (Kanban) — zakázky rozdělené dle odvozené fáze. Hodnota, zadavatel,
 * lhůta a doporučení se dotahují z analýzy (degraduje na „—", když chybí).
 * Přetažení karet mezi sloupci je vizuální, bez persistence (backend beze změn).
 */
export default function PipelinePage({ onOpen }: PipelinePageProps) {
  const { data: tenders = [] } = useQuery({ queryKey: ['tenders'], queryFn: getTenders });

  // Per-tender analýza — paralelně, bez retry; 404 (nezanalyzováno) → degradace.
  const analysisQueries = useQueries({
    queries: tenders.map((t) => ({
      queryKey: ['analysis', t.id],
      queryFn: () => getAnalysis(t.id),
      retry: false,
      staleTime: 60_000,
    })),
  });

  const enriched: EnrichedTender[] = tenders.map((tender, i) => {
    const analysis = analysisQueries[i]?.data;
    return {
      tender,
      nazev: analysis?.zakazka.nazev || tender.name || tender.id,
      stage: deriveStage(tender.steps),
      zadavatel: analysis?.zakazka.zadavatel.nazev ?? null,
      hodnota: analysis?.zakazka.predpokladana_hodnota ?? null,
      lhuta: analysis?.terminy.lhuta_nabidek ?? null,
      decision: normalizeDecision(analysis?.doporuceni.rozhodnuti),
    };
  });

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--text-primary)' }}>Pipeline</h1>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
            Zakázky dle fáze · přetažení bude doplněno
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

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
                  items.map((e) => <PipelineCard key={e.tender.id} item={e} onOpen={onOpen} />)
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PipelineCard({ item, onOpen }: { item: EnrichedTender; onOpen?: (id: string) => void }) {
  const [hover, setHover] = useState(false);
  const css: CSSProperties = {
    textAlign: 'left', width: '100%', display: 'block',
    background: 'var(--surface-card)', border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)', padding: 12, cursor: 'pointer',
    boxShadow: hover ? 'var(--shadow-md)' : 'none',
    transition: 'box-shadow var(--duration-fast) var(--ease-standard)',
  };
  return (
    <button
      onClick={() => onOpen?.(item.tender.id)}
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
      </div>

      <div style={{ height: 1, background: 'var(--border-subtle)', margin: '10px 0' }} />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <DeadlineCountdown date={item.lhuta} />
        <span
          title="Nepřiřazeno"
          style={{
            width: 24, height: 24, borderRadius: 'var(--radius-full)', flexShrink: 0,
            border: '1px dashed var(--border-strong)',
          }}
        />
      </div>
    </button>
  );
}
