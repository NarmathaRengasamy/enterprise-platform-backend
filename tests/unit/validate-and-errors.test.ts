import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { validateRequest } from '../../src/middlewares/validate.js';
import { AppError, errorHandler } from '../../src/middlewares/errorHandler.js';

const schema = z.object({
  body: z.object({
    name: z.string().min(1),
    status: z.string().optional().default('draft'),
  }),
});

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.post('/echo/:id', validateRequest(schema), (req, res) =>
    res.json({ body: req.body, query: req.query, params: req.params })
  );
  app.post('/boom', validateRequest(schema), () => {
    throw new Error('handler failure');
  });
  app.get('/rule', () => {
    throw new AppError('Business rule failed', 422, undefined, { sku: 'SKU already used', price: 'Must be ≥ 0' });
  });
  app.get('/plain', () => {
    throw new AppError('Not found', 404);
  });
  app.use(errorHandler);
  return app;
};

describe('validateRequest', () => {
  it('strips unknown fields from the body', async () => {
    const res = await request(makeApp()).post('/echo/1').send({ name: 'A', is_admin: true });
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ name: 'A', status: 'draft' });
    expect(res.body.body.is_admin).toBeUndefined();
  });

  it('applies Zod defaults', async () => {
    const res = await request(makeApp()).post('/echo/1').send({ name: 'A' });
    expect(res.body.body.status).toBe('draft');
  });

  it('keeps an explicit value over the default', async () => {
    const res = await request(makeApp()).post('/echo/1').send({ name: 'A', status: 'active' });
    expect(res.body.body.status).toBe('active');
  });

  it('leaves query and params alone when the schema does not declare them', async () => {
    const res = await request(makeApp()).post('/echo/42?page=2').send({ name: 'A' });
    expect(res.body.params).toEqual({ id: '42' });
    expect(res.body.query).toEqual({ page: '2' });
  });

  it('rejects missing required fields with 400 and a per-field error', async () => {
    const res = await request(makeApp()).post('/echo/1').send({});
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe('body.name');
  });

  it('does not report a later handler failure as a validation failure', async () => {
    const res = await request(makeApp()).post('/boom').send({ name: 'A' });
    expect(res.status).toBe(500);
    expect(res.body.message).not.toBe('Validation failed');
  });
});

describe('errorHandler', () => {
  it('serialises AppError field errors as errors[{path,message}]', async () => {
    const res = await request(makeApp()).get('/rule');
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      success: false,
      message: 'Business rule failed',
      errors: [
        { path: 'sku', message: 'SKU already used' },
        { path: 'price', message: 'Must be ≥ 0' },
      ],
    });
  });

  it('omits errors when there are none', async () => {
    const res = await request(makeApp()).get('/plain');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, message: 'Not found' });
  });
});
