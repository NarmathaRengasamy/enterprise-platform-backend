import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { store } from '../../src/data/store.js';
import { ProductItemModel } from '../../src/models/ProductItem.model.js';
import { ItemStockModel } from '../../src/models/ItemStock.model.js';
import { StockMovementModel } from '../../src/models/StockMovement.model.js';
import { transactionsSupported, warnIfTransactionsUnavailable } from '../../src/utils/transaction.util.js';
import { USERS } from '../helpers.js';
import { admin, creta, freshDatabase, post, seedTenant, V2 } from './phase3-helpers.js';

/**
 * Phase 3 on a standalone MongoDB (how local development runs): no
 * transactions, so writes run in order and a failure cleans up after itself.
 */

let mongo: MongoMemoryServer;
let app: ReturnType<typeof createApp>;
let cats: Awaited<ReturnType<typeof seedTenant>>;
const raw = (name: string) => mongoose.connection.db!.collection(name);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = createApp();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(store, 'getUserById').mockImplementation(async (id: string) => Object.values(USERS).find((u) => u.id === id) as any);
  await freshDatabase();
  cats = await seedTenant(app);
});

/** Makes the Nth call to a model's `create` fail, calling through otherwise. */
const failOnCall = (model: any, n: number) => {
  const original = model.create.bind(model);
  let calls = 0;
  return vi.spyOn(model, 'create').mockImplementation(async (...args: any[]) => {
    calls += 1;
    if (calls === n) throw new Error(`forced failure on call ${n}`);
    return original(...args);
  });
};

describe('standalone server: ordered writes with clean-up', () => {
  it('knows transactions are unavailable and says so at start-up', async () => {
    expect(await transactionsSupported()).toBe(false);
    /* The logger writes warnings to stderr. */
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await warnIfTransactionsUnavailable();
    const said = stderr.mock.calls.map((c) => String(c[0])).join('\n');
    stderr.mockRestore();
    expect(said).toMatch(/standalone — transactions are unavailable/);
  });

  it('still creates a product with its items and stock', async () => {
    const res = await post(app, creta(cats.suv.id));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(await raw('product_items').countDocuments()).toBe(3);
    expect(await raw('item_stock').countDocuments()).toBe(2);
  });

  it('cleans up the product and earlier items when the 3rd item insert fails', async () => {
    failOnCall(ProductItemModel, 3);
    const res = await post(app, creta(cats.suv.id));
    expect(res.status).toBe(500);
    expect(await raw('products_v2').countDocuments()).toBe(0);
    expect(await raw('product_items').countDocuments()).toBe(0);
    expect(await raw('item_stock').countDocuments()).toBe(0);
  });

  it('cleans up when a stock row fails to save', async () => {
    failOnCall(ItemStockModel, 2);
    const res = await post(app, creta(cats.suv.id));
    expect(res.status).toBe(500);
    expect(await raw('products_v2').countDocuments()).toBe(0);
    expect(await raw('product_items').countDocuments()).toBe(0);
    expect(await raw('item_stock').countDocuments()).toBe(0);
  });

  it('deletes and restores with the cascade on standalone too', async () => {
    const p = (await post(app, creta(cats.suv.id))).body.data;
    expect((await request(app).delete(`${V2}/${p.id}`).set(admin)).status).toBe(200);
    expect(await raw('product_items').countDocuments({ is_deleted: false })).toBe(0);
    expect(await raw('item_stock').countDocuments({ is_deleted: false })).toBe(0);
    expect((await request(app).post(`${V2}/${p.id}/restore`).set(admin)).status).toBe(200);
    expect(await raw('product_items').countDocuments({ is_deleted: false })).toBe(3);
    expect(await raw('item_stock').countDocuments({ is_deleted: false })).toBe(2);
  });
});

/* Phase 4 on standalone: stock stays safe without transactions. */
describe('standalone server: stock (Phase 4)', () => {
  const ITEMS = '/api/v2/items';
  const wiper = async (initial_stock: number) =>
    (await post(app, { name: { en: 'Wiper' }, tracking: 'none', items: [{ sku: 'WIPER', initial_stock }] })).body.data.items[0];
  const adjust = (id: string, delta: number) => request(app).post(`${ITEMS}/${id}/stock/adjust`).set(admin).send({ delta, reason: 'test' });

  it('two −5 at the same moment on 6 → exactly one succeeds (the guarded $inc needs no transaction)', async () => {
    const item = await wiper(6);
    const results = await Promise.all([adjust(item.id, -5), adjust(item.id, -5)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await raw('item_stock').findOne({ item_id: item.id }))?.on_hand).toBe(1);
  });

  it('undoes the stock change when its movement fails to save', async () => {
    const item = await wiper(6);
    vi.spyOn(StockMovementModel, 'create').mockRejectedValueOnce(new Error('forced failure'));
    expect((await adjust(item.id, -2)).status).toBe(500);
    expect((await raw('item_stock').findOne({ item_id: item.id }))?.on_hand).toBe(6);
    expect(await raw('stock_movements').countDocuments({ item_id: item.id, source: 'adjust' })).toBe(0);
  });
});
