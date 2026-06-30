import { useState, type ReactNode } from 'react';
import {
  LayoutDashboard, Radar, KanbanSquare, Table2, Calendar, Warehouse, Settings,
  Search, Bell, ChevronRight, LogOut,
} from 'lucide-react';
import { Avatar } from '../ui';

export type NavKey = 'prehled' | 'monitoring' | 'pipeline' | 'zakazky' | 'kalendar' | 'sklad' | 'nastaveni';

interface NavDef {
  key: NavKey;
  label: string;
  icon: typeof LayoutDashboard;
}

const NAV: NavDef[] = [
  { key: 'prehled', label: 'Přehled', icon: LayoutDashboard },
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
 * chrome; wraps all routed content. Cmd+K and the bell are static placeholders.
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
            title="Hledat (brzy)"
            style={{
              display: 'flex', alignItems: 'center', gap: 8, height: 34, padding: '0 10px 0 11px', cursor: 'pointer',
              background: 'var(--surface-page)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)',
              color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', width: 230,
            }}
          >
            <Search size={15} />
            <span style={{ flex: 1, textAlign: 'left' }}>Hledat zakázky…</span>
            <kbd style={{
              fontFamily: 'var(--font-mono)', fontSize: 11, padding: '1px 5px', borderRadius: 4,
              background: 'var(--surface-card)', border: '1px solid var(--border-default)', color: 'var(--text-secondary)',
            }}>⌘K</kbd>
          </button>
          <button
            title="Upozornění (brzy)"
            style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 34, height: 34, background: 'transparent', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', cursor: 'pointer', color: 'var(--text-secondary)' }}
          >
            <Bell size={17} />
          </button>
        </header>
        <main className="vz-scroll" style={{ flex: 1, overflow: 'auto', padding: 24 }}>{children}</main>
      </div>
    </div>
  );
}
