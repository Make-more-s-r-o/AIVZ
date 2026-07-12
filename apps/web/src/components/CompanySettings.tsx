import { useState, useEffect, useCallback, useRef } from 'react';
import {
  getCompanies, createCompany, updateCompanyApi, deleteCompanyApi,
  getCompanyDocs, uploadCompanyDocs, deleteCompanyDoc, setCompanyDocPlatnost,
  type CompanyData, type DocSlotEntry,
} from '../lib/api';
import { Building2, Trash2, Upload, FileText, Pencil, Plus, X, Check, AlertTriangle, CalendarClock } from 'lucide-react';

const DOC_SLOTS = [
  { type: 'vypis_or', label: 'Výpis z obchodního rejstříku', multi: false, bezne_pozadovan: true, dle_oboru: false, typicka_platnost_dnu: 90, popis: 'Výpis z obchodního rejstříku, ne starší 3 měsíců — justice.cz nebo Czech POINT.' },
  { type: 'rejstrik_trestu', label: 'Výpis z rejstříku trestů', multi: false, bezne_pozadovan: true, dle_oboru: false, typicka_platnost_dnu: 90, popis: 'Výpis z evidence Rejstříku trestů, ne starší 3 měsíců — Czech POINT nebo Portál občana.' },
  { type: 'potvrzeni_fu', label: 'Potvrzení finančního úřadu', multi: false, bezne_pozadovan: true, dle_oboru: false, typicka_platnost_dnu: 90, popis: 'Potvrzení o neexistenci daňových nedoplatků, ne starší 3 měsíců — finanční úřad nebo datová schránka.' },
  { type: 'potvrzeni_ossz', label: 'Potvrzení OSSZ', multi: false, bezne_pozadovan: true, dle_oboru: false, typicka_platnost_dnu: 90, popis: 'Potvrzení o neexistenci nedoplatků na sociálním zabezpečení, ne starší 3 měsíců — OSSZ nebo ePortál ČSSZ.' },
  { type: 'profesni_opravneni', label: 'Profesní oprávnění', multi: false, bezne_pozadovan: false, dle_oboru: true, typicka_platnost_dnu: null, popis: 'Doklad o oprávnění vykonávat regulovanou činnost — příslušná komora, úřad nebo profesní registr.' },
  { type: 'ostatni', label: 'Ostatní', multi: true, bezne_pozadovan: false, dle_oboru: false, typicka_platnost_dnu: null, popis: 'Další kvalifikační doklady podle konkrétní zakázky — zdroj určuje zadávací dokumentace.' },
] as const;

