import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { store } from '../../src/data/store.js';
import { config } from '../../src/config/index.js';
import { bearer, USERS } from '../helpers.js';

const app = createApp();

/* A route under the authenticated router that does no work of its own: once
   auth passes, the request falls through to the 404 handler. */
const PROBE = '/api/v1/__auth_probe__';

afterEach(() => vi.restoreAllMocks());

describe('authenticateJWT', () => {
  it('lets an existing user through', async () => {
    vi.spyOn(store, 'getUserById').mockResolvedValue(USERS.Editor as any);
    const res = await request(app).get(PROBE).set(bearer('Editor'));
    expect(res.status).toBe(404); // past auth
  });

  it('rejects the token of a deleted user (the missing-await bug)', async () => {
    vi.spyOn(store, 'getUserById').mockResolvedValue(undefined);
    const res = await request(app).get(PROBE).set(bearer('Editor'));
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/no longer exists/);
  });

  it('rejects a request with no token', async () => {
    const res = await request(app).get(PROBE);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/token required/);
  });

  it('rejects a malformed token', async () => {
    const res = await request(app).get(PROBE).set({ Authorization: 'Bearer not-a-jwt' });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Invalid authentication token/);
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign({ userId: 'x', email: 'x@y', role: 'Admin', exp: 1 }, config.jwtSecret);
    const res = await request(app).get(PROBE).set({ Authorization: `Bearer ${expired}` });
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/expired/);
  });

  it('answers 401 (not a crash) when the user lookup itself fails', async () => {
    vi.spyOn(store, 'getUserById').mockRejectedValue(new Error('db down'));
    const res = await request(app).get(PROBE).set(bearer('Editor'));
    expect(res.status).toBe(401);
  });

  it('leaves public routes open', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
  });

  it('immediately reflects updated database role even if token claims an older role', async () => {
    // Token says Admin, but database record says Viewer
    vi.spyOn(store, 'getUserById').mockResolvedValue({
      id: USERS.Admin.id,
      name: 'Admin User',
      email: USERS.Admin.email,
      role: 'Viewer',
      status: 'Active',
      department: 'Operations',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as any);

    // Calling an Admin-only route (/api/v1/team/members/:id)
    const res = await request(app)
      .put(`/api/v1/team/members/${USERS.Editor.id}`)
      .set(bearer('Admin'))
      .send({ role: 'Viewer' });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/do not have permission/);
  });
});
