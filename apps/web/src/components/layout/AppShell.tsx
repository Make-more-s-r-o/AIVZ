import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Radar, KanbanSquare, Table2, Calendar, Warehouse, Settings,
  Search, Bell, ChevronRight, LogOut, Inbox,
} from 'lucide-react';
import { Avatar } from '../ui';
import { getNotifications, markNotificationsRead, type Notification } from '../../lib/api';
import { getStoredUser } from '../../lib/auth';

export type NavKey = 'prehled' | 'inbox' | 'monitoring' | 'pipeline' | 'zakazky' | 'kalendar' | 'sklad' | 'nastaveni';

interface NavDef {
  key: NavKey;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavDef[] = [
  { key: 'prehled', label: 'Přehled', icon: LayoutDashboard },
  { key: 'inbox', label: 'Ke schválení', icon: Inbox },
  { key: 'monitoring', label: 'Monitoring', icon: Radar },
  { key: 'pipeline', label: 'Pipeline', icon: KanbanSquare },
  { key: 'zakazky', label: 'Zakázky', icon: Table2 },
  { key: 'kalendar', label: 'Kalendář', icon: Calendar },
  { key: 'sklad', label: 'Cenový sklad', icon: Warehouse },
];
const SETTINGS_NAV: NavDef = { key: 'nastaveni', label: 'Nastavení', icon: Settings };

function NavItem({ item, active, onClick }: { item: NavDef; active: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const Icon = item.icon;
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 10px',
        border: 'none', borderRadius: 'var(--radius-md)', cursor: 'pointer', textAlign: 'left',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)',
        fontWeight: active ? 'var(--weight-semibold)' : 'var(--weight-medium)',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        background: active ? 'var(--accent-soft-bg)' : hover ? 'var(--surface-hover)' : 'transparent',
        transition: 'background var(--duration-fast)',
      }}
    >
      <Icon size={17} strokeWidth={2} />
      <span style={{ flex: 1 }}>{item.label}</span>
    </button>
  );
}

/** Relativní čas v češtině (např. „před 5 min", „před 2 dny"). */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.floor((Date.now() - then) / 1000);
  if (s < 45) return 'právě teď';
  const m = Math.floor(s / 60);
  if (m < 60) return `před ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `před ${h} h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `před ${d} ${d === 1 ? 'dnem' : 'dny'}`;
  return new Date(then).toLocaleDateString('cs-CZ');
}

function NotificationRow({ n, onOpen }: { n: Notification; onOpen: () => void }) {
  const [hover, setHover] = useState(false);
  const clickable = !!n.url || !n.precteno;
  return (
    <div
      role={clickable ? 'button' : undefined}
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 9, padding: '10px 14px',
        cursor: clickable ? 'pointer' : 'default',
        background: hover ? 'var(--surface-hover)' : n.precteno ? 'transparent' : 'var(--accent-soft-bg)',
        borderTop: '1px solid var(--border-subtle)', transition: 'background var(--duration-fast)',
      }}
    >
      <span style={{
        flexShrink: 0, width: 7, height: 7, marginTop: 6, borderRadius: 'var(--radius-full)',
        background: n.precteno ? 'transparent' : 'var(--accent)',
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 'var(--font-size-sm)', lineHeight: 1.35, color: 'var(--text-primary)',
          fontWeight: n.precteno ? 'var(--weight-regular)' : 'var(--weight-medium)',
        }}>{n.text}</div>
        <div style={{ marginTop: 2, fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
          {relativeTime(n.created_at)}
        </div>
      </div>
    </div>
  );
}

/**
 * NotificationBell — zvonek v topbaru: nepřečtený badge + rozbalovací seznam,
 * mark-as-read a deep-link navigace přes hash. Poll každých 45 s, resilientní
 * (bez uživatele nebo při chybě = prázdno, žádný reload loop).
 */
