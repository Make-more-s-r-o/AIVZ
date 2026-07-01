import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Sparkles,
  ChevronDown,
  ListChecks,
  History,
  MessageSquare,
  CalendarClock,
  ArrowLeftRight,
  UserPlus,
  Plus,
  Trash2,
} from 'lucide-react';
import {
  getTenderStatus,
  getTenders,
  getAnalysis,
  getValidation,
  setTenderStatus,
  setTenderAssignee,
  getActivity,
  getUsers,
  getTasks,
  createTask,
  updateTask,
  deleteTask,
  seedChecklist,
  getTerminy,
  createTermin,
  deleteTermin,
  seedTerminy,
  getComments,
  createComment,
  deleteComment,
  type PipelineSteps,
  type ActivityEntry,
  type Task,
  type TaskStav,
  type TaskPriorita,
  type CreateTaskInput,
  type Termin,
  type Comment,
} from '../lib/api';
import { getStoredUser } from '../lib/auth';
import { effectiveStage, stepperCurrent, normalizeDecision } from '../lib/crm-adapters';
import { allowedNextStages } from '../lib/stage-machine';
import { STAGE_LABELS, type StageKey } from '../lib/stages';
import { fmtCZK } from '../lib/format';
import type { TenderAnalysis } from '../types/tender';
import {
  StageBadge,
  DecisionPill,
  DeadlineCountdown,
  StageStepper,
} from '../components/crm';
import { Button, Card, Tabs, Badge, Avatar, Select, Checkbox, Input, useToast, type SelectOption, type BadgeTone } from '../components/ui';
import AnalysisView from '../components/AnalysisView';
import ProductMatchView from '../components/ProductMatchView';
import DocumentList from '../components/DocumentList';
import PipelineStatus from '../components/PipelineStatus';

export interface TenderDetailPageProps {
  tenderId: string;
  initialTab?: string;
  onBack: () => void;
}

const EMPTY_STEPS: PipelineSteps = {
  extract: 'pending',
  analyze: 'pending',
  match: 'pending',
  generate: 'pending',
  validate: 'pending',
};

const TABS = [
  { value: 'prehled', label: 'Přehled' },
  { value: 'analyza', label: 'Analýza' },
  { value: 'oceneni', label: 'Ocenění' },
  { value: 'dokumenty', label: 'Dokumenty' },
  { value: 'ukoly', label: 'Úkoly' },
  { value: 'terminy', label: 'Termíny' },
  { value: 'historie', label: 'Historie' },
  { value: 'komentare', label: 'Komentáře' },
] as const;

const TAB_VALUES = new Set<string>(TABS.map((t) => t.value));

/**
 * Detail zakázky — CRM přepracování. Hlavička se stavovým odznakem, GO/NOGO
 * branou a krokovacím procesem; vlevo záložky (Přehled · Analýza · Ocenění ·
 * Dokumenty · Úkoly · Termíny · Historie · Komentáře), vpravo metadatová lišta.
 * Záložky Analýza/Ocenění/Dokumenty znovupoužívají stávající komponenty.
 */
