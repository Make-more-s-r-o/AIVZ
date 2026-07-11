import { useState, useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Circle, Loader2, AlertCircle, Play, ChevronDown, ChevronUp, Clock } from 'lucide-react';
import { cn } from '../lib/cn';
import {
  runStep, runAllSteps, getJobStatus, getCost, JobNotFoundError,
  type PipelineSteps, type StepName, type StepStatus, type CostSummary, type RunAllStatus,
} from '../lib/api';
import { pipelineObservationKey } from '../lib/pipeline-observation';

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
  runAll?: RunAllStatus;
  onStepComplete: () => void;
  /** Přepnout na záložku Ocenění (odkaz z waiting_approval stavu). */
  onGoToPricing?: () => void;
  /** Vygenerované dokumenty jsou starší než poslední změna/potvrzení ceny. */
  stale?: boolean;
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

export default function PipelineStatus({ tenderId, steps, runAll, onStepComplete, onGoToPricing, stale }: PipelineStatusProps) {
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [activeStep, setActiveStep] = useState<StepName | null>(null);
  const [runningAll, setRunningAll] = useState(false);
  const [failedStep, setFailedStep] = useState<StepName | null>(null);
  // Run-all pauznutý na money-gate (nepotvrzené ceny před generate) — žlutý stav, ne chyba.
  const [waitingApproval, setWaitingApproval] = useState<string | null>(null);
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
  // Sleduj i stav, ne jen jobId: resume pokračuje pod stejným parent ID a přechod
  // waiting_approval → running se proto musí znovu zpracovat po invalidaci status query.
  const observedRunAllRef = useRef<string | null>(null);
  const onStepCompleteRef = useRef(onStepComplete);
  onStepCompleteRef.current = onStepComplete;

  const { data: costData } = useQuery({
    queryKey: ['cost', tenderId],
    queryFn: () => getCost(tenderId),
    refetchInterval: activeJobId ? 10000 : false,
  });

  // Po reloadu stránky se znovu připoj k perzistentnímu run-all jobu; terminální stav
  // zobraz rovnou z tender statusu, i když jej spustila jiná karta prohlížeče.
  useEffect(() => {
    if (!runAll) return;
    const observationKey = pipelineObservationKey(runAll);
    if (observedRunAllRef.current === observationKey) return;
    observedRunAllRef.current = observationKey;
    if (runAll.status === 'queued' || runAll.status === 'running') {
      setActiveJobId(runAll.jobId);
      setActiveStep(runAll.currentStep ?? null);
      activeStepRef.current = runAll.currentStep ?? null;
      setRunningAll(true);
      setShowLogs(true);
      return;
    }
    if (runAll.status === 'waiting_approval') {
      // Pipeline pauznutá na potvrzení cen — bez spinneru, žlutý stav s odkazem na Ocenění.
      setActiveJobId(null);
      setActiveStep(null);
      activeStepRef.current = null;
      setRunningAll(false);
      setWaitingApproval(runAll.error || 'Pipeline čeká na potvrzení cen v záložce Ocenění.');
      return;
    }
    if (runAll.status === 'error' || runAll.status === 'interrupted') {
      setFailedStep(runAll.failedStep ?? runAll.currentStep ?? null);
      setJobError(runAll.error || (runAll.status === 'interrupted'
        ? 'Pipeline byla přerušena restartem serveru.'
        : 'Neznámá chyba'));
    }
  }, [runAll]);

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
        if (job.currentStep) {
          setActiveStep(job.currentStep);
          activeStepRef.current = job.currentStep;
        }

        if (job.status === 'done') {
          clearInterval(interval);
          setActiveJobId(null);
          setActiveStep(null);
          activeStepRef.current = null;
          setRunningAll(false);
          setJobError(null);
          setFailedStep(null);
          onStepCompleteRef.current();
        } else if (job.status === 'waiting_approval') {
          // Řetězec narazil na money-gate → zastav spinner, ukaž žlutý stav (ne chyba).
          clearInterval(interval);
          setActiveJobId(null);
          setActiveStep(null);
          activeStepRef.current = null;
          setRunningAll(false);
          setJobError(null);
          setFailedStep(null);
          setWaitingApproval(job.error || 'Pipeline čeká na potvrzení cen v záložce Ocenění.');
          onStepCompleteRef.current();
        } else if (job.status === 'error' || job.status === 'interrupted') {
          // Zastav spinner (vyprázdni activeJobId/activeStep) a ukaž chybu + krok k restartu.
          clearInterval(interval);
          setActiveJobId(null);
          setActiveStep(null);
          setFailedStep(job.failedStep ?? activeStepRef.current);
          activeStepRef.current = null;
          setRunningAll(false);
          setJobError(job.error || (job.status === 'interrupted'
            ? 'Pipeline byla přerušena restartem serveru.'
            : 'Neznámá chyba'));
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
          setRunningAll(false);
          setJobError(message);
          onStepCompleteRef.current();
        };

        if (err instanceof JobNotFoundError) {
          // 404 — úloha už není v registru serveru. Zastav polling a nabídni nový pokus.
          giveUp('Úloha už není v registru serveru. Zkuste krok spustit znovu.');
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
    setWaitingApproval(null);
    setLogs([]);
    logSeenRef.current = 0;
    failedPollsRef.current = 0;
    setActiveStep(step);
    setRunningAll(false);
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

  const handleRunAll = async () => {
    setError(null);
    setJobError(null);
    setFailedStep(null);
    setWaitingApproval(null);
    setLogs([]);
    logSeenRef.current = 0;
    failedPollsRef.current = 0;
    const firstStep: StepName = 'extract';
    setActiveStep(firstStep);
    activeStepRef.current = firstStep;
    setRunningAll(true);
    setShowLogs(true);

    try {
      const result = await runAllSteps(tenderId);
      observedRunAllRef.current = pipelineObservationKey(result);
      setActiveJobId(result.jobId);
      if (result.currentStep) {
        setActiveStep(result.currentStep);
        activeStepRef.current = result.currentStep;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Neznámá chyba');
      setActiveStep(null);
      activeStepRef.current = null;
      setRunningAll(false);
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
    if (failedStep === step && steps[step] !== 'done') return 'error';
    return steps[step];
  };

  return (
    <div className="space-y-4">
      {stale && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>Dokumenty neodpovídají aktuálním cenám — spusťte znovu Generování.</span>
        </div>
      )}
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 items-center justify-between">
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
        <button
          onClick={handleRunAll}
          disabled={!!activeJobId || !!activeStep}
          className="inline-flex shrink-0 items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {runningAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {runningAll ? 'Spouštím vše…' : 'Spustit vše'}
        </button>
      </div>

      {/* Total cost */}
      {costData && costData.totalCZK > 0 && (
        <div className="text-right text-xs text-gray-400">
          Celkové AI náklady: {costData.totalCZK.toFixed(2)} Kč
        </div>
      )}

      {/* Waiting for price approval (money-gate) — žlutý stav, ne chyba */}
      {waitingApproval && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="flex items-start gap-2">
            <Clock className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">Čeká na potvrzení cen</div>
              <div className="mt-0.5 break-words text-amber-700">{waitingApproval}</div>
              {onGoToPricing && (
                <button
                  onClick={onGoToPricing}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-xs font-medium text-amber-800 transition-colors hover:bg-amber-100"
                >
                  Přejít na Ocenění
                </button>
              )}
            </div>
          </div>
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
