import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Inbox, FileText, ArrowRight } from 'lucide-react';
import FileUpload from '../components/FileUpload';
import { Card, useToast } from '../components/ui';
import { StageBadge } from '../components/crm';
import { getTenders, uploadFiles, type TenderSummary } from '../lib/api';
import { effectiveStage } from '../lib/crm-adapters';

export interface MonitoringPageProps {
  onOpen?: (id: string) => void;
}

const STEP_LABELS: Array<{ key: keyof TenderSummary['steps']; label: string }> = [
  { key: 'extract', label: 'Extrakce' },
  { key: 'analyze', label: 'Analýza' },
  { key: 'match', label: 'Ocenění' },
  { key: 'generate', label: 'Generování' },
  { key: 'validate', label: 'Validace' },
];

// Stav kroku do tooltipu (a11y — stav nesmí být rozlišen jen barvou tečky).
const STEP_STATUS_LABEL: Record<string, string> = {
  done: 'hotovo', running: 'probíhá', error: 'chyba', pending: 'čeká',
};

/**
 * Monitoring = ruční ingest inbox. Automatické sledování zdrojů (Hlídač státu, NEN,
 * TenderArena…) je pozdější milník; do té doby je vstup zakázek manuální: nahraj
 * zadávací dokumentaci a otevři zakázku ke zpracování. Nedokončené (bez hotové
 * analýzy) se řadí nahoru jako „čeká na zpracování".
 */
export default function MonitoringPage({ onOpen }: MonitoringPageProps) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);

  const { data: tenders = [], isLoading } = useQuery({ queryKey: ['tenders'], queryFn: getTenders });

  // Nezpracované (analýza není hotová) nahoru — to je fronta k vyřízení.
  const ordered = useMemo(() => {
    const pending = tenders.filter((t) => t.steps.analyze !== 'done');
    const done = tenders.filter((t) => t.steps.analyze === 'done');
    return { pending, done };
  }, [tenders]);

  async function handleUpload(files: File[]) {
    if (uploading || files.length === 0) return;
    setUploading(true);
    try {
      const created = await uploadFiles(files);
      await qc.invalidateQueries({ queryKey: ['tenders'] });
      toast(`Nahráno ${files.length} soubor(ů) — zakázka připravena ke zpracování`, 'success');
      if (created?.id && onOpen) onOpen(created.id);
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Nahrání selhalo', 'danger');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <div>
        <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 'var(--weight-bold)', color: 'var(--text-primary)', margin: 0 }}>
          Monitoring
        </h1>
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
          Ruční ingest zakázek — nahrajte zadávací dokumentaci a spusťte zpracování. Automatické
          napojení zdrojů (Hlídač státu, NEN, TenderArena…) je v přípravě.
        </p>
      </div>

      {/* Upload CTA */}
      <div style={{ marginTop: 20 }}>
        <Card title="Nahrát novou zakázku">
          <FileUpload onUpload={handleUpload} isUploading={uploading} />
        </Card>
      </div>

      {/* Fronta ke zpracování */}
      <div style={{ marginTop: 20 }}>
        <SectionTitle>Čeká na zpracování {ordered.pending.length > 0 && <Count n={ordered.pending.length} />}</SectionTitle>
        {isLoading ? (
          <Muted>Načítám…</Muted>
        ) : ordered.pending.length === 0 ? (
          <EmptyInbox hasTenders={tenders.length > 0} />
        ) : (
          <CardGrid>
            {ordered.pending.map((t) => <TenderCard key={t.id} t={t} onOpen={onOpen} />)}
          </CardGrid>
        )}
      </div>

      {/* Zpracované */}
      {ordered.done.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <SectionTitle>Zpracované <Count n={ordered.done.length} /></SectionTitle>
          <CardGrid>
            {ordered.done.map((t) => <TenderCard key={t.id} t={t} onOpen={onOpen} />)}
          </CardGrid>
        </div>
      )}
    </div>
  );
}

function TenderCard({ t, onOpen }: { t: TenderSummary; onOpen?: (id: string) => void }) {
  const [hover, setHover] = useState(false);
  const stage = effectiveStage({ status: t.status, steps: t.steps });
  const nazev = t.name || t.tenderId || t.id;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen?.(t.id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen?.(t.id); } }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', flexDirection: 'column', gap: 10, padding: 14, cursor: 'pointer', textAlign: 'left',
        background: 'var(--surface-card)', border: '1px solid var(--border-default)', borderRadius: 'var(--radius-lg)',
        boxShadow: hover ? 'var(--shadow-sm)' : 'none', transition: 'box-shadow var(--duration-fast), border-color var(--duration-fast)',
        borderColor: hover ? 'var(--border-strong)' : 'var(--border-default)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <span style={{
          flexShrink: 0, width: 32, height: 32, borderRadius: 'var(--radius-md)', background: 'var(--surface-sunken)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-tertiary)',
        }}>
          <FileText size={16} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {nazev}
          </div>
          <div style={{ fontSize: 'var(--font-size-2xs)', color: 'var(--text-tertiary)', marginTop: 1 }}>
            {t.inputFiles.length} {filesPlural(t.inputFiles.length)}
          </div>
        </div>
        <ArrowRight size={15} style={{ color: hover ? 'var(--accent)' : 'var(--text-tertiary)', flexShrink: 0 }} />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <StageBadge status={stage} size="sm" />
        <div style={{ display: 'flex', gap: 4 }}>
          {STEP_LABELS.map((s) => {
            const st = t.steps[s.key];
            const color = st === 'done' ? 'var(--success-solid)' : st === 'running' ? 'var(--accent)' : st === 'error' ? 'var(--danger-solid)' : 'var(--border-strong)';
            return <span key={s.key} title={`${s.label}: ${STEP_STATUS_LABEL[st] ?? st}`} style={{ width: 7, height: 7, borderRadius: '50%', background: color }} />;
          })}
        </div>
      </div>
    </div>
  );
}

function filesPlural(n: number): string {
  if (n === 1) return 'soubor';
  if (n >= 2 && n <= 4) return 'soubory';
  return 'souborů';
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
      <h2 style={{ fontSize: 'var(--font-size-base)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-primary)', margin: 0 }}>
        {children}
      </h2>
    </div>
  );
}

function Count({ n }: { n: number }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 20, height: 20, padding: '0 6px',
      fontSize: 'var(--font-size-2xs)', fontWeight: 'var(--weight-semibold)', color: 'var(--text-secondary)',
      background: 'var(--surface-sunken)', borderRadius: 'var(--radius-full)',
    }}>{n}</span>
  );
}

function CardGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>{children}</div>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)', padding: '8px 0' }}>{children}</div>;
}

function EmptyInbox({ hasTenders }: { hasTenders: boolean }) {
  return (
    <div style={{
      padding: '40px 24px', textAlign: 'center', background: 'var(--surface-card)',
      border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-lg)',
    }}>
      <Inbox size={26} style={{ color: 'var(--text-tertiary)', marginBottom: 8 }} />
      <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
        {hasTenders
          ? 'Fronta je prázdná — všechny nahrané zakázky mají hotovou analýzu.'
          : 'Zatím žádné zakázky — nahrajte první zadávací dokumentaci výše.'}
      </div>
    </div>
  );
}
