import TenderList from '../components/TenderList';

export interface ZakazkyPageProps {
  onOpen?: (id: string) => void;
}

/**
 * Zakázky — STUB. Wraps the existing TenderList (portfolio grid) so the page
 * works immediately; the dedicated screen agent replaces it with the dense,
 * filterable design-system table (saved views, status badges, score chips).
 */
export default function ZakazkyPage({ onOpen }: ZakazkyPageProps) {
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <TenderList onSelect={(id) => onOpen?.(id)} />
    </div>
  );
}
