import type { CSSProperties, ReactNode } from 'react';

export interface KpiCardProps {
  label: string;
  value: ReactNode;
  unit?: string;
  delta?: ReactNode;
  deltaDir?: 'up' | 'down';
  icon?: ReactNode;
  accent?: string;
  style?: CSSProperties;
}

/**
 * KpiCard — a dashboard metric tile (Úspěšnost nabídek, Hodnota pipeline,
 * Vážená hodnota, AI náklady…). Big tabular value, label, optional delta.
 */
export function KpiCard({ label, value, unit, delta, deltaDir = 'up', icon, accent = 'var(--accent)', style }: KpiCardProps) {
  const positive = deltaDir === 'up';
  return (
    <div style={{
      background: 'var(--surface-card)', border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-lg)', padding: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 8, ...style,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{
          fontSize: 'var(--font-size-xs)', fontWeight: 'var(--weight-semibold)', letterSpacing: 'var(--tracking-caps)',
          textTransform: 'uppercase', color: 'var(--text-secondary)',
        }}>{label}</span>
        {icon && (
          <span style={{
            display: 'inline-flex', width: 28, height: 28, alignItems: 'center', justifyContent: 'center',
            borderRadius: 'var(--radius-md)', background: 'var(--accent-soft-bg)', color: accent,
          }}>{icon}</span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 5 }}>
        <span style={{
          fontSize: 'var(--font-size-3xl)', fontWeight: 'var(--weight-bold)', lineHeight: 1,
          color: 'var(--text-primary)', letterSpacing: 'var(--tracking-tight)', fontVariantNumeric: 'tabular-nums',
        }}>{value}</span>
        {unit && <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-secondary)' }}>{unit}</span>}
      </div>
      {delta != null && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 'var(--font-size-xs)', fontWeight: 'var(--weight-medium)',
          color: positive ? 'var(--success-fg)' : 'var(--danger-fg)',
        }}>
          {positive ? '▲' : '▼'} {delta}
        </span>
      )}
    </div>
  );
}
