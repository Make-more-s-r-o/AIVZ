import { useState, type CSSProperties, type ReactNode } from 'react';

export interface CardProps {
  children: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
  hoverable?: boolean;
  padding?: number;
  style?: CSSProperties;
}

/**
 * Card — the base surface: white, 1px gray-200 border, rounded-lg.
 * Optional title row and hover elevation (used for clickable list cards).
 */
export function Card({ children, title, action, hoverable = false, padding = 16, style }: CardProps) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => hoverable && setHover(true)}
      onMouseLeave={() => hoverable && setHover(false)}
      style={{
        background: 'var(--surface-card)', border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-lg)', overflow: 'hidden',
        boxShadow: hover ? 'var(--shadow-md)' : 'none',
        transition: 'box-shadow var(--duration-normal) var(--ease-standard)',
        cursor: hoverable ? 'pointer' : 'default', ...style,
      }}
    >
      {title && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '12px 16px', borderBottom: '1px solid var(--border-default)',
        }}>
          <h3 style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>{title}</h3>
          {action}
        </div>
      )}
      <div style={{ padding }}>{children}</div>
    </div>
  );
}
