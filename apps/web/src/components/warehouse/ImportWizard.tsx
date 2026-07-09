import { useState } from 'react';
import {
  uploadImportFile, runWarehouseImport, getWarehouseSources, getWarehouseCategories,
  type ImportPreview, type ImportResult, type WarehouseCategory,
} from '../../lib/api';
import { Select } from '../ui';

const TARGET_FIELDS = [
  { value: 'manufacturer', label: 'Výrobce' },
  { value: 'model', label: 'Model / Název' },
  { value: 'ean', label: 'EAN' },
  { value: 'part_number', label: 'Katalogové číslo' },
  { value: 'description', label: 'Popis' },
  { value: 'price_bez_dph', label: 'Cena bez DPH' },
  { value: 'price_s_dph', label: 'Cena s DPH' },
  { value: 'category', label: 'Kategorie' },
  { value: 'product_family', label: 'Produktová řada' },
  { value: 'image_url', label: 'URL obrázku' },
  { value: 'availability', label: 'Dostupnost' },
  { value: 'stock_quantity', label: 'Sklad (ks)' },
  { value: 'source_url', label: 'URL produktu' },
  { value: 'source_sku', label: 'SKU zdroje' },
  { value: 'ignore', label: '-- ignorovat --' },
];

interface Props {
  onImportDone: () => void;
}

