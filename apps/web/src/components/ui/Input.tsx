import { useState, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';

type Size = 'sm' | 'md' | 'lg';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  invalid?: boolean;
  iconLeft?: ReactNode;
  size?: Size;
}

/**
 * Input — single-line text/number field with the app's focus-ring treatment
 * (blue-500 border + soft ring). Supports an optional leading icon and error state.
 */
export function Input({
  type = 'text', value, onChange, placeholder, disabled = false,
  invalid = false, iconLeft = null, size = 'md', style, ...rest
}: InputProps) {
  const [focus, setFocus] = useState(false);
  const heights: Record<Size, number> = { sm: 30, md: 38, lg: 44 };
  const h = heights[size];
  const border = invalid ? 'var(--danger-solid)' : focus ? 'var(--border-focus)' : 'var(--border-strong)';

  const css: CSSProperties = {
    width: '100%', height: h, boxSizing: 'border-box',
    padding: iconLeft ? '0 12px 0 32px' : '0 12px',
    fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)',
    color: 'var(--text-primary)', background: disabled ? 'var(--surface-sunken)' : 'var(--surface-card)',
    border: `1px solid ${border}`, borderRadius: 'var(--radius-md)', outline: 'none',
    boxShadow: focus ? (invalid ? '0 0 0 3px rgb(220 38 38 / 0.18)' : 'var(--shadow-focus)') : 'none',
    transition: 'border-color var(--duration-fast), box-shadow var(--duration-fast)',
    ...style,
  };

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center', width: '100%' }}>
      {iconLeft && (
        <span style={{ position: 'absolute', left: 10, display: 'flex', color: 'var(--text-tertiary)', pointerEvents: 'none' }}>
          {iconLeft}
        </span>
      )}
      <input
        type={type}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        onFocus={() => setFocus(true)}
        onBlur={() => setFocus(false)}
        style={css}
        {...rest}
      />
    </div>
  );
}
