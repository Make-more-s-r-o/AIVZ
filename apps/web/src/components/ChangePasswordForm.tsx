import { useState } from 'react';
import { changePassword } from '../lib/auth';

export default function ChangePasswordForm() {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess(false);

    if (newPassword !== confirmPassword) {
      setError('Nová hesla se neshodují');
      return;
    }
    if (newPassword.length < 6) {
      setError('Nové heslo musí mít alespoň 6 znaků');
      return;
    }

    setSubmitting(true);
    try {
      await changePassword(currentPassword, newPassword);
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      setError(err.message || 'Změna hesla selhala');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-md">
      <h2 className="mb-6 text-xl font-bold text-gray-900">Změna hesla</h2>

      {error && (
        <div className="mb-4 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
      )}
      {success && (
        <div className="mb-4 rounded bg-green-50 px-3 py-2 text-sm text-green-700">
          Heslo bylo úspěšně změněno.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Současné heslo</label>
          <input
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Nové heslo</label>
          <input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="Minimálně 6 znaků"
            className="w-full rounded border px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
            required
            minLength={6}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">Potvrzení nového hesla</label>
          <input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
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
          {submitting ? 'Ukládám...' : 'Změnit heslo'}
        </button>
      </form>
    </div>
  );
}
