const API_BASE = '/api';
const JWT_KEY = 'vz_jwt';
const USER_KEY = 'vz_user';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface AuthStatus {
  setupRequired: boolean;
  jwtEnabled: boolean;
}

// --- localStorage management ---

export function getJwt(): string | null {
  return localStorage.getItem(JWT_KEY);
}

export function getStoredUser(): AuthUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setAuth(token: string, user: AuthUser): void {
  localStorage.setItem(JWT_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearAuth(): void {
  localStorage.removeItem(JWT_KEY);
  localStorage.removeItem(USER_KEY);
}

export function isAuthenticated(): boolean {
  return !!getJwt();
}

// --- API calls ---

export async function getAuthStatus(): Promise<AuthStatus> {
  const res = await fetch(`${API_BASE}/auth/status`);
  if (!res.ok) throw new Error('Failed to check auth status');
  return res.json();
}

export async function login(email: string, password: string): Promise<{ token: string; user: AuthUser }> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Login failed');
  }
  return res.json();
}

export async function setupFirstUser(
  email: string, name: string, password: string
): Promise<{ token?: string; user: AuthUser }> {
  const res = await fetch(`${API_BASE}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, name, password }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Setup failed');
  }
  return res.json();
}

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  const jwt = getJwt();
  const res = await fetch(`${API_BASE}/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(jwt ? { Authorization: `Bearer ${jwt}` } : {}),
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'Password change failed');
  }
}