export default function TenderDetailPage({ tenderId, initialTab, onBack }: TenderDetailPageProps) {
  const [tab, setTab] = useState<string>(initialTab && TAB_VALUES.has(initialTab) ? initialTab : 'prehled');
  // Deep-link na záložku (zvonek notifikace #/tender/<id>?tab=komentare): když se initialTab změní
  // za běhu (klik na notifikaci u již otevřené zakázky), přepni na cílovou záložku. Manuální přepnutí
  // tabů hash nemění → initialTab zůstává → efekt nepřebíjí volbu uživatele.
  useEffect(() => {
    if (initialTab && TAB_VALUES.has(initialTab)) setTab(initialTab);
  }, [initialTab]);
  // Rozbalovací lišta „Zpracování" nad záložkami — spouštění kroků pipeline.
  const [pipelineOpen, setPipelineOpen] = useState(true);
  const qc = useQueryClient();

  // Manuální přepnutí záložky promítni do hashe (bez zahlcení historie) a uvědom router, aby
  // App.route.tab zůstal v souladu s viditelnou záložkou. Bez toho by deep-link ze zvonku na tutéž
  // zakázku po ručním přepnutí záložky nevyvolal hashchange (shodný hash) → „mrtvý klik".
  function selectTab(next: string) {
    setTab(next);
    const target = next === 'prehled' ? `#/tender/${tenderId}` : `#/tender/${tenderId}?tab=${next}`;
    try {
      if (window.location.hash !== target) {
        window.history.replaceState(null, '', target);
        window.dispatchEvent(new Event('hashchange'));
      }
    } catch {}
  }

  // Po dokončení kroku pipeline obnovíme stav i všechny odvozené záložky.
  function handleStepComplete() {
    const keys: string[][] = [
      ['tender-status', tenderId],
      ['analysis', tenderId],
      ['parts', tenderId],
      ['product-match', tenderId],
      ['documents', tenderId],
      ['attachments', tenderId],
      ['generation-meta', tenderId],
      ['field-validation', tenderId],
      ['validation', tenderId],
      ['cost', tenderId],
      ['tenders'],
    ];
    for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
  }

  // Stav pipeline — refetch během běhu kroku.
  const { data: statusData } = useQuery({
    queryKey: ['tender-status', tenderId],
    queryFn: () => getTenderStatus(tenderId),
    refetchInterval: (query) => {
      const s = query.state.data?.steps;
      return s && Object.values(s).some((v) => v === 'running') ? 3000 : false;
    },
  });
  const steps: PipelineSteps = statusData?.steps ?? EMPTY_STEPS;

  // Efektivní lifecycle fáze: persistovaný stav má přednost, jinak odvození z pipeline.
  const currentStage: StageKey = statusData?.effectiveStatus ?? effectiveStage({ status: statusData?.status, steps });
  // Povolené cílové fáze pro „Změnit stav" (backend je stejně znovu ověří, případně vrátí 409).
  const allowedNext: StageKey[] = statusData?.allowedNext ?? allowedNextStages(currentStage, steps);

  // Seznam zakázek pro název + vstupní soubory (zdroj).
  const { data: tenders } = useQuery({ queryKey: ['tenders'], queryFn: getTenders, staleTime: 30000 });
  const summary = tenders?.find((t) => t.id === tenderId);

  // Analýza — nemusí ještě existovat (404), proto retry:false.
  const { data: analysis } = useQuery({
    queryKey: ['analysis', tenderId],
    queryFn: () => getAnalysis(tenderId),
    retry: false,
    enabled: steps.analyze === 'done',
  });

  // Validace — pro indikátor „Připraveno k podání".
  const { data: validation } = useQuery({
    queryKey: ['validation', tenderId],
    queryFn: () => getValidation(tenderId),
    retry: false,
    enabled: steps.validate === 'done',
  });

  const decision = normalizeDecision(analysis?.doporuceni?.rozhodnuti);
  const nazev = analysis?.zakazka?.nazev || summary?.name || tenderId;
  const evidence = analysis?.zakazka?.evidencni_cislo || tenderId;

  // Zdroj — odvozeno z přípon vstupních souborů (jediný dostupný „původ" dat).
  const sourceFormats = Array.from(
    new Set(
      (summary?.inputFiles ?? [])
        .map((f) => f.split('.').pop()?.toUpperCase())
        .filter((ext): ext is string => !!ext),
    ),
  );

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <button
        onClick={onBack}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none',
          cursor: 'pointer', color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)',
          fontSize: 'var(--font-size-sm)', marginBottom: 14, padding: 0,
        }}
      >
        <ArrowLeft size={15} /> Zpět na zakázky
      </button>

      {/* Hlavička */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <StageBadge status={currentStage} />
            {decision && (
              <Badge tone={decision === 'GO' ? 'success' : decision === 'NOGO' ? 'danger' : 'warning'}>
                {decision === 'ZVAZIT' ? 'ZVÁŽIT' : decision}
              </Badge>
            )}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
              {evidence}
            </span>
          </div>
          <h1 style={{ margin: '8px 0 0', fontSize: 'var(--font-size-2xl)', fontWeight: 'var(--weight-bold)', color: 'var(--text-primary)', lineHeight: 1.25 }}>
            {nazev}
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <Button variant="secondary" iconLeft={<Sparkles size={16} />} onClick={() => setTab('analyza')}>
            Analyzovat
          </Button>
          <StatusChangeButton tenderId={tenderId} allowedNext={allowedNext} />
        </div>
      </div>

      {/* Krokovací proces */}
      <Card padding={20} style={{ marginTop: 16 }}>
        <StageStepper current={stepperCurrent(steps)} />
      </Card>

      {/* Zpracování — spuštění kroků pipeline (extrakce → analýza → produkty → dokumenty → validace) */}
      <Card
        title="Zpracování zakázky"
        padding={pipelineOpen ? 20 : 0}
        style={{ marginTop: 16 }}
        action={
          <Button
            variant="ghost"
            size="sm"
            iconRight={
              <ChevronDown
                size={16}
                style={{ transform: pipelineOpen ? 'rotate(180deg)' : undefined, transition: 'transform 120ms' }}
              />
            }
            onClick={() => setPipelineOpen((o) => !o)}
          >
            {pipelineOpen ? 'Skrýt' : 'Spustit kroky'}
          </Button>
        }
      >
        {pipelineOpen && (
          <PipelineStatus tenderId={tenderId} steps={steps} onStepComplete={handleStepComplete} />
        )}
      </Card>

      {/* Tělo: obsah + metadatová lišta */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20, marginTop: 20, alignItems: 'start' }}>
        <div style={{ minWidth: 0 }}>
          <Tabs tabs={[...TABS]} value={tab} onChange={selectTab} />
          <div style={{ marginTop: 16 }}>
            {tab === 'prehled' && <PrehledTab analysis={analysis} decision={decision} />}
            {tab === 'analyza' && <AnalysisView tenderId={tenderId} />}
            {tab === 'oceneni' && <ProductMatchView tenderId={tenderId} />}
            {tab === 'dokumenty' && <DocumentList tenderId={tenderId} />}
            {tab === 'ukoly' && <UkolyTab tenderId={tenderId} />}
            {tab === 'terminy' && <TerminyTab tenderId={tenderId} />}
            {tab === 'historie' && <HistorieTab tenderId={tenderId} />}
            {tab === 'komentare' && <CommentsTab tenderId={tenderId} />}
          </div>
        </div>

        <MetadataRail
          analysis={analysis}
          sourceFormats={sourceFormats}
          ready={validation?.ready_to_submit ?? null}
          score={validation?.overall_score ?? null}
          tenderId={tenderId}
          assignee={statusData?.assignee ?? null}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PrehledTab({ analysis, decision }: { analysis: TenderAnalysis | undefined; decision: ReturnType<typeof normalizeDecision> }) {
  if (!analysis) {
    return (
      <EmptyState
        icon={<Sparkles size={28} />}
        title="Analýza zatím neproběhla"
        hint="Spusťte AI analýzu zadávací dokumentace v sekci Pipeline."
      />
    );
  }
  const z = analysis.zakazka;
  const kriteria = analysis.hodnotici_kriteria ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {decision && (
        <DecisionPill decision={decision} reason={analysis.doporuceni?.oduvodneni} />
      )}

      <Card title="Základní údaje">
        <InfoRow label="Předmět" value={z.predmet} />
        <InfoRow label="Zadavatel" value={z.zadavatel?.nazev} />
        <InfoRow label="IČO" value={z.zadavatel?.ico} mono />
        <InfoRow label="Typ zakázky" value={z.typ_zakazky} />
        <InfoRow label="Předpokládaná hodnota" value={z.predpokladana_hodnota != null ? fmtCZK(z.predpokladana_hodnota) : null} tnum />
        <InfoRow label="Typ řízení" value={z.typ_rizeni} />
      </Card>

      <Card title="Hodnotící kritéria">
        {kriteria.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>Zatím bez hodnotících kritérií.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {kriteria.map((k, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={{
                  flexShrink: 0, minWidth: 48, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  padding: '0 8px', borderRadius: 'var(--radius-md)', background: 'var(--accent-soft-bg)',
                  color: 'var(--accent-soft-fg)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-bold)',
                  fontVariantNumeric: 'tabular-nums',
                }}>
                  {k.vaha_procent} %
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-medium)', color: 'var(--text-primary)' }}>{k.nazev}</div>
                  {k.popis && <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>{k.popis}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

const TERMIN_LABEL: Record<Termin['typ'], string> = {
  lhuta_nabidek: 'Lhůta pro nabídky',
  otevirani_obalek: 'Otevírání obálek',
  doba_plneni: 'Doba plnění',
  prohlidka: 'Prohlídka místa',
  vlastni: 'Vlastní',
};

const TERMIN_OPTIONS: SelectOption[] = [
  { value: 'lhuta_nabidek', label: 'Lhůta pro nabídky' },
  { value: 'otevirani_obalek', label: 'Otevírání obálek' },
  { value: 'doba_plneni', label: 'Doba plnění' },
  { value: 'prohlidka', label: 'Prohlídka místa' },
  { value: 'vlastni', label: 'Vlastní' },
];

const PRIPOMINKA_OPTIONS: SelectOption[] = [
  { value: '', label: 'Bez připomínky' },
  { value: '1', label: '1 den předem' },
  { value: '3', label: '3 dny předem' },
  { value: '7', label: '7 dní předem' },
];

/** Český tvar „X dní/dny/den" pro připomínku. */
function dayLabel(n: number): string {
  if (n === 1) return 'den';
  if (n >= 2 && n <= 4) return 'dny';
  return 'dní';
}

/**
 * Záložka Termíny — persistované lhůty zakázky (M6). Tlačítko „Načíst z analýzy"
 * naseeduje termíny z analysis.terminy (idempotentně), inline formulář přidává
 * ruční termíny. Změny invalidují i kalendář. Řádek: typ · datum · popis ·
 * připomínka · smazání.
 */
function TerminyTab({ tenderId }: { tenderId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: terminy = [] } = useQuery({ queryKey: ['terminy', tenderId], queryFn: () => getTerminy(tenderId) });

  const [seeding, setSeeding] = useState(false);
  const [adding, setAdding] = useState(false);
  const [typ, setTyp] = useState<Termin['typ']>('lhuta_nabidek');
  const [datum, setDatum] = useState('');
  const [popis, setPopis] = useState('');
  const [pripominka, setPripominka] = useState('');

  const invalidate = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['terminy', tenderId] }),
    qc.invalidateQueries({ queryKey: ['calendar'] }),
  ]);

  // Řazení vzestupně dle data ('YYYY-MM-DD' → string compare); bez data na konec.
  const sorted = [...terminy].sort((a, b) => (a.datum ?? '9999-99-99').localeCompare(b.datum ?? '9999-99-99'));

  async function handleSeed() {
    if (seeding) return;
    setSeeding(true);
    try {
      const r = await seedTerminy(tenderId);
      await invalidate();
      toast(r.seeded > 0 ? `Načteno ${r.seeded} termínů` : 'Termíny jsou aktuální', 'success');
    } catch (e) {
      toast(statusErrorMessage(e), 'danger');
    } finally {
      setSeeding(false);
    }
  }

  async function handleAdd() {
    if (!datum || adding) return;
    setAdding(true);
    try {
      await createTermin(tenderId, {
        typ,
        datum,
        popis: popis.trim() || null,
        pripominka: pripominka ? Number(pripominka) : null,
      });
      await invalidate();
      setTyp('lhuta_nabidek');
      setDatum('');
      setPopis('');
      setPripominka('');
      toast('Termín přidán', 'success');
    } catch (e) {
      toast(statusErrorMessage(e), 'danger');
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(t: Termin) {
    try {
      await deleteTermin(t.id);
      await invalidate();
      toast('Termín smazán', 'success');
    } catch (e) {
      toast(statusErrorMessage(e), 'danger');
    }
  }

  function renderRow(t: Termin) {
    return (
      <div
        key={t.id}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}
      >
        <Badge tone="outline" size="sm">{TERMIN_LABEL[t.typ]}</Badge>
        <span style={{
          flexShrink: 0, fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)',
          color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
        }}>
          {t.datum ? new Date(t.datum + 'T00:00:00').toLocaleDateString('cs-CZ') : '—'}{t.cas ? ` · ${t.cas}` : ''}
        </span>
        <span
          title={t.popis ?? undefined}
          style={{
            flex: 1, minWidth: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {t.popis ?? ''}
        </span>
        {t.pripominka != null && (
          <span style={{ flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
            připomínka {t.pripominka} {dayLabel(t.pripominka)} předem
          </span>
        )}
        <Button variant="ghost" size="sm" onClick={() => void handleDelete(t)} title="Smazat termín">
          <Trash2 size={14} />
        </Button>
      </div>
    );
  }

  return (
    <Card
      title="Termíny"
      action={
        <Button
          variant="secondary"
          size="sm"
          iconLeft={<Sparkles size={14} />}
          onClick={() => void handleSeed()}
          disabled={seeding}
        >
          Načíst z analýzy
        </Button>
      }
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: sorted.length > 0 ? 12 : 4 }}>
        <div style={{ width: 170 }}>
          <Select
            size="sm"
            value={typ}
            options={TERMIN_OPTIONS}
            onChange={(e) => setTyp(e.target.value as Termin['typ'])}
          />
        </div>
        <div style={{ width: 150 }}>
          <Input type="date" value={datum} onChange={(e) => setDatum(e.target.value)} size="sm" />
        </div>
        <div style={{ flex: '1 1 180px', minWidth: 150 }}>
          <Input
            value={popis}
            onChange={(e) => setPopis(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd(); } }}
            placeholder="Popis (nepovinné)…"
            size="sm"
          />
        </div>
        <div style={{ width: 150 }}>
          <Select
            size="sm"
            value={pripominka}
            options={PRIPOMINKA_OPTIONS}
            onChange={(e) => setPripominka(e.target.value)}
          />
        </div>
        <Button size="sm" iconLeft={<Plus size={14} />} onClick={() => void handleAdd()} disabled={!datum || adding}>
          Přidat
        </Button>
      </div>

      {sorted.length === 0 ? (
        <EmptyState
          icon={<CalendarClock size={28} />}
          title="Zatím žádné termíny"
          hint="Načtěte je z analýzy nebo přidejte ručně."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {sorted.map(renderRow)}
        </div>
      )}
    </Card>
  );
}

function MetadataRail({
  analysis, sourceFormats, ready, score, tenderId, assignee,
}: {
  analysis: TenderAnalysis | undefined;
  sourceFormats: string[];
  ready: boolean | null;
  score: number | null;
  tenderId: string;
  assignee: string | null;
}) {
  const z = analysis?.zakazka;
  const lhuta = analysis?.terminy?.lhuta_nabidek ?? null;

  return (
    <Card title="Metadata" style={{ position: 'sticky', top: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <RailField label="Lhůta">
          <DeadlineCountdown date={lhuta} size="md" />
        </RailField>

        <RailField label="Předpokládaná hodnota">
          <span className="tnum" style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
            {z?.predpokladana_hodnota != null ? fmtCZK(z.predpokladana_hodnota) : '—'}
          </span>
        </RailField>

        <RailField label="Zadavatel">
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)' }}>{z?.zadavatel?.nazev || '—'}</span>
          {z?.zadavatel?.ico && (
            <span style={{ display: 'block', marginTop: 2, fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
              IČO {z.zadavatel.ico}
            </span>
          )}
        </RailField>

        <RailField label="Region">
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>—</span>
        </RailField>

        <RailField label="Zdroj">
          {sourceFormats.length === 0 ? (
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>—</span>
          ) : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {sourceFormats.map((f) => (
                <Badge key={f} tone="outline" size="sm">{f}</Badge>
              ))}
            </div>
          )}
        </RailField>

        <RailField label="Připraveno k podání">
          {ready == null ? (
            <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>—</span>
          ) : (
            <Badge tone={ready ? 'success' : 'warning'} size="sm">
              {ready ? 'Ano' : 'Ne'}{score != null ? ` · ${score}/10` : ''}
            </Badge>
          )}
        </RailField>

        <RailField label="Řešitel">
          <AssigneePicker tenderId={tenderId} assignee={assignee} />
        </RailField>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function RailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--weight-semibold)', textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--text-tertiary)', marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function InfoRow({ label, value, mono, tnum }: { label: string; value?: string | null; mono?: boolean; tnum?: boolean }) {
  if (!value) return null;
  return (
    <div style={{ display: 'flex', gap: 12, padding: '6px 0', fontSize: 'var(--font-size-sm)', borderBottom: '1px solid var(--border-default)' }}>
      <span style={{ width: 180, flexShrink: 0, color: 'var(--text-secondary)' }}>{label}</span>
      <span
        className={tnum ? 'tnum' : undefined}
        style={{ color: 'var(--text-primary)', fontFamily: mono ? 'var(--font-mono)' : undefined, minWidth: 0 }}
      >
        {value}
      </span>
    </div>
  );
}

function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint?: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center',
      padding: '48px 24px', border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-lg)',
      background: 'var(--surface-sunken)',
    }}>
      <div style={{ color: 'var(--text-tertiary)', marginBottom: 10 }}>{icon}</div>
      <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-secondary)' }}>{title}</div>
      {hint && <div style={{ marginTop: 4, fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', maxWidth: 320 }}>{hint}</div>}
    </div>
  );
}

// --- M2 interakce: změna stavu, přiřazení řešitele, historie aktivity -------

/** Společná hláška pro selhání persistované akce (DB nedostupná → 503, jinak guard důvod). */
function statusErrorMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : 'Chyba';
  return m === 'db_unavailable'
    ? 'Perzistence stavu vyžaduje databázi (běží jen na hlavním serveru).'
    : m;
}

/** Bezpečné čtení textového pole z volného payloadu aktivity. */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

const menuSurfaceStyle: CSSProperties = {
  position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 60, minWidth: 224,
  padding: '6px 0', background: 'var(--surface-card)', border: '1px solid var(--border-default)',
  borderRadius: 'var(--radius-lg)', boxShadow: 'var(--shadow-lg)',
};

function StageMenuItem({ stage, onSelect }: { stage: StageKey; onSelect: (s: StageKey) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      type="button"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onSelect(stage)}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, width: '100%', textAlign: 'left',
        padding: '7px 12px', border: 'none', cursor: 'pointer', fontFamily: 'var(--font-sans)',
        fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)',
        background: hover ? 'var(--surface-hover)' : 'transparent',
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: `var(--stage-${stage}-dot)`, flexShrink: 0 }} />
      {STAGE_LABELS[stage]}
    </button>
  );
}

