import { useState, type CSSProperties, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Building2, CheckCircle2, FileText, AlertCircle } from 'lucide-react';
import { Button, Input, Card } from '../components/ui';
import { createCompany, type CompanyData } from '../lib/api';

export interface RegistraceFirmyPageProps {
  onDone?: () => void;
}

type FieldKey =
  | 'nazev' | 'ico' | 'dic' | 'sidlo' | 'jednajici_osoba'
  | 'telefon' | 'email' | 'datova_schranka' | 'iban';

type FormState = Record<FieldKey, string>;

const EMPTY_FORM: FormState = {
  nazev: '', ico: '', dic: '', sidlo: '', jednajici_osoba: '',
  telefon: '', email: '', datova_schranka: '', iban: '',
};

type FieldErrors = Partial<Record<FieldKey, string>>;

function validate(form: FormState): FieldErrors {
  const errors: FieldErrors = {};
  if (!form.nazev.trim()) errors.nazev = 'Vyplňte název firmy.';
  const ico = form.ico.trim();
  if (!ico) {
    errors.ico = 'Vyplňte IČO.';
  } else if (!/^\d{8}$/.test(ico)) {
    errors.ico = 'IČO musí mít přesně 8 číslic.';
  }
  if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
    errors.email = 'Neplatný formát e-mailu.';
  }
  return errors;
}

/**
 * Registrace firmy (onboarding) — formulář pro firmu, která dodává řešení do
 * veřejných zakázek. Její údaje plní nabídkové dokumenty (krycí list, čestné
 * prohlášení, cenová nabídka). Zapisuje přes POST /api/companies.
 */
