import { useQuery } from '@tanstack/react-query';
import { getValidation } from '../lib/api';
import { cn } from '../lib/cn';
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

  if (isLoading) return <div className="py-8 text-center text-gray-500">Načítám validaci...</div>;
  if (error) return <div className="py-8 text-center text-gray-500">Validace zatím není k dispozici. Spusťte krok "Validace".</div>;
  if (!data) return null;

  const report = data as ValidationReportType;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-6">
        <div className="text-center">
          <div className={cn(
            'text-4xl font-bold',
            report.overall_score >= 7 ? 'text-green-600' : report.overall_score >= 5 ? 'text-yellow-600' : 'text-red-600'
          )}>
            {report.overall_score}/10
          </div>
          <div className="text-xs text-gray-500">Celkové skóre</div>
        </div>
        <div className={cn(
          'rounded-full px-4 py-2 text-sm font-bold',
          report.ready_to_submit
            ? 'bg-green-100 text-green-800'
            : 'bg-red-100 text-red-800'
        )}>
          {report.ready_to_submit ? 'PŘIPRAVENO K PODÁNÍ' : 'NENÍ PŘIPRAVENO'}
        </div>
      </div>

      {report.kriticke_problemy?.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <h3 className="mb-2 text-sm font-semibold text-red-800">Kritické problémy</h3>
          <ul className="list-inside list-disc space-y-1 text-sm text-red-700">
            {report.kriticke_problemy.map((p: string, i: number) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </div>
      )}

      {report.checks?.length > 0 && (
        <div className="rounded-lg border bg-white p-4">
          <h3 className="mb-3 text-sm font-semibold">Kontroly</h3>
          <div className="space-y-2">
            {report.checks.map((check: ValidationCheck, i: number) => (
              <div key={i} className="flex items-start gap-2">
                {check.status === 'pass' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />}
                {check.status === 'fail' && <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />}
                {check.status === 'warning' && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />}
                <div>
                  <div className="text-sm">
                    <span className="font-medium">[{check.kategorie}]</span> {check.kontrola}
                  </div>
                  <div className="text-xs text-gray-500">{check.detail}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {report.doporuceni?.length > 0 && (
        <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <h3 className="mb-2 text-sm font-semibold text-blue-800">Doporučení</h3>
          <ul className="list-inside list-disc space-y-1 text-sm text-blue-700">
            {report.doporuceni.map((d: string, i: number) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
