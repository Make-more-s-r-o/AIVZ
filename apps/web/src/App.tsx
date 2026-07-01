import { useState, useEffect } from 'react';
import LoginForm from './components/LoginForm';
import WarehouseDashboard from './components/warehouse/WarehouseDashboard';
import ProductDetailPage from './components/warehouse/ProductDetailPage';
import { AppShell, type NavKey } from './components/layout/AppShell';
import PrehledPage from './pages/PrehledPage';
import MonitoringPage from './pages/MonitoringPage';
import PipelinePage from './pages/PipelinePage';
import ZakazkyPage from './pages/ZakazkyPage';
import KalendarPage from './pages/KalendarPage';
import TenderDetailPage from './pages/TenderDetailPage';
import NastaveniPage, { type SettingsSection } from './pages/NastaveniPage';
import RegistraceFirmyPage from './pages/RegistraceFirmyPage';
import { getStoredUser, clearAuth, isAuthenticated, type AuthUser } from './lib/auth';
import { getAuthToken } from './lib/api';

type WarehouseTab = 'dashboard' | 'products' | 'import' | 'scraping' | 'sources';

type Route =
  | { view: 'prehled' }
  | { view: 'monitoring' }
  | { view: 'pipeline' }
  | { view: 'zakazky' }
  | { view: 'kalendar' }
  | { view: 'tender'; tenderId: string; tab?: string }
  | { view: 'warehouse'; tab: WarehouseTab }
  | { view: 'warehouse-product'; productId: string }
  | { view: 'registrace' }
  | { view: 'settings'; section: SettingsSection };

const WAREHOUSE_TAB_LABELS: Record<WarehouseTab, string> = {
  dashboard: 'Přehled', products: 'Produkty', import: 'Import', scraping: 'Scraping', sources: 'Zdroje',
};
const SETTINGS_LABELS: Record<SettingsSection, string> = {
  firmy: 'Firmy', uzivatele: 'Uživatelé a role', heslo: 'Heslo', stitky: 'Štítky',
};

function parseHash(): Route {
  const hash = window.location.hash.slice(1) || '/';
  const qIdx = hash.indexOf('?');
  const path = qIdx === -1 ? hash : hash.slice(0, qIdx);

  if (path.startsWith('/tender/')) {
    const tenderId = path.split('/')[2];
    if (tenderId) {
      // Deep-link na konkrétní záložku, např. #/tender/<id>?tab=komentare (zvonek notifikace).
      const q = qIdx === -1 ? '' : hash.slice(qIdx + 1);
      const tab = new URLSearchParams(q).get('tab') || undefined;
      return { view: 'tender', tenderId, tab };
    }
  }
  if (path.startsWith('/warehouse/product/')) {
    const productId = path.split('/')[3];
    if (productId) return { view: 'warehouse-product', productId };
  }
  if (path === '/warehouse') return { view: 'warehouse', tab: 'dashboard' };
  if (path === '/warehouse/products') return { view: 'warehouse', tab: 'products' };
  if (path === '/warehouse/import') return { view: 'warehouse', tab: 'import' };
  if (path === '/warehouse/scraping') return { view: 'warehouse', tab: 'scraping' };
  if (path === '/warehouse/sources') return { view: 'warehouse', tab: 'sources' };
  if (path === '/warehouse/dashboard') return { view: 'warehouse', tab: 'dashboard' };
  if (path === '/settings/companies') return { view: 'settings', section: 'firmy' };
  if (path === '/settings/users') return { view: 'settings', section: 'uzivatele' };
  if (path === '/settings/password') return { view: 'settings', section: 'heslo' };
  if (path === '/settings/tags') return { view: 'settings', section: 'stitky' };
  if (path === '/registrace') return { view: 'registrace' };
  if (path === '/monitoring') return { view: 'monitoring' };
  if (path === '/pipeline') return { view: 'pipeline' };
  if (path === '/zakazky') return { view: 'zakazky' };
  if (path === '/kalendar') return { view: 'kalendar' };
  if (path === '/prehled') return { view: 'prehled' };
  return { view: 'prehled' };
}

function navigate(path: string) {
  window.location.hash = path;
}

