import { useQuery } from '@tanstack/react-query';
import { Calendar } from 'lucide-react';
import { getTenders } from '../lib/api';

/**
 * Kalendář / Lhůty — STUB / placeholder. The full month/list deadline calendar
 * reads from analyzy.terminy + reminders (later milestone). For now an honest
 * empty state; the count of known tenders hints at future content.
 */
export default function KalendarPage() {
  const { data: tenders = [] } = useQuery({ queryKey: ['tenders'], queryFn: getTenders });
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--text-primary)' }}>Kalendář</h1>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2 }}>Lhůty a termíny napříč zakázkami</p>
      <div style={{
        marginTop: 20, padding: '48px 24px', textAlign: 'center', background: 'var(--surface-card)',
        border: '1px dashed var(--border-default)', borderRadius: 'var(--radius-lg)',
      }}>
        <Calendar size={28} style={{ color: 'var(--text-tertiary)', marginBottom: 10 }} />
        <div style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>Žádné nadcházející termíny</div>
        <div style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-tertiary)', marginTop: 6 }}>
          {tenders.length} zakázek v systému · kalendář lhůt je v přípravě.
        </div>
      </div>
    </div>
  );
}
