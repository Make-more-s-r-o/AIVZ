import { useState } from 'react';
import TenderList from './components/TenderList';
import TenderDetail from './components/TenderDetail';

export default function App() {
  const [selectedTenderId, setSelectedTenderId] = useState<string | null>(null);

  return (
    <div className="min-h-screen">
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
          {selectedTenderId && (
            <button
              onClick={() => setSelectedTenderId(null)}
              className="text-sm text-gray-500 hover:text-gray-900"
            >
              &larr; Zpět na seznam
            </button>
          )}
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
