import { useMemo, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Plus, Inbox, Save, Trash2 } from 'lucide-react';
import { Button, Input, Select, Avatar, Badge, useToast } from '../components/ui';
import { StageBadge, DecisionPill, DeadlineCountdown } from '../components/crm';
import {
  getTendersSummary, getUsers,
  getViews, createView, deleteView, getTags,
  type SavedView, type Stitek,
} from '../lib/api';
import { getStoredUser } from '../lib/auth';
import { effectiveStage, deadlineDays, normalizeDecision, type Decision } from '../lib/crm-adapters';
import { fmtCZK } from '../lib/format';
import type { StageKey } from '../lib/stages';

export interface ZakazkyPageProps {
  onOpen?: (id: string) => void;
}

// --- saved views (uložená zobrazení) ---
const VIEWS = ['Všechny', 'Přiřazeno mně', 'Blížící se lhůty', 'GO rozhodnuto', 'Vyhráno letos'] as const;
type View = (typeof VIEWS)[number];

const DECISION_OPTIONS = [
  { value: '', label: 'Všechna rozhodnutí' },
  { value: 'GO', label: 'GO' },
  { value: 'ZVAZIT', label: 'ZVÁŽIT' },
  { value: 'NOGO', label: 'NOGO' },
];

// Mřížka sloupců — sdílená hlavičkou i řádky pro přesné zarovnání.
// Název · Zadavatel · Hodnota · Lhůta · Stav · Skóre · Řeší.
const GRID = 'minmax(220px, 2.4fr) minmax(170px, 1.7fr) 150px 132px 138px 96px 64px';
const MIN_WIDTH = 940;

interface Row {
  id: string;
  stage: StageKey;
  nazev: string;
  evidence: string;
  zadavatel: string;
  ico: string;
  hodnota: number | null | undefined;
  lhuta: string | null | undefined;
  decision: Decision | null;
  days: number | null;
  assignee: string | null;
  stitky: Stitek[];
}

const HEAD: { label: string; align?: 'right' }[] = [
  { label: 'Název' },
  { label: 'Zadavatel' },
  { label: 'Hodnota', align: 'right' },
  { label: 'Lhůta' },
  { label: 'Stav' },
  { label: 'Doporučení' },
  { label: 'Řeší' },
];

const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-2xs)', color: 'var(--text-tertiary)' };

