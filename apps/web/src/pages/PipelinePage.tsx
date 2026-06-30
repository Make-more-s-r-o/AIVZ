import { useQuery } from '@tanstack/react-query';
import { getTenders } from '../lib/api';
import { deriveStage } from '../lib/crm-adapters';

export interface PipelinePageProps {
  onOpen?: (id: string) => void;
}

const COLS: { key: ReturnType<typeof deriveStage>; label: string }[] = [
  { key: 'nova', label: 'Nová' },
  { key: 'analyzovana', label: 'Analyzovaná' },
  { key: 'ocenena', label: 'Oceněná' },
  { key: 'pripravena', label: 'Připravená' },
];

/**
 * Pipeline (Kanban) — STUB. Buckets real tenders by derived stage (read-only).
 * The full kanban with cards/values is built by the dedicated screen agent.
 */
export default function PipelinePage({ onOpen }: PipelinePageProps) {
  const { data: tenders = [] } = useQuery({ queryKey: ['tenders'], queryFn: getTenders });

  return (
    <div>
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--text-primary)' }}>Pipeline</h1>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>Zakázky dle odvozené fáze</p>
      <div className="vz-scroll" style={{ display: 'flex', gap: 14, overflowX: 'auto', marginTop: 18, alignItems: 'flex-start' }}>
        {COLS.map((col) => {
          const items = tenders.filter((t) => deriveStage(t.steps) === col.key);
          return (
            <div key={col.key} style={{ width: 260, flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderRadius: 'var(--radius-md)', background: `var(--stage-${col.key}-bg)`, marginBottom: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--stage-${col.key}-dot)` }} />
                <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: `var(--stage-${col.key}-fg)` }}>{col.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: 'var(--font-size-xs)', color: `var(--stage-${col.key}-fg)`, opacity: 0.7 }}>{items.length}</span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {items.map((t) => (
                  <button key={t.id} onClick={() => onOpen?.(t.id)} style={{ textAlign: 'left', background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)', padding: 12, cursor: 'pointer' }}>
                    <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{t.name || t.id}</div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
