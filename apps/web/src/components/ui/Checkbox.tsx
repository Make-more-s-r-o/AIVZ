import type { CSSProperties, ReactNode } from 'react';

export interface CheckboxProps {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  style?: CSSProperties;
}

/**
 * Checkbox — square selection control with the app's blue-600 checked fill.
 * Renders an optional label; the whole row is clickable.
 */
export function Checkbox({ checked = false, onChange, label, description, disabled = false, style }: CheckboxProps) {
  return (
    <label style={{
      display: 'inline-flex', alignItems: description ? 'flex-start' : 'center', gap: 9,
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1, ...style,
    }}>
      <span
        onClick={() => !disabled && onChange && onChange(!checked)}
        style={{
          width: 16, height: 16, flexShrink: 0, marginTop: description ? 2 : 0,
          borderRadius: 'var(--radius-sm)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          border: `1.5px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
          background: checked ? 'var(--accent)' : 'var(--surface-card)',
          transition: 'background var(--duration-fast), border-color var(--duration-fast)',
        }}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 6.2L4.8 8.5L9.5 3.5" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
      {(label || description) && (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          {label && <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)' }}>{label}</span>}
          {description && <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>{description}</span>}
        </span>
      )}
    </label>
  );
}
