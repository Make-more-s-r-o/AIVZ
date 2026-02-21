import { useState, useEffect } from 'react';
import TenderList from './components/TenderList';
import TenderDetail from './components/TenderDetail';
import { getAuthToken, setAuthToken, clearAuthToken } from './lib/api';

export default function App() {
  const [selectedTenderId, setSelectedTenderId] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(getAuthToken());
  const [tokenInput, setTokenInput] = useState('');
  const [showTokenDialog, setShowTokenDialog] = useState(false);

  // Show token dialog if no token is set and we're likely on a remote server
  useEffect(() => {
    if (!token && window.location.hostname !== 'localhost') {
      setShowTokenDialog(true);
    }
  }, [token]);

  const handleTokenSubmit = () => {
    if (tokenInput.trim()) {
      setAuthToken(tokenInput.trim());
      setToken(tokenInput.trim());
      setTokenInput('');
      setShowTokenDialog(false);
    }
  };

  const handleLogout = () => {
    clearAuthToken();
    setToken(null);
    setShowTokenDialog(true);
  };

  return (
    <div className="min-h-screen">
      {/* Token dialog */}
      {showTokenDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 w-full max-w-sm rounded-lg bg-white p-6 shadow-xl">
            <h2 className="mb-2 text-lg font-semibold">API Token</h2>
            <p className="mb-4 text-sm text-gray-600">
              Zadejte API token pro přístup k serveru.
            </p>
            <input
              type="password"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleTokenSubmit()}
              placeholder="Bearer token..."
              className="mb-3 w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={handleTokenSubmit}
                className="flex-1 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Uložit
              </button>
              {window.location.hostname === 'localhost' && (
                <button
                  onClick={() => setShowTokenDialog(false)}
                  className="rounded border px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Přeskočit
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <header className="border-b bg-white px-6 py-4">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-3">
            <h1
              className="cursor-pointer text-xl font-bold text-gray-900"
              onClick={() => setSelectedTenderId(null)}
            >
              VZ AI Tool
            </h1>
            <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700">
              Mini MVP
            </span>
          </div>
          <div className="flex items-center gap-4">
            {selectedTenderId && (
              <button
                onClick={() => setSelectedTenderId(null)}
                className="text-sm text-gray-500 hover:text-gray-900"
              >
                &larr; Zpět na seznam
              </button>
            )}
            {token ? (
              <button
                onClick={handleLogout}
                className="text-xs text-gray-400 hover:text-gray-600"
                title="Odhlásit API token"
              >
                Token: ***
              </button>
            ) : (
              <button
                onClick={() => setShowTokenDialog(true)}
                className="text-xs text-amber-600 hover:text-amber-800"
              >
                Nastavit token
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 py-8">
        {selectedTenderId ? (
          <TenderDetail tenderId={selectedTenderId} />
        ) : (
          <TenderList onSelect={setSelectedTenderId} />
        )}
      </main>
    </div>
  );
}
