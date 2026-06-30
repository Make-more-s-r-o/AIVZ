import { useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-soft';
type Size = 'sm' | 'md' | 'lg';

const sizes: Record<Size, { fontSize: string; padding: string; height: number; gap: number }> = {
  sm: { fontSize: 'var(--font-size-xs)', padding: '6px 12px', height: 30, gap: 6 },
  md: { fontSize: 'var(--font-size-sm)', padding: '8px 16px', height: 38, gap: 8 },
  lg: { fontSize: 'var(--font-size-base)', padding: '10px 20px', height: 44, gap: 8 },
};

const variants: Record<Variant, { background: string; color: string; border: string; hoverBg: string }> = {
  primary: { background: 'var(--accent)', color: 'var(--accent-on)', border: '1px solid transparent', hoverBg: 'var(--accent-hover)' },
  secondary: { background: 'var(--surface-card)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)', hoverBg: 'var(--surface-hover)' },
  ghost: { background: 'transparent', color: 'var(--text-secondary)', border: '1px solid transparent', hoverBg: 'var(--surface-hover)' },
  danger: { background: 'var(--danger-solid)', color: '#fff', border: '1px solid transparent', hoverBg: 'var(--red-700)' },
  'danger-soft': { background: 'var(--danger-bg)', color: 'var(--danger-fg)', border: '1px solid transparent', hoverBg: 'var(--red-200)' },
};

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  variant?: Variant;
  size?: Size;
  iconLeft?: ReactNode;
  iconRight?: ReactNode;
  fullWidth?: boolean;
  type?: 'button' | 'submit' | 'reset';
}

/**
 * Button — the primary action control. Honors the app's blue-600 primary,
 * white-bordered secondary, and ghost nav-button patterns.
 */
export function Button({
  children, variant = 'primary', size = 'md', disabled = false,
  iconLeft = null, iconRight = null, fullWidth = false, type = 'button',
  onClick, style, ...rest
}: ButtonProps) {
  const sz = sizes[size];
  const vr = variants[variant];
  const [hover, setHover] = useState(false);

  const css: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    gap: sz.gap, height: sz.height, padding: sz.padding, fontSize: sz.fontSize,
    fontFamily: 'var(--font-sans)', fontWeight: 'var(--weight-medium)',
    lineHeight: 1, borderRadius: 'var(--radius-md)', cursor: disabled ? 'not-allowed' : 'pointer',
    whiteSpace: 'nowrap', width: fullWidth ? '100%' : 'auto',
    transition: 'background var(--duration-fast) var(--ease-standard), box-shadow var(--duration-fast)',
    opacity: disabled ? 0.5 : 1,
    background: hover && !disabled ? vr.hoverBg : vr.background,
    color: vr.color, border: vr.border,
    boxShadow: variant === 'primary' || variant === 'danger' ? 'var(--shadow-xs)' : 'none',
    ...style,
  };

  return (
    <button
      type={type}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={css}
      {...rest}
    >
      {iconLeft}
      {children}
      {iconRight}
    </button>
  );
}
