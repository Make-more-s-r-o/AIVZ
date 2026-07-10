import { useQuery } from '@tanstack/react-query';
import { getValidation } from '../lib/api';
import { CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { ValidationReport as ValidationReportType, ValidationCheck } from '../types/tender';

interface ValidationReportProps {
  tenderId: string;
}

export default function ValidationReport({ tenderId }: ValidationReportProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['validation', tenderId],
    queryFn: () => getValidation(tenderId),
  });

  if (isLoading) return <div className="py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Načítám validaci...</div>;
  if (error) return <div className="py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Validace zatím není k dispozici. Spusťte krok "Validace".</div>;
  if (!data) return null;

  const report = data as ValidationReportType;
  const scoreColor = report.overall_score >= 7 ? 'var(--success-solid)' : report.overall_score >= 5 ? 'var(--warning-solid)' : 'var(--danger-solid)';
  const deterministicChecks = report.checks?.filter((check) => check.zdroj === 'deterministic') ?? [];
  const aiChecks = report.checks?.filter((check) => (check.zdroj ?? 'ai') === 'ai') ?? [];

  const renderChecks = (checks: ValidationCheck[]) => (
    <div className="space-y-2">
      {checks.map((check: ValidationCheck, i: number) => (
        <div key={`${check.zdroj ?? 'ai'}-${i}`} className="flex items-start gap-2">
          {check.status === 'pass' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--success-solid)' }} />}
          {check.status === 'fail' && <XCircle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--danger-solid)' }} />}
          {check.status === 'warning' && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" style={{ color: 'var(--warning-solid)' }} />}
          <div>
            <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
              <span className="font-medium">[{check.kategorie}]</span> {check.kontrola}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{check.detail}</div>
          </div>
        </div>
      ))}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-6">
        <div className="text-center">
          <div className="text-4xl font-bold" style={{ color: scoreColor }}>
            {report.overall_score}/10
          </div>
          <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>Celkové skóre</div>
        </div>
        <div
          className="rounded-full px-4 py-2 text-sm font-bold"
          style={report.ready_to_submit
            ? { background: 'var(--success-bg)', color: 'var(--success-fg)' }
            : { background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
        >
          {report.ready_to_submit ? 'PŘIPRAVENO K PODÁNÍ' : 'NENÍ PŘIPRAVENO'}
        </div>
      </div>

      {report.kriticke_problemy?.length > 0 && (
        <div className="rounded-lg border p-4" style={{ borderColor: 'var(--danger-bg)', background: 'var(--danger-soft-bg)' }}>
          <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--danger-fg)' }}>Kritické problémy</h3>
          <ul className="list-inside list-disc space-y-1 text-sm" style={{ color: 'var(--danger-fg)' }}>
            {report.kriticke_problemy.map((p: string, i: number) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {deterministicChecks.length > 0 && (
        <div className="rounded-lg border p-4" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
          <h3 className="mb-1 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Deterministické kontroly</h3>
          <p className="mb-3 text-xs" style={{ color: 'var(--text-secondary)' }}>Tyto kontroly rozhodují o připravenosti k podání společně se submit-gate.</p>
          {renderChecks(deterministicChecks)}
        </div>
      )}

      {aiChecks.length > 0 && (
        <div className="rounded-lg border p-4" style={{ borderColor: 'var(--border-default)', background: 'var(--surface-card)' }}>
          <h3 className="mb-1 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>AI posouzení (advisory)</h3>
          <p className="mb-3 text-xs" style={{ color: 'var(--text-secondary)' }}>AI pomáhá najít věcná rizika; samo o sobě nabídku neblokuje.</p>
          {renderChecks(aiChecks)}
        </div>
      )}

      {report.doporuceni?.length > 0 && (
        <div className="rounded-lg border p-4" style={{ borderColor: 'var(--info-bg)', background: 'var(--info-soft-bg)' }}>
          <h3 className="mb-2 text-sm font-semibold" style={{ color: 'var(--info-fg)' }}>Doporučení</h3>
          <ul className="list-inside list-disc space-y-1 text-sm" style={{ color: 'var(--info-fg)' }}>
            {report.doporuceni.map((d: string, i: number) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
