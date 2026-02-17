import { useQuery } from '@tanstack/react-query';
import { getDocuments, getDocumentDownloadUrl } from '../lib/api';
import { FileText, Download } from 'lucide-react';

interface DocumentListProps {
  tenderId: string;
}

const DOC_LABELS: Record<string, string> = {
  'technicky_navrh.docx': 'Technický návrh',
  'cenova_nabidka.docx': 'Cenová nabídka',
  'kryci_list.docx': 'Krycí list',
  'cestne_prohlaseni.docx': 'Čestné prohlášení',
  'seznam_poddodavatelu.docx': 'Seznam poddodavatelů',
};

export default function DocumentList({ tenderId }: DocumentListProps) {
  const { data: documents, isLoading, error } = useQuery({
    queryKey: ['documents', tenderId],
    queryFn: () => getDocuments(tenderId),
  });

  if (isLoading) return <div className="py-8 text-center text-gray-500">Načítám dokumenty...</div>;
  if (error) return <div className="py-8 text-center text-gray-500">Dokumenty zatím nejsou k dispozici. Spusťte krok "Dokumenty".</div>;
  if (!documents?.length) return <div className="py-8 text-center text-gray-500">Žádné dokumenty.</div>;

  return (
    <div className="space-y-2">
      {documents.map((filename) => (
        <a
          key={filename}
          href={getDocumentDownloadUrl(tenderId, filename)}
          download
          className="flex items-center justify-between rounded-lg border bg-white p-4 transition-colors hover:bg-gray-50"
        >
          <div className="flex items-center gap-3">
            <FileText className="h-8 w-8 text-blue-500" />
            <div>
              <div className="font-medium">{DOC_LABELS[filename] || filename}</div>
              <div className="text-xs text-gray-500">{filename}</div>
            </div>
          </div>
          <Download className="h-5 w-5 text-gray-400" />
        </a>
      ))}
    </div>
  );
}
