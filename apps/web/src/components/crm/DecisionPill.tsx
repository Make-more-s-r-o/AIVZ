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
  reason?: ReactNode;
  style?: CSSProperties;
}

/**
 * DecisionPill — the GO / NOGO / ZVÁŽIT recommendation gate from AI analysis.
 * Bold pill; optionally followed by the odůvodnění text.
 */
export function DecisionPill({ decision = 'ZVAZIT', reason, style }: DecisionPillProps) {
  const c = MAP[decision] || MAP.ZVAZIT;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 8, padding: '5px 14px',
      borderRadius: 'var(--radius-full)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-bold)',
      background: c.bg, color: c.fg, ...style,
    }}>
      {LABEL[decision] || decision}
      {reason && <span style={{ fontWeight: 'var(--weight-regular)' }}>— {reason}</span>}
    </span>
  );
}
