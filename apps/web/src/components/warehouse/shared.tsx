/**
 * Sdílené warehouse komponenty a utility.
 * Extrahováno z ProductCard, ProductList, ProductDetailPage, WarehouseDashboard.
 */

// --- formatPrice ---

export const formatPrice = (price: number | null | undefined) => {
  if (price == null) return '-';
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: 'CZK', maximumFractionDigits: 0 }).format(price);
};

// --- PriceAgeDot ---

interface PriceAgeDotProps {
  fetchedAt?: string | null;
  variant?: 'dot' | 'dot-with-label';
}

export function PriceAgeDot({ fetchedAt, variant = 'dot' }: PriceAgeDotProps) {
  if (!fetchedAt) return null;
  const days = Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 86400000);
  const color = days < 7 ? 'bg-green-500' : days < 30 ? 'bg-yellow-500' : 'bg-red-500';
  const label = days < 7 ? 'aktuální' : days < 30 ? 'stárnoucí' : 'zastaralé';

  if (variant === 'dot-with-label') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />
        <span className="text-xs text-gray-500">{days}d — {label}</span>
      </span>
    );
  }

  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} title={`${days}d - ${label}`} />;
}

// --- FreshnessDot ---

export function FreshnessDot({ lastScrapedAt }: { lastScrapedAt: string | null }) {
  if (!lastScrapedAt) return <span className="inline-block h-2.5 w-2.5 rounded-full bg-gray-300" title="Nikdy scrapováno" />;
  const days = Math.floor((Date.now() - new Date(lastScrapedAt).getTime()) / 86400000);
  const color = days < 7 ? 'bg-green-500' : days < 30 ? 'bg-yellow-500' : 'bg-red-500';
  return <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} title={`${days}d`} />;
}

// --- JobStatusBadge ---

export function JobStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-700',
    running: 'bg-blue-100 text-blue-700',
    done: 'bg-green-100 text-green-700',
    error: 'bg-red-100 text-red-700',
  };
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${colors[status] || 'bg-gray-100'}`}>
      {status}
    </span>
  );
}