function navKeyForRoute(route: Route): NavKey {
  switch (route.view) {
    case 'prehled': return 'prehled';
    case 'monitoring': return 'monitoring';
    case 'pipeline': return 'pipeline';
    case 'zakazky':
    case 'tender': return 'zakazky';
    case 'kalendar': return 'kalendar';
    case 'warehouse':
    case 'warehouse-product': return 'sklad';
    case 'settings':
    case 'registrace': return 'nastaveni';
  }
}

function breadcrumbsForRoute(route: Route): string[] {
  switch (route.view) {
    case 'prehled': return ['Přehled'];
    case 'monitoring': return ['Monitoring'];
    case 'pipeline': return ['Pipeline'];
    case 'zakazky': return ['Zakázky'];
    case 'tender': return ['Zakázky', route.tenderId];
    case 'kalendar': return ['Kalendář'];
    case 'warehouse': return ['Cenový sklad', WAREHOUSE_TAB_LABELS[route.tab]];
    case 'warehouse-product': return ['Cenový sklad', 'Produkt'];
    case 'settings': return ['Nastavení', SETTINGS_LABELS[route.section]];
    case 'registrace': return ['Nastavení', 'Registrace firmy'];
  }
}

const NAV_HASH: Record<NavKey, string> = {
  prehled: '/', monitoring: '/monitoring', pipeline: '/pipeline', zakazky: '/zakazky',
  kalendar: '/kalendar', sklad: '/warehouse', nastaveni: '/settings/companies',
};

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [user, setUser] = useState<AuthUser | null>(getStoredUser());
  const [loggedIn, setLoggedIn] = useState(isAuthenticated() || !!getAuthToken());

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const handleLogin = (loginUser: AuthUser) => {
    setUser(loginUser);
    setLoggedIn(true);
  };

  const handleLogout = () => {
    clearAuth();
    setUser(null);
    setLoggedIn(false);
    window.location.hash = '/';
  };

  // Not authenticated: show login form (localhost without JWT keeps legacy skip).
  if (!loggedIn && window.location.hostname !== 'localhost') {
    return <LoginForm onLogin={handleLogin} />;
  }
  if (!loggedIn && !getAuthToken()) {
    return <LoginForm onLogin={handleLogin} />;
  }

  let content: React.ReactNode;
  switch (route.view) {
    case 'prehled':
      content = <PrehledPage onOpen={(id) => navigate('/tender/' + id)} currentUserId={user?.id} />;
      break;
    case 'monitoring':
      content = <MonitoringPage onOpen={(id) => navigate('/tender/' + id)} />;
      break;
    case 'pipeline':
      content = <PipelinePage onOpen={(id) => navigate('/tender/' + id)} />;
      break;
    case 'zakazky':
      content = <ZakazkyPage onOpen={(id) => navigate('/tender/' + id)} />;
      break;
    case 'kalendar':
      content = <KalendarPage />;
      break;
    case 'tender':
      // key={tenderId} → remount při přepnutí zakázky, aby se initialTab (deep-link) čistě
      // aplikoval na novou zakázku a nezůstala „zděděná" záložka z předchozí.
      content = <TenderDetailPage key={route.tenderId} tenderId={route.tenderId} initialTab={route.tab} onBack={() => navigate('/zakazky')} />;
      break;
    case 'warehouse':
      content = <WarehouseDashboard initialTab={route.tab} />;
      break;
    case 'warehouse-product':
      content = <ProductDetailPage productId={route.productId} onBack={() => window.history.back()} />;
      break;
    case 'registrace':
      content = <RegistraceFirmyPage onDone={() => navigate('/settings/companies')} />;
      break;
    case 'settings':
      content = (
        <NastaveniPage
          section={route.section}
          currentUserId={user?.id}
          onNavSection={(s) => navigate(
            s === 'firmy' ? '/settings/companies' : s === 'uzivatele' ? '/settings/users' : s === 'heslo' ? '/settings/password' : '/settings/tags'
          )}
        />
      );
      break;
  }

  return (
    <AppShell
      active={navKeyForRoute(route)}
      onNav={(key) => navigate(NAV_HASH[key])}
      breadcrumbs={breadcrumbsForRoute(route)}
      user={user ? { name: user.name } : null}
      onLogout={handleLogout}
    >
      {content}
    </AppShell>
  );
}
