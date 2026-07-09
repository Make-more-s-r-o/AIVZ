/**
 * Sdílené warehouse komponenty a utility.
 * Extrahováno z ProductCard, ProductList, ProductDetailPage, WarehouseDashboard.
 */

import { Badge, type BadgeTone } from '../ui/Badge';
import { fmtCZK } from '../../lib/format';

// --- formatPrice ---
// Sjednoceno na canonical formátovač z lib/format.ts (dřív duplicitní Intl.NumberFormat implementace).

export const formatPrice = fmtCZK;

// --- PriceAgeDot ---

interface PriceAgeDotProps {
  fetchedAt?: string | null;
  variant?: 'dot' | 'dot-with-label';
}

// Barva podle stáří ceny — stejná sémantika jako --success/--warning/--danger-solid tokeny.
function ageColor(days: number): string {
  return days < 7 ? 'var(--success-solid)' : days < 30 ? 'var(--warning-solid)' : 'var(--danger-solid)';
}

export function PriceAgeDot({ fetchedAt, variant = 'dot' }: PriceAgeDotProps) {
  if (!fetchedAt) return null;
  const days = Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 86400000);
  const color = ageColor(days);
  const label = days < 7 ? 'aktuální' : days < 30 ? 'stárnoucí' : 'zastaralé';

  if (variant === 'dot-with-label') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 'var(--radius-full)', background: color }} />
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>{days}d — {label}</span>
      </span>
    );
  }

  return (
    <span
      style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 'var(--radius-full)', background: color }}
      title={`${days}d - ${label}`}
    />
  );
}

// --- FreshnessDot ---

export function FreshnessDot({ lastScrapedAt }: { lastScrapedAt: string | null }) {
  if (!lastScrapedAt) {
    return (
      <span
        style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 'var(--radius-full)', background: 'var(--gray-300)' }}
        title="Nikdy scrapováno"
      />
    );
  }
  const days = Math.floor((Date.now() - new Date(lastScrapedAt).getTime()) / 86400000);
  return (
    <span
      style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 'var(--radius-full)', background: ageColor(days) }}
      title={`${days}d`}
    />
  );
}

// --- JobStatusBadge ---

const JOB_STATUS_TONE: Record<string, BadgeTone> = {
  pending: 'warning',
  running: 'primary',
  done: 'success',
  error: 'danger',
};

export function JobStatusBadge({ status }: { status: string }) {
  return (
    <Badge tone={JOB_STATUS_TONE[status] ?? 'neutral'} size="sm" pill={false}>
      {status}
    </Badge>
  );
}
