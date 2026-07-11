import { useEffect, useState, type KeyboardEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, X } from 'lucide-react';
import {
  getMonitoringConfig,
  saveMonitoringConfig,
  type MonitoringConfig,
  type MonitoringKategorie,
} from '../lib/api';
import { MONITORING_CATEGORIES } from '../lib/monitoring';
import { Badge, Button, Card, Checkbox, Input, useToast } from './ui';

export default function MonitoringSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState<MonitoringConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['monitoring-config'],
    queryFn: getMonitoringConfig,
  });

  useEffect(() => {
    if (data) setForm({ ...data, kategorie_zajmu: [...data.kategorie_zajmu], klicova_slova: [...data.klicova_slova], vyloucena_slova: [...data.vyloucena_slova] });
  }, [data]);

  if (error) {
    return <p style={{ color: 'var(--danger-fg)', fontSize: 'var(--font-size-sm)' }}>{error instanceof Error ? error.message : 'Nastavení nelze načíst.'}</p>;
  }
  if (isLoading || !form) {
    return <p style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>Načítám nastavení monitoringu…</p>;
  }

  const toggleCategory = (category: MonitoringKategorie, checked: boolean) => {
    setForm((current) => current && ({
      ...current,
      kategorie_zajmu: checked
        ? [...new Set([...current.kategorie_zajmu, category])]
        : current.kategorie_zajmu.filter((value) => value !== category),
    }));
  };

  const handleSave = async () => {
    if (form.min_hodnota != null && form.max_hodnota != null && form.min_hodnota > form.max_hodnota) {
      toast('Maximální hodnota nesmí být nižší než minimální.', 'danger');
      return;
    }
    setSaving(true);
    try {
      const saved = await saveMonitoringConfig(form);
      setForm(saved);
      qc.setQueryData(['monitoring-config'], saved);
      await qc.invalidateQueries({ queryKey: ['monitoring-feed'] });
      toast('Nastavení zájmu bylo uloženo.', 'success');
    } catch (saveError) {
      toast(saveError instanceof Error ? saveError.message : 'Nastavení se nepodařilo uložit.', 'danger');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 900 }}>
      <Card
        title="Monitoring — co nás zajímá"
        action={<Button size="sm" iconLeft={<Save size={14} />} disabled={saving} onClick={handleSave}>{saving ? 'Ukládám…' : 'Uložit'}</Button>}
      >
        <p style={{ margin: '0 0 18px', color: 'var(--text-secondary)', fontSize: 'var(--font-size-sm)' }}>
          Kategorie ovlivňují relevanci. Klíčová slova se při synchronizaci posílají jako samostatné fulltextové dotazy do NEN.
        </p>

        <Fieldset title="Kategorie zájmu" description="Vyberte obory, ve kterých má monitoring hledat relevantní příležitosti.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 10 }}>
            {MONITORING_CATEGORIES.map((category) => (
              <Checkbox
                key={category.value}
                checked={form.kategorie_zajmu.includes(category.value)}
                onChange={(checked) => toggleCategory(category.value, checked)}
                label={category.label}
              />
            ))}
          </div>
        </Fieldset>

        <Fieldset title="Klíčová slova pro hledání" description="Napište výraz a potvrďte Enterem. Každý výraz spustí vlastní dotaz.">
          <TagInput
            value={form.klicova_slova}
            placeholder="např. notebooky"
            onChange={(klicova_slova) => setForm({ ...form, klicova_slova })}
          />
        </Fieldset>

        <Fieldset title="Vyloučená slova" description="Zakázky s těmito výrazy v názvu dostanou NOGO a ve výchozím feedu se skryjí.">
          <TagInput
            value={form.vyloucena_slova}
            placeholder="např. pronájem"
            onChange={(vyloucena_slova) => setForm({ ...form, vyloucena_slova })}
          />
        </Fieldset>

        <Fieldset title="Rozsah předpokládané hodnoty" description="Pokud zdroj hodnotu neuvádí, omezení se na zakázku nepoužije.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(180px, 280px))', gap: 12 }}>
            <LabeledInput label="Minimum (Kč)">
              <Input type="number" min={0} step={1000} value={form.min_hodnota ?? ''} placeholder="Bez minima" onChange={(event) => setForm({ ...form, min_hodnota: numberOrNull(event.target.value) })} />
            </LabeledInput>
            <LabeledInput label="Maximum (Kč)">
              <Input type="number" min={0} step={1000} value={form.max_hodnota ?? ''} placeholder="Bez maxima" onChange={(event) => setForm({ ...form, max_hodnota: numberOrNull(event.target.value) })} />
            </LabeledInput>
          </div>
        </Fieldset>
      </Card>
    </div>
  );
}

function Fieldset({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: '18px 0', borderTop: '1px solid var(--border-default)' }}>
      <h3 style={{ margin: 0, color: 'var(--text-primary)', fontSize: 'var(--font-size-sm)', fontWeight: 'var(--weight-semibold)' }}>{title}</h3>
      <p style={{ margin: '3px 0 12px', color: 'var(--text-tertiary)', fontSize: 'var(--font-size-xs)' }}>{description}</p>
      {children}
    </section>
  );
}

function LabeledInput({ label, children }: { label: string; children: React.ReactNode }) {
  return <label style={{ display: 'grid', gap: 6, color: 'var(--text-secondary)', fontSize: 'var(--font-size-xs)', fontWeight: 'var(--weight-medium)' }}>{label}{children}</label>;
}

function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (value: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const tag = draft.trim();
    if (!tag) return;
    if (!value.some((current) => current.toLocaleLowerCase('cs') === tag.toLocaleLowerCase('cs'))) onChange([...value, tag]);
    setDraft('');
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      add();
    }
  };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <Input value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleKeyDown} />
      {value.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {value.map((tag) => (
            <Badge key={tag} tone="primary">
              {tag}
              <button type="button" onClick={() => onChange(value.filter((current) => current !== tag))} aria-label={`Odebrat ${tag}`} style={{ display: 'inline-flex', padding: 0, border: 0, background: 'none', color: 'inherit', cursor: 'pointer' }}>
                <X size={12} />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function numberOrNull(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
