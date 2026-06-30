import type { CSSProperties } from 'react';

export type TabItem = string | { value: string; label: string; count?: number };

export interface TabsProps {
  tabs?: TabItem[];
  value?: string;
  onChange?: (value: string) => void;
  style?: CSSProperties;
}

/**
 * Tabs — underline tab bar matching the tender detail's tab set
 * (Přehled · Analýza · Ocenění · Dokumenty · Úkoly · Termíny · Historie · Komentáře).
 * Tabs can carry an optional count badge.
 */
export function Tabs({ tabs = [], value, onChange, style }: TabsProps) {
  const items = tabs.map((t) => (typeof t === 'string' ? { value: t, label: t, count: undefined as number | undefined } : t));
  return (
    <div className="vz-scroll" style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-default)', overflowX: 'auto', ...style }}>
      {items.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            onClick={() => onChange && onChange(t.value)}
            style={{
              position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 7,
              padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap',
              fontWeight: active ? 'var(--weight-semibold)' : 'var(--weight-medium)',
              color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
              boxShadow: active ? 'inset 0 -2px 0 0 var(--accent)' : 'none',
              transition: 'color var(--duration-fast)',
            }}
          >
            {t.label}
            {t.count != null && (
              <span style={{
                fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--weight-semibold)',
                padding: '1px 6px', borderRadius: 'var(--radius-full)', lineHeight: 1.5,
                background: active ? 'var(--accent-soft-bg)' : 'var(--gray-100)',
                color: active ? 'var(--accent-soft-fg)' : 'var(--text-secondary)',
              }}>{t.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
