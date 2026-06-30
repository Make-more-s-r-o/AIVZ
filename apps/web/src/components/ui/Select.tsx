import { useState, type ChangeEventHandler, type CSSProperties } from 'react';

type Size = 'sm' | 'md' | 'lg';
export type SelectOption = string | { value: string; label: string };

export interface SelectProps {
  value?: string;
  onChange?: ChangeEventHandler<HTMLSelectElement>;
  options?: SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  size?: Size;
  style?: CSSProperties;
}

/**
 * Select — native dropdown styled to match Input (chevron, focus ring).
 * Options: array of {value,label} or strings.
 */
export function Select({ value, onChange, options = [], placeholder, disabled = false, size = 'md', style }: SelectProps) {
  const [focus, setFocus] = useState(false);
  const heights: Record<Size, number> = { sm: 30, md: 38, lg: 44 };
  const h = heights[size];
  const opts = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));

  const css: CSSProperties = {
    width: '100%', height: h, boxSizing: 'border-box', padding: '0 34px 0 12px',
    fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', color: value ? 'var(--text-primary)' : 'var(--text-tertiary)',
    background: disabled ? 'var(--surface-sunken)' : 'var(--surface-card)', appearance: 'none', WebkitAppearance: 'none',
    border: `1px solid ${focus ? 'var(--border-focus)' : 'var(--border-strong)'}`, borderRadius: 'var(--radius-md)',
    outline: 'none', boxShadow: focus ? 'var(--shadow-focus)' : 'none', cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'border-color var(--duration-fast), box-shadow var(--duration-fast)', ...style,
  };

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <select
        value={value ?? ''}
        onChange={onChange}
        disabled={disabled}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={css}
      >
        {placeholder && <option value="" disabled>{placeholder}</option>}
        {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <span style={{ position: 'absolute', right: 11, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: 'var(--text-tertiary)' }}>
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    </div>
  );
}
