import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, USERS } from '../helpers.js';

/* The uploads directory is read when the media controller is first imported,
   so it is pointed at a throwaway folder before the app is loaded. */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'media-test-'));
process.env.UPLOADS_DIR = TMP;

let app: any;
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex'
);

beforeAll(async () => {
  const { createApp } = await import('../../src/app.js');
  const { store } = await import('../../src/data/store.js');
  vi.spyOn(store, 'getUserById').mockImplementation(async (id: string) =>
    Object.values(USERS).find((u) => u.id === id) as any
  );
  app = createApp();
});

afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const filesIn = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? filesIn(path.join(dir, e.name)) : [path.join(dir, e.name)]
      )
    : [];

describe('POST /api/v1/media', () => {
  it('stores an image for an Editor and returns a URL that serves it', async () => {
    const res = await request(app)
      .post('/api/v1/media')
      .set(bearer('Editor'))
      .attach('file', PNG, { filename: 'pixel.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ kind: 'image', mime_type: 'image/png', size_bytes: PNG.length });
    expect(res.body.data.url).toMatch(/^\/uploads\/media\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
    expect(res.body.data.url).not.toMatch(/^blob:/);

    const served = await request(app).get(res.body.data.url);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toMatch(/image\/png/);
    expect(served.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
  });

  it('allows an Admin', async () => {
    const res = await request(app)
      .post('/api/v1/media')
      .set(bearer('Admin'))
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
  });

  it('never uses the client file name on disk', async () => {
    const res = await request(app)
      .post('/api/v1/media')
      .set(bearer('Editor'))
      .attach('file', PNG, { filename: '../../evil.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    expect(res.body.data.url).not.toContain('evil');
  });

  it('refuses a Viewer (403) and writes nothing', async () => {
    const before = filesIn(TMP).length;
    const res = await request(app)
      .post('/api/v1/media')
      .set(bearer('Viewer'))
      .attach('file', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
    expect(filesIn(TMP).length).toBe(before);
  });

  it('refuses a request with no token (401)', async () => {
    const res = await request(app).post('/api/v1/media').attach('file', PNG, 'a.png');
    expect(res.status).toBe(401);
  });

  it('rejects a disallowed type with 422 and a field error', async () => {
    const res = await request(app)
      .post('/api/v1/media')
      .set(bearer('Editor'))
      .attach('file', Buffer.from('MZ'), { filename: 'tool.exe', contentType: 'application/x-msdownload' });
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('file');
  });

  it('rejects an image over 10 MB with 422 and removes it', async () => {
    const before = filesIn(TMP).length;
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0);
    const res = await request(app)
      .post('/api/v1/media')
      .set(bearer('Editor'))
      .attach('file', big, { filename: 'big.png', contentType: 'image/png' });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/at most 10 MB/);
    expect(filesIn(TMP).length).toBe(before);
  });

  it('answers 400 when no file is sent', async () => {
    const res = await request(app).post('/api/v1/media').set(bearer('Editor')).send({});
    expect(res.status).toBe(400);
  });

  it('answers 400 when the file is sent under the wrong field name', async () => {
    const res = await request(app)
      .post('/api/v1/media')
      .set(bearer('Editor'))
      .attach('image', PNG, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });

  it('404s for an uploaded file that does not exist', async () => {
    const res = await request(app).get('/uploads/media/2026/01/does-not-exist.png');
    expect(res.status).toBe(404);
  });
});
