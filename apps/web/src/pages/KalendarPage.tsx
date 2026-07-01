import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, CalendarDays } from 'lucide-react';
import { getCalendar, getTenders, type CalendarItem, type TerminTyp } from '../lib/api';
import { Card, Button } from '../components/ui';

// Český popisek pro každý typ termínu (viz TerminTyp v lib/api).
const TYP_LABEL: Record<TerminTyp, string> = {
  lhuta_nabidek: 'Lhůta pro nabídky',
  otevirani_obalek: 'Otevírání obálek',
  doba_plneni: 'Doba plnění',
  prohlidka: 'Prohlídka místa',
  vlastni: 'Vlastní',
};

// Barevný token pro chip/tečku podle typu (soft bg + fg + dot z palety).
const TYP_COLOR: Record<TerminTyp, { bg: string; fg: string; dot: string }> = {
  lhuta_nabidek:    { bg: 'var(--red-100)',    fg: 'var(--red-700)',    dot: 'var(--red-600)' },
  otevirani_obalek: { bg: 'var(--blue-100)',   fg: 'var(--blue-700)',   dot: 'var(--blue-600)' },
  doba_plneni:      { bg: 'var(--violet-100)', fg: 'var(--violet-700)', dot: 'var(--violet-600)' },
  prohlidka:        { bg: 'var(--amber-100)',  fg: 'var(--amber-800)',  dot: 'var(--amber-500)' },
  vlastni:          { bg: 'var(--gray-100)',   fg: 'var(--gray-700)',   dot: 'var(--gray-400)' },
};

