import { Building2 } from 'lucide-react';
import { Button } from '../components/ui';

export interface RegistraceFirmyPageProps {
  onDone?: () => void;
}

/**
 * Registrace firmy (onboarding) — STUB. The dedicated screen agent builds the
 * full form (název, IČO, DIČ, sídlo, kontakt, datová schránka, DOC_SLOTS) wired
 * to POST /api/companies. For now a placeholder pointing to Nastavení → Firmy.
 */
export default function RegistraceFirmyPage({ onDone }: RegistraceFirmyPageProps) {
  return (
    <div style={{ maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--text-primary)' }}>Registrace firmy</h1>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>
        Firma, která dodává řešení do veřejných zakázek — její údaje plní nabídkové dokumenty.
      </p>
      <div style={{
        marginTop: 20, padding: '40px 24px', textAlign: 'center', background: 'var(--surface-card)',
        border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-lg)',
      }}>
        <Building2 size={28} style={{ color: 'var(--text-tertiary)', marginBottom: 10 }} />
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginBottom: 16 }}>
          Registrační formulář firmy je v přípravě. Zatím spravujte firmy v Nastavení.
        </div>
        {onDone && <Button variant="secondary" onClick={onDone}>Přejít na Nastavení → Firmy</Button>}
      </div>
    </div>
  );
}
