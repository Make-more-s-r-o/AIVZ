import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Loader2, AlertCircle, Play, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '../lib/cn';
import { runStep, getJobStatus, getCost, type PipelineSteps, type StepName, type StepStatus, type CostSummary } from '../lib/api';

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
  const [logs, setLogs] = useState<string[]>([]);
  const [jobError, setJobError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const logSeenRef = useRef(0);
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
        // Append new log lines
        if (job.logs.length > 0) {
          setLogs(prev => [...prev, ...job.logs]);
          logSeenRef.current = job.totalLogLines;
        }

        if (job.status === 'done') {
          clearInterval(interval);
          setActiveJobId(null);
          setActiveStep(null);
          setJobError(null);
          onStepCompleteRef.current();
        } else if (job.status === 'error') {
          clearInterval(interval);
          setActiveJobId(null);
          setActiveStep(null);
          setJobError(job.error || 'Unknown error');
          onStepCompleteRef.current();
        }
      } catch {
        // Network error — keep polling
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
    setLogs([]);
    logSeenRef.current = 0;
    setActiveStep(step);
    setShowLogs(true);

    try {
      const result = await runStep(tenderId, step);
      setActiveJobId(result.jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      setActiveStep(null);
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
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          Krok selhal: {jobError}
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
