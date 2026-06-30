import type { CSSProperties } from 'react';

export type ConfidenceLevel = 'vysoka' | 'stredni' | 'nizka';

const MAP: Record<ConfidenceLevel, { bg: string; fg: string; label: string }> = {
  vysoka: { bg: 'var(--success-bg)', fg: 'var(--success-fg)', label: 'Vysoká' },
  stredni: { bg: 'var(--warning-bg)', fg: 'var(--warning-fg)', label: 'Střední' },
  nizka: { bg: 'var(--danger-bg)', fg: 'var(--danger-fg)', label: 'Nízká' },
};

export interface ConfidenceBadgeProps {
  level?: ConfidenceLevel;
  label?: string;
  style?: CSSProperties;
}

/**
 * ConfidenceBadge — price-reliability level (Vysoká / Střední / Nízká) shown
 * on product candidates and the cenová kalkulace. Maps 1:1 to the backend's
 * `cena_spolehlivost` field. Also fits match confidence.
 */
export function ConfidenceBadge({ level = 'stredni', label, style }: ConfidenceBadgeProps) {
  const c = MAP[level] || MAP.stredni;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: '2px 8px',
      borderRadius: 'var(--radius-full)', fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--weight-semibold)',
      background: c.bg, color: c.fg, whiteSpace: 'nowrap', ...style,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor' }} />
      {label || c.label}
    </span>
  );
}
