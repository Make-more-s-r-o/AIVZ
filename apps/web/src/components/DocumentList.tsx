import { useRef, useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getDocuments,
  getDocumentDownloadUrl,
  getAttachments,
  uploadAttachments,
  deleteAttachment,
  getAttachmentDownloadUrl,
  getDocumentsZipUrl,
  getBundleZipUrl,
  getGenerationMeta,
  getFieldValidation,
  setDocumentMode,
  type FieldValidationResult,
} from '../lib/api';
import { FileText, Download, Upload, Trash2, Paperclip, Archive, ChevronDown, ChevronRight, ShieldCheck, ShieldAlert } from 'lucide-react';

interface DocumentListProps {
  tenderId: string;
}

const DOC_LABELS: Record<string, string> = {
  'technicky_navrh.docx': 'Technický návrh',
  'technicky_navrh.pdf': 'Technický návrh (PDF)',
  'cenova_nabidka.docx': 'Cenová nabídka',
  'cenova_nabidka.pdf': 'Cenová nabídka (PDF)',
  'kryci_list.docx': 'Krycí list',
  'kryci_list.pdf': 'Krycí list (PDF)',
  'cestne_prohlaseni.docx': 'Čestné prohlášení',
  'cestne_prohlaseni.pdf': 'Čestné prohlášení (PDF)',
  'seznam_poddodavatelu.docx': 'Seznam poddodavatelů',
  'seznam_poddodavatelu.pdf': 'Seznam poddodavatelů (PDF)',
  'kupni_smlouva.docx': 'Kupní smlouva',
  'kupni_smlouva.pdf': 'Kupní smlouva (PDF)',
  'technicka_specifikace.docx': 'Technická specifikace',
  'technicka_specifikace.pdf': 'Technická specifikace (PDF)',
};

const MODE_BADGES: Record<string, { label: string; color: string }> = {
  clean: { label: 'Clean', color: 'bg-green-100 text-green-800' },
  reconstruct: { label: 'Reconstruct', color: 'bg-blue-100 text-blue-800' },
  fill: { label: 'Fill', color: 'bg-amber-100 text-amber-800' },
  programmatic: { label: 'Built-in', color: 'bg-green-100 text-green-800' },
};

function ConfidenceBadge({ confidence }: { confidence: number }) {
  let color = 'text-green-600';
  if (confidence < 80) color = 'text-red-600';
  else if (confidence < 95) color = 'text-amber-600';
  return <span className={`text-xs font-semibold ${color}`}>{confidence}%</span>;
}

