import { useMemo, useState, type CSSProperties } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Search, Plus, SlidersHorizontal, Inbox } from 'lucide-react';
import { Button, Input, Select, Checkbox } from '../components/ui';
import { StageBadge, DeadlineCountdown } from '../components/crm';
import { getTenders, getAnalysis } from '../lib/api';
import { effectiveStage, deadlineDays, normalizeDecision, type Decision } from '../lib/crm-adapters';
import { fmtCZK } from '../lib/format';
import type { StageKey } from '../lib/stages';

export interface ZakazkyPageProps {
  onOpen?: (id: string) => void;
}

// --- saved views (uložená zobrazení) ---
const VIEWS = ['Všechny', 'Přiřazeno mně', 'Blížící se lhůty', 'GO rozhodnuto', 'Vyhráno letos'] as const;
type View = (typeof VIEWS)[number];

// Region je čistě vizuální filtr — zdroj dat o kraji zatím neexistuje.
const REGIONS = ['Všechny kraje', 'Praha', 'Středočeský', 'Jihomoravský', 'Moravskoslezský', 'Ostatní'];

const DECISION_OPTIONS = [
  { value: '', label: 'Všechna rozhodnutí' },
  { value: 'GO', label: 'GO' },
  { value: 'ZVAZIT', label: 'ZVÁŽIT' },
  { value: 'NOGO', label: 'NOGO' },
];

// Mřížka sloupců — sdílená hlavičkou i řádky pro přesné zarovnání.
const GRID = '40px minmax(220px, 2.4fr) minmax(170px, 1.7fr) 150px 132px 138px 76px 60px';
const MIN_WIDTH = 980;

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
}

const HEAD: { label: string; align?: 'right' }[] = [
  { label: '' },
  { label: 'Název' },
  { label: 'Zadavatel' },
  { label: 'Hodnota', align: 'right' },
  { label: 'Lhůta' },
  { label: 'Stav' },
  { label: 'Skóre' },
  { label: 'Řeší' },
];

const mono: CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-2xs)', color: 'var(--text-tertiary)' };

export default function ZakazkyPage({ onOpen }: ZakazkyPageProps) {
  const [query, setQuery] = useState('');
  const [view, setView] = useState<View>('Všechny');
  const [region, setRegion] = useState('Všechny kraje');
  const [decision, setDecision] = useState('');

  const { data: tenders = [], isLoading } = useQuery({ queryKey: ['tenders'], queryFn: getTenders });

  // Lazy per-row obohacení (zadavatel, hodnota, lhůta, rozhodnutí) z analysis.json.
  const analyses = useQueries({
    queries: tenders.map((t) => ({
      queryKey: ['analysis', t.id],
      queryFn: () => getAnalysis(t.id),
      retry: false,
      enabled: t.steps.analyze === 'done',
      staleTime: 5 * 60 * 1000,
    })),
  });

  const rows: Row[] = useMemo(
    () =>
      tenders.map((t, i) => {
        const q = analyses[i];
        const a = q?.data;
        const lhuta = a?.terminy?.lhuta_nabidek ?? null;
        return {
          id: t.id,
          stage: effectiveStage({ status: t.status, steps: t.steps }),
          nazev: a?.zakazka?.nazev || t.name || t.tenderId || t.id,
          evidence: a?.zakazka?.evidencni_cislo || t.tenderId || t.id,
          zadavatel: a?.zakazka?.zadavatel?.nazev || '',
          ico: a?.zakazka?.zadavatel?.ico || '',
          hodnota: a?.zakazka?.predpokladana_hodnota,
          lhuta,
          decision: normalizeDecision(a?.doporuceni?.rozhodnuti),
          days: deadlineDays(lhuta),
        };
      }),
    [tenders, analyses],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q) {
        const hay = `${r.nazev} ${r.zadavatel} ${r.ico} ${r.evidence} ${r.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (decision && r.decision !== decision) return false;
      switch (view) {
        case 'Přiřazeno mně':
          return false; // řešitel zatím není napojen → poctivě prázdné
        case 'Blížící se lhůty':
          if (r.days == null || r.days < 0 || r.days > 7) return false;
          break;
        case 'GO rozhodnuto':
          if (r.decision !== 'GO') return false;
          break;
        case 'Vyhráno letos':
          if (r.stage !== 'vyhrano') return false; // stav „vyhráno" zatím není dosažitelný → prázdné
          break;
        default:
          break;
      }
      return true;
    });
  }, [rows, query, decision, view]);

  const hasFilters = query.trim() !== '' || view !== 'Všechny' || decision !== '' || region !== 'Všechny kraje';
  const resetFilters = () => {
    setQuery('');
    setView('Všechny');
    setRegion('Všechny kraje');
    setDecision('');
  };

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
        <Button variant="primary" iconLeft={<Plus size={15} />} onClick={() => { /* TODO: ruční import zakázky */ }}>
          Ruční import
        </Button>
      </div>

      {/* Uložená zobrazení (saved views) */}
      <div className="vz-scroll" style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-default)', overflowX: 'auto', marginTop: 16 }}>
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
        <div style={{ width: 180 }}>
          <Select value={region} onChange={(e) => setRegion(e.target.value)} options={REGIONS} />
        </div>
        <div style={{ width: 190 }}>
          <Select value={decision} onChange={(e) => setDecision(e.target.value)} options={DECISION_OPTIONS} />
        </div>
        <Button variant="ghost" iconLeft={<SlidersHorizontal size={15} />} onClick={() => { /* TODO: rozšířené filtry */ }}>
          Více filtrů
        </Button>
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
              <span style={{ display: 'flex' }}>
                <Checkbox checked={false} disabled />
              </span>
              {HEAD.slice(1).map((h) => (
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
              filtered.map((r) => <TableRow key={r.id} row={r} onOpen={onOpen} />)
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

function TableRow({ row, onOpen }: { row: Row; onOpen?: (id: string) => void }) {
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
      {/* Checkbox (vizuální) */}
      <span style={{ display: 'flex' }} onClick={(e) => e.stopPropagation()}>
        <Checkbox checked={false} onChange={() => { /* výběr řádků: TODO */ }} />
      </span>

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

      {/* Skóre — zdroj relevance zatím neexistuje */}
      <div>{dash}</div>

      {/* Řeší — přiřazení zatím neexistuje */}
      <div>{dash}</div>
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
          <Bar w={16} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 0' }}>
            <Bar w="70%" />
            <Bar w="40%" h={8} />
          </div>
          <Bar w="60%" />
          <div style={{ justifySelf: 'end', width: '50%' }}><Bar w="100%" /></div>
          <Bar w="55%" />
          <Bar w={80} h={18} />
          <Bar w={28} />
          <Bar w={28} />
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
