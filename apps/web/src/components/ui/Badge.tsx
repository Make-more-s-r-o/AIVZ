import type { CSSProperties, ReactNode } from 'react';

export type BadgeTone = 'neutral' | 'primary' | 'success' | 'danger' | 'warning' | 'outline';
type Size = 'sm' | 'md';

const tones: Record<BadgeTone, { bg: string; fg: string; border?: string }> = {
  neutral: { bg: 'var(--gray-100)', fg: 'var(--gray-700)' },
  primary: { bg: 'var(--info-bg)', fg: 'var(--info-fg)' },
  success: { bg: 'var(--success-bg)', fg: 'var(--success-fg)' },
  danger: { bg: 'var(--danger-bg)', fg: 'var(--danger-fg)' },
  warning: { bg: 'var(--warning-bg)', fg: 'var(--warning-fg)' },
  outline: { bg: 'transparent', fg: 'var(--text-secondary)', border: '1px solid var(--border-strong)' },
};

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  size?: Size;
  pill?: boolean;
  dot?: boolean;
  style?: CSSProperties;
}

/**
 * Badge — small soft status chip. The workhorse for the CRM's many
 * sub-status sets (povinné Ano/Ne, zdroj chips, counts, etc.).
 */
export function Badge({ children, tone = 'neutral', size = 'md', pill = true, dot = false, style }: BadgeProps) {
  const t = tones[tone];
  const pad = size === 'sm' ? '2px 7px' : '3px 9px';
  const fs = size === 'sm' ? 'var(--font-size-2xs)' : 'var(--font-size-xs)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, padding: pad, fontSize: fs,
      fontWeight: 'var(--weight-medium)', lineHeight: 1.4, color: t.fg, background: t.bg,
      border: t.border || '1px solid transparent',
      borderRadius: pill ? 'var(--radius-full)' : 'var(--radius-sm)', whiteSpace: 'nowrap', ...style,
    }}>
      {dot && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor', opacity: 0.7 }} />}
      {children}
    </span>
  );
}