function ValidationChecklist({ result }: { result: FieldValidationResult }) {
  const [expanded, setExpanded] = useState(false);
  const passCount = result.checks.filter(c => c.status === 'pass').length;
  const failCount = result.checks.filter(c => c.status === 'fail').length;
  const warnCount = result.checks.filter(c => c.status === 'warning').length;

  return (
    <div className="mt-2 border-t pt-2">
      <button
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded(!expanded); }}
        className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700"
      >
        {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="text-green-600">{passCount} OK</span>
        {failCount > 0 && <span className="text-red-600">{failCount} chyb</span>}
        {warnCount > 0 && <span className="text-amber-600">{warnCount} upoz.</span>}
      </button>
      {expanded && (
        <div className="mt-1.5 space-y-1 text-xs">
          {result.checks.map((check, i) => (
            <div key={i} className="flex items-start gap-1.5">
              {check.status === 'pass' && <span className="text-green-500 font-bold shrink-0">OK</span>}
              {check.status === 'fail' && <span className="text-red-500 font-bold shrink-0">X</span>}
              {check.status === 'warning' && <span className="text-amber-500 font-bold shrink-0">!</span>}
              <span className="text-gray-600">
                <strong>{check.field}:</strong>{' '}
                {check.status === 'pass'
                  ? check.expected
                  : <><span className="line-through text-red-400">{check.actual}</span> (očekáváno: {check.expected})</>
                }
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function DocumentList({ tenderId }: DocumentListProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const { data: documents, isLoading, error } = useQuery({
    queryKey: ['documents', tenderId],
    queryFn: () => getDocuments(tenderId),
  });

  const { data: attachments } = useQuery({
    queryKey: ['attachments', tenderId],
    queryFn: () => getAttachments(tenderId),
  });

  const { data: genMeta } = useQuery({
    queryKey: ['generation-meta', tenderId],
    queryFn: () => getGenerationMeta(tenderId),
    retry: false,
  });

  const { data: fieldValidation } = useQuery({
    queryKey: ['field-validation', tenderId],
    queryFn: () => getFieldValidation(tenderId),
    retry: false,
  });

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setActionError(null);
    try {
      await uploadAttachments(tenderId, Array.from(files));
      queryClient.invalidateQueries({ queryKey: ['attachments', tenderId] });
    } catch (err) {
      console.error('Upload failed:', err);
      setActionError('Nahrání přílohy se nezdařilo.');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [tenderId, queryClient]);

  const handleDelete = useCallback(async (filename: string) => {
    if (!window.confirm('Opravdu smazat tuto přílohu?')) return;
    setActionError(null);
    try {
      await deleteAttachment(tenderId, filename);
      queryClient.invalidateQueries({ queryKey: ['attachments', tenderId] });
    } catch (err) {
      console.error('Delete failed:', err);
      setActionError('Smazání přílohy se nezdařilo.');
    }
  }, [tenderId, queryClient]);

  const handleModeChange = useCallback(async (filename: string, mode: 'clean' | 'reconstruct' | 'fill') => {
    setActionError(null);
    try {
      await setDocumentMode(tenderId, filename, mode);
      queryClient.invalidateQueries({ queryKey: ['generation-meta', tenderId] });
    } catch (err) {
      console.error('Mode change failed:', err);
      setActionError('Změna režimu se nezdařila.');
    }
  }, [tenderId, queryClient]);

  if (isLoading) return <div className="py-8 text-center text-gray-500">Načítám dokumenty...</div>;
  if (error) return <div className="py-8 text-center text-gray-500">Dokumenty zatím nejsou k dispozici. Spusťte krok "Dokumenty".</div>;

  // Build validation lookup
  const validationByDoc = new Map<string, FieldValidationResult>();
  if (fieldValidation) {
    for (const r of fieldValidation) {
      validationByDoc.set(r.document, r);
    }
  }

  // Overall readiness
  const allDocsPass = fieldValidation?.every(r => r.overall === 'pass');
  const hasValidation = fieldValidation && fieldValidation.length > 0;

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{actionError}</div>
      )}

      {/* Overall status banner */}
      {hasValidation && (
        <div className={`flex items-center gap-3 rounded-lg border px-4 py-3 ${
          allDocsPass
            ? 'border-green-200 bg-green-50 text-green-800'
            : 'border-amber-200 bg-amber-50 text-amber-800'
        }`}>
          {allDocsPass
            ? <><ShieldCheck className="h-5 w-5" /> <span className="font-medium">Dokumenty jsou připraveny k odeslání</span></>
            : <><ShieldAlert className="h-5 w-5" /> <span className="font-medium">Některé dokumenty vyžadují kontrolu</span></>
          }
        </div>
      )}

      {/* Generated documents */}
      {documents && documents.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Vygenerované dokumenty</h3>
            <div className="flex gap-2">
              <a
                href={getDocumentsZipUrl(tenderId)}
                download
                className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <Archive className="h-3.5 w-3.5" />
                Stáhnout dokumenty
              </a>
              {attachments && attachments.length > 0 && (
                <a
                  href={getBundleZipUrl(tenderId)}
                  download
                  className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                >
                  <Archive className="h-3.5 w-3.5" />
                  Kompletní nabídka
                </a>
              )}
            </div>
          </div>
          <div className="space-y-2">
            {documents.map((filename) => {
              const meta = genMeta?.[filename];
              const validation = validationByDoc.get(filename);
              const mode = meta?.mode;
              const modeBadge = mode ? MODE_BADGES[mode] : null;

              return (
                <div
                  key={filename}
                  className="rounded-lg border bg-white p-4 transition-colors hover:bg-gray-50"
                >
                  <div className="flex items-center justify-between">
                    <a
                      href={getDocumentDownloadUrl(tenderId, filename)}
                      download
                      className="flex items-center gap-3 flex-1"
                    >
                      <FileText className="h-8 w-8 text-blue-500 shrink-0" />
                      <div className="min-w-0">
                        <div className="font-medium flex items-center gap-2">
                          {DOC_LABELS[filename] || filename}
                          {modeBadge && (
                            <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${modeBadge.color}`}>
                              {modeBadge.label}
                            </span>
                          )}
                          {validation && <ConfidenceBadge confidence={validation.confidence} />}
                        </div>
                        <div className="text-xs text-gray-500 flex items-center gap-2">
                          {filename}
                          {meta?.cost_czk !== undefined && meta.cost_czk > 0 && (
                            <span className="text-gray-400">({meta.cost_czk.toFixed(2)} CZK)</span>
                          )}
                        </div>
                      </div>
                    </a>
                    <div className="flex items-center gap-2 shrink-0">
                      {/* Mode selector — only for DOCX files with known modes */}
                      {filename.endsWith('.docx') && mode && (
                        <select
                          value={mode}
                          onChange={(e) => {
                            e.stopPropagation();
                            handleModeChange(filename, e.target.value as 'clean' | 'reconstruct' | 'fill');
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="rounded border border-gray-300 px-1.5 py-1 text-xs text-gray-600 bg-white"
                          title="Režim generování"
                        >
                          <option value="clean">Clean</option>
                          <option value="reconstruct">Reconstruct</option>
                          <option value="fill">Fill</option>
                        </select>
                      )}
                      {validation && (
                        validation.overall === 'pass'
                          ? <span title="Validace OK"><ShieldCheck className="h-5 w-5 text-green-500" /></span>
                          : <span title="Vyžaduje kontrolu"><ShieldAlert className="h-5 w-5 text-amber-500" /></span>
                      )}
                      <a href={getDocumentDownloadUrl(tenderId, filename)} download>
                        <Download className="h-5 w-5 text-gray-400 hover:text-gray-600" />
                      </a>
                    </div>
                  </div>
                  {/* Validation checklist (expandable) */}
                  {validation && <ValidationChecklist result={validation} />}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Qualification documents (attachments) */}
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Kvalifikační doklady</h3>
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-dashed border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:border-blue-400 hover:text-blue-600 transition-colors">
            <Upload className="h-4 w-4" />
            {uploading ? 'Nahrávám...' : 'Nahrát přílohu'}
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
            <p>Žádné kvalifikační doklady.</p>
            <p className="mt-1 text-xs">Nahrajte výpis z OR, živnostenský list, reference, partnerství výrobce apod.</p>
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