function NotificationBell() {
  const me = getStoredUser();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const { data } = useQuery({
    queryKey: ['notifications', me?.id ?? 'anon'],
    queryFn: () => getNotifications(me?.id ?? ''),
    enabled: !!me?.id,
    refetchInterval: 45_000,
    retry: false,
    staleTime: 30_000,
  });

  const unread = data?.unread ?? 0;
  const items = data?.items ?? [];

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['notifications'] }); };

  const markAll = () => { void markNotificationsRead().then(invalidate).catch(() => {}); };

  const openNotification = (n: Notification) => {
    if (n.url) window.location.hash = n.url;
    if (!n.precteno) void markNotificationsRead([n.id]).then(invalidate).catch(() => {});
    setOpen(false);
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        title="Upozornění"
        aria-label="Upozornění"
        style={{
          position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 34, height: 34, background: open || hover ? 'var(--surface-hover)' : 'transparent',
          border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', cursor: 'pointer',
          color: open ? 'var(--text-primary)' : 'var(--text-secondary)', transition: 'background var(--duration-fast)',
        }}
      >
        <Bell size={17} />
        {unread > 0 && (
          <span style={{
            position: 'absolute', top: -5, right: -5, minWidth: 16, height: 16, padding: '0 4px',
            display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
            background: 'var(--danger-solid)', color: '#fff', fontFamily: 'var(--font-sans)',
            fontSize: 10, fontWeight: 'var(--weight-semibold)', lineHeight: 1, borderRadius: 'var(--radius-full)',
            border: '2px solid var(--surface-card)',
          }}>{unread > 99 ? '99+' : unread}</span>
        )}
      </button>

      {open && (
        <div role="menu" style={{
          position: 'absolute', top: 'calc(100% + 8px)', right: 0, width: 340, maxWidth: '90vw',
          background: 'var(--surface-card)', border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)', zIndex: 50, overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, padding: '11px 14px',
            borderBottom: '1px solid var(--border-subtle)',
          }}>
            <span style={{ flex: 1, fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
              Upozornění
            </span>
            {unread > 0 && (
              <button
                onClick={markAll}
                style={{
                  background: 'transparent', border: 'none', cursor: 'pointer', padding: 0,
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-xs)', fontWeight: 'var(--weight-medium)',
                  color: 'var(--text-link)',
                }}
              >Označit vše přečtené</button>
            )}
          </div>
          <div className="vz-scroll" style={{ maxHeight: 360, overflowY: 'auto' }}>
            {items.length === 0 ? (
              <div style={{ padding: '28px 14px', textAlign: 'center', fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>
                Žádná upozornění.
              </div>
            ) : (
              items.map((n) => <NotificationRow key={n.id} n={n} onOpen={() => openNotification(n)} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export interface AppShellProps {
  active: NavKey;
  onNav: (key: NavKey) => void;
  breadcrumbs?: string[];
  user?: { name: string; role?: string } | null;
  onLogout?: () => void;
  children: ReactNode;
}

/**
 * AppShell — persistent 240px sidebar + slim 56px top bar. The primary VZ CRM
 * chrome; wraps all routed content. Cmd+K is a static placeholder; the bell is
 * a live NotificationBell (badge + dropdown + mark-as-read + deep-link).
 */
export function AppShell({ active, onNav, breadcrumbs = [], user, onLogout, children }: AppShellProps) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--surface-page)' }}>
      {/* Sidebar */}
      <aside style={{
        width: 'var(--sidebar-width)', flexShrink: 0, background: 'var(--surface-card)',
        borderRight: '1px solid var(--border-default)', display: 'flex', flexDirection: 'column',
        position: 'sticky', top: 0, height: '100vh',
      }}>
        <button
          onClick={() => onNav('prehled')}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 16px 14px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
        >
          <span style={{
            width: 32, height: 32, borderRadius: 'var(--radius-md)', background: 'var(--accent)', color: '#fff',
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14, letterSpacing: '-.02em',
          }}>VZ</span>
          <div style={{ lineHeight: 1.1 }}>
            <div style={{ fontWeight: 700, fontSize: 'var(--font-size-base)', color: 'var(--text-primary)' }}>VZ&nbsp;CRM</div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>veřejné zakázky</div>
          </div>
        </button>
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 10px', flex: 1 }}>
          {NAV.map((it) => (
            <NavItem key={it.key} item={it} active={active === it.key} onClick={() => onNav(it.key)} />
          ))}
          <div style={{ height: 1, background: 'var(--border-default)', margin: '8px 6px' }} />
          <NavItem item={SETTINGS_NAV} active={active === 'nastaveni'} onClick={() => onNav('nastaveni')} />
        </nav>
        <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border-default)', display: 'flex', alignItems: 'center', gap: 9 }}>
          <Avatar name={user?.name || 'Uživatel'} size={30} />
          <div style={{ flex: 1, lineHeight: 1.2, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{user?.name || 'Uživatel'}</div>
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{user?.role || 'Přihlášen'}</div>
          </div>
          {onLogout && (
            <button
              onClick={onLogout}
              title="Odhlásit se"
              style={{ color: 'var(--text-tertiary)', display: 'flex', cursor: 'pointer', background: 'transparent', border: 'none', padding: 4 }}
            >
              <LogOut size={16} />
            </button>
          )}
        </div>
      </aside>

      {/* Main column */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header style={{
          height: 'var(--topbar-height)', flexShrink: 0, background: 'var(--surface-card)',
          borderBottom: '1px solid var(--border-default)', display: 'flex', alignItems: 'center',
          gap: 16, padding: '0 24px', position: 'sticky', top: 0, zIndex: 10,
        }}>
          <nav style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 1, minWidth: 0 }}>
            {breadcrumbs.map((b, i) => (
              <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                {i > 0 && <ChevronRight size={14} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />}
                <span style={{
                  fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap',
                  color: i === breadcrumbs.length - 1 ? 'var(--text-primary)' : 'var(--text-secondary)',
                  fontWeight: i === breadcrumbs.length - 1 ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                  overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: i === breadcrumbs.length - 1 ? 520 : 'none',
                }}>{b}</span>
              </span>
            ))}
          </nav>
          <button
            onClick={() => onNav('zakazky')}
            title="Hledat zakázky"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px 0 11px', cursor: 'pointer',
              background: 'var(--surface-page)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
              color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', width: 230,
            }}
          >
            <Search size={15} />
            <span style={{ flex: 1, textAlign: 'left' }}>Hledat zakázky…</span>
          </button>
          <NotificationBell />
        </header>
        <main className="vz-scroll" style={{ flex: 1, overflow: 'auto', padding: 24 }}>{children}</main>
      </div>
    </div>
  );
}
