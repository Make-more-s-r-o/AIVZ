import { ArrowLeft } from 'lucide-react';
import TenderDetail from '../components/TenderDetail';

export interface TenderDetailPageProps {
  tenderId: string;
  onBack: () => void;
}

/**
 * Detail zakázky — STUB. Renders a back link + the existing TenderDetail
 * (which already carries the Pipeline/Analýza/Produkty/Dokumenty/Validace tabs).
 * The dedicated screen agent re-frames it with the design header (StageStepper,
 * "Změnit stav"), the right metadata rail, and the CRM tab set.
 */
export default function TenderDetailPage({ tenderId, onBack }: TenderDetailPageProps) {
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <button
        onClick={onBack}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontFamily: 'var(--font-sans)', fontSize: 'var(--font-size-sm)', marginBottom: 14, padding: 0 }}
      >
        <ArrowLeft size={15} /> Zpět na zakázky
      </button>
      <TenderDetail tenderId={tenderId} />
    </div>
  );
}
