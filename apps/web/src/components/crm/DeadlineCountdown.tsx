import type { CSSProperties } from 'react';
import { deadlineDays } from '../../lib/crm-adapters';

// Relative Czech deadline text from a number of days (negative = overdue).
export function formatDeadline(days: number | null | undefined): string {
  if (days == null) return '—';
  if (days < 0) return 'po termínu';
  if (days === 0) return 'dnes';
  if (days === 1) return 'zítra';
  if (days < 5) return `za ${days} dny`;
  return `za ${days} dní`;
}

function tone(days: number | null | undefined): string {
  if (days == null) return 'var(--deadline-ok)';
  if (days < 0) return 'var(--deadline-overdue)';
  if (days <= 3) return 'var(--deadline-soon)';
  return 'var(--deadline-ok)';
}

export interface DeadlineCountdownProps {
  days?: number | null;
  date?: string | null;
  withIcon?: boolean;
  size?: 'sm' | 'md';
  style?: CSSProperties;
}

/**
 * DeadlineCountdown — relative lhůta text with semantic colour
 * (≤3 days = warning amber, past = danger red, else muted).
 * Pass `days` directly, or a `date` (ISO) to compute from today.
 */
export function DeadlineCountdown({ days, date, withIcon = true, size = 'sm', style }: DeadlineCountdownProps) {
  const d = days != null ? days : deadlineDays(date);
  const fg = tone(d);
  const fs = size === 'md' ? 'var(--font-size-sm)' : 'var(--font-size-xs)';
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: fs,
      fontWeight: 'var(--weight-medium)', color: fg, fontVariantNumeric: 'tabular-nums', ...style,
    }}>
      {withIcon && (
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
          <circle cx="8" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.4" />
          <path d="M8 6.5V9l1.8 1.2M6 1.5h4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </svg>
      )}
      {formatDeadline(d)}
    </span>
  );
}
