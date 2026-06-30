// Czech number / money formatting — space thousands separator, unit after.
// Money is bez DPH unless noted; DPH is 21 %.

export function fmtCZK(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('cs-CZ', { maximumFractionDigits: 0 }) + ' Kč';
}

// Abbreviated millions: "2,3 mil. Kč".
export function fmtMil(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return (n / 1e6).toLocaleString('cs-CZ', { maximumFractionDigits: 1 }) + ' mil. Kč';
}

// Compact money: under 1 mil. → full Kč, otherwise millions.
export function fmtMoneyCompact(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.abs(n) >= 1e6 ? fmtMil(n) : fmtCZK(n);
}

export function fmtThousands(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('cs-CZ', { maximumFractionDigits: 0 });
}

export function fmtPercent(n: number | null | undefined, digits = 0): string {
  if (n == null || Number.isNaN(n)) return '—';
  return n.toLocaleString('cs-CZ', { maximumFractionDigits: digits }) + ' %';
}

export const DPH_RATE = 0.21;
