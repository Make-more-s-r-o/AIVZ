import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Input, Select, useToast, type SelectOption } from './ui';
import { getTags, createTag, deleteTag, type TagColor } from '../lib/api';
import { getStoredUser } from '../lib/auth';
import { X } from 'lucide-react';

const COLOR_OPTIONS: { value: TagColor; label: string }[] = [
  { value: 'neutral', label: 'Neutrální' },
  { value: 'primary', label: 'Modrá' },
  { value: 'success', label: 'Zelená' },
  { value: 'warning', label: 'Oranžová' },
  { value: 'danger', label: 'Červená' },
];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Nastala chyba';
}

/**
 * Správa štítků — globální číselník štítků (M9b). Vytváření povoleno všem
 * kromě role viewer, mazání jen adminovi. Napojeno do Nastavení → Štítky.
 */
export default function TagManager() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const role = getStoredUser()?.role;
  const canCreate = role !== 'viewer';
  const canDelete = role === 'admin';

  const { data: tags = [], isLoading } = useQuery({ queryKey: ['tags'], queryFn: getTags });

  const [nazev, setNazev] = useState('');
  const [barva, setBarva] = useState<TagColor>('neutral');
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleCreate() {
    const n = nazev.trim();
    if (!n || saving) return;
    setSaving(true);
    try {
      await createTag(n, barva);
      await qc.invalidateQueries({ queryKey: ['tags'] });
      setNazev('');
      setBarva('neutral');
      toast('Štítek vytvořen', 'success');
    } catch (e) {
      toast(errorMessage(e), 'danger');
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (deletingId) return;
    setDeletingId(id);
    try {
      await deleteTag(id);
      // Cascade delete odpojí štítek ze zakázek → refresh i chipy na seznamu Zakázek a v detailu.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['tags'] }),
        qc.invalidateQueries({ queryKey: ['tenders'] }),
        qc.invalidateQueries({ queryKey: ['tender-tags'] }),
      ]);
      toast('Štítek smazán', 'success');
    } catch (e) {
      toast(errorMessage(e), 'danger');
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <Card title="Štítky">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: canCreate ? 20 : 0 }}>
        {isLoading && (
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>Načítám…</span>
        )}
        {!isLoading && tags.length === 0 && (
          <span style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-tertiary)' }}>Zatím žádné štítky</span>
        )}
        {tags.map((t) => (
          <Badge key={t.id} tone={t.barva as any} size="sm">
            {t.nazev}
            {canDelete && (
              <button
                type="button"
                onClick={() => void handleDelete(t.id)}
                disabled={deletingId === t.id}
                title="Smazat štítek"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 14, height: 14, marginLeft: 2, padding: 0, border: 'none',
                  background: 'transparent', color: 'inherit', cursor: deletingId === t.id ? 'not-allowed' : 'pointer',
                  opacity: deletingId === t.id ? 0.5 : 0.75,
                }}
              >
                <X size={11} />
              </button>
            )}
          </Badge>
        ))}
      </div>

      {canCreate && (
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 200px', minWidth: 160 }}>
            <label style={{ display: 'block', fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginBottom: 4 }}>
              Název štítku
            </label>
            <Input
              value={nazev}
              onChange={(e) => setNazev(e.target.value)}
              placeholder="Např. Prioritní"
              size="sm"
            />
          </div>
          <div style={{ flex: '0 0 160px' }}>
            <label style={{ display: 'block', fontSize: 'var(--font-size-xs)', color: 'var(--text-secondary)', marginBottom: 4 }}>
              Barva
            </label>
            <Select
              value={barva}
              onChange={(e) => setBarva(e.target.value as TagColor)}
              options={COLOR_OPTIONS as SelectOption[]}
              size="sm"
            />
          </div>
          <div style={{ paddingBottom: 1 }}>
            <Badge tone={barva} size="sm">{nazev.trim() || 'Náhled'}</Badge>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleCreate()}
            disabled={!nazev.trim() || saving}
          >
            Přidat štítek
          </Button>
        </div>
      )}
    </Card>
  );
}
