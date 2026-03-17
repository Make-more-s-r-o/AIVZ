import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getCompanies, createCompany, updateCompanyApi, deleteCompanyApi,
  getCompanyDocs, uploadCompanyDocs, deleteCompanyDoc,
  type CompanyData, type DocSlotEntry,
} from '../lib/api';
import { Building2, Trash2, Upload, FileText, Pencil, Plus, X, Check, AlertTriangle } from 'lucide-react';

const DOC_SLOTS = [
  { type: 'vypis_or',           label: 'Výpis z obchodního rejstříku', multi: false },
  { type: 'rejstrik_trestu',    label: 'Výpis z rejstříku trestů',     multi: false },
  { type: 'potvrzeni_fu',       label: 'Potvrzení finančního úřadu',   multi: false },
  { type: 'potvrzeni_ossz',     label: 'Potvrzení OSSZ',               multi: false },
  { type: 'profesni_opravneni', label: 'Profesní oprávnění',           multi: false },
  { type: 'ostatni',            label: 'Ostatní',                       multi: true  },
] as const;

export default function CompanySettings() {
  const [companies, setCompanies] = useState<CompanyData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await getCompanies();
      setCompanies(data);
      setError('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Neznámá chyba');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string) => {
    if (!confirm('Opravdu smazat tuto firmu?')) return;
    try {
      await deleteCompanyApi(id);
      if (editId === id) setEditId(null);
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Neznámá chyba');
    }
  };

  if (loading) return <div className="py-8 text-center text-gray-500">Načítání firem...</div>;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">Správa firem</h2>
        <button
          onClick={() => { setShowForm(!showForm); setEditId(null); }}
          className="flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {showForm ? <><X className="h-4 w-4" /> Zrušit</> : <><Plus className="h-4 w-4" /> Přidat firmu</>}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {showForm && (
        <CompanyForm
          onSave={async () => { setShowForm(false); await load(); }}
          onCancel={() => setShowForm(false)}
        />
      )}

      <div className="space-y-4">
        {companies.map(company => (
          <CompanyCard
            key={company.id}
            company={company}
            isEditing={editId === company.id}
            onEdit={() => setEditId(editId === company.id ? null : company.id)}
            onDelete={() => handleDelete(company.id)}
            onSaved={load}
          />
        ))}
        {companies.length === 0 && !showForm && (
          <div className="py-8 text-center text-gray-500">Žádné firmy. Přidejte firmu výše.</div>
        )}
      </div>
    </div>
  );
}

// --- Company Form (create/edit) ---

interface CompanyFormProps {
  company?: CompanyData;
  onSave: () => Promise<void>;
  onCancel: () => void;
}