const WEEKDAYS = ['Po', 'Út', 'St', 'Čt', 'Pá', 'So', 'Ne'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// m je 0-indexovaný měsíc (jako Date.getMonth()); vrací 'YYYY-MM-DD'.
function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad2(m + 1)}-${pad2(d)}`;
}

// Bezpečný parse 'YYYY-MM-DD' bez TZ posunu (poledne lokálně).
function parseDatum(datum: string): Date {
  return new Date(datum + 'T00:00:00');
}

// Navigace na detail zakázky přes stejný hash-routing jako zbytek appky.
function openTender(id: string): void {
  window.location.hash = '#/tender/' + id;
}

/**
 * Kalendář / Lhůty — read-only přehled termínů napříč zakázkami.
 * Vlevo měsíční mřížka (Po–Ne) s barevnými chip-y podle typu termínu,
 * vpravo seznam termínů viditelného měsíce seřazený vzestupně.
 * Data z perzistovaných termínů (getCalendar); klik → detail zakázky.
 */
export default function KalendarPage() {
  // Aktuální měsíc počítáme client-side v inicializátoru (ne na module scope).
  const [month, setMonth] = useState<{ y: number; m: number }>(() => {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() };
  });

  // Rozsah viditelného měsíce + ploché buňky mřížky (leading/trailing prázdné).
  const { firstIso, lastIso, cells } = useMemo(() => {
    const daysInMonth = new Date(month.y, month.m + 1, 0).getDate();
    // getDay(): 0=neděle..6=sobota → posun na Po-first (0=pondělí).
    const firstWeekday = (new Date(month.y, month.m, 1).getDay() + 6) % 7;
    const grid: Array<number | null> = [
      ...Array.from({ length: firstWeekday }, () => null),
      ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
    ];
    while (grid.length % 7 !== 0) grid.push(null);
    return {
      firstIso: ymd(month.y, month.m, 1),
      lastIso: ymd(month.y, month.m, daysInMonth),
      cells: grid,
    };
  }, [month]);

  const { data: items = [] } = useQuery({
    queryKey: ['calendar', month.y, month.m],
    queryFn: () => getCalendar(firstIso, lastIso),
    retry: false,
    staleTime: 30_000,
  });
  const { data: tenders = [] } = useQuery({ queryKey: ['tenders'], queryFn: getTenders });

  const tenderName = (id: string): string => tenders.find((t) => t.id === id)?.name ?? id;

  // Termíny s konkrétním datem (bez data nelze umístit ani vypsat).
  const dated = useMemo(
    () => items.filter((it): it is CalendarItem & { datum: string } => !!it.datum),
    [items],
  );

  // datum → termíny (pro umístění do buněk mřížky).
  const byDate = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const it of dated) {
      const list = map.get(it.datum) ?? [];
      list.push(it);
      map.set(it.datum, list);
    }
    return map;
  }, [dated]);

  // Seznam vpravo: vzestupně dle data, pak dle času.
  const upcoming = useMemo(
    () => [...dated].sort((a, b) =>
      a.datum === b.datum ? (a.cas ?? '').localeCompare(b.cas ?? '') : a.datum.localeCompare(b.datum),
    ),
    [dated],
  );

  const todayIso = useMemo(() => {
    const n = new Date();
    return ymd(n.getFullYear(), n.getMonth(), n.getDate());
  }, []);

  const monthLabel = new Date(month.y, month.m, 1).toLocaleDateString('cs-CZ', { month: 'long', year: 'numeric' });
  const monthTitle = monthLabel.charAt(0).toUpperCase() + monthLabel.slice(1);

  const goPrev = () => setMonth(({ y, m }) => (m === 0 ? { y: y - 1, m: 11 } : { y, m: m - 1 }));
  const goNext = () => setMonth(({ y, m }) => (m === 11 ? { y: y + 1, m: 0 } : { y, m: m + 1 }));
  const goToday = () => {
    const n = new Date();
    setMonth({ y: n.getFullYear(), m: n.getMonth() });
  };

  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Button variant="ghost" size="sm" onClick={goPrev} aria-label="Předchozí měsíc"><ChevronLeft size={16} /></Button>
      <Button variant="secondary" size="sm" onClick={goToday}>Dnes</Button>
      <Button variant="ghost" size="sm" onClick={goNext} aria-label="Následující měsíc"><ChevronRight size={16} /></Button>
    </div>
  );

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Header */}
      <div>
        <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Kalendář</h1>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
          Lhůty a termíny napříč zakázkami
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 24, alignItems: 'start' }}>
        {/* Měsíční mřížka */}
        <Card title={monthTitle} action={toolbar}>
          {/* Hlavička dnů v týdnu */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, marginBottom: 6 }}>
            {WEEKDAYS.map((d, i) => (
              <div key={d} style={{
                textAlign: 'center', fontSize: 'var(--font-size-xs)', fontWeight: 'var(--weight-semibold)',
                color: i >= 5 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
              }}>{d}</div>
            ))}
          </div>

          {/* Dny */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
            {cells.map((day, idx) => {
              if (day == null) {
                return <div key={idx} style={{ minHeight: 96, borderRadius: 'var(--radius-sm)' }} />;
              }
              const iso = ymd(month.y, month.m, day);
              const dayItems = byDate.get(iso) ?? [];
              const isToday = iso === todayIso;
              const weekend = idx % 7 >= 5;
              return (
                <div key={idx} style={{
                  minHeight: 96, padding: 6, display: 'flex', flexDirection: 'column', gap: 4,
                  border: `1px solid ${isToday ? 'var(--accent)' : 'var(--border-subtle)'}`,
                  borderRadius: 'var(--radius-sm)',
                  background: isToday ? 'var(--accent-soft-bg)' : weekend ? 'var(--surface-sunken)' : 'var(--surface-card)',
                }}>
                  <div style={{
                    fontSize: 'var(--font-size-xs)', fontWeight: isToday ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                    color: isToday ? 'var(--accent)' : weekend ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                  }}>{day}</div>
                  {dayItems.slice(0, 3).map((it) => {
                    const c = TYP_COLOR[it.typ];
                    const title = `${TYP_LABEL[it.typ]} — ${tenderName(it.tender_id)}`
                      + (it.cas ? ` · ${it.cas.slice(0, 5)}` : '') + (it.popis ? ` · ${it.popis}` : '');
                    return (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => openTender(it.tender_id)}
                        title={title}
                        style={{
                          display: 'block', width: '100%', textAlign: 'left', border: 'none', cursor: 'pointer',
                          padding: '1px 5px', borderRadius: 'var(--radius-sm)', background: c.bg, color: c.fg,
                          fontSize: 'var(--font-size-xs)', lineHeight: 1.35, fontWeight: 'var(--weight-medium)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >{tenderName(it.tender_id)}</button>
                    );
                  })}
                  {dayItems.length > 3 && (
                    <span
                      title={dayItems.slice(3).map((it) => `${TYP_LABEL[it.typ]} — ${tenderName(it.tender_id)}`).join('\n')}
                      style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', paddingLeft: 5 }}
                    >+{dayItems.length - 3} další</span>
                  )}
                </div>
              );
            })}
          </div>

          {/* Legenda typů */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-subtle)' }}>
            {(Object.keys(TYP_LABEL) as TerminTyp[]).map((typ) => (
              <span key={typ} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)' }}>
                <span style={{ width: 8, height: 8, borderRadius: 'var(--radius-full)', background: TYP_COLOR[typ].dot, flexShrink: 0 }} />
                {TYP_LABEL[typ]}
              </span>
            ))}
          </div>
        </Card>

        {/* Seznam termínů měsíce */}
        <Card title="Termíny v měsíci" padding={upcoming.length ? 0 : 16}>
          {upcoming.length === 0 ? (
            <EmptyState icon={<CalendarDays size={20} strokeWidth={2} />}>Žádné termíny v tomto měsíci.</EmptyState>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {upcoming.map((it, i) => {
                const d = parseDatum(it.datum);
                const weekday = d.toLocaleDateString('cs-CZ', { weekday: 'short' });
                const c = TYP_COLOR[it.typ];
                return (
                  <div
                    key={it.id}
                    onClick={() => openTender(it.tender_id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTender(it.tender_id); }
                    }}
                    style={{
                      display: 'flex', gap: 12, padding: '11px 16px', cursor: 'pointer',
                      borderTop: i ? '1px solid var(--border-subtle)' : 'none',
                    }}
                  >
                    <div style={{ width: 96, flexShrink: 0 }}>
                      <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
                        {d.toLocaleDateString('cs-CZ')}
                      </div>
                      <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
                        {weekday}{it.cas ? ` · ${it.cas.slice(0, 5)}` : ''}
                      </div>
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 'var(--radius-full)', background: c.dot, flexShrink: 0 }} />
                        <span style={{
                          fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{TYP_LABEL[it.typ]}</span>
                      </div>
                      <div style={{
                        fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginTop: 1,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{tenderName(it.tender_id)}</div>
                      {it.popis && (
                        <div style={{
                          fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', marginTop: 1,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{it.popis}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

function EmptyState({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 8, padding: '24px 0', color: 'var(--text-tertiary)', textAlign: 'center',
    }}>
      <span style={{ color: 'var(--text-tertiary)' }}>{icon}</span>
      <span style={{ fontSize: 'var(--font-size-sm)' }}>{children}</span>
    </div>
  );
}
