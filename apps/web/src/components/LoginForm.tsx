import { useState, useEffect } from 'react';
import {
  getAuthStatus, login, setupFirstUser, setAuth,
  type AuthUser, type AuthStatus,
} from '../lib/auth';
import { setAuthToken } from '../lib/api';

interface LoginFormProps {
  onLogin: (user: AuthUser) => void;
}

export default function LoginForm({ onLogin }: LoginFormProps) {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Form fields
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [legacyToken, setLegacyToken] = useState('');

  useEffect(() => {
    getAuthStatus()
      .then(setStatus)
      .catch(() => setStatus({ setupRequired: false, jwtEnabled: false }))
      .finally(() => setLoading(false));
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await login(email, password);
      setAuth(result.token, result.user);
      onLogin(result.user);
    } catch (err: any) {
      setError(err.message || 'Přihlášení selhalo');
    } finally {
      setSubmitting(false);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const result = await setupFirstUser(email, name, password);
      if (result.token) {
        setAuth(result.token, result.user);
      }
      onLogin(result.user);
    } catch (err: any) {
      setError(err.message || 'Vytvoření účtu selhalo');
    } finally {
      setSubmitting(false);
    }
  };

  const handleLegacyToken = (e: React.FormEvent) => {
    e.preventDefault();
    if (legacyToken.trim()) {
      setAuthToken(legacyToken.trim());
      // Reload to let App detect the token
      window.location.reload();
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-gray-500">Načítání...</div>
      </div>
    );
  }

  // Fallback: JWT not enabled, show legacy token dialog
  if (status && !status.jwtEnabled) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="mx-4 w-full max-w-sm rounded-lg bg-white p-6 shadow-lg">
          <h2 className="mb-2 text-lg font-semibold text-gray-900">API Token</h2>
          <p className="mb-4 text-sm text-gray-600">
            Zadejte API token pro přístup k serveru.
          </p>
          <form onSubmit={handleLegacyToken}>
            <input
              type="password"
              value={legacyToken}
              onChange={(e) => setLegacyToken(e.target.value)}
              placeholder="Bearer token..."
              className="mb-3 w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                type="submit"
                className="flex-1 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Uložit
              </button>
              {window.location.hostname === 'localhost' && (
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="rounded border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Přeskočit
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
    );
  }

  // Setup mode: first user creation
  if (status?.setupRequired) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="mx-4 w-full max-w-sm rounded-lg bg-white p-6 shadow-lg">
          <h2 className="mb-1 text-lg font-semibold text-gray-900">Vytvořit účet</h2>
          <p className="mb-4 text-sm text-gray-600">
            Žádný uživatel nebyl nalezen. Vytvořte první účet.
          </p>
          {error && (
            <div className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}
          <form onSubmit={handleSetup} className="space-y-3">
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Jméno</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jan Novák"
                className="w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                required
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">E-mail</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jan@firma.cz"
                className="w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-gray-700">Heslo</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimálně 6 znaků"
                className="w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                required
                minLength={6}
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? 'Vytvářím...' : 'Vytvořit účet'}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Login form
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50">
      <div className="mx-4 w-full max-w-sm rounded-lg bg-white p-6 shadow-lg">
        <h2 className="mb-1 text-lg font-semibold text-gray-900">Přihlášení</h2>
        <p className="mb-4 text-sm text-gray-600">VZ AI Tool</p>
        {error && (
          <div className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
        )}
        <form onSubmit={handleLogin} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">E-mail</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="jan@firma.cz"
              className="w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              required
              autoFocus
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Heslo</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              required
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? 'Přihlašuji...' : 'Přihlásit se'}
          </button>
        </form>
      </div>
    </div>
  );
}
