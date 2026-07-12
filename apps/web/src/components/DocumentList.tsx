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
  finalizeTender,
  getPrilohaChecklist,
  createKvalifikaceVyjimka,
  getBalikChecklist,
  confirmBalikItem,
  prevzitUplnost,
  zamitnoutBalikPozadavek,
  downloadWithAuth,
  type FieldValidationResult,
  type PrilohaChecklistItem,
} from '../lib/api';
import { FileText, Download, Upload, Trash2, Paperclip, Archive, ChevronDown, ChevronRight, ShieldCheck, ShieldAlert, Send } from 'lucide-react';
import { Button, Card, Badge, useToast } from './ui';
import { finalizeWithInvalidation } from '../lib/finalize-flow';
import SubmissionCockpit from './SubmissionCockpit';

interface DocumentListProps {
  tenderId: string;
  /** Vygenerované dokumenty jsou starší než poslední změna/potvrzení ceny. */
  stale?: boolean;
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

/**
 * Řádek checklistu kvalifikačních příloh — název dokladu + stav (nahráno/chybí).
 * Nahráno: badge se zdrojem (firma × zakázka) + název souboru. Chybí: badge + odkaz
 * na sekci nahrávání níže.
 */
function PrilohaChecklistRow({ item, onUpload, onException }: {
  item: PrilohaChecklistItem;
  onUpload: () => void;
  onException: () => void;
}) {
  const nahrano = item.status === 'nahrano' || item.status === 'expiruje';
  const expirovany = item.status === 'po_platnosti';
  const expiruje = item.status === 'expiruje';
  const hardRisk = item.povinny && (item.status === 'chybi' || expirovany);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-primary)' }}>
          {item.label}
        </span>
        {nahrano ? (
          <>
            <Badge tone={expiruje ? 'warning' : 'success'} size="sm">
              Nahráno ({item.zdroj === 'firma' ? 'firma' : 'zakázka'})
            </Badge>
            {item.filename && (
              <span
                title={item.filename}
                style={{
                  fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)',
                  maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}
              >
                {item.filename}
              </span>
            )}
          </>
        ) : (
          <>
            <Badge tone={expirovany ? 'danger' : 'warning'} size="sm">
              {expirovany ? 'Po platnosti' : 'Chybí'}
            </Badge>
            <button type="button" onClick={onUpload} className="text-xs font-medium text-blue-700">Nahrát</button>
            {hardRisk && !item.vyjimka && (
              <button type="button" onClick={onException} className="text-xs text-gray-600 underline">
                Podat i bez dokladu (výjimka)
              </button>
            )}
          </>
        )}
      </div>
      {hardRisk && (
        <span style={{ fontSize: 'var(--font-size-xs)', fontWeight: 600, color: 'var(--danger-fg)' }}>
          Bez tohoto dokladu bude nabídka vyřazena.
        </span>
      )}
      {item.vyjimka && <Badge tone="warning" size="sm">Výjimka: {item.vyjimka.duvod}</Badge>}
      {item.poznamka && (
        <span style={{ fontSize: 'var(--font-size-xs)', color: expirovany ? 'var(--danger-fg)' : 'var(--warning-fg)' }}>
          {item.poznamka}
        </span>
      )}
    </div>
  );
}

