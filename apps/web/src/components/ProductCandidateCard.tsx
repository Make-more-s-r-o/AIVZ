import { cn } from '../lib/cn';
import { Check, X, AlertTriangle, ExternalLink } from 'lucide-react';
import type { ProductCandidate } from '../types/tender';

const CONFIDENCE_LABELS: Record<string, { label: string; color: string }> = {
  vysoka: { label: 'Vysoká', color: 'bg-green-100 text-green-800' },
  stredni: { label: 'Střední', color: 'bg-yellow-100 text-yellow-800' },
  nizka: { label: 'Nízká', color: 'bg-red-100 text-red-800' },
};

interface ProductCandidateCardProps {
  product: ProductCandidate;
  isSelected: boolean;
}

export default function ProductCandidateCard({ product, isSelected }: ProductCandidateCardProps) {
  const confidence = CONFIDENCE_LABELS[product.cena_spolehlivost] ?? { label: 'Nizka', color: 'bg-red-100 text-red-800' };

  return (
    <div
      className={cn(
        'rounded-lg border p-4',
        isSelected
          ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
          : 'bg-white'
      )}
    >
      {isSelected && (
        <div className="mb-2 inline-block rounded bg-blue-600 px-2 py-0.5 text-xs font-bold text-white">
          VYBRANÝ
        </div>
      )}
      <h4 className="font-semibold">{product.vyrobce} {product.model}</h4>
      <p className="mt-1 text-sm text-gray-600">{product.popis}</p>

      <div className="mt-3 border-t pt-3">
        <div className="flex items-center gap-2">
          <div className="text-lg font-bold text-gray-900">
            {product.cena_bez_dph?.toLocaleString('cs-CZ')} Kč
          </div>
          <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium', confidence.color)}>
            {confidence.label}
          </span>
        </div>
        <div className="text-xs text-gray-500">
          s DPH: {product.cena_s_dph?.toLocaleString('cs-CZ')} Kč
        </div>
        {product.cena_komentar && (
          <div className="mt-1 flex items-start gap-1 text-xs text-amber-700">
            <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{product.cena_komentar}</span>
          </div>
        )}
        {product.zdroj_ceny && (
          <div className="mt-1 text-xs text-gray-600">
            <span className="font-medium">Zdroj:</span> {product.zdroj_ceny}
          </div>
        )}
      </div>

      {/* Part number + Google search */}
      {product.katalogove_cislo && (
        <div className="mt-2 flex items-center gap-2">
          <span className="text-xs text-gray-500">P/N:</span>
          <a
            href={`https://www.google.com/search?q=${encodeURIComponent(product.katalogove_cislo)}`}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-0.5 text-xs font-mono text-blue-600 hover:bg-blue-100 hover:text-blue-800 transition-colors"
          >
            {product.katalogove_cislo}
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}

      {product.parametry && (
        <div className="mt-3 border-t pt-3">
          <div className="text-xs font-medium text-gray-500">Parametry</div>
          <div className="mt-1 space-y-1">
            {Object.entries(product.parametry).map(([key, val]) => (
              <div key={key} className="flex justify-between text-xs">
                <span className="text-gray-600">{key}</span>
                <span className="font-medium">{val as string}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {product.shoda_s_pozadavky?.length > 0 && (
        <div className="mt-3 border-t pt-3">
          <div className="text-xs font-medium text-gray-500">Shoda s požadavky</div>
          <div className="mt-1 space-y-1">
            {product.shoda_s_pozadavky.map((s, j: number) => (
              <div key={j} className="flex items-start gap-1 text-xs">
                {s.splneno ? (
                  <Check className="mt-0.5 h-3 w-3 shrink-0 text-green-500" />
                ) : (
                  <X className="mt-0.5 h-3 w-3 shrink-0 text-red-500" />
                )}
                <span>{s.pozadavek}: {s.hodnota}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {product.dodavatele?.length > 0 && (
        <div className="mt-3 text-xs text-gray-500">
          Dodavatelé: {product.dodavatele.join(', ')}
        </div>
      )}
      {product.dostupnost && (
        <div className="text-xs text-gray-500">Dostupnost: {product.dostupnost}</div>
      )}
    </div>
  );
}
