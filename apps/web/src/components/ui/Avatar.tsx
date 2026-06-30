import type { CSSProperties } from 'react';

const palette = [
  { bg: 'var(--blue-100)', fg: 'var(--blue-700)' },
  { bg: 'var(--green-100)', fg: 'var(--green-800)' },
  { bg: 'var(--violet-100)', fg: 'var(--violet-700)' },
  { bg: 'var(--amber-100)', fg: 'var(--amber-800)' },
  { bg: 'var(--cyan-100)', fg: 'var(--cyan-700)' },
  { bg: 'var(--red-100)', fg: 'var(--red-700)' },
];

function initials(name = ''): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.charAt(0).toUpperCase();
  const last = parts[parts.length - 1] ?? '';
  return (first.charAt(0) + last.charAt(0)).toUpperCase();
}

export interface AvatarProps {
  name?: string;
  size?: number;
  src?: string | null;
  style?: CSSProperties;
}

/**
 * Avatar — initials chip used on assignees across cards, rows, and the detail rail.
 * Colour is derived deterministically from the name so each person is stable.
 */
export function Avatar({ name = '', size = 28, src = null, style }: AvatarProps) {
  const idx = [...name].reduce((s, c) => s + c.charCodeAt(0), 0) % palette.length;
  const c = palette[idx]!;
  return (
    <span
      title={name}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: size, height: size, borderRadius: 'var(--radius-full)', flexShrink: 0,
        fontSize: Math.round(size * 0.4), fontWeight: 'var(--weight-semibold)',
        background: src ? 'transparent' : c.bg, color: c.fg, overflow: 'hidden',
        backgroundImage: src ? `url(${src})` : 'none', backgroundSize: 'cover', backgroundPosition: 'center',
        ...style,
      }}
    >
      {!src && initials(name)}
    </span>
  );
}
