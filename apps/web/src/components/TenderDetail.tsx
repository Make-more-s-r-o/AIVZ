import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getTenderStatus, getTenders, getCompanies, setTenderCompany, type PipelineSteps } from '../lib/api';
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

  // Get tender name from cached tenders list
  const { data: tenders } = useQuery({
    queryKey: ['tenders'],
    queryFn: getTenders,
    staleTime: 30000,
  });
  const tenderName = tenders?.find(t => t.id === tenderId)?.name;

  const steps: PipelineSteps = data?.steps || {
    extract: 'pending',
    analyze: 'pending',
    match: 'pending',
    generate: 'pending',
    validate: 'pending',
  };

  // Companies for selector
  const { data: companies } = useQuery({
    queryKey: ['companies'],
    queryFn: getCompanies,
    staleTime: 60000,
  });

  const handleCompanyChange = useCallback(async (companyId: string) => {
    try {
      const result = await setTenderCompany(tenderId, companyId);
      queryClient.invalidateQueries({ queryKey: ['attachments', tenderId] });
      if (result.copied_documents.length > 0) {
        // Silently refresh — docs were copied
      }
    } catch (err) {
      console.error('Failed to set company:', err);
    }
  }, [tenderId, queryClient]);

  const handleStepComplete = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['tender-status', tenderId] });
    queryClient.invalidateQueries({ queryKey: ['analysis', tenderId] });
    queryClient.invalidateQueries({ queryKey: ['product-match', tenderId] });
    queryClient.invalidateQueries({ queryKey: ['documents', tenderId] });
    queryClient.invalidateQueries({ queryKey: ['validation', tenderId] });
    queryClient.invalidateQueries({ queryKey: ['tenders'] });
  }, [queryClient, tenderId]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold">{tenderName || tenderId}</h2>
          {tenderName && <div className="text-xs text-gray-400">{tenderId}</div>}
        </div>
        {companies && companies.length > 0 && (
          <select
            onChange={(e) => e.target.value && handleCompanyChange(e.target.value)}
            defaultValue=""
            className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 focus:border-blue-500 focus:outline-none"
          >
            <option value="" disabled>Firma...</option>
            {companies.map(c => (
              <option key={c.id} value={c.id}>{c.nazev}</option>
            ))}
          </select>
        )}
      </div>

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
