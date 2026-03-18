import { useState } from 'react';
import {
  uploadImportFile, runWarehouseImport, getWarehouseSources, getWarehouseCategories,
  type ImportPreview, type ImportResult, type WarehouseCategory,
} from '../../lib/api';

const TARGET_FIELDS = [
  { value: 'manufacturer', label: 'Vyrobce' },
  { value: 'model', label: 'Model / Nazev' },
  { value: 'ean', label: 'EAN' },
  { value: 'part_number', label: 'Katalogove cislo' },
  { value: 'description', label: 'Popis' },
  { value: 'price_bez_dph', label: 'Cena bez DPH' },
  { value: 'price_s_dph', label: 'Cena s DPH' },
  { value: 'category', label: 'Kategorie' },
  { value: 'product_family', label: 'Produktova rada' },
  { value: 'image_url', label: 'URL obrazku' },
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
      <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center">
        <p className="mb-4 text-gray-600">
          Nahrajte CSV nebo Excel soubor s produkty
        </p>
        <label className="inline-block cursor-pointer rounded-md bg-blue-600 px-6 py-2 text-sm text-white hover:bg-blue-700">
          Vybrat soubor
          <input
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFileUpload}
            className="hidden"
          />
        </label>
        {loading && <p className="mt-3 text-sm text-gray-500">Analyzuji soubor...</p>}
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </div>
    );
  }

  // Step 2: Mapping
  if (step === 'mapping' && preview) {
    return (
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold">Mapovani sloupcu</h3>
            <p className="text-sm text-gray-500">
              {preview.filename} — {preview.total_rows} radku, {preview.columns.length} sloupcu
            </p>
          </div>
          <button
            onClick={() => { setStep('upload'); setPreview(null); }}
            className="text-sm text-gray-500 hover:text-gray-700"
          >
            Zrusit
          </button>
        </div>

        {error && (
          <div className="mb-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {/* Nastaveni importu */}
        <div className="mb-4 flex flex-wrap gap-4 rounded-lg bg-gray-50 p-4">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Zdroj dat</label>
            <select
              value={sourceId}
              onChange={(e) => setSourceId(Number(e.target.value))}
              className="rounded border px-3 py-1.5 text-sm"
            >
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Kategorie</label>
            <select
              value={categoryId ?? ''}
              onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : undefined)}
              className="rounded border px-3 py-1.5 text-sm"
            >
              <option value="">-- neurci --</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.parent_id ? '\u00A0\u00A0' : ''}{c.nazev}</option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enrichParams}
                onChange={(e) => setEnrichParams(e.target.checked)}
              />
              AI normalizace parametru
            </label>
          </div>
        </div>

        {/* Mapping tabulka */}
        <div className="mb-4 overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Sloupec v souboru</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Cilove pole</th>
                <th className="px-4 py-2 text-left font-medium text-gray-600">Ukazka dat</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {mapping.map((m, i) => (
                <tr key={i} className="hover:bg-gray-50">
                  <td className="px-4 py-2 font-medium">{m.source_name}</td>
                  <td className="px-4 py-2">
                    <select
                      value={m.target_field || 'ignore'}
                      onChange={(e) => handleMappingChange(i, e.target.value)}
                      className={`rounded border px-2 py-1 text-sm ${
                        m.target_field === 'ignore' || !m.target_field
                          ? 'text-gray-400'
                          : ''
                      }`}
                    >
                      {TARGET_FIELDS.map((f) => (
                        <option key={f.value} value={f.value}>{f.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="max-w-xs truncate px-4 py-2 text-gray-500">
                    {preview.sample_rows[0]?.[m.source_name] || '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Preview dat */}
        <details className="mb-4">
          <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700">
            Ukazka dat ({Math.min(10, preview.sample_rows.length)} radku)
          </summary>
          <div className="mt-2 overflow-x-auto rounded border">
            <table className="w-full text-xs">
              <thead className="bg-gray-50">
                <tr>
                  {preview.columns.map((c) => (
                    <th key={c} className="whitespace-nowrap px-3 py-1 text-left">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.sample_rows.map((row, i) => (
                  <tr key={i} className="border-t">
                    {preview.columns.map((c) => (
                      <td key={c} className="max-w-32 truncate px-3 py-1">{row[c] || ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>

        <button
          onClick={handleRunImport}
          className="rounded-md bg-green-600 px-6 py-2 text-sm text-white hover:bg-green-700"
        >
          Spustit import ({preview.total_rows} radku)
        </button>
      </div>
    );
  }

  // Step 3: Running
  if (step === 'running') {
    return (
      <div className="rounded-lg border p-8 text-center">
        <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-4 border-blue-200 border-t-blue-600" />
        <p className="text-gray-600">Import probiha...</p>
        <p className="mt-1 text-sm text-gray-400">
          Zpracovavam {preview?.total_rows} radku
          {enrichParams && ' s AI normalizaci parametru'}
        </p>
      </div>
    );
  }

  // Step 4: Done
  if (step === 'done' && result) {
    return (
      <div className="rounded-lg border p-6">
        <h3 className="mb-3 text-lg font-semibold text-green-700">Import dokoncen</h3>
        <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-4">
          <div className="rounded bg-green-50 p-3 text-center">
            <div className="text-2xl font-bold text-green-700">{result.imported}</div>
            <div className="text-gray-500">Novych</div>
          </div>
          <div className="rounded bg-blue-50 p-3 text-center">
            <div className="text-2xl font-bold text-blue-700">{result.updated}</div>
            <div className="text-gray-500">Aktualizovanych</div>
          </div>
          <div className="rounded bg-gray-50 p-3 text-center">
            <div className="text-2xl font-bold text-gray-700">{result.skipped}</div>
            <div className="text-gray-500">Preskoceno</div>
          </div>
          <div className="rounded bg-red-50 p-3 text-center">
            <div className="text-2xl font-bold text-red-700">{result.errors.length}</div>
            <div className="text-gray-500">Chyb</div>
          </div>
        </div>

        {result.errors.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-red-600">
              Zobrazit chyby ({result.errors.length})
            </summary>
            <div className="mt-2 max-h-48 overflow-y-auto rounded border p-2 text-xs">
              {result.errors.map((e, i) => (
                <div key={i} className="py-0.5">
                  <span className="text-gray-500">Radek {e.row}:</span> {e.error}
                </div>
              ))}
            </div>
          </details>
        )}

        <div className="mt-4 flex gap-3">
          <button
            onClick={onImportDone}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
          >
            Zobrazit produkty
          </button>
          <button
            onClick={() => { setStep('upload'); setPreview(null); setResult(null); }}
            className="rounded-md border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            Dalsi import
          </button>
        </div>
      </div>
    );
  }

  return null;
}
