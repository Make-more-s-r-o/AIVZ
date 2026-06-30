import { useQuery } from '@tanstack/react-query';
import { getTenders } from '../lib/api';
import { deriveStage } from '../lib/crm-adapters';
import { STAGES } from '../lib/stages';

export interface PrehledPageProps {
  onOpen?: (id: string) => void;
}

/**
 * Přehled (Dashboard) — STUB. Renders a minimal real-data funnel so the app
 * works end-to-end; the full KPI strip / deadlines / activity is built by the
 * dedicated screen agent on top of the design system.
 */
export default function PrehledPage(_props: PrehledPageProps) {
  const { data: tenders = [] } = useQuery({ queryKey: ['tenders'], queryFn: getTenders });

  const counts = STAGES.map((s) => ({
    ...s,
    n: tenders.filter((t) => deriveStage(t.steps) === s.key).length,
  }));

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--text-primary)' }}>Přehled</h1>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
        Stav portfolia nabídek · {tenders.length} zakázek
      </p>
      <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 520 }}>
        {counts.map((c) => (
          <div key={c.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ width: 130, fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', textAlign: 'right' }}>{c.label}</span>
            <div style={{ flex: 1, height: 20, background: 'var(--surface-sunken)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${tenders.length ? (c.n / tenders.length) * 100 : 0}%`, height: '100%', background: `var(--stage-${c.key}-dot)`, opacity: 0.85 }} />
            </div>
            <span className="tnum" style={{ width: 20, fontWeight: 600, color: 'var(--text-primary)' }}>{c.n}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
