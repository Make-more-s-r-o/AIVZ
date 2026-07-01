import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const USERS_FILE = join(ROOT, 'config', 'users.json');
const SALT_ROUNDS = 10;

// RBAC (M7): viewer = jen čtení, analytik = plné CRM mutace, admin = + správa uživatelů/rolí.
export type UserRole = 'admin' | 'analytik' | 'viewer';
export const USER_ROLES: UserRole[] = ['admin', 'analytik', 'viewer'];

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  role: UserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export type SafeUser = Omit<User, 'passwordHash'>;

interface UsersFile {
  users: Array<Partial<User> & { id: string; email: string; name: string; passwordHash: string }>;
}

async function readUsers(): Promise<User[]> {
  try {
    const raw = await readFile(USERS_FILE, 'utf-8');
    const data: UsersFile = JSON.parse(raw);
    // Backfill role u legacy účtů (předcházejí RBAC) → admin, aby se nikdo nezamkl.
    return (data.users || []).map((u) => ({
      ...u,
      role: (u.role && USER_ROLES.includes(u.role)) ? u.role : 'admin',
      lastLoginAt: u.lastLoginAt ?? null,
      createdAt: u.createdAt ?? new Date(0).toISOString(),
    })) as User[];
  } catch {
    return [];
  }
}

async function writeUsers(users: User[]): Promise<void> {
  const dir = join(ROOT, 'config');
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(USERS_FILE, JSON.stringify({ users }, null, 2), 'utf-8');
}

function toSafeUser(user: User): SafeUser {
  const { passwordHash: _, ...safe } = user;
  return safe;
}

export async function getAllUsers(): Promise<SafeUser[]> {
  const users = await readUsers();
  return users.map(toSafeUser);
}

export async function getUserByEmail(email: string): Promise<User | null> {
  const users = await readUsers();
  return users.find(u => u.email.toLowerCase() === email.toLowerCase()) || null;
}

export async function getUserById(id: string): Promise<User | null> {
  const users = await readUsers();
  return users.find(u => u.id === id) || null;
}

export async function createUser(email: string, name: string, password: string, role?: UserRole): Promise<SafeUser> {
  const users = await readUsers();

  if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
    throw new Error('User with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  // První uživatel (setup) = admin; jinak výchozí analytik, nebo předaná role.
  const finalRole: UserRole = users.length === 0 ? 'admin' : (role && USER_ROLES.includes(role) ? role : 'analytik');
  const user: User = {
    id: `u_${randomUUID().slice(0, 12)}`,
    email: email.toLowerCase().trim(),
    name: name.trim(),
    passwordHash,
    role: finalRole,
    createdAt: new Date().toISOString(),
    lastLoginAt: null,
  };

  users.push(user);
  await writeUsers(users);
  return toSafeUser(user);
}

export async function updateUserRole(userId: string, role: UserRole): Promise<SafeUser> {
  if (!USER_ROLES.includes(role)) throw new Error('Invalid role');
  const users = await readUsers();
  const user = users.find(u => u.id === userId);
  if (!user) throw new Error('User not found');
  user.role = role;
  await writeUsers(users);
  return toSafeUser(user);
}

export async function verifyPassword(user: User, password: string): Promise<boolean> {
  return bcrypt.compare(password, user.passwordHash);
}

export async function updatePassword(userId: string, newPassword: string): Promise<void> {
  const users = await readUsers();
  const user = users.find(u => u.id === userId);
  if (!user) throw new Error('User not found');

  user.passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await writeUsers(users);
}

export async function deleteUser(userId: string): Promise<void> {
  const users = await readUsers();
  const idx = users.findIndex(u => u.id === userId);
  if (idx === -1) throw new Error('User not found');

  users.splice(idx, 1);
  await writeUsers(users);
}

export async function updateLastLogin(userId: string): Promise<void> {
  const users = await readUsers();
  const user = users.find(u => u.id === userId);
  if (user) {
    user.lastLoginAt = new Date().toISOString();
    await writeUsers(users);
  }
}

export async function isFirstRun(): Promise<boolean> {
  const users = await readUsers();
  return users.length === 0;
}