export default function RegistraceFirmyPage({ onDone }: RegistraceFirmyPageProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitted, setSubmitted] = useState(false);

  const mutation = useMutation<CompanyData, Error, Partial<CompanyData>>({
    mutationFn: (payload) => createCompany(payload),
    onSuccess: () => setSubmitted(true),
  });

  const set = (key: FieldKey) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setForm((prev) => ({ ...prev, [key]: v }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const found = validate(form);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    const payload: Partial<CompanyData> = {
      nazev: form.nazev.trim(),
      ico: form.ico.trim(),
      dic: form.dic.trim(),
      sidlo: form.sidlo.trim(),
      jednajici_osoba: form.jednajici_osoba.trim(),
      telefon: form.telefon.trim() || undefined,
      email: form.email.trim() || undefined,
      datova_schranka: form.datova_schranka.trim() || undefined,
      iban: form.iban.trim() || undefined,
    };
    mutation.mutate(payload);
  };

  if (submitted) {
    return (
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        <Card style={{ marginTop: 24 }}>
          <div style={{ textAlign: 'center', padding: '24px 8px' }}>
            <div
              style={{
                width: 52, height: 52, margin: '0 auto 14px', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'var(--stage-vyhrano-bg)', color: 'var(--stage-vyhrano-fg)',
              }}
            >
              <CheckCircle2 size={28} strokeWidth={2} />
            </div>
            <h2 style={{ fontSize: 'var(--font-size-lg)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
              Firma byla zaregistrována
            </h2>
            <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 6, marginBottom: 0 }}>
              Údaje firmy <strong style={{ color: 'var(--text-primary)' }}>{form.nazev.trim()}</strong> se nyní použijí
              při generování nabídkových dokumentů.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 20 }}>
              {onDone && (
                <Button variant="primary" onClick={onDone}>Pokračovat</Button>
              )}
              <Button
                variant="secondary"
                onClick={() => { setForm(EMPTY_FORM); setErrors({}); setSubmitted(false); mutation.reset(); }}
              >
                Registrovat další firmu
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} style={{ maxWidth: 720, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div
          style={{
            width: 36, height: 36, borderRadius: 'var(--radius-md)', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--accent-soft-bg)', color: 'var(--accent-soft-fg)',
          }}
        >
          <Building2 size={18} strokeWidth={2} />
        </div>
        <div>
          <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Registrace firmy
          </h1>
          <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', margin: '2px 0 0' }}>
            Zaregistrujte firmu, která dodává řešení do zakázek — její údaje plní nabídkové dokumenty.
          </p>
        </div>
      </div>

      <Card title="Údaje firmy" style={{ marginTop: 20 }}>
        {mutation.isError && (
          <div
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 16,
              padding: '10px 12px', borderRadius: 'var(--radius-md)',
              background: 'var(--danger-bg)', color: 'var(--danger-fg)', fontSize: 'var(--font-size-sm)',
            }}
          >
            <AlertCircle size={16} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>Firmu se nepodařilo uložit: {mutation.error.message}</span>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
          <Field label="Název firmy" required error={errors.nazev} span={2}>
            <Input
              value={form.nazev}
              onChange={set('nazev')}
              placeholder="Make more s.r.o."
              invalid={!!errors.nazev}
            />
          </Field>

          <Field label="IČO" required error={errors.ico}>
            <Input
              value={form.ico}
              onChange={set('ico')}
              placeholder="07023987"
              inputMode="numeric"
              maxLength={8}
              invalid={!!errors.ico}
              style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
            />
          </Field>

          <Field label="DIČ">
            <Input
              value={form.dic}
              onChange={set('dic')}
              placeholder="CZ07023987"
              style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
            />
          </Field>

          <Field label="Sídlo" span={2}>
            <Input value={form.sidlo} onChange={set('sidlo')} placeholder="Ulice 123, 110 00 Praha" />
          </Field>

          <Field label="Jednající osoba">
            <Input value={form.jednajici_osoba} onChange={set('jednajici_osoba')} placeholder="Jan Novák" />
          </Field>

          <Field label="Telefon">
            <Input value={form.telefon} onChange={set('telefon')} placeholder="+420 737 061 492" inputMode="tel" />
          </Field>

          <Field label="E-mail" error={errors.email}>
            <Input
              value={form.email}
              onChange={set('email')}
              placeholder="info@firma.cz"
              type="email"
              invalid={!!errors.email}
            />
          </Field>

          <Field label="Datová schránka">
            <Input
              value={form.datova_schranka}
              onChange={set('datova_schranka')}
              placeholder="abc12xy"
              style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
            />
          </Field>

          <Field label="IBAN" span={2}>
            <Input
              value={form.iban}
              onChange={set('iban')}
              placeholder="CZ65 0800 0000 1920 0014 5399"
              style={{ fontFamily: 'var(--font-mono)', letterSpacing: '0.04em' }}
            />
          </Field>
        </div>

        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 16,
            padding: '10px 12px', borderRadius: 'var(--radius-md)',
            background: 'var(--surface-sunken)', color: 'var(--text-secondary)', fontSize: 'var(--font-size-xs)',
          }}
        >
          <FileText size={15} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1, color: 'var(--text-tertiary)' }} />
          <span>Kvalifikační doklady (výpis z OR, rejstřík trestů, potvrzení FÚ a OSSZ) doplníte později v Nastavení → Firmy.</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 20 }}>
          <Button type="submit" variant="primary" disabled={mutation.isPending}>
            {mutation.isPending ? 'Ukládám…' : 'Zaregistrovat firmu'}
          </Button>
          <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
            Pole označená <span style={{ color: 'var(--danger-fg)' }}>*</span> jsou povinná.
          </span>
        </div>
      </Card>
    </form>
  );
}

// --- Field wrapper (label + control + error) ---

interface FieldProps {
  label: string;
  required?: boolean;
  error?: string;
  span?: 1 | 2;
  children: ReactNode;
}

function Field({ label, required = false, error, span = 1, children }: FieldProps) {
  const wrap: CSSProperties = span === 2 ? { gridColumn: '1 / -1' } : {};
  return (
    <div style={wrap}>
      <label
        style={{
          display: 'block', marginBottom: 6,
          fontSize: 'var(--font-size-xs)', fontWeight: 'var(--weight-medium)', color: 'var(--text-secondary)',
        }}
      >
        {label}
        {required && <span style={{ color: 'var(--danger-fg)', marginLeft: 3 }}>*</span>}
      </label>
      {children}
      {error && (
        <div style={{ marginTop: 5, fontSize: 'var(--font-size-xs)', color: 'var(--danger-fg)' }}>{error}</div>
      )}
    </div>
  );
}
