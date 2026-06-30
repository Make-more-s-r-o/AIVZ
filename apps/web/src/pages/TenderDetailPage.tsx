import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowLeft,
  Sparkles,
  ChevronDown,
  ListChecks,
  History,
  MessageSquare,
  CalendarClock,
} from 'lucide-react';
import {
  getTenderStatus,
  getTenders,
  getAnalysis,
  getValidation,
  type PipelineSteps,
} from '../lib/api';
import { deriveStage, stepperCurrent, normalizeDecision } from '../lib/crm-adapters';
import { fmtCZK } from '../lib/format';
import type { TenderAnalysis } from '../types/tender';
import {
  StageBadge,
  DecisionPill,
  DeadlineCountdown,
  StageStepper,
} from '../components/crm';
import { Button, Card, Tabs, Badge } from '../components/ui';
import AnalysisView from '../components/AnalysisView';
import ProductMatchView from '../components/ProductMatchView';
import DocumentList from '../components/DocumentList';

export interface TenderDetailPageProps {
  tenderId: string;
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

/**
 * Detail zakázky — CRM přepracování. Hlavička se stavovým odznakem, GO/NOGO
 * branou a krokovacím procesem; vlevo záložky (Přehled · Analýza · Ocenění ·
 * Dokumenty · Úkoly · Termíny · Historie · Komentáře), vpravo metadatová lišta.
 * Záložky Analýza/Ocenění/Dokumenty znovupoužívají stávající komponenty.
 */
export default function TenderDetailPage({ tenderId, onBack }: TenderDetailPageProps) {
  const [tab, setTab] = useState<string>('prehled');

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

  // Seznam zakázek pro název + vstupní soubory (zdroj).
  const { data: tenders } = useQuery({ queryKey: ['tenders'], queryFn: getTenders, staleTime: 30000 });
  const summary = tenders?.find((t) => t.id === tenderId);

  // Analýza — nemusí ještě existovat (404), proto retry:false.
  const { data: analysis } = useQuery({
    queryKey: ['analysis', tenderId],
    queryFn: () => getAnalysis(tenderId),
    retry: false,
  });

  // Validace — pro indikátor „Připraveno k podání".
  const { data: validation } = useQuery({
    queryKey: ['validation', tenderId],
    queryFn: () => getValidation(tenderId),
    retry: false,
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
            <StageBadge status={deriveStage(steps)} />
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
          <Button variant="primary" iconRight={<ChevronDown size={16} />} disabled title="Brzy">
            Změnit stav
          </Button>
        </div>
      </div>

      {/* Krokovací proces */}
      <Card padding={20} style={{ marginTop: 16 }}>
        <StageStepper current={stepperCurrent(steps)} />
      </Card>

      {/* Tělo: obsah + metadatová lišta */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 280px', gap: 20, marginTop: 20, alignItems: 'start' }}>
        <div style={{ minWidth: 0 }}>
          <Tabs tabs={[...TABS]} value={tab} onChange={setTab} />
          <div style={{ marginTop: 16 }}>
            {tab === 'prehled' && <PrehledTab analysis={analysis} decision={decision} />}
            {tab === 'analyza' && <AnalysisView tenderId={tenderId} />}
            {tab === 'oceneni' && <ProductMatchView tenderId={tenderId} />}
            {tab === 'dokumenty' && <DocumentList tenderId={tenderId} />}
            {tab === 'ukoly' && (
              <EmptyState icon={<ListChecks size={28} />} title="Zatím žádné úkoly" hint="Správa úkolů k zakázce přibude v dalším kroku." />
            )}
            {tab === 'terminy' && <TerminyTab analysis={analysis} />}
            {tab === 'historie' && (
              <EmptyState icon={<History size={28} />} title="Zatím žádná aktivita" hint="Historie změn stavu a akcí přibude v dalším kroku." />
            )}
            {tab === 'komentare' && (
              <EmptyState icon={<MessageSquare size={28} />} title="Zatím žádné komentáře" hint="Týmové komentáře přibudou v dalším kroku." />
            )}
          </div>
        </div>

        <MetadataRail
          analysis={analysis}
          sourceFormats={sourceFormats}
          ready={validation?.ready_to_submit ?? null}
          score={validation?.overall_score ?? null}
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

function TerminyTab({ analysis }: { analysis: TenderAnalysis | undefined }) {
  const t = analysis?.terminy;
  const rows: Array<{ label: string; value?: string | null }> = [
    { label: 'Lhůta pro podání nabídek', value: t?.lhuta_nabidek },
    { label: 'Otevírání obálek', value: t?.otevirani_obalek },
    { label: 'Plnění od', value: t?.doba_plneni_od },
    { label: 'Plnění do', value: t?.doba_plneni_do },
  ];
  const hasAny = rows.some((r) => !!r.value);

  if (!hasAny) {
    return <EmptyState icon={<CalendarClock size={28} />} title="Zatím žádné termíny" hint="Termíny se doplní po AI analýze zadávací dokumentace." />;
  }

  return (
    <Card title="Termíny">
      {rows.map((r) => (
        <InfoRow key={r.label} label={r.label} value={r.value} />
      ))}
    </Card>
  );
}

function MetadataRail({
  analysis, sourceFormats, ready, score,
}: {
  analysis: TenderAnalysis | undefined;
  sourceFormats: string[];
  ready: boolean | null;
  score: number | null;
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
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>Nepřiřazeno</span>
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
