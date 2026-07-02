import CompanySettings from '../components/CompanySettings';
import UserManagement from '../components/UserManagement';
import ChangePasswordForm from '../components/ChangePasswordForm';
import TagManager from '../components/TagManager';
import { Tabs } from '../components/ui';

export type SettingsSection = 'firmy' | 'uzivatele' | 'heslo' | 'stitky';

export interface NastaveniPageProps {
  section: SettingsSection;
  currentUserId?: string;
  onNavSection: (section: SettingsSection) => void;
}

/**
 * Nastavení — pod-navigace (Firmy · Uživatelé a role · Heslo · Štítky) obalující
 * CompanySettings / UserManagement / ChangePasswordForm / TagManager.
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
          { value: 'stitky', label: 'Štítky' },
        ]}
        style={{ marginBottom: 20 }}
      />
      {section === 'firmy' && <CompanySettings />}
      {section === 'uzivatele' && (currentUserId ? (
        <UserManagement currentUserId={currentUserId} />
      ) : (
        // Bez přihlášeného uživatele (dev bez JWT / chybějící profil) nenechávej prázdnou plochu.
        <p style={{ fontSize: 'var(--font-size-sm)', color: 'var(--text-secondary)' }}>
          Správa uživatelů vyžaduje přihlášení. Přihlaste se prosím znovu.
        </p>
      ))}
      {section === 'heslo' && <ChangePasswordForm />}
      {section === 'stitky' && <TagManager />}
    </div>
  );
}
