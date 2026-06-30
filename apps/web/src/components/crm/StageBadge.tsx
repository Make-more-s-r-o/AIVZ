import type { CSSProperties } from 'react';
import { STAGE_LABELS, type StageKey } from '../../lib/stages';

export { STAGES, type StageKey } from '../../lib/stages';

export interface StageBadgeProps {
  status?: StageKey;
  label?: string;
  size?: 'sm' | 'md';
  style?: CSSProperties;
}

/**
 * StageBadge — the lifecycle status chip. `status` is the single source of
 * truth across the CRM, so this is the one component that renders it.
 * Pass the stage key (e.g. "pripravena"); the label and colour come from tokens.
 */
export function StageBadge({ status = 'nova', label, size = 'md', style }: StageBadgeProps) {
  const text = label || STAGE_LABELS[status] || status;
  const pad = size === 'sm' ? '2px 8px 2px 7px' : '4px 11px 4px 9px';
  const fs = size === 'sm' ? 'var(--font-size-2xs)' : 'var(--font-size-xs)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, padding: pad, fontSize: fs,
      fontWeight: 'var(--weight-semibold)', lineHeight: 1.4, borderRadius: 'var(--radius-full)', whiteSpace: 'nowrap',
      background: `var(--stage-${status}-bg)`, color: `var(--stage-${status}-fg)`, ...style,
    }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: `var(--stage-${status}-dot)`, flexShrink: 0 }} />
      {text}
    </span>
  );
}
