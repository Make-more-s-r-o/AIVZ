import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Loader2, AlertCircle, Play, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../lib/cn';
import { runStep, getJobStatus, getCost, JobNotFoundError, type PipelineSteps, type StepName, type StepStatus, type CostSummary } from '../lib/api';

// Kolik po sobě jdoucích síťových chyb pollu tolerujeme, než úlohu vzdáme (interval 2s → ~60s).
const MAX_FAILED_POLLS = 30;

const STEPS: { key: StepName; label: string }[] = [
  { key: 'extract', label: 'Extrakce' },
  { key: 'analyze', label: 'AI analýza' },
  { key: 'match', label: 'Produkty' },
  { key: 'generate', label: 'Dokumenty' },
  { key: 'validate', label: 'Validace' },
];

interface PipelineStatusProps {
  tenderId: string;
  steps: PipelineSteps;
  onStepComplete: () => void;
}

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'done':
      return <CheckCircle2 className="h-6 w-6 text-green-500" />;
    case 'running':
      return <Loader2 className="h-6 w-6 animate-spin text-blue-500" />;
    case 'error':
      return <AlertCircle className="h-6 w-6 text-red-500" />;
    default:
      return <Circle className="h-6 w-6 text-gray-300" />;
  }
}

function getStepCost(stepKey: string, byStep: CostSummary['byStep']): number {
  if (stepKey === 'extract') return 0;
  if (stepKey === 'analyze' || stepKey === 'validate') return byStep[stepKey]?.costCZK || 0;
  // For match/generate: sum all entries starting with that prefix
  return Object.entries(byStep)
    .filter(([k]) => k.startsWith(stepKey))
    .reduce((s, [, v]) => s + v.costCZK, 0);
}

