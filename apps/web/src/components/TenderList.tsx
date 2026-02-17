import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { getTenders, uploadFiles, type TenderSummary } from '../lib/api';
import FileUpload from './FileUpload';
import { FileText, CheckCircle2 } from 'lucide-react';
import { cn } from '../lib/cn';

interface TenderListProps {
  onSelect: (tenderId: string) => void;
}

function getCompletedSteps(steps: TenderSummary['steps']): number {
  return Object.values(steps).filter((s) => s === 'done').length;
}

export default function TenderList({ onSelect }: TenderListProps) {
  const queryClient = useQueryClient();
  const [isUploading, setIsUploading] = useState(false);

  const { data: tenders, isLoading } = useQuery({
    queryKey: ['tenders'],
    queryFn: getTenders,
  });

  const handleUpload = async (files: File[]) => {
    setIsUploading(true);
    try {
      await uploadFiles(files);
      queryClient.invalidateQueries({ queryKey: ['tenders'] });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-lg font-semibold">Nová zakázka</h2>
        <p className="mb-4 text-sm text-gray-500">Nahrajte PDF a DOCX soubory zadávací dokumentace</p>
        <FileUpload onUpload={handleUpload} isUploading={isUploading} />
      </div>

      <div>
        <h2 className="text-lg font-semibold">Zakázky</h2>
        {isLoading ? (
          <div className="py-8 text-center text-gray-500">Načítám...</div>
        ) : !tenders?.length ? (
          <div className="py-8 text-center text-gray-500">Žádné zakázky. Nahrajte dokumenty výše.</div>
        ) : (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {tenders.map((tender) => {
              const completed = getCompletedSteps(tender.steps);
              return (
                <button
                  key={tender.id}
                  onClick={() => onSelect(tender.id)}
                  className="rounded-lg border bg-white p-4 text-left transition-shadow hover:shadow-md"
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <FileText className="h-5 w-5 text-blue-500" />
                      <span className="font-medium">{tender.id}</span>
                    </div>
                    {completed === 5 ? (
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                    ) : completed > 0 ? (
                      <span className="text-xs text-gray-500">{completed}/5</span>
                    ) : null}
                  </div>
                  <div className="mt-2 text-xs text-gray-500">
                    {tender.inputFiles.length} soubor(ů)
                  </div>
                  <div className="mt-3 flex gap-1">
                    {(['extract', 'analyze', 'match', 'generate', 'validate'] as const).map((step) => (
                      <div
                        key={step}
                        className={cn(
                          'h-1.5 flex-1 rounded-full',
                          tender.steps[step] === 'done' ? 'bg-green-400' :
                          tender.steps[step] === 'error' ? 'bg-red-400' :
                          'bg-gray-200'
                        )}
                      />
                    ))}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
