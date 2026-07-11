import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ShieldCheck, CheckCircle2, Copy } from 'lucide-react';
import {
  getPodani,
  getPodaniDownloadUrl,
  recordPodano,
  downloadWithAuth,
  type PodaniState,
} from '../lib/api';
import { Button, Badge, useToast } from './ui';

interface SubmissionCockpitProps {
  tenderId: string;
}

// Lokální datetime-local hodnota → ISO 8601 s offsetem (server validuje z.string().datetime).
function localInputToIso(value: string): string {
  // value je "YYYY-MM-DDTHH:mm" v lokálním čase; new Date to interpretuje lokálně.
  const d = new Date(value);
  return d.toISOString();
}

// Výchozí hodnota pro <input type="datetime-local"> = teď (lokální čas), ořezané na minuty.
function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Submission cockpit — pravdivý stav podání. Zobrazí se, jakmile finalize vytvoří balík.
 * Stažení immutable balíku (ZIP + sha256), otisk obsahu a formulář „Zaznamenat podání".
 * Teprve zaznamenané podání (evidence) přepne zakázku na Odesláno — nikoli finalize.
 */
export default function SubmissionCockpit({ tenderId }: SubmissionCockpitProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [portal, setPortal] = useState('');
  const [casPodani, setCasPodani] = useState(nowLocalInput());
  const [evidencniCislo, setEvidencniCislo] = useState('');
  const [poznamka, setPoznamka] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const { data: podani } = useQuery<PodaniState>({
    queryKey: ['podani', tenderId],
    queryFn: () => getPodani(tenderId),
  });

  const manifest = podani?.manifest ?? null;
  const evidence = podani?.evidence ?? null;

  // Bez balíku (před finalizací) se cockpit nezobrazuje — řídí to nadřazená komponenta,
  // ale i tady jsme defenzivní.
  if (!manifest) return null;

  const shortHash = manifest.content_hash.slice(0, 12);

  const handleDownload = async () => {
    try {
      await downloadWithAuth(getPodaniDownloadUrl(tenderId), `${manifest.zip_filename}`);
    } catch (err) {
      toast((err as Error).message || 'Stažení balíku selhalo.', 'danger');
    }
  };

  const handleCopyHash = async () => {
    try {
      await navigator.clipboard.writeText(manifest.content_hash);
      toast('Hash zkopírován', 'success');
    } catch {
      /* clipboard nedostupný — tichý fallback */
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!portal.trim()) {
      toast('Vyplňte portál, kam byla nabídka podána.', 'danger');
      return;
    }
    setSubmitting(true);
    try {
      await recordPodano(tenderId, {
        portal: portal.trim(),
        cas_podani: localInputToIso(casPodani),
        evidencni_cislo: evidencniCislo.trim() || undefined,
        poznamka: poznamka.trim() || undefined,
      });
      toast('Podání zaznamenáno — zakázka označena jako Odesláno.', 'success');
      void queryClient.invalidateQueries({ queryKey: ['podani', tenderId] });
      void queryClient.invalidateQueries({ queryKey: ['tender-status', tenderId] });
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    } catch (err) {
      toast((err as Error).message || 'Zaznamenání podání selhalo.', 'danger');
    } finally {
      setSubmitting(false);
    }
  };

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 'var(--font-size-xs)', fontWeight: 600,
    color: 'var(--text-secondary)', marginBottom: 4,
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', fontSize: 'var(--font-size-sm)',
    border: '1px solid var(--border-default)', borderRadius: 6,
    background: 'var(--surface-default, #fff)', color: 'var(--text-primary)',
  };

  return (
    <div
      style={{
        border: '1px solid var(--border-default)', borderRadius: 10, padding: 16,
        background: 'var(--surface-raised, #fff)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Archive className="h-5 w-5" style={{ color: 'var(--info-fg, #2563eb)' }} />
        <h3 style={{ margin: 0, fontSize: 'var(--font-size-md)', fontWeight: 700, color: 'var(--text-primary)' }}>
          Podání
        </h3>
        {evidence ? (
          <Badge tone="success" size="sm">Odesláno</Badge>
        ) : (
          <Badge tone="warning" size="sm">Připraveno, nepodáno</Badge>
        )}
      </div>

      {/* Balík: stažení + otisk */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Button variant="secondary" iconLeft={<Archive className="h-4 w-4" />} onClick={handleDownload}>
          Stáhnout balík (v{manifest.version})
        </Button>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)' }}>
          {manifest.files.length} souborů
          {manifest.celkova_cena_s_dph != null && ` · ${manifest.celkova_cena_s_dph.toLocaleString('cs-CZ')} Kč s DPH`}
        </span>
        <button
          type="button"
          onClick={handleCopyHash}
          title="Kopírovat celý otisk (sha256)"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 8px',
            fontSize: 'var(--font-size-2xs)', fontFamily: 'monospace', color: 'var(--text-tertiary)',
            border: '1px solid var(--border-subtle, var(--border-default))', borderRadius: 6,
            background: 'transparent', cursor: 'pointer',
          }}
        >
          <ShieldCheck className="h-3 w-3" /> sha256:{shortHash}… <Copy className="h-3 w-3" />
        </button>
      </div>

      {evidence ? (
        <div
          style={{
            display: 'flex', flexDirection: 'column', gap: 4, padding: 12, borderRadius: 8,
            background: 'var(--success-bg, #f0fdf4)', border: '1px solid var(--success-border, #bbf7d0)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, color: 'var(--success-fg, #15803d)' }}>
            <CheckCircle2 className="h-4 w-4" /> Nabídka podána
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
            Portál: <strong>{evidence.portal}</strong>
          </div>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
            Čas podání: <strong>{new Date(evidence.cas_podani).toLocaleString('cs-CZ')}</strong>
          </div>
          {evidence.evidencni_cislo && (
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
              Evidenční číslo: <strong>{evidence.evidencni_cislo}</strong>
            </div>
          )}
          {evidence.poznamka && (
            <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
              Poznámka: {evidence.poznamka}
            </div>
          )}
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
            Po ručním podání nabídky zaznamenejte podání — teprve tím se zakázka označí jako Odesláno.
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
            <div>
              <label style={labelStyle} htmlFor="podani-portal">Portál *</label>
              <input
                id="podani-portal" style={inputStyle} value={portal}
                onChange={(e) => setPortal(e.target.value)}
                placeholder="NEN / profil zadavatele / e-mail"
              />
            </div>
            <div>
              <label style={labelStyle} htmlFor="podani-cas">Čas podání *</label>
              <input
                id="podani-cas" type="datetime-local" style={inputStyle} value={casPodani}
                onChange={(e) => setCasPodani(e.target.value)}
              />
            </div>
            <div>
              <label style={labelStyle} htmlFor="podani-cislo">Evidenční číslo</label>
              <input
                id="podani-cislo" style={inputStyle} value={evidencniCislo}
                onChange={(e) => setEvidencniCislo(e.target.value)}
                placeholder="volitelné"
              />
            </div>
          </div>
          <div>
            <label style={labelStyle} htmlFor="podani-poznamka">Poznámka</label>
            <input
              id="podani-poznamka" style={inputStyle} value={poznamka}
              onChange={(e) => setPoznamka(e.target.value)}
              placeholder="volitelné"
            />
          </div>
          <div>
            <Button type="submit" variant="primary" disabled={submitting}>
              {submitting ? 'Zaznamenávám…' : 'Zaznamenat podání'}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