export default function PipelineStatus({ tenderId, steps, onStepComplete }: PipelineStatusProps) {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<StepName | null>(null);
  const [failedStep, setFailedStep] = useState<StepName | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [jobError, setJobError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logSeenRef = useRef(0);
  // Aktuálně běžící krok drž i v refu — closure v pollovacím intervalu jinak vidí stale hodnotu
  // a při chybě bychom nevěděli, který krok nabídnout k opětovnému spuštění.
  const activeStepRef = useRef<StepName | null>(null);
  // Počítadlo po sobě jdoucích neúspěšných pollů — po překročení limitu úlohu vzdáme,
  // ať spinner netočí donekonečna při delším výpadku spojení.
  const failedPollsRef = useRef(0);
  const onStepCompleteRef = useRef(onStepComplete);
  onStepCompleteRef.current = onStepComplete;

  const { data: costData } = useQuery({
    queryKey: ['cost', tenderId],
    queryFn: () => getCost(tenderId),
    refetchInterval: activeJobId ? 10000 : false,
  });

  // Poll job status when we have an active job
  useEffect(() => {
    if (!activeJobId) return;

    const interval = setInterval(async () => {
      try {
        const job = await getJobStatus(activeJobId, logSeenRef.current);
        failedPollsRef.current = 0; // úspěšný poll → vynuluj počítadlo výpadků
        // Append new log lines
        if (job.logs.length > 0) {
          setLogs(prev => [...prev, ...job.logs]);
          logSeenRef.current = job.totalLogLines;
        }

        if (job.status === 'done') {
          clearInterval(interval);
          setActiveJobId(null);
          setActiveStep(null);
          activeStepRef.current = null;
          setJobError(null);
          setFailedStep(null);
          onStepCompleteRef.current();
        } else if (job.status === 'error') {
          // Zastav spinner (vyprázdni activeJobId/activeStep) a ukaž chybu + krok k restartu.
          clearInterval(interval);
          setActiveJobId(null);
          setActiveStep(null);
          setFailedStep(activeStepRef.current);
          activeStepRef.current = null;
          setJobError(job.error || 'Neznámá chyba');
          onStepCompleteRef.current();
        }
      } catch (err) {
        // Ukonči spinner, ukaž chybu a nabídni restart kroku.
        const giveUp = (message: string) => {
          clearInterval(interval);
          setActiveJobId(null);
          setActiveStep(null);
          setFailedStep(activeStepRef.current);
          activeStepRef.current = null;
          setJobError(message);
          onStepCompleteRef.current();
        };

        if (err instanceof JobNotFoundError) {
          // 404 — úloha zmizela ze serveru (nejčastěji restart/deploy během běhu). Dřív to
          // catch spolkl a spinner točil navždy. Teď zastav a nabídni „Zkusit znovu".
          giveUp('Úloha byla ztracena — server se pravděpodobně restartoval během běhu (deploy). Zkuste krok spustit znovu.');
          return;
        }

        // Síťová chyba — pollovat dál, ale s limitem, ať spinner netočí donekonečna.
        failedPollsRef.current += 1;
        if (failedPollsRef.current >= MAX_FAILED_POLLS) {
          giveUp('Ztráta spojení se serverem. Zkuste krok spustit znovu.');
        }
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [activeJobId]);

  // Auto-scroll logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const handleRun = async (step: StepName) => {
    setError(null);
    setJobError(null);
    setFailedStep(null);
    setLogs([]);
    logSeenRef.current = 0;
    failedPollsRef.current = 0;
    setActiveStep(step);
    activeStepRef.current = step;
    setShowLogs(true);

    try {
      const result = await runStep(tenderId, step);
      setActiveJobId(result.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Neznámá chyba');
      setActiveStep(null);
      activeStepRef.current = null;
      setFailedStep(step);
    }
  };

  const canRun = (index: number): boolean => {
    if (activeJobId || activeStep) return false;
    if (index === 0) return true;
    const prevStep = STEPS[index - 1]!;
    return steps[prevStep.key] === 'done';
  };

  const getStepStatus = (step: StepName): StepStatus => {
    if (activeStep === step) return 'running';
    return steps[step];
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {STEPS.map((step, i) => (
          <div key={step.key} className="flex flex-1 items-center">
            <div className="flex flex-col items-center gap-1">
              <div className="relative">
                <StepIcon status={getStepStatus(step.key)} />
                {getStepStatus(step.key) !== 'done' && getStepStatus(step.key) !== 'running' && canRun(i) && (
                  <button
                    onClick={() => handleRun(step.key)}
                    className="absolute -bottom-1 -right-1 rounded-full bg-blue-600 p-0.5 text-white hover:bg-blue-700"
                    title={`Spustit ${step.label}`}
                  >
                    <Play className="h-3 w-3" />
                  </button>
                )}
              </div>
              <span
                className={cn(
                  'text-xs font-medium',
                  getStepStatus(step.key) === 'done' ? 'text-green-700' :
                  getStepStatus(step.key) === 'running' ? 'text-blue-600' :
                  'text-gray-500'
                )}
              >
                {step.label}
              </span>
              {costData && (() => {
                const cost = getStepCost(step.key, costData.byStep);
                return cost > 0 ? (
                  <span className="text-[9px] text-gray-400">{cost.toFixed(1)} Kč</span>
                ) : null;
              })()}
            </div>
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  'mx-2 h-0.5 flex-1',
                  steps[step.key] === 'done' ? 'bg-green-300' : 'bg-gray-200'
                )}
              />
            )}
          </div>
        ))}
      </div>

      {/* Total cost */}
      {costData && costData.totalCZK > 0 && (
        <div className="text-right text-xs text-gray-400">
          Celkové AI náklady: {costData.totalCZK.toFixed(2)} Kč
        </div>
      )}

      {/* Error messages */}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
      {jobError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <div className="flex items-start gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                Krok {failedStep ? STEPS.find(s => s.key === failedStep)?.label ?? failedStep : ''} selhal
              </div>
              <div className="mt-0.5 break-words text-red-600">{jobError}</div>
              {failedStep && (
                <button
                  onClick={() => handleRun(failedStep)}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100"
                >
                  <Play className="h-3 w-3" />
                  Zkusit znovu
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Log output */}
      {logs.length > 0 && (
        <div className="rounded-lg border bg-gray-50">
          <button
            onClick={() => setShowLogs(prev => !prev)}
            className="flex w-full items-center justify-between px-4 py-2 text-xs font-medium text-gray-600 hover:bg-gray-100"
          >
            <span>Log ({logs.length} lines)</span>
            {showLogs ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          {showLogs && (
            <div className="max-h-64 overflow-y-auto border-t px-4 py-2">
              <pre className="whitespace-pre-wrap font-mono text-xs text-gray-700">
                {logs.join('\n')}
              </pre>
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
