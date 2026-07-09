import { useState, useEffect, useCallback, type CSSProperties, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAnalysis, getParts, saveParts, type Cast } from '../lib/api';
import type { TenderAnalysis } from '../types/tender';

interface AnalysisViewProps {
  tenderId: string;
}

const DECISION_STYLE: Record<string, CSSProperties> = {
  GO: { background: 'var(--success-bg)', color: 'var(--success-fg)' },
  NOGO: { background: 'var(--danger-bg)', color: 'var(--danger-fg)' },
  ZVAZIT: { background: 'var(--warning-bg)', color: 'var(--warning-fg)' },
};

export default function AnalysisView({ tenderId }: AnalysisViewProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['analysis', tenderId],
    queryFn: () => getAnalysis(tenderId),
  });

  if (isLoading) return <div className="py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Načítám analýzu...</div>;
  if (error) return <div className="py-8 text-center" style={{ color: 'var(--text-secondary)' }}>Analýza zatím není k dispozici. Spusťte krok "AI analýza".</div>;
  if (!data) return null;

  const analysis = data as TenderAnalysis;

  const casti = analysis.casti as Cast[] | undefined;
  const showParts = casti && casti.length > 1;

  return (
    <div className="space-y-6">
      {showParts && (
        <PartsSelector tenderId={tenderId} casti={casti!} />
      )}

      {analysis.doporuceni && (
        <div
          className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold"
          style={DECISION_STYLE[analysis.doporuceni.rozhodnuti] ?? DECISION_STYLE.ZVAZIT}
        >
          {analysis.doporuceni.rozhodnuti}
          <span className="font-normal">— {analysis.doporuceni.oduvodneni}</span>
        </div>
      )}

      {analysis.zakazka && (
        <Section title="Základní údaje">
          <InfoRow label="Název" value={analysis.zakazka.nazev} />
          <InfoRow label="Evidenční číslo" value={analysis.zakazka.evidencni_cislo} />
          <InfoRow label="Zadavatel" value={analysis.zakazka.zadavatel?.nazev} />
          <InfoRow label="Předmět" value={analysis.zakazka.predmet} />
          <InfoRow label="Typ zakázky" value={analysis.zakazka.typ_zakazky} />
          <InfoRow label="Typ řízení" value={analysis.zakazka.typ_rizeni} />
          {analysis.zakazka.predpokladana_hodnota && (
            <InfoRow label="Předpokládaná hodnota" value={`${analysis.zakazka.predpokladana_hodnota.toLocaleString('cs-CZ')} Kč`} />
          )}
        </Section>
      )}

      {analysis.terminy && (
        <Section title="Termíny">
          <InfoRow label="Lhůta nabídek" value={analysis.terminy.lhuta_nabidek} />
          <InfoRow label="Otevírání obálek" value={analysis.terminy.otevirani_obalek} />
          <InfoRow label="Plnění od" value={analysis.terminy.doba_plneni_od} />
          <InfoRow label="Plnění do" value={analysis.terminy.doba_plneni_do} />
        </Section>
      )}

      {analysis.hodnotici_kriteria?.length > 0 && (
        <Section title="Hodnotící kritéria">
          <div className="space-y-2">
            {analysis.hodnotici_kriteria.map((k, i: number) => (
              <div key={i} className="flex items-center gap-3">
                <div
                  className="flex h-8 w-16 items-center justify-center rounded text-sm font-bold"
                  style={{ background: 'var(--info-bg)', color: 'var(--info-fg)' }}
                >
                  {k.vaha_procent}%
                </div>
                <div>
                  <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{k.nazev}</div>
                  <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>{k.popis}</div>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {analysis.technicke_pozadavky?.length > 0 && (
        <Section title="Technické požadavky">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border-default)', textAlign: 'left' }}>
                  <th className="pb-2 font-medium" style={{ color: 'var(--text-primary)' }}>Parametr</th>
                  <th className="pb-2 font-medium" style={{ color: 'var(--text-primary)' }}>Požadovaná hodnota</th>
                  <th className="pb-2 font-medium" style={{ color: 'var(--text-primary)' }}>Povinné</th>
                </tr>
              </thead>
              <tbody>
                {analysis.technicke_pozadavky.map((r, i: number) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-default)' }}>
                    <td className="py-2" style={{ color: 'var(--text-primary)' }}>{r.parametr}</td>
                    <td className="py-2" style={{ color: 'var(--text-primary)' }}>{r.pozadovana_hodnota} {r.jednotka || ''}</td>
                    <td className="py-2">
                      <span
                        className="rounded px-2 py-0.5 text-xs"
                        style={r.povinny
                          ? { background: 'var(--danger-bg)', color: 'var(--danger-fg)' }
                          : { background: 'var(--gray-100)', color: 'var(--text-secondary)' }}
                      >
                        {r.povinny ? 'Ano' : 'Ne'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {analysis.kvalifikace?.length > 0 && (
        <Section title="Kvalifikační požadavky">
          {analysis.kvalifikace.map((k, i: number) => (
            <div key={i} className="flex items-start gap-2 py-1">
              <span
                className="mt-0.5 rounded px-2 py-0.5 text-xs font-medium"
                style={k.splnitelne
                  ? { background: 'var(--success-bg)', color: 'var(--success-fg)' }
                  : { background: 'var(--danger-bg)', color: 'var(--danger-fg)' }}
              >
                {k.typ}
              </span>
              <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{k.popis}</span>
            </div>
          ))}
        </Section>
      )}

      {analysis.rizika?.length > 0 && (
        <Section title="Rizika">
          {analysis.rizika.map((r, i: number) => (
            <div key={i} className="rounded p-3" style={{ border: '1px solid var(--border-default)' }}>
              <div className="flex items-center gap-2">
                <span
                  className="rounded px-2 py-0.5 text-xs font-medium"
                  style={
                    r.zavaznost === 'vysoka' ? { background: 'var(--danger-bg)', color: 'var(--danger-fg)' }
                      : r.zavaznost === 'stredni' ? { background: 'var(--warning-bg)', color: 'var(--warning-fg)' }
                        : { background: 'var(--success-bg)', color: 'var(--success-fg)' }
                  }
                >
                  {r.zavaznost}
                </span>
                <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{r.popis}</span>
              </div>
              <p className="mt-1 text-xs" style={{ color: 'var(--text-secondary)' }}>Mitigace: {r.mitigace}</p>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg p-4" style={{ border: '1px solid var(--border-default)', background: 'var(--surface-card)' }}>
      <h3 className="mb-3 text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</h3>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 py-1 text-sm">
      <span className="w-40 shrink-0 font-medium" style={{ color: 'var(--text-secondary)' }}>{label}</span>
      <span style={{ color: 'var(--text-primary)' }}>{value}</span>
    </div>
  );
}

function PartsSelector({ tenderId, casti }: { tenderId: string; casti: Cast[] }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(casti.map(c => c.id)));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveHover, setSaveHover] = useState(false);

  const { data: partsData } = useQuery({
    queryKey: ['parts', tenderId],
    queryFn: () => getParts(tenderId),
  });

  useEffect(() => {
    if (partsData?.selected_parts) {
      setSelected(new Set(partsData.selected_parts));
    }
  }, [partsData]);

  const toggle = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setDirty(true);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await saveParts(tenderId, [...selected]);
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ['parts', tenderId] });
    } catch (err) {
      console.error('Failed to save parts:', err);
      setSaveError('Uložení výběru se nezdařilo.');
    } finally {
      setSaving(false);
    }
  }, [tenderId, selected, queryClient]);

  return (
    <div className="rounded-lg p-4" style={{ border: '1px solid var(--border-default)', background: 'var(--surface-card)' }}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Části zakázky</h3>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          onMouseEnter={() => setSaveHover(true)}
          onMouseLeave={() => setSaveHover(false)}
          className="rounded px-3 py-1.5 text-xs font-medium transition-colors"
          style={dirty
            ? { background: saveHover ? 'var(--accent-hover)' : 'var(--accent)', color: 'var(--text-on-accent)', cursor: 'pointer' }
            : { background: 'var(--gray-100)', color: 'var(--text-tertiary)', cursor: 'not-allowed' }}
        >
          {saving ? 'Ukládám...' : 'Uložit výběr'}
        </button>
      </div>
      <div className="space-y-2">
        {casti.map(cast => (
          <label
            key={cast.id}
            className="flex items-center justify-between rounded-md px-3 py-2.5 cursor-pointer transition-colors"
            style={selected.has(cast.id)
              ? { border: '1px solid var(--blue-300)', background: 'var(--accent-soft-bg)' }
              : { border: '1px solid var(--border-default)', background: 'var(--surface-sunken)', opacity: 0.6 }}
          >
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={selected.has(cast.id)}
                onChange={() => toggle(cast.id)}
                className="h-4 w-4 rounded"
                style={{ borderColor: 'var(--border-strong)', accentColor: 'var(--accent)' }}
              />
              <div>
                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{cast.nazev}</div>
                <div className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                  {cast.pocet_polozek} {cast.pocet_polozek === 1 ? 'položka' : cast.pocet_polozek < 5 ? 'položky' : 'položek'}
                </div>
              </div>
            </div>
            {cast.predpokladana_hodnota && (
              <div className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {cast.predpokladana_hodnota.toLocaleString('cs-CZ')} Kč
              </div>
            )}
          </label>
        ))}
      </div>
      {saveError && (
        <div className="mt-2 rounded px-2 py-1 text-xs" style={{ background: 'var(--danger-soft-bg)', color: 'var(--danger-fg)' }}>{saveError}</div>
      )}
      {selected.size === 0 && (
        <p className="mt-2 text-xs" style={{ color: 'var(--danger-solid)' }}>Vyberte alespoň jednu část.</p>
      )}
    </div>
  );
}
