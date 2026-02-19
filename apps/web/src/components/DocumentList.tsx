import { useRef, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getDocuments,
  getDocumentDownloadUrl,
  getAttachments,
  uploadAttachments,
  deleteAttachment,
  getAttachmentDownloadUrl,
} from '../lib/api';
import { FileText, Download, Upload, Trash2, Paperclip } from 'lucide-react';

interface DocumentListProps {
  tenderId: string;
}

const DOC_LABELS: Record<string, string> = {
  'technicky_navrh.docx': 'Technicky navrh',
  'cenova_nabidka.docx': 'Cenova nabidka',
  'kryci_list.docx': 'Kryci list',
  'cestne_prohlaseni.docx': 'Cestne prohlaseni',
  'seznam_poddodavatelu.docx': 'Seznam poddodavatelu',
  'kupni_smlouva.docx': 'Kupni smlouva',
  'technicka_specifikace.docx': 'Technicka specifikace',
};

export default function DocumentList({ tenderId }: DocumentListProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const { data: documents, isLoading, error } = useQuery({
    queryKey: ['documents', tenderId],
    queryFn: () => getDocuments(tenderId),
  });

  const { data: attachments } = useQuery({
    queryKey: ['attachments', tenderId],
    queryFn: () => getAttachments(tenderId),
  });

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      await uploadAttachments(tenderId, Array.from(files));
      queryClient.invalidateQueries({ queryKey: ['attachments', tenderId] });
    } catch (err) {
      console.error('Upload failed:', err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [tenderId, queryClient]);

  const handleDelete = useCallback(async (filename: string) => {
    try {
      await deleteAttachment(tenderId, filename);
      queryClient.invalidateQueries({ queryKey: ['attachments', tenderId] });
    } catch (err) {
      console.error('Delete failed:', err);
    }
  }, [tenderId, queryClient]);

  if (isLoading) return <div className="py-8 text-center text-gray-500">Nacitam dokumenty...</div>;
  if (error) return <div className="py-8 text-center text-gray-500">Dokumenty zatim nejsou k dispozici. Spustte krok "Dokumenty".</div>;

  return (
    <div className="space-y-6">
      {/* Generated documents */}
      {documents && documents.length > 0 && (
        <div>
          <h3 className="mb-3 text-sm font-semibold text-gray-700 uppercase tracking-wide">Vygenerovane dokumenty</h3>
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
        </div>
      )}

      {/* Qualification documents (attachments) */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Kvalifikacni doklady</h3>
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors">
            <Upload className="h-4 w-4" />
            {uploading ? 'Nahravam...' : 'Nahrat prilohu'}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.docx,.doc,.xls,.xlsx,.jpg,.jpeg,.png"
              onChange={handleUpload}
              className="hidden"
              disabled={uploading}
            />
          </label>
        </div>

        {(!attachments || attachments.length === 0) ? (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
            <Paperclip className="mx-auto mb-2 h-8 w-8 text-gray-300" />
            <p>Zadne kvalifikacni doklady.</p>
            <p className="mt-1 text-xs">Nahrajte vypis z OR, zivnostensky list, reference, partnerstvi vyrobce apod.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {attachments.map((filename) => (
              <div
                key={filename}
                className="flex items-center justify-between rounded-lg border bg-white p-4"
              >
                <a
                  href={getAttachmentDownloadUrl(tenderId, filename)}
                  download
                  className="flex items-center gap-3 flex-1 hover:text-blue-600 transition-colors"
                >
                  <Paperclip className="h-6 w-6 text-amber-500" />
                  <div className="font-medium text-sm">{filename}</div>
                </a>
                <div className="flex items-center gap-2">
                  <a href={getAttachmentDownloadUrl(tenderId, filename)} download>
                    <Download className="h-4 w-4 text-gray-400 hover:text-gray-600" />
                  </a>
                  <button
                    onClick={() => handleDelete(filename)}
                    className="text-gray-400 hover:text-red-500 transition-colors"
                    title="Smazat"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
