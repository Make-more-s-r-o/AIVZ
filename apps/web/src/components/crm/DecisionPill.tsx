import type { CSSProperties, ReactNode } from 'react';
import type { Decision } from '../../lib/crm-adapters';

const MAP: Record<Decision, { bg: string; fg: string }> = {
  GO: { bg: 'var(--go-bg)', fg: 'var(--go-fg)' },
  NOGO: { bg: 'var(--nogo-bg)', fg: 'var(--nogo-fg)' },
  ZVAZIT: { bg: 'var(--zvazit-bg)', fg: 'var(--zvazit-fg)' },
};
const LABEL: Record<Decision, string> = { GO: 'GO', NOGO: 'NOGO', ZVAZIT: 'ZVÁŽIT' };

export interface DecisionPillProps {
  decision?: Decision;
  score?: number;
  reasons?: string[];
  reason?: ReactNode;
  style?: CSSProperties;
}

/**
 * Barevný odznak číselného go/no-go skóre. Důvody jsou dostupné v nativním tooltipu;
 * původní textové odůvodnění lze dál zobrazit vedle odznaku přes `reason`.
 */
export function DecisionPill({ decision = 'ZVAZIT', score, reasons, reason, style }: DecisionPillProps) {
  const c = MAP[decision] || MAP.ZVAZIT;
  const label = `${score == null ? '' : `${Math.round(score)} · `}${LABEL[decision] || decision}`;
  const tooltip = reasons?.filter(Boolean).join('\n') || undefined;
  return (
    <span title={tooltip} aria-label={tooltip ? `${label}. ${reasons?.join('. ')}` : label} tabIndex={tooltip ? 0 : undefined} style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 14px',
      borderRadius: 'var(--radius-full)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-bold)',
      background: c.bg, color: c.fg, ...style,
    }}>
      {label}
      {reason && <span style={{ fontWeight: 'var(--weight-regular)' }}>— {reason}</span>}
    </span>
  );
}