export default function CompanySettings() {
  const [companies, setCompanies] = useState<CompanyData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [addHover, setAddHover] = useState(false);

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

  if (loading) return <div className="py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Načítání firem...</div>;

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>Správa firem</h2>
        <button
          onClick={() => { setShowForm(!showForm); setEditId(null); }}
          onMouseEnter={() => setAddHover(true)}
          onMouseLeave={() => setAddHover(false)}
          className="flex items-center gap-2 rounded px-4 py-2 text-sm font-medium"
          style={{ background: addHover ? 'var(--accent-hover)' : 'var(--accent)', color: 'var(--text-on-accent)' }}
        >
          {showForm ? <><X className="h-4 w-4" /> Zrušit</> : <><Plus className="h-4 w-4" /> Přidat firmu</>}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded px-3 py-2 text-sm" style={{ background: 'var(--danger-soft-bg)', color: 'var(--danger-fg)' }}>{error}</div>
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
          <div className="py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Žádné firmy. Přidejte firmu výše.</div>
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
    default_marze_procent: company?.default_marze_procent ?? 10,
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [submitHover, setSubmitHover] = useState(false);
  const [cancelHover, setCancelHover] = useState(false);

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
    <form onSubmit={handleSubmit} className="mb-6 rounded-lg p-4" style={{ border: '1px solid var(--border-default)', background: 'var(--surface-sunken)' }}>
      <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
        {company ? 'Upravit firmu' : 'Nová firma'}
      </h3>
      {formError && (
        <div className="mb-3 rounded px-2 py-1 text-xs" style={{ background: 'var(--danger-soft-bg)', color: 'var(--danger-fg)' }}>{formError}</div>
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
        <Field
          label="Výchozí přirážka k nákupu (%)"
          value={form.default_marze_procent}
          onChange={(e) => setForm(prev => ({ ...prev, default_marze_procent: Number(e.target.value) }))}
          type="number"
          min={0}
          max={100}
          step={1}
          required
        />
        <Field label="Zápis v rejstříku" value={form.rejstrik} onChange={set('rejstrik')} placeholder="C 293255 u Městského soudu" className="sm:col-span-2 lg:col-span-3" />
      </div>
      <div className="mt-4 flex gap-2">
        <button
          type="submit"
          disabled={saving}
          onMouseEnter={() => setSubmitHover(true)}
          onMouseLeave={() => setSubmitHover(false)}
          className="rounded px-4 py-2 text-sm font-medium"
          style={{
            background: submitHover && !saving ? 'var(--green-700)' : 'var(--success-solid)',
            color: 'var(--text-on-accent)', opacity: saving ? 0.5 : 1,
          }}
        >
          {saving ? 'Ukládám...' : company ? 'Uložit' : 'Vytvořit'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          onMouseEnter={() => setCancelHover(true)}
          onMouseLeave={() => setCancelHover(false)}
          className="rounded px-4 py-2 text-sm"
          style={{
            border: '1px solid var(--border-default)', color: 'var(--text-secondary)',
            background: cancelHover ? 'var(--surface-hover)' : 'transparent',
          }}
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
      <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</label>
      <input
        {...props}
        className="w-full rounded px-3 py-2 text-sm focus:outline-none"
        style={{ border: '1px solid var(--border-strong)', background: 'var(--surface-card)', color: 'var(--text-primary)' }}
        onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--border-focus)'; props.onFocus?.(e); }}
        onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; props.onBlur?.(e); }}
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
  const [editHover, setEditHover] = useState(false);
  const [deleteHover, setDeleteHover] = useState(false);

  return (
    <div className="rounded-lg" style={{ border: '1px solid var(--border-default)', background: 'var(--surface-card)' }}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <Building2 className="h-5 w-5" style={{ color: 'var(--text-tertiary)' }} />
          <div>
            <div className="font-medium" style={{ color: 'var(--text-primary)' }}>{company.nazev}</div>
            <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              IČO: {company.ico} | {company.jednajici_osoba} | Výchozí přirážka: {company.default_marze_procent ?? 10} %
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={onEdit}
            onMouseEnter={() => setEditHover(true)}
            onMouseLeave={() => setEditHover(false)}
            className="rounded p-1.5"
            style={{
              color: editHover ? 'var(--text-secondary)' : 'var(--text-tertiary)',
              background: editHover ? 'var(--surface-hover)' : 'transparent',
            }}
            title="Upravit"
            aria-label="Upravit firmu"
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            onClick={onDelete}
            onMouseEnter={() => setDeleteHover(true)}
            onMouseLeave={() => setDeleteHover(false)}
            className="rounded p-1.5"
            style={{
              color: deleteHover ? 'var(--danger-solid)' : 'var(--text-tertiary)',
              background: deleteHover ? 'var(--danger-soft-bg)' : 'transparent',
            }}
            title="Smazat"
            aria-label="Smazat firmu"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {isEditing && (
        <div className="px-4 py-3" style={{ borderTop: '1px solid var(--border-default)' }}>
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

  const handleSetPlatnost = async (slot: string, filename: string, platnostDo: string | null) => {
    try {
      const resp = await setCompanyDocPlatnost(companyId, filename, platnostDo, slot);
      setEntries(resp.entries);
      setDocError(null);
    } catch (err) {
      console.error('Set platnost failed:', err);
      setDocError('Uložení platnosti se nezdařilo.');
    }
  };

  const requiredSlots = DOC_SLOTS.filter(slot => slot.bezne_pozadovan);
  const prepared = requiredSlots.filter(slot => entries.some(entry =>
    entry.slot === slot.type && (entry.platnost_status === 'ok' || entry.platnost_status === 'expiruje'),
  )).length;

  return (
    <div className="mt-4 rounded-lg p-3" style={{ border: '1px dashed var(--border-strong)' }}>
      {docError && (
        <div className="mb-2 rounded px-2 py-1 text-xs" style={{ background: 'var(--danger-soft-bg)', color: 'var(--danger-fg)' }}>{docError}</div>
      )}
      <h4 className="mb-2 text-xs font-semibold uppercase" style={{ color: 'var(--text-secondary)' }}>Výchozí kvalifikační doklady</h4>
      <div className="mb-3 rounded px-3 py-2 text-sm font-medium" style={{ background: prepared === requiredSlots.length ? 'var(--success-soft-bg)' : 'var(--warning-soft-bg)', color: prepared === requiredSlots.length ? 'var(--success-fg)' : 'var(--warning-fg)' }}>
        Připravenost k podání: {prepared}/{requiredSlots.length} běžně požadovaných dokladů nahráno a platných
      </div>
      <div className="space-y-2">
        {DOC_SLOTS.map(slot => {
          const slotEntries = entries.filter(e => e.slot === slot.type);
          const isUploading = uploading === slot.type;

          return (
            <DocSlotRow
              key={slot.type}
              slot={slot}
              slotEntries={slotEntries}
              isUploading={isUploading}
              fileRefs={fileRefs}
              onUpload={handleUpload}
              onDelete={handleDelete}
              onSetPlatnost={handleSetPlatnost}
            />
          );
        })}
      </div>
    </div>
  );
}

function DocSlotRow({
  slot, slotEntries, isUploading, fileRefs, onUpload, onDelete, onSetPlatnost,
}: {
  slot: (typeof DOC_SLOTS)[number];
  slotEntries: DocSlotEntry[];
  isUploading: boolean;
  fileRefs: React.MutableRefObject<Record<string, HTMLInputElement | null>>;
  onUpload: (slotType: string, e: React.ChangeEvent<HTMLInputElement>) => void;
  onDelete: (slot: string, filename: string) => void;
  onSetPlatnost: (slot: string, filename: string, platnostDo: string | null) => void;
}) {
  const [rowHover, setRowHover] = useState(false);
  const [uploadHover, setUploadHover] = useState(false);
  const statuses = slotEntries.map(entry => entry.platnost_status ?? 'nezadano');
  const hasExpired = statuses.includes('expirovany');
  const hasExpiring = statuses.includes('expiruje');
  const missingRequired = slot.bezne_pozadovan && slotEntries.length === 0;
  const rowBackground = hasExpired
    ? 'var(--danger-soft-bg)'
    : hasExpiring
      ? 'var(--warning-soft-bg)'
      : missingRequired
        ? 'var(--warning-soft-bg)'
        : rowHover ? 'var(--surface-hover)' : 'transparent';

  return (
    <div
      onMouseEnter={() => setRowHover(true)}
      onMouseLeave={() => setRowHover(false)}
      className="flex items-start gap-3 rounded px-2 py-2"
      style={{ background: rowBackground }}
    >
      {/* Label */}
      <div className="w-72 shrink-0 pt-0.5" style={{ color: 'var(--text-secondary)' }}>
        <div className="flex items-center gap-1.5 text-xs font-medium">
          {slot.label}
          {(slot.bezne_pozadovan || slot.dle_oboru) && (
            <span className="rounded px-1.5 py-0.5 text-[10px]" style={{ background: 'var(--surface-sunken)', color: 'var(--text-secondary)' }}>
              {slot.dle_oboru ? 'dle oboru' : 'běžně požadován'}
            </span>
          )}
        </div>
        <div className="mt-1 text-[11px] font-normal leading-4" style={{ color: 'var(--text-tertiary)' }}>{slot.popis}</div>
        {slot.typicka_platnost_dnu != null && <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>Doporučení: obvykle max {slot.typicka_platnost_dnu} dní staré.</div>}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {slotEntries.length === 0 ? (
          <div className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--warning-solid)' }}>
            <AlertTriangle className="h-3 w-3" />
            <span>Nenahrán</span>
          </div>
        ) : (
          <div className="space-y-1">
            {slotEntries.map(entry => (
              <DocEntryRow key={entry.filename} entry={entry} onDelete={onDelete} onSetPlatnost={onSetPlatnost} />
            ))}
          </div>
        )}
      </div>

      {/* Upload button */}
      <label
        onMouseEnter={() => setUploadHover(true)}
        onMouseLeave={() => setUploadHover(false)}
        className="shrink-0 flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs"
        style={{
          border: `1px dashed ${uploadHover ? 'var(--blue-400)' : 'var(--border-strong)'}`,
          color: uploadHover ? 'var(--accent)' : 'var(--text-secondary)',
        }}
      >
        <Upload className="h-3 w-3" />
        {isUploading ? '...' : slot.multi && slotEntries.length > 0 ? '+ Nahrát' : 'Nahrát'}
        <input
          ref={(el) => { fileRefs.current[slot.type] = el; }}
          type="file"
          multiple={slot.multi}
          accept=".pdf,.docx,.doc,.xls,.xlsx,.jpg,.jpeg,.png"
          onChange={(e) => onUpload(slot.type, e)}
          className="hidden"
          disabled={isUploading}
        />
      </label>
    </div>
  );
}

// --- Platnost dokladu (badge + inline datum) ---

type ExpiryStatus = 'ok' | 'expiruje' | 'expirovany' | 'nezadano';

/** Barvy a text badge platnosti podle stavu z backendu. */
function expiryBadgeStyle(status: ExpiryStatus): { bg: string; fg: string } {
  switch (status) {
    case 'ok':         return { bg: 'var(--success-soft-bg)', fg: 'var(--success-fg)' };
    case 'expiruje':   return { bg: 'var(--warning-soft-bg)', fg: 'var(--warning-fg)' };
    case 'expirovany': return { bg: 'var(--danger-soft-bg)',  fg: 'var(--danger-fg)' };
    default:           return { bg: 'var(--surface-sunken)',  fg: 'var(--text-tertiary)' };
  }
}

/** Formát ISO data (YYYY-MM-DD) na české DD.MM.YYYY. */
function formatCzDate(iso?: string | null): string {
  if (!iso) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

function ExpiryBadge({ entry }: { entry: DocSlotEntry }) {
  const status = (entry.platnost_status ?? 'nezadano') as ExpiryStatus;
  const { bg, fg } = expiryBadgeStyle(status);
  const dny = entry.dny_do_expirace;
  let text: string;
  if (status === 'ok') text = `Platí do ${formatCzDate(entry.platnost_do)}`;
  else if (status === 'expiruje') text = dny != null ? `Expiruje za ${dny} ${dny === 1 ? 'den' : dny >= 2 && dny <= 4 ? 'dny' : 'dní'}` : 'Brzy expiruje';
  else if (status === 'expirovany') text = `Po platnosti (${formatCzDate(entry.platnost_do)})`;
  else text = 'Platnost nezadána';
  return (
    <span
      className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium"
      style={{ background: bg, color: fg }}
      title={entry.platnost_do ? `Platnost do ${formatCzDate(entry.platnost_do)}` : 'Platnost dokladu není zadána'}
    >
      {text}
    </span>
  );
}

function DocEntryRow({
  entry, onDelete, onSetPlatnost,
}: {
  entry: DocSlotEntry;
  onDelete: (slot: string, filename: string) => void;
  onSetPlatnost: (slot: string, filename: string, platnostDo: string | null) => void;
}) {
  const [hover, setHover] = useState(false);
  const dateValue = entry.platnost_do ? entry.platnost_do.slice(0, 10) : '';
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--success-solid)' }} />
      <FileText className="h-3 w-3 shrink-0" style={{ color: 'var(--text-tertiary)' }} />
      <span className="truncate" style={{ color: 'var(--text-secondary)' }}>{entry.filename}</span>
      <ExpiryBadge entry={entry} />
      <label
        className="ml-auto flex shrink-0 items-center gap-1"
        title="Datum platnosti dokladu (platnost do)"
        style={{ color: 'var(--text-tertiary)' }}
      >
        <CalendarClock className="h-3 w-3" />
        <input
          type="date"
          value={dateValue}
          onChange={(e) => onSetPlatnost(entry.slot, entry.filename, e.target.value || null)}
          className="rounded px-1 py-0.5 text-[11px]"
          style={{ border: '1px solid var(--border-strong)', background: 'var(--surface-card)', color: 'var(--text-secondary)' }}
          aria-label={`Platnost do — ${entry.filename}`}
        />
      </label>
      <button
        onClick={() => onDelete(entry.slot, entry.filename)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="shrink-0"
        style={{ color: hover ? 'var(--danger-solid)' : 'var(--text-tertiary)' }}
        title="Smazat"
        aria-label={`Smazat dokument ${entry.filename}`}
      >
        <Trash2 className="h-3 w-3" />
      </button>
      {(!entry.platnost_do || entry.platnost_status === 'nezadano') && (
        <div className="basis-full rounded px-2 py-1 text-[11px]" style={{ background: 'var(--warning-soft-bg)', color: 'var(--warning-fg)' }}>
          Bez data platnosti systém nepozná, jestli je doklad ještě použitelný — doplňte.
        </div>
      )}
    </div>
  );
}