function CompanyForm({ company, onSave, onCancel }: CompanyFormProps) {
  const [form, setForm] = useState({
    nazev: company?.nazev || '',
    ico: company?.ico || '',
    dic: company?.dic || '',
    sidlo: company?.sidlo || '',
    jednajici_osoba: company?.jednajici_osoba || '',
    telefon: company?.telefon || '',
    email: company?.email || '',
    ucet: company?.ucet || '',
    datova_schranka: company?.datova_schranka || '',
    rejstrik: company?.rejstrik || '',
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setFormError('');
    try {
      if (company) {
        await updateCompanyApi(company.id, form);
      } else {
        await createCompany(form);
      }
      await onSave();
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Neznámá chyba');
    } finally {
      setSaving(false);
    }
  };

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [key]: e.target.value }));

  return (
    <form onSubmit={handleSubmit} className="mb-6 rounded-lg border bg-gray-50 p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-700">
        {company ? 'Upravit firmu' : 'Nová firma'}
      </h3>
      {formError && (
        <div className="mb-3 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{formError}</div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Název firmy *" value={form.nazev} onChange={set('nazev')} required placeholder="Make more s.r.o." />
        <Field label="IČO *" value={form.ico} onChange={set('ico')} required placeholder="07023987" />
        <Field label="DIČ" value={form.dic} onChange={set('dic')} placeholder="CZ07023987" />
        <Field label="Sídlo *" value={form.sidlo} onChange={set('sidlo')} required placeholder="Ulice 123, Praha" />
        <Field label="Jednající osoba *" value={form.jednajici_osoba} onChange={set('jednajici_osoba')} required placeholder="Jan Novák" />
        <Field label="Telefon" value={form.telefon} onChange={set('telefon')} placeholder="737061492" />
        <Field label="E-mail" value={form.email} onChange={set('email')} type="email" placeholder="info@firma.cz" />
        <Field label="Bankovní účet" value={form.ucet} onChange={set('ucet')} placeholder="283090885/0300" />
        <Field label="Datová schránka" value={form.datova_schranka} onChange={set('datova_schranka')} placeholder="abc123" />
        <Field label="Zápis v rejstříku" value={form.rejstrik} onChange={set('rejstrik')} placeholder="C 293255 u Městského soudu" className="sm:col-span-2 lg:col-span-3" />
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={saving}
          className="rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
        >
          {saving ? 'Ukládám...' : company ? 'Uložit' : 'Vytvořit'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded border px-4 py-2 text-sm text-gray-600 hover:bg-gray-100"
        >
          Zrušit
        </button>
      </div>
    </form>
  );
}

function Field({ label, className, ...props }: { label: string; className?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className={className}>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      <input
        {...props}
        className="w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
      />
    </div>
  );
}

// --- Company Card ---

interface CompanyCardProps {
  company: CompanyData;
  isEditing: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onSaved: () => Promise<void>;
}

function CompanyCard({ company, isEditing, onEdit, onDelete, onSaved }: CompanyCardProps) {
  return (
    <div className="rounded-lg border bg-white">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <Building2 className="h-5 w-5 text-gray-400" />
          <div>
            <div className="font-medium text-gray-900">{company.nazev}</div>
            <div className="text-xs text-gray-500">
              IČO: {company.ico} | {company.jednajici_osoba}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onEdit}
            className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            title="Upravit"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={onDelete}
            className="rounded p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-500"
            title="Smazat"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {isEditing && (
        <div className="border-t px-4 py-3">
          <CompanyForm
            company={company}
            onSave={async () => { onEdit(); await onSaved(); }}
            onCancel={onEdit}
          />
          <CompanyDocuments companyId={company.id} />
        </div>
      )}
    </div>
  );
}

// --- Company Documents ---

function CompanyDocuments({ companyId }: { companyId: string }) {
  const [entries, setEntries] = useState<DocSlotEntry[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const fileRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const loadDocs = useCallback(async () => {
    try {
      const resp = await getCompanyDocs(companyId);
      setEntries(resp.entries);
      setDocError(null);
    } catch (err) {
      console.error('Failed to load docs:', err);
    }
  }, [companyId]);

  useEffect(() => { loadDocs(); }, [loadDocs]);

  const handleUpload = async (slotType: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(slotType);
    setDocError(null);
    try {
      const resp = await uploadCompanyDocs(companyId, Array.from(files), slotType);
      setEntries(resp.entries);
    } catch (err) {
      console.error('Upload failed:', err);
      setDocError('Nahrání souboru se nezdařilo.');
    }
    setUploading(null);
    const ref = fileRefs.current[slotType];
    if (ref) ref.value = '';
  };

  const handleDelete = async (slot: string, filename: string) => {
    if (!window.confirm('Opravdu smazat tento dokument?')) return;
    try {
      const resp = await deleteCompanyDoc(companyId, filename, slot);
      setEntries(resp.entries);
    } catch (err) {
      console.error('Delete failed:', err);
      setDocError('Smazání souboru se nezdařilo.');
    }
  };

  return (
    <div className="mt-4 rounded-lg border border-dashed border-gray-300 p-3">
      {docError && (
        <div className="mb-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{docError}</div>
      )}
      <h4 className="mb-3 text-xs font-semibold text-gray-600 uppercase">Výchozí kvalifikační doklady</h4>
      <div className="space-y-2">
        {DOC_SLOTS.map(slot => {
          const slotEntries = entries.filter(e => e.slot === slot.type);
          const isUploading = uploading === slot.type;

          return (
            <div key={slot.type} className="flex items-start gap-3 rounded px-2 py-1.5 hover:bg-gray-50">
              {/* Label */}
              <div className="w-56 shrink-0 text-xs font-medium text-gray-600 pt-0.5">
                {slot.label}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                {slotEntries.length === 0 ? (
                  <div className="flex items-center gap-1.5 text-xs text-amber-600">
                    <AlertTriangle className="h-3 w-3" />
                    <span>Nenahrán</span>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {slotEntries.map(entry => (
                      <div key={entry.filename} className="flex items-center gap-2 text-xs">
                        <Check className="h-3 w-3 text-green-600 shrink-0" />
                        <FileText className="h-3 w-3 text-gray-400 shrink-0" />
                        <span className="truncate text-gray-700">{entry.filename}</span>
                        <button
                          onClick={() => handleDelete(entry.slot, entry.filename)}
                          className="ml-auto shrink-0 text-gray-400 hover:text-red-500"
                          title="Smazat"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Upload button */}
              <label className="shrink-0 flex cursor-pointer items-center gap-1 rounded border border-dashed border-gray-300 px-2 py-1 text-xs text-gray-500 hover:border-blue-400 hover:text-blue-600">
                <Upload className="h-3 w-3" />
                {isUploading ? '...' : slot.multi && slotEntries.length > 0 ? '+ Nahrát' : 'Nahrát'}
                <input
                  ref={(el) => { fileRefs.current[slot.type] = el; }}
                  type="file"
                  multiple={slot.multi}
                  accept=".pdf,.docx,.doc,.xls,.xlsx,.jpg,.jpeg,.png"
                  onChange={(e) => handleUpload(slot.type, e)}
                  className="hidden"
                  disabled={isUploading}
                />
              </label>
            </div>
          );
        })}
      </div>
    </div>
  );
}
