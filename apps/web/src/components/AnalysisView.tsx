import { useState, useEffect, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAnalysis, getParts, saveParts, type Cast } from '../lib/api';
import { cn } from '../lib/cn';
import type { TenderAnalysis } from '../types/tender';

interface AnalysisViewProps {
  tenderId: string;
}

export default function AnalysisView({ tenderId }: AnalysisViewProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['analysis', tenderId],
    queryFn: () => getAnalysis(tenderId),
  });

  if (isLoading) return <div className="py-8 text-center text-gray-500">Načítám analýzu...</div>;
  if (error) return <div className="py-8 text-center text-gray-500">Analýza zatím není k dispozici. Spusťte krok "AI analýza".</div>;
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
        <div className={cn(
          'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-bold',
          analysis.doporuceni.rozhodnuti === 'GO' && 'bg-green-100 text-green-800',
          analysis.doporuceni.rozhodnuti === 'NOGO' && 'bg-red-100 text-red-800',
          analysis.doporuceni.rozhodnuti === 'ZVAZIT' && 'bg-yellow-100 text-yellow-800',
        )}>
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
                <div className="flex h-8 w-16 items-center justify-center rounded bg-blue-100 text-sm font-bold text-blue-800">
                  {k.vaha_procent}%
                </div>
                <div>
                  <div className="text-sm font-medium">{k.nazev}</div>
                  <div className="text-xs text-gray-500">{k.popis}</div>
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
                <tr className="border-b text-left">
                  <th className="pb-2 font-medium">Parametr</th>
                  <th className="pb-2 font-medium">Požadovaná hodnota</th>
                  <th className="pb-2 font-medium">Povinné</th>
                </tr>
              </thead>
              <tbody>
                {analysis.technicke_pozadavky.map((r, i: number) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-2">{r.parametr}</td>
                    <td className="py-2">{r.pozadovana_hodnota} {r.jednotka || ''}</td>
                    <td className="py-2">
                      <span className={cn(
                        'rounded px-2 py-0.5 text-xs',
                        r.povinny ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-600'
                      )}>
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
              <span className={cn(
                'mt-0.5 rounded px-2 py-0.5 text-xs font-medium',
                k.splnitelne ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
              )}>
                {k.typ}
              </span>
              <span className="text-sm">{k.popis}</span>
            </div>
          ))}
        </Section>
      )}

      {analysis.rizika?.length > 0 && (
        <Section title="Rizika">
          {analysis.rizika.map((r, i: number) => (
            <div key={i} className="rounded border p-3">
              <div className="flex items-center gap-2">
                <span className={cn(
                  'rounded px-2 py-0.5 text-xs font-medium',
                  r.zavaznost === 'vysoka' && 'bg-red-100 text-red-700',
                  r.zavaznost === 'stredni' && 'bg-yellow-100 text-yellow-700',
                  r.zavaznost === 'nizka' && 'bg-green-100 text-green-700',
                )}>
                  {r.zavaznost}
                </span>
                <span className="text-sm font-medium">{r.popis}</span>
              </div>
              <p className="mt-1 text-xs text-gray-600">Mitigace: {r.mitigace}</p>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold text-gray-900">{title}</h3>
      {children}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null;
  return (
    <div className="flex gap-2 py-1 text-sm">
      <span className="w-40 shrink-0 font-medium text-gray-500">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function PartsSelector({ tenderId, casti }: { tenderId: string; casti: Cast[] }) {
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(() => new Set(casti.map(c => c.id)));
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
    <div className="rounded-lg border bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-900">Části zakázky</h3>
        <button
          onClick={handleSave}
          disabled={saving || !dirty}
          className={cn(
            'rounded px-3 py-1.5 text-xs font-medium transition-colors',
            dirty
              ? 'bg-blue-600 text-white hover:bg-blue-700'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed'
          )}
        >
          {saving ? 'Ukládám...' : 'Uložit výběr'}
        </button>
      </div>
      <div className="space-y-2">
        {casti.map(cast => (
          <label
            key={cast.id}
            className={cn(
              'flex items-center justify-between rounded-md border px-3 py-2.5 cursor-pointer transition-colors',
              selected.has(cast.id)
                ? 'border-blue-300 bg-blue-50'
                : 'border-gray-200 bg-gray-50 opacity-60'
            )}
          >
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={selected.has(cast.id)}
                onChange={() => toggle(cast.id)}
                className="h-4 w-4 rounded border-gray-300 text-blue-600"
              />
              <div>
                <div className="text-sm font-medium">{cast.nazev}</div>
                <div className="text-xs text-gray-500">
                  {cast.pocet_polozek} {cast.pocet_polozek === 1 ? 'položka' : cast.pocet_polozek < 5 ? 'položky' : 'položek'}
                </div>
              </div>
            </div>
            {cast.predpokladana_hodnota && (
              <div className="text-sm font-semibold text-gray-700">
                {cast.predpokladana_hodnota.toLocaleString('cs-CZ')} Kč
              </div>
            )}
          </label>
        ))}
      </div>
      {saveError && (
        <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">{saveError}</div>
      )}
      {selected.size === 0 && (
        <p className="mt-2 text-xs text-red-600">Vyberte alespoň jednu část.</p>
      )}
    </div>
  );
}
