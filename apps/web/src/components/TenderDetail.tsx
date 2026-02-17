import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getTenderStatus, type PipelineSteps } from '../lib/api';
import PipelineStatus from './PipelineStatus';
import AnalysisView from './AnalysisView';
import ProductMatchView from './ProductMatchView';
import DocumentList from './DocumentList';
import ValidationReport from './ValidationReport';
import { cn } from '../lib/cn';

interface TenderDetailProps {
  tenderId: string;
}

const TABS = [
  { key: 'pipeline', label: 'Pipeline' },
  { key: 'analysis', label: 'Analýza' },
  { key: 'products', label: 'Produkty' },
  { key: 'documents', label: 'Dokumenty' },
  { key: 'validation', label: 'Validace' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

export default function TenderDetail({ tenderId }: TenderDetailProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('pipeline');
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ['tender-status', tenderId],
    queryFn: () => getTenderStatus(tenderId),
    refetchInterval: 3000,
  });

  const steps: PipelineSteps = data?.steps || {
    extract: 'pending',
    analyze: 'pending',
    match: 'pending',
    generate: 'pending',
    validate: 'pending',
  };

  const handleStepComplete = () => {
    queryClient.invalidateQueries({ queryKey: ['tender-status', tenderId] });
    queryClient.invalidateQueries({ queryKey: ['analysis', tenderId] });
    queryClient.invalidateQueries({ queryKey: ['product-match', tenderId] });
    queryClient.invalidateQueries({ queryKey: ['documents', tenderId] });
    queryClient.invalidateQueries({ queryKey: ['validation', tenderId] });
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">{tenderId}</h2>

      <div className="rounded-lg border bg-white p-6">
        <PipelineStatus
          tenderId={tenderId}
          steps={steps}
          onStepComplete={handleStepComplete}
        />
      </div>

      <div className="flex gap-1 border-b">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={cn(
              'px-4 py-2 text-sm font-medium transition-colors',
              activeTab === tab.key
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-500 hover:text-gray-700'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div>
        {activeTab === 'pipeline' && (
          <div className="rounded-lg border bg-white p-6">
            <h3 className="mb-4 text-sm font-semibold">Jak to funguje</h3>
            <ol className="list-inside list-decimal space-y-2 text-sm text-gray-600">
              <li><strong>Extrakce</strong> — Parsování PDF a DOCX souborů, extrakce textu</li>
              <li><strong>AI analýza</strong> — Claude analyzuje zadávací dokumentaci, extrahuje požadavky</li>
              <li><strong>Produkty</strong> — AI navrhne 3 produkty, vybere nejlepší match</li>
              <li><strong>Dokumenty</strong> — Vygeneruje 5 DOCX nabídkových dokumentů</li>
              <li><strong>Validace</strong> — AI zkontroluje shodu nabídky s požadavky</li>
            </ol>
            <p className="mt-4 text-xs text-gray-400">
              Klikněte na tlačítko Play u každého kroku v pipeline výše, nebo spusťte kroky postupně.
            </p>
          </div>
        )}
        {activeTab === 'analysis' && <AnalysisView tenderId={tenderId} />}
        {activeTab === 'products' && <ProductMatchView tenderId={tenderId} />}
        {activeTab === 'documents' && <DocumentList tenderId={tenderId} />}
        {activeTab === 'validation' && <ValidationReport tenderId={tenderId} />}
      </div>
    </div>
  );
}
