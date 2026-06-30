import { Radar } from 'lucide-react';

/**
 * Monitoring — STUB / placeholder. Multi-source tender aggregation (TenderArena,
 * NEN, Vhodné uveřejnění, e-zakázky, Hlídač státu) is a later milestone; for now
 * an honest empty state. Manual import lives on the Zakázky screen.
 */
export default function MonitoringPage() {
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--text-primary)' }}>Monitoring</h1>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>Automatické sledování nových zakázek z více zdrojů</p>
      <div style={{
        marginTop: 20, padding: '48px 24px', textAlign: 'center', background: 'var(--surface-card)',
        border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-lg)',
      }}>
        <Radar size={28} style={{ color: 'var(--text-tertiary)', marginBottom: 10 }} />
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
          Žádné nové zakázky. Monitoring poběží automaticky.
        </div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', marginTop: 6 }}>
          Napojení zdrojů (Hlídač státu, NEN, TenderArena…) je v přípravě.
        </div>
      </div>
    </div>
  );
}
