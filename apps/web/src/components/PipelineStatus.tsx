import { useState } from 'react';
import { CheckCircle2, Circle, Loader2, AlertCircle, Play } from 'lucide-react';
import { cn } from '../lib/cn';
import { runStep, type PipelineSteps, type StepName, type StepStatus } from '../lib/api';

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

export default function PipelineStatus({ tenderId, steps, onStepComplete }: PipelineStatusProps) {
  const [runningStep, setRunningStep] = useState<StepName | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleRun = async (step: StepName) => {
    setRunningStep(step);
    setError(null);
    try {
      await runStep(tenderId, step);
      onStepComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRunningStep(null);
    }
  };

  const canRun = (index: number): boolean => {
    if (runningStep) return false;
    if (index === 0) return true;
    const prevStep = STEPS[index - 1]!;
    return steps[prevStep.key] === 'done';
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        {STEPS.map((step, i) => (
          <div key={step.key} className="flex flex-1 items-center">
            <div className="flex flex-col items-center gap-1">
              <div className="relative">
                <StepIcon status={runningStep === step.key ? 'running' : steps[step.key]} />
                {steps[step.key] !== 'done' && canRun(i) && (
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
                  steps[step.key] === 'done' ? 'text-green-700' : 'text-gray-500'
                )}
              >
                {step.label}
              </span>
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
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </div>
      )}
    </div>
  );
}
