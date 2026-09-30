import jwt from 'jsonwebtoken';
import { config } from '../src/config/index.js';
import type { Role } from '../src/types/index.js';

/** Test users, one per role. Tests that need them to "exist" stub store.getUserById. */
export const USERS: Record<Role, { id: string; email: string; role: Role }> = {
  Admin: { id: 'test-admin', email: 'admin@test.local', role: 'Admin' },
  Editor: { id: 'test-editor', email: 'editor@test.local', role: 'Editor' },
  Viewer: { id: 'test-viewer', email: 'viewer@test.local', role: 'Viewer' },
} as Record<Role, { id: string; email: string; role: Role }>;

export const tokenFor = (role: Role, userId = USERS[role].id): string =>
  jwt.sign({ userId, email: USERS[role]?.email ?? `${userId}@test.local`, role }, config.jwtSecret, {
    expiresIn: '1h',
  });

export const bearer = (role: Role, userId?: string) => ({ Authorization: `Bearer ${tokenFor(role, userId)}` });
