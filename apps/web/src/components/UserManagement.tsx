import { useState, useEffect, useCallback } from 'react';
import { getUsers, createNewUser, deleteUserById, type SafeUser } from '../lib/api';

interface UserManagementProps {
  currentUserId: string;
}

export default function UserManagement({ currentUserId }: UserManagementProps) {
  const [users, setUsers] = useState<SafeUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Add user form
  const [showForm, setShowForm] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [creating, setCreating] = useState(false);

  // Delete confirmation
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const loadUsers = useCallback(async () => {
    try {
      const data = await getUsers();
      setUsers(data);
      setError('');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError('');
    try {
      await createNewUser(newEmail, newName, newPassword);
      setNewEmail('');
      setNewName('');
      setNewPassword('');
      setShowForm(false);
      await loadUsers();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleDelete = async (userId: string) => {
    try {
      await deleteUserById(userId);
      setDeleteId(null);
      await loadUsers();
    } catch (err: any) {
      setError(err.message);
      setDeleteId(null);
    }
  };

  const formatDate = (d: string | null) => {
    if (!d) return '-';
    return new Date(d).toLocaleString('cs-CZ');
  };

  if (loading) {
    return <div className="py-8 text-center text-gray-500">Načítání uživatelů...</div>;
  }

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-bold text-gray-900">Správa uživatelů</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          {showForm ? 'Zrušit' : 'Přidat uživatele'}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}

      {showForm && (
        <form onSubmit={handleCreate} className="mb-6 rounded-lg border bg-gray-50 p-4">
          <h3 className="mb-3 text-sm font-semibold text-gray-700">Nový uživatel</h3>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Jméno</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Jan Novák"
                className="w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">E-mail</label>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="jan@firma.cz"
                className="w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                required
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">Heslo</label>
              <input
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="Min. 6 znaků"
                className="w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                required
                minLength={6}
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={creating}
            className="mt-3 rounded bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            {creating ? 'Vytvářím...' : 'Vytvořit'}
          </button>
        </form>
      )}

      <div className="overflow-hidden rounded-lg border">
        <table className="w-full text-left text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 font-medium text-gray-600">Jméno</th>
              <th className="px-4 py-3 font-medium text-gray-600">E-mail</th>
              <th className="px-4 py-3 font-medium text-gray-600">Vytvořen</th>
              <th className="px-4 py-3 font-medium text-gray-600">Poslední přihlášení</th>
              <th className="px-4 py-3 font-medium text-gray-600"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {users.map((user) => (
              <tr key={user.id} className="hover:bg-gray-50">
                <td className="px-4 py-3 font-medium text-gray-900">
                  {user.name}
                  {user.id === currentUserId && (
                    <span className="ml-2 text-xs text-gray-400">(vy)</span>
                  )}
                </td>
                <td className="px-4 py-3 text-gray-600">{user.email}</td>
                <td className="px-4 py-3 text-gray-500">{formatDate(user.createdAt)}</td>
                <td className="px-4 py-3 text-gray-500">{formatDate(user.lastLoginAt)}</td>
                <td className="px-4 py-3 text-right">
                  {user.id === currentUserId ? (
                    <span className="text-xs text-gray-400">-</span>
                  ) : deleteId === user.id ? (
                    <div className="flex items-center justify-end gap-2">
                      <span className="text-xs text-red-600">Opravdu?</span>
                      <button
                        onClick={() => handleDelete(user.id)}
                        className="rounded bg-red-600 px-2 py-1 text-xs text-white hover:bg-red-700"
                      >
                        Ano
                      </button>
                      <button
                        onClick={() => setDeleteId(null)}
                        className="rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-100"
                      >
                        Ne
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setDeleteId(user.id)}
                      className="text-xs text-red-500 hover:text-red-700"
                    >
                      Smazat
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <div className="py-8 text-center text-gray-500">Žádní uživatelé</div>
        )}
      </div>
    </div>
  );
}