export default function ImportWizard({ onImportDone }: Props) {
  const [step, setStep] = useState<'upload' | 'mapping' | 'running' | 'done'>('upload');
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [mapping, setMapping] = useState<ImportPreview['suggested_mapping']>([]);
  const [sourceId, setSourceId] = useState(1); // 1 = Rucni import
  const [categoryId, setCategoryId] = useState<number | undefined>();
  const [enrichParams, setEnrichParams] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<any[]>([]);
  const [categories, setCategories] = useState<WarehouseCategory[]>([]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);
    try {
      // Nacti zdroje a kategorie paralelne s uplodem
      const [previewData, sourcesData, categoriesData] = await Promise.all([
        uploadImportFile(file),
        getWarehouseSources(),
        getWarehouseCategories(),
      ]);
      setPreview(previewData);
      setMapping(previewData.suggested_mapping);
      setSources(sourcesData);
      setCategories(categoriesData);
      setStep('mapping');
    } catch (err: any) {
      setError(err.message || 'Upload selhal');
    } finally {
      setLoading(false);
    }
  };

  const handleMappingChange = (index: number, field: string) => {
    setMapping((prev) =>
      prev.map((m, i) => (i === index ? { ...m, target_field: field } : m)),
    );
  };

  const handleRunImport = async () => {
    if (!preview) return;
    setStep('running');
    setError(null);
    try {
      const importResult = await runWarehouseImport({
        upload_path: preview.upload_path,
        mapping,
        source_id: sourceId,
        category_id: categoryId,
        enrich_params: enrichParams,
      });
      setResult(importResult);
      setStep('done');
    } catch (err: any) {
      setError(err.message || 'Import selhal');
      setStep('mapping');
    }
  };

  // Step 1: Upload
  if (step === 'upload') {
    return (
      <div className="rounded-lg p-8 text-center" style={{ border: '1px dashed var(--border-strong)' }}>
        <p className="mb-4" style={{ color: 'var(--text-secondary)' }}>
          Nahrajte CSV nebo Excel soubor s produkty
        </p>
        <label
          className="inline-block cursor-pointer rounded-md px-6 py-2 text-sm"
          style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
        >
          Vybrat soubor
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFileUpload}
            className="hidden"
          />
        </label>
        {loading && <p className="mt-3 text-sm" style={{ color: 'var(--text-secondary)' }}>Analyzuji soubor...</p>}
        {error && <p className="mt-3 text-sm" style={{ color: 'var(--danger-solid)' }}>{error}</p>}
      </div>
    );
  }

  // Step 2: Mapping
  if (step === 'mapping' && preview) {
    const sourceOptions = sources.map((s) => ({ value: String(s.id), label: s.name }));
    const categoryOptions = [
      { value: '', label: '-- neurčeno --' },
      ...categories.map((c) => ({ value: String(c.id), label: `${c.parent_id ? '  ' : ''}${c.nazev}` })),
    ];

    return (
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>Mapování sloupců</h3>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {preview.filename} — {preview.total_rows} řádků, {preview.columns.length} sloupců
            </p>
          </div>
          <button
            onClick={() => { setStep('upload'); setPreview(null); }}
            className="text-sm"
            style={{ color: 'var(--text-secondary)' }}
          >
            Zrušit
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded p-3 text-sm" style={{ border: '1px solid var(--danger-bg)', background: 'var(--danger-soft-bg)', color: 'var(--danger-fg)' }}>
            {error}
          </div>
        )}

        {/* Nastaveni importu */}
        <div className="mb-4 flex flex-wrap gap-4 rounded-lg p-4" style={{ background: 'var(--surface-sunken)' }}>
          <div className="w-56">
            <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Zdroj dat</label>
            <Select
              value={String(sourceId)}
              onChange={(e) => setSourceId(Number(e.target.value))}
              options={sourceOptions}
              size="sm"
            />
          </div>
          <div className="w-56">
            <label className="mb-1 block text-xs font-medium" style={{ color: 'var(--text-secondary)' }}>Kategorie</label>
            <Select
              value={categoryId != null ? String(categoryId) : ''}
              onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)}
              options={categoryOptions}
              size="sm"
            />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
              <input
                type="checkbox"
                checked={enrichParams}
                onChange={(e) => setEnrichParams(e.target.checked)}
                style={{ accentColor: 'var(--accent)' }}
              />
              AI normalizace parametrů
            </label>
          </div>
        </div>

        {/* Mapping tabulka */}
        <div className="mb-4 overflow-x-auto rounded-lg" style={{ border: '1px solid var(--border-default)' }}>
          <table className="w-full text-sm">
            <thead style={{ background: 'var(--surface-sunken)' }}>
              <tr>
                <th className="px-4 py-2 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Sloupec v souboru</th>
                <th className="px-4 py-2 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Cílové pole</th>
                <th className="px-4 py-2 text-left font-medium" style={{ color: 'var(--text-secondary)' }}>Ukázka dat</th>
              </tr>
            </thead>
            <tbody>
              {mapping.map((m, i) => (
                <tr key={i} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className="px-4 py-2 font-medium" style={{ color: 'var(--text-primary)' }}>{m.source_name}</td>
                  <td className="px-4 py-2 w-52">
                    <Select
                      value={m.target_field || 'ignore'}
                      onChange={(e) => handleMappingChange(i, e.target.value)}
                      options={TARGET_FIELDS}
                      size="sm"
                    />
                  </td>
                  <td className="max-w-xs truncate px-4 py-2" style={{ color: 'var(--text-secondary)' }}>
                    {preview.sample_rows[0]?.[m.source_name] || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Preview dat */}
        <details className="mb-4">
          <summary className="cursor-pointer text-sm" style={{ color: 'var(--text-secondary)' }}>
            Ukázka dat ({Math.min(10, preview.sample_rows.length)} řádků)
          </summary>
          <div className="mt-2 overflow-x-auto rounded" style={{ border: '1px solid var(--border-default)' }}>
            <table className="w-full text-xs">
              <thead style={{ background: 'var(--surface-sunken)' }}>
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-3 py-1 text-left" style={{ color: 'var(--text-secondary)' }}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample_rows.map((row, i) => (
                  <tr key={i} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    {preview.columns.map((c) => (
                      <td key={c} className="max-w-32 truncate px-3 py-1" style={{ color: 'var(--text-primary)' }}>{row[c] || ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        <button
          onClick={handleRunImport}
          className="rounded-md px-6 py-2 text-sm"
          style={{ background: 'var(--success-solid)', color: 'var(--text-on-accent)' }}
        >
          Spustit import ({preview.total_rows} řádků)
        </button>
      </div>
    );
  }

  // Step 3: Running
  if (step === 'running') {
    return (
      <div className="rounded-lg p-8 text-center" style={{ border: '1px solid var(--border-default)' }}>
        <div
          className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full"
          style={{ border: '4px solid var(--blue-200)', borderTopColor: 'var(--accent)' }}
        />
        <p style={{ color: 'var(--text-secondary)' }}>Import probíhá...</p>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-tertiary)' }}>
          Zpracovávám {preview?.total_rows} řádků
          {enrichParams && ' s AI normalizací parametrů'}
        </p>
      </div>
    );
  }

  // Step 4: Done
  if (step === 'done' && result) {
    return (
      <div className="rounded-lg p-6" style={{ border: '1px solid var(--border-default)' }}>
        <h3 className="mb-3 text-lg font-semibold" style={{ color: 'var(--success-fg)' }}>Import dokončen</h3>
        <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div className="rounded p-3 text-center" style={{ background: 'var(--success-soft-bg)' }}>
            <div className="text-2xl font-bold" style={{ color: 'var(--success-fg)' }}>{result.imported}</div>
            <div style={{ color: 'var(--text-secondary)' }}>Nových</div>
          </div>
          <div className="rounded p-3 text-center" style={{ background: 'var(--info-soft-bg)' }}>
            <div className="text-2xl font-bold" style={{ color: 'var(--info-fg)' }}>{result.updated}</div>
            <div style={{ color: 'var(--text-secondary)' }}>Aktualizovaných</div>
          </div>
          <div className="rounded p-3 text-center" style={{ background: 'var(--surface-sunken)' }}>
            <div className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>{result.skipped}</div>
            <div style={{ color: 'var(--text-secondary)' }}>Přeskočeno</div>
          </div>
          <div className="rounded p-3 text-center" style={{ background: 'var(--danger-soft-bg)' }}>
            <div className="text-2xl font-bold" style={{ color: 'var(--danger-fg)' }}>{result.errors.length}</div>
            <div style={{ color: 'var(--text-secondary)' }}>Chyb</div>
          </div>
        </div>

        {result.errors.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm" style={{ color: 'var(--danger-solid)' }}>
              Zobrazit chyby ({result.errors.length})
            </summary>
            <div className="mt-2 max-h-48 overflow-y-auto rounded p-2 text-xs" style={{ border: '1px solid var(--border-default)' }}>
              {result.errors.map((e, i) => (
                <div key={i} className="py-0.5">
                  <span style={{ color: 'var(--text-secondary)' }}>Řádek {e.row}:</span> {e.error}
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="mt-4 flex gap-3">
          <button
            onClick={onImportDone}
            className="rounded-md px-4 py-2 text-sm"
            style={{ background: 'var(--accent)', color: 'var(--text-on-accent)' }}
          >
            Zobrazit produkty
          </button>
          <button
            onClick={() => { setStep('upload'); setPreview(null); setResult(null); }}
            className="rounded-md px-4 py-2 text-sm"
            style={{ border: '1px solid var(--border-default)', color: 'var(--text-secondary)' }}
          >
            Další import
          </button>
        </div>
      </div>
    );
  }

  return null;
}
