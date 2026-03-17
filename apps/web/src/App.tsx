import { useState, useEffect } from 'react';
import TenderList from './components/TenderList';
import TenderDetail from './components/TenderDetail';
import LoginForm from './components/LoginForm';
import UserManagement from './components/UserManagement';
import ChangePasswordForm from './components/ChangePasswordForm';
import CompanySettings from './components/CompanySettings';
import { getStoredUser, clearAuth, isAuthenticated, type AuthUser } from './lib/auth';
import { getAuthToken } from './lib/api';

type Route =
  | { view: 'tenders'; tenderId: null }
  | { view: 'tenders'; tenderId: string }
  | { view: 'companies' }
  | { view: 'users' }
  | { view: 'change-password' };

function parseHash(): Route {
  const hash = window.location.hash.slice(1) || '/';
  if (hash.startsWith('/tender/')) {
    const tenderId = hash.split('/')[2];
    if (tenderId) return { view: 'tenders', tenderId };
  }
  if (hash === '/settings/companies') return { view: 'companies' };
  if (hash === '/settings/users') return { view: 'users' };
  if (hash === '/settings/password') return { view: 'change-password' };
  return { view: 'tenders', tenderId: null };
}

function navigate(path: string) {
  window.location.hash = path;
}

export default function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [user, setUser] = useState<AuthUser | null>(getStoredUser());
  const [loggedIn, setLoggedIn] = useState(isAuthenticated() || !!getAuthToken());
  const [showUserMenu, setShowUserMenu] = useState(false);

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // Close user menu on outside click
  useEffect(() => {
    if (!showUserMenu) return;
    const handler = () => setShowUserMenu(false);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [showUserMenu]);

  const view = route.view;
  const selectedTenderId = route.view === 'tenders' ? route.tenderId : null;

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

  // Not authenticated: show login form
  // On localhost without JWT, allow skipping (legacy behavior via getAuthToken check)
  if (!loggedIn && window.location.hostname !== 'localhost') {
    return <LoginForm onLogin={handleLogin} />;
  }
  if (!loggedIn && !getAuthToken()) {
    return <LoginForm onLogin={handleLogin} />;
  }

  return (
    <div className="min-h-screen">
      <header className="border-b bg-white px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-3">
            <h1
              className="cursor-pointer text-xl font-bold text-gray-900"
              onClick={() => navigate('/')}
            >
              VZ AI Tool
            </h1>
            <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
              Mini MVP
            </span>
          </div>
          <div className="flex items-center gap-4">
            {selectedTenderId && view === 'tenders' && (
              <button
                onClick={() => navigate('/')}
                className="text-sm text-gray-500 hover:text-gray-900"
              >
                &larr; Zpět na seznam
              </button>
            )}
            {view !== 'tenders' && (
              <button
                onClick={() => navigate('/')}
                className="text-sm text-gray-500 hover:text-gray-900"
              >
                &larr; Zakázky
              </button>
            )}
            {user ? (
              <div className="relative">
                <button
                  onClick={(e) => { e.stopPropagation(); setShowUserMenu(!showUserMenu); }}
                  className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
                >
                  <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-blue-100 text-xs font-medium text-blue-700">
                    {user.name.charAt(0).toUpperCase()}
                  </span>
                  <span className="hidden sm:inline">{user.name}</span>
                </button>
                {showUserMenu && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-48 rounded-md border bg-white py-1 shadow-lg">
                    <button
                      onClick={() => { navigate('/settings/companies'); setShowUserMenu(false); }}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                    >
                      Správa firem
                    </button>
                    <button
                      onClick={() => { navigate('/settings/users'); setShowUserMenu(false); }}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                    >
                      Správa uživatelů
                    </button>
                    <button
                      onClick={() => { navigate('/settings/password'); setShowUserMenu(false); }}
                      className="w-full px-4 py-2 text-left text-sm text-gray-700 hover:bg-gray-100"
                    >
                      Změnit heslo
                    </button>
                    <hr className="my-1" />
                    <button
                      onClick={handleLogout}
                      className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-gray-100"
                    >
                      Odhlásit se
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                onClick={handleLogout}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                Token: ***
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {view === 'companies' && <CompanySettings />}
        {view === 'users' && user && (
          <UserManagement currentUserId={user.id} />
        )}
        {view === 'change-password' && (
          <ChangePasswordForm />
        )}
        {view === 'tenders' && (
          selectedTenderId ? (
            <TenderDetail tenderId={selectedTenderId} />
          ) : (
            <TenderList onSelect={(id) => navigate('/tender/' + id)} />
          )
        )}
      </main>
    </div>
  );
}