/**
 * Tlačítko „Změnit stav" — dropdown povolených cílových fází. Volba „Nepodáno"
 * otevře popover s povinným důvodem. Po úspěchu invaliduje stav + seznam + historii.
 */
function StatusChangeButton({ tenderId, allowedNext }: { tenderId: string; allowedNext: StageKey[] }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open && !reasonOpen) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setReasonOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open, reasonOpen]);

  async function invalidate() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['tender-status', tenderId] }),
      qc.invalidateQueries({ queryKey: ['tenders'] }),
      qc.invalidateQueries({ queryKey: ['activity', tenderId] }),
    ]);
  }

  async function apply(stage: StageKey, reasonText?: string) {
    setBusy(true);
    try {
      await setTenderStatus(tenderId, stage, reasonText);
      await invalidate();
      toast(`Stav změněn na ${STAGE_LABELS[stage]}`, 'success');
      setOpen(false);
      setReasonOpen(false);
      setReason('');
    } catch (e) {
      toast(statusErrorMessage(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  function handleSelect(stage: StageKey) {
    if (stage === 'nepodano') {
      setOpen(false);
      setReasonOpen(true);
    } else {
      void apply(stage);
    }
  }

  const disabled = allowedNext.length === 0;

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <Button
        variant="primary"
        iconRight={<ChevronDown size={16} />}
        disabled={disabled}
        title={disabled ? 'Žádné dostupné přechody' : 'Změnit stav zakázky'}
        onClick={() => { setReasonOpen(false); setOpen((o) => !o); }}
      >
        Změnit stav
      </Button>

      {open && !disabled && (
        <div style={menuSurfaceStyle} role="menu">
          {allowedNext.map((s) => (
            <StageMenuItem key={s} stage={s} onSelect={handleSelect} />
          ))}
        </div>
      )}

      {reasonOpen && (
        <div style={{ ...menuSurfaceStyle, width: 288, padding: 14 }}>
          <div style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', marginBottom: 8 }}>
            Důvod nepodání
          </div>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Uveďte důvod, proč zakázka nebude podána…"
            style={{
              width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: '8px 10px',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)',
              background: 'var(--surface-card)', border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)', outline: 'none',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <Button variant="secondary" size="sm" onClick={() => { setReasonOpen(false); setReason(''); }}>
              Zrušit
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || reason.trim().length === 0}
              onClick={() => void apply('nepodano', reason.trim())}
            >
              Označit jako nepodané
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Výběr řešitele v metadatové liště — Avatar+jméno + Select (vč. „Nepřiřazeno"). */
function AssigneePicker({ tenderId, assignee }: { tenderId: string; assignee: string | null }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: getUsers, staleTime: 60000 });
  const [busy, setBusy] = useState(false);
  const current = users?.find((u) => u.id === assignee) ?? null;

  async function change(userId: string | null) {
    setBusy(true);
    try {
      await setTenderAssignee(tenderId, userId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['tender-status', tenderId] }),
        qc.invalidateQueries({ queryKey: ['tenders'] }),
        qc.invalidateQueries({ queryKey: ['activity', tenderId] }),
      ]);
      toast('Řešitel upraven', 'success');
    } catch (e) {
      toast(statusErrorMessage(e), 'danger');
    } finally {
      setBusy(false);
    }
  }

  const options: SelectOption[] = [
    { value: '', label: 'Nepřiřazeno' },
    ...(users ?? []).map((u) => ({ value: u.id, label: u.name || u.email })),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {current ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <Avatar name={current.name || current.email} size={24} />
          <span style={{
            fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {current.name || current.email}
          </span>
        </div>
      ) : (
        <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>Nepřiřazeno</span>
      )}
      <Select
        size="sm"
        value={assignee ?? ''}
        options={options}
        disabled={busy}
        onChange={(e) => void change(e.target.value || null)}
      />
    </div>
  );
}

const activityIconTileStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  width: 30, height: 30, borderRadius: 'var(--radius-md)', background: 'var(--surface-sunken)',
  color: 'var(--text-tertiary)',
};

/** Relativní čas: „před X min/h", „včera", jinak absolutní datum (cs-CZ). */
function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'právě teď';
  if (min < 60) return `před ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `před ${h} h`;
  const d = new Date(iso);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startThen = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (Math.round((startToday - startThen) / 86400000) === 1) return 'včera';
  return d.toLocaleDateString('cs-CZ');
}

function ActivityRow({ entry, userName }: { entry: ActivityEntry; userName: (id: string | undefined) => string }) {
  const p = entry.payload ?? {};
  const actor = asString(p.actor_name) ?? 'Systém';

  let Icon = History;
  let action: ReactNode = entry.type;

  if (entry.type === 'status_change') {
    Icon = ArrowLeftRight;
    const newKey = asString(p.new);
    const label = newKey && newKey in STAGE_LABELS ? STAGE_LABELS[newKey as StageKey] : (newKey ?? '—');
    const reasonText = asString(p.reason);
    action = (
      <>
        změnil(a) stav na{' '}
        <strong style={{ color: 'var(--text-primary)', fontWeight: 'var(--weight-semibold)' }}>{label}</strong>
        {reasonText ? ` — ${reasonText}` : ''}
      </>
    );
  } else if (entry.type === 'assignment') {
    Icon = UserPlus;
    const assigneeId = asString(p.assignee);
    action = assigneeId ? `přiřadil(a) řešitele ${userName(assigneeId)}` : 'odebral(a) řešitele';
  }

  return (
    <div style={{ display: 'flex', gap: 10, padding: '10px 8px', alignItems: 'flex-start' }}>
      <span style={activityIconTileStyle}>
        <Icon size={15} />
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          <strong style={{ color: 'var(--text-primary)', fontWeight: 'var(--weight-semibold)' }}>{actor}</strong>{' '}{action}
        </div>
        <div
          title={new Date(entry.created_at).toLocaleString('cs-CZ')}
          style={{ marginTop: 2, fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}
        >
          {relativeTime(entry.created_at)}
        </div>
      </div>
    </div>
  );
}

/** Záložka Historie — reálná aktivita (změny stavu, přiřazení) seřazená od nejnovější. */
function HistorieTab({ tenderId }: { tenderId: string }) {
  const { data: activity } = useQuery({ queryKey: ['activity', tenderId], queryFn: () => getActivity(tenderId) });
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: getUsers, staleTime: 60000 });

  const entries = [...(activity ?? [])].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );

  function userName(id: string | undefined): string {
    if (!id) return '';
    const u = users?.find((x) => x.id === id);
    return u?.name || u?.email || id;
  }

  if (entries.length === 0) {
    return <EmptyState icon={<History size={28} />} title="Zatím žádná aktivita." />;
  }

  return (
    <Card padding={8}>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {entries.map((e) => (
          <ActivityRow key={e.id} entry={e} userName={userName} />
        ))}
      </div>
    </Card>
  );
}

// --- M3 záložka: Úkoly + checklist kvalifikace -----------------------------

const STAV_LABEL: Record<TaskStav, string> = {
  k_vyrizeni: 'K vyřízení',
  probiha: 'Probíhá',
  hotovo: 'Hotovo',
  blokovano: 'Blokováno',
};
const STAV_TONE: Record<TaskStav, BadgeTone> = {
  k_vyrizeni: 'outline',
  probiha: 'primary',
  hotovo: 'success',
  blokovano: 'danger',
};
const PRIORITA_LABEL: Record<TaskPriorita, string> = {
  nizka: 'Nízká',
  stredni: 'Střední',
  vysoka: 'Vysoká',
};
const PRIORITA_TONE: Record<TaskPriorita, BadgeTone> = {
  nizka: 'neutral',
  stredni: 'warning',
  vysoka: 'danger',
};

const PRIORITA_OPTIONS: SelectOption[] = [
  { value: 'nizka', label: 'Nízká' },
  { value: 'stredni', label: 'Střední' },
  { value: 'vysoka', label: 'Vysoká' },
];

/**
 * Záložka Úkoly — dvě karty: auto-seedovaný „Checklist kvalifikace" (z kvalifikačních
 * požadavků analýzy) a volné „Úkoly" s inline přidávacím formulářem. Řádek úkolu je
 * sdílený mezi oběma kartami (checkbox hotovo, priorita/stav odznak, termín, řešitel, smazání).
 */
function UkolyTab({ tenderId }: { tenderId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const { data: tasks = [] } = useQuery({ queryKey: ['tasks', tenderId], queryFn: () => getTasks(tenderId) });
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: getUsers, retry: false, staleTime: 60_000 });
  const usersMap = new Map(users.map((u): [string, string] => [u.id, u.name || u.email]));

  const [seeding, setSeeding] = useState(false);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const [priorita, setPriorita] = useState<TaskPriorita>('stredni');

  const invalidate = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['tasks', tenderId] }),
    qc.invalidateQueries({ queryKey: ['tenders'] }),
    qc.invalidateQueries({ queryKey: ['my-tasks'] }),
    qc.invalidateQueries({ queryKey: ['activity', tenderId] }),
  ]);

  const checklist = tasks.filter((t) => t.je_checklist);
  const ukoly = tasks.filter((t) => !t.je_checklist);

  async function handleSeed() {
    if (seeding) return;
    setSeeding(true);
    try {
      const r = await seedChecklist(tenderId);
      await invalidate();
      toast(r.seeded > 0 ? `Checklist vygenerován (${r.seeded} položek)` : 'Checklist je aktuální — nic nového', 'success');
    } catch (e) {
      toast(statusErrorMessage(e), 'danger');
    } finally {
      setSeeding(false);
    }
  }

  async function handleAdd() {
    const t = title.trim();
    if (!t || adding) return;
    setAdding(true);
    try {
      const input: CreateTaskInput = { title: t, assignee: assignee || null, due_date: due || null, priorita };
      await createTask(tenderId, input);
      await invalidate();
      setTitle('');
      setAssignee('');
      setDue('');
      setPriorita('stredni');
      toast('Úkol přidán', 'success');
    } catch (e) {
      toast(statusErrorMessage(e), 'danger');
    } finally {
      setAdding(false);
    }
  }

  async function handleToggle(t: Task, checked: boolean) {
    try {
      await updateTask(t.id, { stav: checked ? 'hotovo' : 'k_vyrizeni' });
      await invalidate();
    } catch (e) {
      toast(statusErrorMessage(e), 'danger');
    }
  }

  async function handleDelete(t: Task) {
    try {
      await deleteTask(t.id);
      await invalidate();
      toast('Úkol smazán', 'success');
    } catch (e) {
      toast(statusErrorMessage(e), 'danger');
    }
  }

  function renderRow(t: Task) {
    const done = t.stav === 'hotovo';
    return (
      <div
        key={t.id}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}
      >
        <Checkbox checked={done} onChange={(c) => void handleToggle(t, c)} />
        <span
          title={t.title}
          style={{
            flex: 1, minWidth: 0, fontSize: 'var(--font-size-sm)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            textDecoration: done ? 'line-through' : 'none',
            color: done ? 'var(--text-tertiary)' : 'var(--text-primary)',
          }}
        >
          {t.title}
        </span>
        <Badge tone={PRIORITA_TONE[t.priorita]} size="sm">{PRIORITA_LABEL[t.priorita]}</Badge>
        {!done && <Badge tone={STAV_TONE[t.stav]} size="sm">{STAV_LABEL[t.stav]}</Badge>}
        {t.due_date && (
          <span style={{ flexShrink: 0, fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
            {new Date(t.due_date).toLocaleDateString('cs-CZ')}
          </span>
        )}
        {t.assignee && <Avatar name={usersMap.get(t.assignee) ?? t.assignee} size={22} />}
        <Button variant="ghost" size="sm" onClick={() => void handleDelete(t)} title="Smazat úkol">
          <Trash2 size={14} />
        </Button>
      </div>
    );
  }

  const assigneeOptions: SelectOption[] = [
    { value: '', label: 'Nepřiřazeno' },
    ...users.map((u) => ({ value: u.id, label: u.name || u.email })),
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card
        title="Checklist kvalifikace"
        action={
          <Button
            variant="secondary"
            size="sm"
            iconLeft={<Sparkles size={14} />}
            onClick={() => void handleSeed()}
            disabled={seeding}
          >
            Vygenerovat checklist z analýzy
          </Button>
        }
      >
        {checklist.length === 0 ? (
          <EmptyState
            icon={<ListChecks size={28} />}
            title="Zatím žádný checklist"
            hint="Vygenerujte jej z kvalifikačních požadavků analýzy."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {checklist.map(renderRow)}
          </div>
        )}
      </Card>

      <Card title="Úkoly">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: ukoly.length > 0 ? 12 : 4 }}>
          <div style={{ flex: '1 1 200px', minWidth: 160 }}>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd(); } }}
              placeholder="Nový úkol…"
              size="sm"
            />
          </div>
          <div style={{ width: 150 }}>
            <Select
              size="sm"
              value={assignee}
              options={assigneeOptions}
              onChange={(e) => setAssignee(e.target.value)}
            />
          </div>
          <div style={{ width: 150 }}>
            <Input type="date" value={due} onChange={(e) => setDue(e.target.value)} size="sm" />
          </div>
          <div style={{ width: 130 }}>
            <Select
              size="sm"
              value={priorita}
              options={PRIORITA_OPTIONS}
              onChange={(e) => setPriorita(e.target.value as TaskPriorita)}
            />
          </div>
          <Button size="sm" iconLeft={<Plus size={14} />} onClick={() => void handleAdd()} disabled={!title.trim() || adding}>
            Přidat
          </Button>
        </div>

        {ukoly.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>
            Zatím žádné úkoly. Přidejte první pomocí formuláře výše.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {ukoly.map(renderRow)}
          </div>
        )}
      </Card>
    </div>
  );
}

function CommentsTab({ tenderId }: { tenderId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const me = getStoredUser();
  const isAdmin = me?.role === 'admin';

  const { data: comments = [] } = useQuery({ queryKey: ['comments', tenderId], queryFn: () => getComments(tenderId) });
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: getUsers, retry: false, staleTime: 60_000 });
  const usersMap = new Map(users.map((u): [string, string] => [u.id, u.name || u.email]));

  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const invalidate = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['comments', tenderId] }),
    qc.invalidateQueries({ queryKey: ['activity', tenderId] }),
    qc.invalidateQueries({ queryKey: ['notifications'] }),
  ]);

  function toggleMention(id: string) {
    setMentions((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function handleSubmit() {
    const t = text.trim();
    if (!t || saving) return;
    setSaving(true);
    try {
      await createComment(tenderId, { text: t, mentions });
      await invalidate();
      setText('');
      setMentions([]);
      toast('Komentář přidán', 'success');
    } catch (e) {
      toast(statusErrorMessage(e), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(c: Comment) {
    try {
      await deleteComment(c.id);
      await invalidate();
      toast('Komentář smazán', 'success');
    } catch (e) {
      toast(statusErrorMessage(e), 'danger');
    }
  }

  // Uživatelé k zmínění — bez sebe sama (self-notif se stejně na backendu přeskočí).
  const mentionable = users.filter((u) => u.id !== me?.id);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card title="Nový komentář">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Napište komentář týmu…"
          rows={3}
          style={{
            width: '100%', boxSizing: 'border-box', padding: '8px 12px', resize: 'vertical', lineHeight: 1.5,
            fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)',
            background: 'var(--surface-card)', border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)', outline: 'none',
          }}
        />
        {mentionable.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', marginBottom: 6 }}>
              Zmínit (upozornit):
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {mentionable.map((u) => {
                const on = mentions.includes(u.id);
                const label = u.name || u.email;
                return (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => toggleMention(u.id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px 3px 4px', cursor: 'pointer',
                      fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-xs)', fontWeight: 'var(--weight-medium)',
                      color: on ? 'var(--accent)' : 'var(--text-secondary)',
                      background: on ? 'var(--accent-soft-bg)' : 'var(--surface-page)',
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border-default)'}`,
                      borderRadius: 'var(--radius-full)',
                    }}
                  >
                    <Avatar name={label} size={18} />
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 12 }}>
          <Button
            variant="primary"
            size="sm"
            iconLeft={<MessageSquare size={14} />}
            onClick={() => void handleSubmit()}
            disabled={saving || !text.trim()}
          >
            Přidat komentář
          </Button>
        </div>
      </Card>

      <Card title={comments.length ? `Komentáře (${comments.length})` : 'Komentáře'}>
        {comments.length === 0 ? (
          <EmptyState icon={<MessageSquare size={28} />} title="Zatím žádné komentáře" hint="Napište první komentář týmu výše." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {comments.map((c) => {
              const authorName = (c.author_id && usersMap.get(c.author_id)) || c.author_name || 'Neznámý';
              const canDelete = isAdmin || (!!me?.id && c.author_id === me.id);
              return (
                <div key={c.id} style={{ display: 'flex', gap: 10 }}>
                  <Avatar name={authorName} size={30} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)' }}>
                        {authorName}
                      </span>
                      <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
                        {relativeTime(c.created_at)}
                      </span>
                      {canDelete && (
                        <Button variant="ghost" size="sm" onClick={() => void handleDelete(c)} title="Smazat komentář" style={{ marginLeft: 'auto' }}>
                          <Trash2 size={14} />
                        </Button>
                      )}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {c.text}
                    </div>
                    {c.mentions.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                        {c.mentions.map((mid) => (
                          <Badge key={mid} tone="primary" size="sm">@{usersMap.get(mid) ?? mid}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
