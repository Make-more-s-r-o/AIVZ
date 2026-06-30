import CompanySettings from '../components/CompanySettings';
import UserManagement from '../components/UserManagement';
import ChangePasswordForm from '../components/ChangePasswordForm';
import { Tabs } from '../components/ui';

export type SettingsSection = 'firmy' | 'uzivatele' | 'heslo';

export interface NastaveniPageProps {
  section: SettingsSection;
  currentUserId?: string;
  onNavSection: (section: SettingsSection) => void;
}

/**
 * Nastavení — STUB. Sub-navigation (Firmy · Uživatelé a role · Heslo) wrapping
 * the existing CompanySettings / UserManagement / ChangePasswordForm. The screen
 * agent restyles the inner forms to the design tokens.
 */
export default function NastaveniPage({ section, currentUserId, onNavSection }: NastaveniPageProps) {
  return (
    <div style={{ maxWidth: 1280, margin: '0 auto' }}>
      <h1 style={{ fontSize: 'var(--font-size-xl)', fontWeight: 700, color: 'var(--text-primary)' }}>Nastavení</h1>
      <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)', marginTop: 2, marginBottom: 16 }}>
        Firmy, uživatelé a zabezpečení
      </p>
      <Tabs
        value={section}
        onChange={(v) => onNavSection(v as SettingsSection)}
        tabs={[
          { value: 'firmy', label: 'Firmy' },
          { value: 'uzivatele', label: 'Uživatelé a role' },
          { value: 'heslo', label: 'Heslo' },
        ]}
        style={{ marginBottom: 20 }}
      />
      {section === 'firmy' && <CompanySettings />}
      {section === 'uzivatele' && currentUserId && <UserManagement currentUserId={currentUserId} />}
      {section === 'heslo' && <ChangePasswordForm />}
    </div>
  );
}
