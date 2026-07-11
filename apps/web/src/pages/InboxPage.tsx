import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, AlertTriangle, Coins, ClipboardCheck, Clock } from 'lucide-react';
import { getInbox, type InboxEntry } from '../lib/api';
import { fmtCZK } from '../lib/format';
import { STAGE_LABELS, type StageKey } from '../lib/stages';
import { Card, Badge } from '../components/ui';

export interface InboxPageProps {
  // Otevře detail zakázky rovnou na záložce Ocenění (deep-link ?tab=oceneni).
  onOpen?: (id: string) => void;
}

// Odznak s počtem — zobrazí se jen když je počet > 0, jinak nenápadná pomlčka.
function CountBadge({ count, tone, icon }: { count: number; tone: 'danger' | 'warning'; icon: React.ReactNode }) {
  if (count <= 0) {
    return <span style={{ color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>—</span>;
  }
  return (
    <Badge tone={tone} size="sm">
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        {icon}
        <span className="tnum" style={{ fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      </span>
    </Badge>
  );
}

const GRID = 'minmax(200px, 2fr) 110px 120px 110px 120px minmax(110px, 1fr) minmax(110px, 1fr)';
const HEAD = ['Zakázka', 'Stav', 'Nepotvrzené ceny', 'HARD flagy', 'Chyby validace', 'Zisk', 'Nabídková cena'];

/**
 * Ke schválení (schvalovací inbox) — jeden pohled napříč všemi zakázkami s tím,
 * co ode mě čeká akci: nepotvrzené ceny, HARD sanity flagy, chyby validace.
 * Zakázky bez akce se sem nezobrazují (BE je odfiltruje). Klik = otevře detail
 * na záložce Ocenění, kde se ceny potvrzují.
 */
export default function InboxPage({ onOpen }: InboxPageProps) {
  const { data: entries = [], isLoading, isError } = useQuery({
    queryKey: ['inbox'],
    queryFn: getInbox,
    refetchInterval: 30_000,
  });

  return (
    <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--weight-bold)', color: 'var(--text-primary)', margin: 0 }}>
          Ke schválení
        </h1>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: '4px 0 0' }}>
          Zakázky, které čekají na vaši akci — nepotvrzené ceny, kritické cenové flagy nebo chyby ve validaci.
        </p>
      </div>

      <Card padding={0}>
        <div className="vz-scroll" style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: 960 }}>
            {/* Hlavička */}
            <div
              style={{
                display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 12,
                padding: '0 16px', height: 40,
                background: 'var(--surface-sunken)', borderBottom: '1px solid var(--border-default)',
              }}
            >
              {HEAD.map((h, i) => (
                <span
                  key={h}
                  style={{
                    fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--weight-semibold)',
                    textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)',
                    textAlign: i >= 2 ? (i >= 5 ? 'right' : 'center') : 'left',
                  }}
                >
                  {h}
                </span>
              ))}
            </div>

            {/* Tělo */}
            {isLoading ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--font-size-sm)' }}>
                Načítám…
              </div>
            ) : isError ? (
              <div style={{ padding: 32, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 'var(--font-size-sm)' }}>
                Inbox se nepodařilo načíst.
              </div>
            ) : entries.length === 0 ? (
              <div style={{ padding: '40px 24px', textAlign: 'center' }}>
                <CheckCircle2 size={28} style={{ color: 'var(--color-success, #16a34a)', marginBottom: 8 }} />
                <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
                  Vše je čisté
                </div>
                <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginTop: 2 }}>
                  Žádná zakázka aktuálně nečeká na vaši akci.
                </div>
              </div>
            ) : (
              entries.map((e) => <InboxRow key={e.tender_id} entry={e} onOpen={onOpen} />)
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

// Text alarmu blížící se lhůty: „za X h" / „za <1 h" / „po lhůtě".
function alarmLabel(hodin: number | null): string {
  if (hodin == null) return 'Připraveno, nepodáno';
  if (hodin < 0) return `Připraveno, nepodáno, ${Math.abs(hodin)} h po lhůtě`;
  if (hodin < 1) return 'Připraveno, nepodáno, lhůta za <1 h';
  return `Připraveno, nepodáno, lhůta za ${hodin} h`;
}

function InboxRow({ entry, onOpen }: { entry: InboxEntry; onOpen?: (id: string) => void }) {
  const stavLabel = entry.crm_stav ? (STAGE_LABELS[entry.crm_stav as StageKey] ?? entry.crm_stav) : '—';
  return (
    <button
      onClick={() => onOpen?.(entry.tender_id)}
      style={{
        display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 12,
        padding: '0 16px', minHeight: 52, width: '100%',
        background: entry.deadline_alarm ? 'var(--danger-bg, #fef2f2)' : 'transparent',
        border: 'none',
        borderLeft: entry.deadline_alarm ? '3px solid var(--danger-fg, #dc2626)' : '3px solid transparent',
        borderBottom: '1px solid var(--border-subtle, var(--border-default))',
        cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
      }}
    >
      <span style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        <span
          style={{
            fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
          title={entry.nazev}
        >
          {entry.nazev}
        </span>
        <span style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--text-tertiary)' }}>{entry.tender_id}</span>
        {entry.deadline_alarm && (
          <span title="Balík je připraven, ale podání nebylo zaznamenáno a lhůta se blíží.">
            <Badge tone="danger" size="sm">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Clock size={12} />
                {alarmLabel(entry.hodin_do_lhuty)}
              </span>
            </Badge>
          </span>
        )}
        {entry.data_error && (
          <span title={`Vadné soubory: ${entry.data_error_files.join(', ')}`}>
            <Badge tone="danger" size="sm">Vadná data</Badge>
          </span>
        )}
      </span>

      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>{stavLabel}</span>

      <span style={{ textAlign: 'center' }}>
        <CountBadge count={entry.nepotvrzene_ceny} tone="warning" icon={<Coins size={12} />} />
      </span>
      <span style={{ textAlign: 'center' }}>
        <CountBadge count={entry.hard_flagy} tone="danger" icon={<AlertTriangle size={12} />} />
      </span>
      <span style={{ textAlign: 'center' }}>
        <CountBadge count={entry.validation_fails} tone="danger" icon={<ClipboardCheck size={12} />} />
      </span>

      <span
        className="tnum"
        style={{
          textAlign: 'right', fontSize: 'var(--font-size-sm)', fontVariantNumeric: 'tabular-nums',
          fontWeight: 'var(--weight-semibold)',
          color: entry.zisk_kc == null
            ? 'var(--text-tertiary)'
            : entry.zisk_kc > 0 ? 'var(--color-success, #16a34a)' : 'var(--color-danger, #dc2626)',
        }}
        title="Očekávaný hrubý zisk bez DPH (Σ nabídková − nákupní × množství)"
      >
        {entry.zisk_kc != null ? fmtCZK(entry.zisk_kc) : '—'}
      </span>

      <span
        className="tnum"
        style={{
          textAlign: 'right', fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {entry.celkova_cena_s_dph != null ? fmtCZK(entry.celkova_cena_s_dph) : '—'}
      </span>
    </button>
  );
}