export default function DocumentList({ tenderId, stale }: DocumentListProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exceptionItem, setExceptionItem] = useState<PrilohaChecklistItem | null>(null);
  const [exceptionReason, setExceptionReason] = useState('');
  const [savingException, setSavingException] = useState(false);
  const [confirmingBalikKey, setConfirmingBalikKey] = useState<string | null>(null);
  const [auditDialog, setAuditDialog] = useState<{ mode: 'prevzit' | 'zamitnout'; klic?: string } | null>(null);
  const [auditReason, setAuditReason] = useState('');
  const [savingAudit, setSavingAudit] = useState(false);

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

  const { data: prilohaChecklist, isLoading: prilohaChecklistLoading } = useQuery({
    queryKey: ['priloha-checklist', tenderId],
    queryFn: () => getPrilohaChecklist(tenderId),
  });

  const { data: balikChecklist, isLoading: balikChecklistLoading } = useQuery({
    queryKey: ['balik-checklist', tenderId],
    queryFn: () => getBalikChecklist(tenderId),
  });

  const handleUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setActionError(null);
    try {
      await uploadAttachments(tenderId, Array.from(files));
      queryClient.invalidateQueries({ queryKey: ['attachments', tenderId] });
      queryClient.invalidateQueries({ queryKey: ['priloha-checklist', tenderId] });
      queryClient.invalidateQueries({ queryKey: ['balik-checklist', tenderId] });
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
      queryClient.invalidateQueries({ queryKey: ['priloha-checklist', tenderId] });
      queryClient.invalidateQueries({ queryKey: ['balik-checklist', tenderId] });
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

  // Stažení souboru s Authorization hlavičkou místo `?token=` v URL (viz downloadWithAuth).
  const handleDownload = useCallback(async (url: string, filename: string) => {
    try {
      await downloadWithAuth(url, filename);
    } catch (err) {
      toast((err as Error).message || 'Stažení souboru se nezdařilo.', 'danger');
    }
  }, [toast]);

  const handleFinalize = useCallback(async () => {
    setFinalizing(true);
    try {
      try {
        await finalizeWithInvalidation({
          finalize: () => finalizeTender(tenderId),
          invalidate: () => {
            void queryClient.invalidateQueries({ queryKey: ['tender-status', tenderId] });
            void queryClient.invalidateQueries({ queryKey: ['podani', tenderId] });
            void queryClient.invalidateQueries({ queryKey: ['inbox'] });
          },
        });
      } catch (err) {
        // Zpráva z API obsahuje výčet problémů brány (cenový strop, placeholdery, ceny).
        toast((err as Error).message, 'danger');
        return;
      }
      // Finalize už NEoznačuje zakázku jako odeslanou — jen vytvoří immutable balík.
      // Podání se zaznamená níže v sekci „Podání" (teprve to přepne stav na Odesláno).
      toast('Balík podání připraven — stáhněte jej a zaznamenejte podání níže.', 'success');
    } finally {
      setFinalizing(false);
    }
  }, [tenderId, queryClient, toast]);

  const handleException = useCallback(async () => {
    if (!exceptionItem || exceptionReason.trim().length < 10) return;
    setSavingException(true);
    try {
      await createKvalifikaceVyjimka(tenderId, exceptionItem.slot, exceptionReason.trim());
      await queryClient.invalidateQueries({ queryKey: ['priloha-checklist', tenderId] });
      toast('Výjimka byla auditovaně zaznamenána.', 'info');
      setExceptionItem(null);
      setExceptionReason('');
    } catch (err) {
      toast((err as Error).message, 'danger');
    } finally {
      setSavingException(false);
    }
  }, [exceptionItem, exceptionReason, queryClient, tenderId, toast]);

  const handleBalikConfirmation = useCallback(async (klic: string) => {
    setConfirmingBalikKey(klic);
    try {
      await confirmBalikItem(tenderId, klic);
      await queryClient.invalidateQueries({ queryKey: ['balik-checklist', tenderId] });
      toast('Pokrytí dokumentu bylo auditovaně potvrzeno.', 'success');
    } catch (err) {
      toast((err as Error).message, 'danger');
    } finally {
      setConfirmingBalikKey(null);
    }
  }, [queryClient, tenderId, toast]);

  const handleBalikAudit = useCallback(async () => {
    if (!auditDialog || auditReason.trim().length < 10) return;
    setSavingAudit(true);
    try {
      if (auditDialog.mode === 'prevzit') await prevzitUplnost(tenderId, auditReason.trim());
      else await zamitnoutBalikPozadavek(tenderId, auditDialog.klic!, auditReason.trim());
      await queryClient.invalidateQueries({ queryKey: ['balik-checklist', tenderId] });
      toast('Auditovaná korekce byla uložena.', 'success'); setAuditDialog(null); setAuditReason('');
    } catch (err) { toast((err as Error).message, 'danger'); }
    finally { setSavingAudit(false); }
  }, [auditDialog, auditReason, queryClient, tenderId, toast]);

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
  // Připraveno k odeslání = máme validaci a všechny dokumenty prošly (stejný signál jako banner).
  const readyToSubmit = Boolean(hasValidation && allDocsPass);

  return (
    <div className="space-y-6">
      {actionError && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">{actionError}</div>
      )}

      {/* Ceny se po vygenerování dokumentů změnily/potvrdily — dokumenty jsou zastaralé. */}
      {stale && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          <span>Dokumenty neodpovídají aktuálním cenám — spusťte znovu Generování.</span>
        </div>
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

      {/* Finalizace — brána na kompletní podatelný balík; vytvoří immutable balík podání.
          NEoznačuje zakázku jako odeslanou — to se děje až zaznamenáním podání v sekci Podání. */}
      {documents && documents.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white px-4 py-3">
          <Button
            variant="primary"
            iconLeft={<Send className="h-4 w-4" />}
            disabled={!readyToSubmit || finalizing}
            onClick={handleFinalize}
          >
            {finalizing ? 'Připravuji balík...' : 'Připravit balík k podání'}
          </Button>
          {!readyToSubmit && (
            <span className="text-xs text-gray-500">
              Nejprve doplňte cenu a dokumenty a spusťte validaci.
            </span>
          )}
        </div>
      )}

      {/* Submission cockpit — pravdivý stav podání (zobrazí se, jakmile existuje balík). */}
      <SubmissionCockpit tenderId={tenderId} />

      {/* Generated documents */}
      {documents && documents.length > 0 && (
        <div>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-700 uppercase tracking-wide">Vygenerované dokumenty</h3>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => handleDownload(getDocumentsZipUrl(tenderId), `dokumenty_${tenderId}.zip`)}
                className="flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <Archive className="h-3.5 w-3.5" />
                Stáhnout dokumenty
              </button>
              {attachments && attachments.length > 0 && (
                <button
                  type="button"
                  onClick={() => handleDownload(getBundleZipUrl(tenderId), `kompletni_nabidka_${tenderId}.zip`)}
                  className="flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                >
                  <Archive className="h-3.5 w-3.5" />
                  Kompletní nabídka
                </button>
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
                    <button
                      type="button"
                      onClick={() => handleDownload(getDocumentDownloadUrl(tenderId, filename), filename)}
                      className="flex items-center gap-3 flex-1 text-left"
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
                    </button>
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
                      <button
                        type="button"
                        onClick={() => handleDownload(getDocumentDownloadUrl(tenderId, filename), filename)}
                        title="Stáhnout"
                      >
                        <Download className="h-5 w-5 text-gray-400 hover:text-gray-600" />
                      </button>
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

      {/* Checklist kvalifikačních příloh — odvozený z kvalifikačních požadavků AI analýzy */}
      <Card title="Úplnost balíku vs. zadání">
        {balikChecklistLoading ? (
          <p className="m-0 text-sm text-gray-500">Načítám…</p>
        ) : !balikChecklist?.podporovana_analyza ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            <p>Analýza je z předchozí verze a neobsahuje seznam požadovaných dokumentů.</p>
            {balikChecklist?.prevzeti_uplnosti && <p className="mt-1">Odpovědnost převzal/a {balikChecklist.prevzeti_uplnosti.kdo}: {balikChecklist.prevzeti_uplnosti.duvod}</p>}
            <div className="mt-3 flex gap-2">
              <Button variant="primary" onClick={() => { window.location.hash = `#/tender/${encodeURIComponent(tenderId)}?tab=analyza`; }}>Spustit analýzu znovu</Button>
              <Button variant="secondary" onClick={() => setAuditDialog({ mode: 'prevzit' })}>Převzít odpovědnost za úplnost</Button>
            </div>
          </div>
        ) : balikChecklist.items.length === 0 ? (
          <p className="m-0 text-sm text-gray-500">Zadávací dokumentace nepožaduje žádné další dokumenty nabídky.</p>
        ) : (
          <div>
            <p className="mb-2 text-sm font-medium text-gray-700">
              {balikChecklist.items.filter((item) => item.status === 'pokryto' || item.potvrzeni).length}/{balikChecklist.items.length} pokryto
            </p>
            {balikChecklist.items.map((item) => {
              const covered = item.status === 'pokryto' || Boolean(item.potvrzeni) || Boolean(item.zamitnuti);
              return (
                <div key={item.klic} className="border-b border-gray-100 py-2 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 text-sm text-gray-900">{item.nazev}</span>
                    <Badge tone={covered ? 'success' : item.status === 'chybi' ? 'danger' : 'warning'} size="sm">
                      {covered ? 'Pokryto' : item.status === 'chybi' ? 'Chybí' : 'Nejisté'}
                    </Badge>
                    {item.status === 'nejiste' && !item.potvrzeni && (
                      <Button
                        variant="secondary"
                        disabled={confirmingBalikKey === item.klic}
                        onClick={() => handleBalikConfirmation(item.klic)}
                      >
                        {confirmingBalikKey === item.klic ? 'Potvrzuji…' : 'Potvrdit, že je pokryto'}
                      </Button>
                    )}
                    {!item.zamitnuti && <Button variant="secondary" onClick={() => setAuditDialog({ mode: 'zamitnout', klic: item.klic })}>V ZD není požadováno</Button>}
                  </div>
                  {item.popis && <p className="mt-1 text-xs text-gray-500">{item.popis}</p>}
                  {item.soubor && <p className="mt-1 text-xs text-gray-500">Soubor: {item.soubor}</p>}
                  {item.poznamka && <p className="mt-1 text-xs text-amber-700">{item.poznamka}</p>}
                  {item.potvrzeni_propadlo && <p className="mt-1 text-xs font-semibold text-red-700">potvrzení propadlo, dokumenty se změnily</p>}
                  {item.zamitnuti && <p className="mt-1 text-xs text-amber-700">Operátor označil: v ZD není požadováno ({item.zamitnuti.duvod})</p>}
                  {item.status === 'chybi' && item.povinny && (
                    <p className="mt-1 text-xs font-semibold text-red-700">Bez tohoto dokumentu bude nabídka vyřazena.</p>
                  )}
                  {item.potvrzeni && (
                    <p className="mt-1 text-xs text-gray-500">Ručně potvrdil/a {item.potvrzeni.potvrdil}.</p>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {auditDialog && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
        <p className="font-semibold">{auditDialog.mode === 'prevzit' ? 'Převzít odpovědnost za úplnost' : 'Označit požadavek jako chybný'}</p>
        <textarea className="mt-2 w-full rounded border p-2" value={auditReason} onChange={(e) => setAuditReason(e.target.value)} placeholder="Auditní důvod (alespoň 10 znaků)" />
        <div className="mt-2 flex gap-2"><Button variant="primary" disabled={auditReason.trim().length < 10 || savingAudit} onClick={handleBalikAudit}>Uložit</Button><Button variant="secondary" onClick={() => setAuditDialog(null)}>Zrušit</Button></div>
      </div>}

      <Card title="Kvalifikační přílohy">
        {prilohaChecklistLoading ? (
          <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>Načítám…</p>
        ) : !prilohaChecklist?.analyza_hotova ? (
          <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>
            Spusťte AI analýzu — checklist se odvozuje z kvalifikačních požadavků.
          </p>
        ) : prilohaChecklist.items.length === 0 ? (
          <p style={{ margin: 0, fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>
            Analýza nevyžaduje žádné kvalifikační doklady.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {prilohaChecklist.items.map((item) => (
              <PrilohaChecklistRow
                key={item.slot}
                item={item}
                onUpload={() => { document.getElementById('kvalifikacni-doklady')?.scrollIntoView(); fileInputRef.current?.click(); }}
                onException={() => { setExceptionItem(item); setExceptionReason(''); }}
              />
            ))}
          </div>
        )}
        {prilohaChecklist?.analyza_hotova && prilohaChecklist.company_id === null
          && prilohaChecklist.items.some((i) => i.status === 'chybi') && (
          <p style={{ margin: '10px 0 0', fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
            Přiřaďte zakázce firmu (Nastavení → Firmy), doklady se doplní automaticky.
          </p>
        )}
      </Card>

      {exceptionItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h3 className="font-semibold text-gray-900">Výjimka pro povinný doklad</h3>
            <p className="mt-2 text-sm text-red-700">Bez dokladu „{exceptionItem.label}“ může být nabídka vyřazena.</p>
            <label className="mt-4 block text-sm font-medium text-gray-700" htmlFor="exception-reason">Důvod (min. 10 znaků)</label>
            <textarea id="exception-reason" value={exceptionReason} onChange={(event) => setExceptionReason(event.target.value)}
              className="mt-1 min-h-24 w-full rounded-md border border-gray-300 p-2 text-sm" autoFocus />
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setExceptionItem(null)}>Zrušit</Button>
              <Button variant="primary" disabled={exceptionReason.trim().length < 10 || savingException} onClick={handleException}>
                {savingException ? 'Ukládám…' : 'Schválit výjimku'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Qualification documents (attachments) */}
      <div id="kvalifikacni-doklady">
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
                <button
                  type="button"
                  onClick={() => handleDownload(getAttachmentDownloadUrl(tenderId, filename), filename)}
                  className="flex items-center gap-3 flex-1 text-left hover:text-blue-600 transition-colors"
                >
                  <Paperclip className="h-6 w-6 text-amber-500" />
                  <div className="font-medium text-sm">{filename}</div>
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleDownload(getAttachmentDownloadUrl(tenderId, filename), filename)}
                    title="Stáhnout"
                  >
                    <Download className="h-4 w-4 text-gray-400 hover:text-gray-600" />
                  </button>
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
