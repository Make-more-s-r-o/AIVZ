import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Save } from 'lucide-react';
import { getGovernance, saveGovernance, type Governance } from '../lib/api';
import { Button, Card, Checkbox, Input, useToast } from './ui';

const SWITCHES: Array<{ key: keyof Governance; label: string; description: string }> = [
  { key: 'ingest_enabled', label: 'Příjem a převzetí zakázek', description: 'Synchronizace monitoringu a převzetí položky z feedu.' },
  { key: 'ai_jobs_enabled', label: 'AI joby', description: 'Analýza, párování, generování, validace a ověřování cen.' },
  { key: 'generate_enabled', label: 'Generování dokumentů', description: 'Samostatná stopka pro krok generate.' },
  { key: 'finalize_enabled', label: 'Finalizace', description: 'Vytvoření neměnného balíku nabídky.' },
  { key: 'submission_enabled', label: 'Evidence podání', description: 'Zápis skutečného podání nabídky.' },
];

export default function GovernanceSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { data, isLoading, error } = useQuery({ queryKey: ['governance'], queryFn: getGovernance });
  const [form, setForm] = useState<Governance | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (data) setForm({ ...data }); }, [data]);
  if (error) return <p style={{ color: 'var(--danger-fg)' }}>{error instanceof Error ? error.message : 'Governance nelze načíst.'}</p>;
  if (isLoading || !form) return <p style={{ color: 'var(--text-secondary)' }}>Načítám Governance…</p>;
  const restricted = SWITCHES.some(({ key }) => form[key] === false);

  const save = async () => {
    setSaving(true);
    try {
      const saved = await saveGovernance(form);
      setForm(saved);
      qc.setQueryData(['governance'], saved);
      toast('Governance byla uložena.', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Uložení selhalo.', 'danger');
    } finally { setSaving(false); }
  };

  return <div style={{ maxWidth: 900, display: 'grid', gap: 14 }}>
    {restricted && <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 14, borderRadius: 'var(--radius-md)', background: 'var(--danger-soft-bg)', color: 'var(--danger-fg)', border: '1px solid var(--danger-border)' }}>
      <AlertTriangle size={18} /> Provoz je omezen: alespoň jeden kill-switch je vypnutý.
    </div>}
    <Card title="Governance / Kill-switch" action={<Button size="sm" iconLeft={<Save size={14} />} disabled={saving} onClick={save}>{saving ? 'Ukládám…' : 'Uložit'}</Button>}>
      <p style={{ margin: '0 0 18px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>Vypnutý přepínač okamžitě zastaví nové závazné nebo placené operace na serveru.</p>
      <div style={{ display: 'grid', gap: 14 }}>
        {SWITCHES.map(({ key, label, description }) => <Checkbox key={key} checked={form[key] === true} label={label} description={description} onChange={(checked) => setForm({ ...form, [key]: checked })} />)}
        <label style={{ display: 'grid', gap: 6, maxWidth: 280, color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
          Denní limit AI nákladů (Kč)
          <Input type="number" min={0} step={100} value={form.denni_ai_limit_czk ?? ''} placeholder="Bez limitu" onChange={(e) => setForm({ ...form, denni_ai_limit_czk: e.target.value === '' ? null : Number(e.target.value) })} />
        </label>
        <label style={{ display: 'grid', gap: 6, color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
          Poznámka
          <textarea rows={3} maxLength={2000} value={form.poznamka ?? ''} onChange={(e) => setForm({ ...form, poznamka: e.target.value || null })} style={{ padding: 10, border: '1px solid var(--border-default)', borderRadius: 'var(--radius-md)', font: 'inherit', resize: 'vertical' }} />
        </label>
      </div>
      <p style={{ margin: '18px 0 0', color: 'var(--text-tertiary)', fontSize: 'var(--font-size-xs)' }}>
        Naposledy změnil: {form.zmeneno_kym ?? 'zatím nikdo'}{form.zmeneno_at ? ` · ${new Date(form.zmeneno_at).toLocaleString('cs-CZ')}` : ''}
      </p>
    </Card>
  </div>;
}