export default function ZakazkyPage({ onOpen }: ZakazkyPageProps) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('Všechny');
  const [decision, setDecision] = useState('');
  const [tagId, setTagId] = useState('');
  const [savingView, setSavingView] = useState(false);
  const [viewName, setViewName] = useState('');

  const currentUserId = getStoredUser()?.id ?? null;
  const qc = useQueryClient();
  const { toast } = useToast();

  // Jeden request se souhrnem analýzy embednutým na každé zakázce (zrušení N+1 getAnalysis).
  const { data: tenders = [], isLoading } = useQuery({ queryKey: ['tenders', 'summary'], queryFn: getTendersSummary });
  // Řešitel = jméno z user-store; enrichment, degraduje na prázdno (getUsers je resilientní).
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: getUsers, retry: false, staleTime: 60_000 });
  const usersMap = useMemo(() => new Map(users.map((u): [string, string] => [u.id, u.name || u.email])), [users]);
  // Štítky (M9b) — číselník pro filtr + uložená zobrazení pro rychlou lištu.
  const { data: allTags = [] } = useQuery({ queryKey: ['tags'], queryFn: getTags });
  const { data: savedViews = [] } = useQuery({ queryKey: ['views'], queryFn: getViews });
  const tagOptions = useMemo(
    () => [{ value: '', label: 'Všechny štítky' }, ...allTags.map((t) => ({ value: t.id, label: t.nazev }))],
    [allTags],
  );

  // Obohacení (zadavatel, hodnota, lhůta, rozhodnutí) přichází embednuté v t.analysis (souhrn).
  const rows: Row[] = useMemo(
    () =>
      tenders.map((t) => {
        const a = t.analysis;
        const lhuta = a?.lhuta_nabidek ?? null;
        return {
          id: t.id,
          stage: effectiveStage({ status: t.status, steps: t.steps }),
          nazev: a?.nazev || t.name || t.tenderId || t.id,
          evidence: a?.evidencni_cislo || t.tenderId || t.id,
          zadavatel: a?.zadavatel_nazev || '',
          ico: a?.zadavatel_ico || '',
          hodnota: a?.predpokladana_hodnota ?? undefined,
          lhuta,
          decision: normalizeDecision(a?.rozhodnuti ?? undefined),
          days: deadlineDays(lhuta),
          assignee: t.assignee ?? null,
          stitky: t.stitky ?? [],
        };
      }),
    [tenders],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q) {
        const hay = `${r.nazev} ${r.zadavatel} ${r.ico} ${r.evidence} ${r.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (decision && r.decision !== decision) return false;
      if (tagId && !r.stitky.some((s) => s.id === tagId)) return false;
      switch (view) {
        case 'Přiřazeno mně':
          // Reálné: zakázky přiřazené přihlášenému uživateli (bez přihlášení → prázdné).
          if (!currentUserId || r.assignee !== currentUserId) return false;
          break;
        case 'Blížící se lhůty':
          if (r.days == null || r.days < 0 || r.days > 7) return false;
          break;
        case 'GO rozhodnuto':
          if (r.decision !== 'GO') return false;
          break;
        case 'Vyhráno letos':
          if (r.stage !== 'vyhrano') return false;
          break;
        default:
          break;
      }
      return true;
    });
  }, [rows, query, decision, tagId, view, currentUserId]);

  const hasFilters = query.trim() !== '' || view !== 'Všechny' || decision !== '' || tagId !== '';
  const resetFilters = () => {
    setQuery('');
    setView('Všechny');
    setDecision('');
    setTagId('');
  };

  // Aplikuje uložený pohled (M9b) — definice nese jen query/decision/view (bez štítku).
  function applySavedView(v: SavedView) {
    const def = v.definice || {};
    setQuery(def.query ?? '');
    setDecision(def.decision ?? '');
    setTagId(def.tag ?? '');
    if (def.view && (VIEWS as readonly string[]).includes(def.view)) {
      setView(def.view as View);
    }
  }

  async function handleDeleteView(id: string) {
    try {
      await deleteView(id);
      qc.invalidateQueries({ queryKey: ['views'] });
      toast('Pohled smazán', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Nepodařilo se smazat pohled', 'danger');
    }
  }

  async function handleSaveView() {
    const nazev = viewName.trim();
    if (!nazev) return;
    try {
      await createView({ nazev, definice: { query: query || undefined, decision: decision || undefined, view, tag: tagId || undefined } });
      qc.invalidateQueries({ queryKey: ['views'] });
      toast('Pohled uložen', 'success');
      setViewName('');
      setSavingView(false);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Nepodařilo se uložit pohled', 'danger');
    }
  }

  function handleSaveViewKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') void handleSaveView();
    if (e.key === 'Escape') {
      setSavingView(false);
      setViewName('');
    }
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--weight-bold)', color: 'var(--text-primary)', margin: 0 }}>
            Zakázky
          </h1>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
            {filtered.length} z {rows.length} {plural(rows.length)}
          </p>
        </div>
        {/* Ruční import = nahrání zadávací dokumentace v ingest inboxu (Monitoring). */}
        <Button variant="primary" iconLeft={<Plus size={15} />} onClick={() => { window.location.hash = '/monitoring'; }}>
          Ruční import
        </Button>
      </div>

      {/* Uložená zobrazení (saved views) */}
      <div className="vz-scroll" style={{ display: 'flex', gap: 2, alignItems: 'center', borderBottom: '1px solid var(--border-default)', overflowX: 'auto', marginTop: 16 }}>
        {VIEWS.map((v) => {
          const active = v === view;
          return (
            <button
              key={v}
              onClick={() => setView(v)}
              style={{
                position: 'relative', padding: '10px 12px', background: 'transparent', border: 'none', cursor: 'pointer',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap',
                fontWeight: active ? 'var(--weight-semibold)' : 'var(--weight-medium)',
                color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
                boxShadow: active ? 'inset 0 -2px 0 0 var(--accent)' : 'none',
                transition: 'color var(--duration-fast)',
              }}
            >
              {v}
            </button>
          );
        })}
        {savedViews.map((v) => {
          const isOwn = v.user_id === currentUserId;
          return (
            <div key={v.id} style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
              <button
                onClick={() => applySavedView(v)}
                title={v.nazev}
                style={{
                  position: 'relative', padding: '10px 4px 10px 12px', background: 'transparent', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', whiteSpace: 'nowrap',
                  fontWeight: 'var(--weight-medium)', color: 'var(--text-secondary)',
                  transition: 'color var(--duration-fast)',
                }}
              >
                {v.nazev}
              </button>
              {isOwn && (
                <button
                  onClick={() => handleDeleteView(v.id)}
                  title="Smazat pohled"
                  style={{
                    display: 'flex', alignItems: 'center', padding: '6px 12px 6px 4px', background: 'transparent',
                    border: 'none', cursor: 'pointer', color: 'var(--text-tertiary)',
                  }}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Filtr bar */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 16, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 280px', minWidth: 220, maxWidth: 420 }}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Hledat zakázky, zadavatele, IČO…"
            iconLeft={<Search size={15} />}
          />
        </div>
        <div style={{ width: 190 }}>
          <Select value={decision} onChange={(e) => setDecision(e.target.value)} options={DECISION_OPTIONS} />
        </div>
        <div style={{ width: 190 }}>
          <Select value={tagId} onChange={(e) => setTagId(e.target.value)} options={tagOptions} />
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {savingView ? (
            <>
              <div style={{ width: 180 }}>
                <Input
                  value={viewName}
                  onChange={(e) => setViewName(e.target.value)}
                  onKeyDown={handleSaveViewKeyDown}
                  placeholder="Název pohledu…"
                  size="sm"
                  autoFocus
                />
              </div>
              <Button variant="primary" size="sm" onClick={handleSaveView} disabled={!viewName.trim()}>
                Uložit
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setSavingView(false); setViewName(''); }}>
                Zrušit
              </Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" iconLeft={<Save size={14} />} onClick={() => setSavingView(true)}>
              Uložit pohled
            </Button>
          )}
        </div>
      </div>

      {/* Tabulka */}
      <div
        style={{
          marginTop: 16, background: 'var(--surface-card)', border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)', overflow: 'hidden',
        }}
      >
        <div className="vz-scroll" style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: MIN_WIDTH }}>
            {/* Hlavička */}
            <div
              style={{
                display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 12,
                padding: '0 16px', height: 40, position: 'sticky', top: 0, zIndex: 1,
                background: 'var(--surface-sunken)', borderBottom: '1px solid var(--border-default)',
              }}
            >
              {HEAD.map((h) => (
                <span
                  key={h.label}
                  style={{
                    fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--weight-semibold)',
                    textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)',
                    textAlign: h.align ?? 'left',
                  }}
                >
                  {h.label}
                </span>
              ))}
            </div>

            {/* Tělo */}
            {isLoading ? (
              <SkeletonRows />
            ) : filtered.length === 0 ? (
              <EmptyState hasFilters={hasFilters} onReset={resetFilters} />
            ) : (
              filtered.map((r) => <TableRow key={r.id} row={r} usersMap={usersMap} onOpen={onOpen} />)
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function plural(n: number): string {
  if (n === 1) return 'zakázka';
  if (n >= 2 && n <= 4) return 'zakázky';
  return 'zakázek';
}

function TableRow({ row, usersMap, onOpen }: { row: Row; usersMap: Map<string, string>; onOpen?: (id: string) => void }) {
  const [hover, setHover] = useState(false);
  const dash = <span style={{ color: 'var(--text-tertiary)' }}>—</span>;

  return (
    <div
      onClick={() => onOpen?.(row.id)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 12,
        padding: '0 16px', minHeight: 52, cursor: 'pointer',
        background: hover ? 'var(--surface-hover)' : 'transparent',
        borderBottom: '1px solid var(--border-subtle)',
        transition: 'background var(--duration-fast)',
      }}
    >
      {/* Název */}
      <div style={{ minWidth: 0, padding: '8px 0' }}>
        <div style={{
          fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {row.nazev}
        </div>
        <div style={{ ...mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 1 }}>
          {row.evidence}
        </div>
        {row.stitky.length > 0 && (
          <div style={{ display: 'flex', gap: 4, marginTop: 4, overflow: 'hidden' }}>
            {row.stitky.slice(0, 4).map((s) => (
              <Badge key={s.id} tone={s.barva as any} size="sm">{s.nazev}</Badge>
            ))}
            {row.stitky.length > 4 && <Badge tone="neutral" size="sm">+{row.stitky.length - 4}</Badge>}
          </div>
        )}
      </div>

      {/* Zadavatel */}
      <div style={{ minWidth: 0 }}>
        {row.zadavatel ? (
          <>
            <div style={{
              fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {row.zadavatel}
            </div>
            {row.ico && <div style={{ ...mono, marginTop: 1 }}>IČO {row.ico}</div>}
          </>
        ) : (
          dash
        )}
      </div>

      {/* Hodnota */}
      <div style={{ textAlign: 'right' }}>
        {row.hodnota != null ? (
          <span className="tnum" style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
            {fmtCZK(row.hodnota)}
          </span>
        ) : (
          dash
        )}
      </div>

      {/* Lhůta */}
      <div>
        {row.lhuta ? <DeadlineCountdown date={row.lhuta} /> : dash}
      </div>

      {/* Stav */}
      <div>
        <StageBadge status={row.stage} size="sm" />
      </div>

      {/* Doporučení — GO/NOGO/ZVÁŽIT z AI analýzy (dokud není analýza, prázdné). */}
      <div>
        {row.decision ? (
          <DecisionPill decision={row.decision} style={{ padding: '3px 10px', fontSize: 'var(--font-size-2xs)' }} />
        ) : (
          dash
        )}
      </div>

      {/* Řeší — přiřazený řešitel (avatar), jinak prázdné. */}
      <div>
        {row.assignee ? (
          <Avatar name={usersMap.get(row.assignee) ?? row.assignee} size={26} />
        ) : (
          dash
        )}
      </div>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', gap: 12,
            padding: '0 16px', minHeight: 52, borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }}>
            <Bar w="70%" />
            <Bar w="40%" h={8} />
          </div>
          <Bar w="60%" />
          <div style={{ justifySelf: 'end', width: '50%' }}><Bar w="100%" /></div>
          <Bar w="55%" />
          <Bar w={80} h={18} />
          <Bar w={56} h={18} />
          <Bar w={26} h={26} />
        </div>
      ))}
    </>
  );
}

function Bar({ w, h = 10 }: { w: number | string; h?: number }) {
  return (
    <span style={{ display: 'block', width: w, height: h, borderRadius: 4, background: 'var(--surface-sunken)' }} />
  );
}

function EmptyState({ hasFilters, onReset }: { hasFilters: boolean; onReset: () => void }) {
  return (
    <div style={{ padding: '56px 24px', textAlign: 'center' }}>
      <Inbox size={28} style={{ color: 'var(--text-tertiary)', marginBottom: 10 }} />
      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
        {hasFilters ? 'Žádné zakázky neodpovídají filtru' : 'Zatím žádné zakázky'}
      </div>
      {hasFilters && (
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'center' }}>
          <Button variant="secondary" size="sm" onClick={onReset}>Zrušit filtry</Button>
        </div>
      )}
    </div>
  );
}
