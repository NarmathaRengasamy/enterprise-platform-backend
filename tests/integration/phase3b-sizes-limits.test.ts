import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { store } from '../../src/data/store.js';
import { USERS } from '../helpers.js';
import { admin, creta, editor, freshDatabase, post, seedTenant, V2, viewer } from './phase3-helpers.js';

/**
 * Phase 3b — measured sizes (R45–R46) and purchase limits (R50–R53), plan 3b.5,
 * plus the 1 Oct 2026 search status "deleted". Replica set, so real transactions.
 */

let rs: MongoMemoryReplSet;
let app: ReturnType<typeof createApp>;
let cats: Awaited<ReturnType<typeof seedTenant>>;

const FIELDS = '/api/v1/product-type/fields';
const raw = (name: string) => mongoose.connection.db!.collection(name);
const get = (id: string, headers = admin) => request(app).get(`${V2}/${id}`).set(headers);
const search = (body: object, headers = admin) => request(app).post(`${V2}/search`).set(headers).send(body);
const bySku = (p: any, sku: string) => p.items.find((i: any) => i.sku === sku);

const addNetQuantity = () =>
  request(app).post(FIELDS).set(admin).send({ label: { en: 'Net quantity' }, type: 'number', unit: 'ml', unit_family: 'volume', variant_forming: true, filterable: true });

const SIZES = [{ amount: 500, unit: 'ml' }, { amount: 1, unit: 'l' }, { amount: 5, unit: 'l' }];

/** "Sunflower Oil": 500 ml / 1 l / 5 l, own stock each (tracked by quantity). */
const oil = (over: Record<string, unknown> = {}) => ({
  name: { en: 'Sunflower Oil' },
  tracking: 'none',
  variant_axes: [{ key: 'net_quantity', values: SIZES }],
  items: [
    { sku: 'OIL-500', attributes: [{ key: 'net_quantity', value: 500 }], price: { amount_minor: 18000 }, initial_stock: 5 },
    { sku: 'OIL-1L', attributes: [{ key: 'net_quantity', value: { amount: 1, unit: 'l' } }], price: { amount_minor: 32000 }, initial_stock: 7 },
    { sku: 'OIL-5L', attributes: [{ key: 'net_quantity', value: 5000 }], price: { amount_minor: 150000 }, initial_stock: 2 },
  ],
  ...over,
});

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(rs.getUri());
  app = createApp();
});

afterAll(async () => {
  await mongoose.disconnect();
  await rs.stop();
});

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.spyOn(store, 'getUserById').mockImplementation(async (id: string) => Object.values(USERS).find((u) => u.id === id) as any);
  await freshDatabase();
  cats = await seedTenant(app);
});

/* ============================================================ unit family */

describe('unit family on number attributes (3b.1, 3b.3)', () => {
  it('saves a measured attribute; refuses a unit from another family (422)', async () => {
    const ok = await addNetQuantity();
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data.product_type.fields.find((f: any) => f.key === 'net_quantity')).toMatchObject({ unit_family: 'volume', unit: 'ml', variant_forming: true });

    const bad = await request(app).post(FIELDS).set(admin).send({ label: { en: 'Bottle' }, type: 'number', unit: 'kg', unit_family: 'volume' });
    expect(bad.status).toBe(422);
    expect(bad.body.message).toMatch(/ml, l/);

    const text = await request(app).post(FIELDS).set(admin).send({ label: { en: 'Note' }, type: 'text', unit_family: 'weight' });
    expect(text.status).toBe(422);
  });

  it('clearing the family turns variant use off; changing it on a field products vary by → 409; Viewer → 403', async () => {
    await addNetQuantity();
    const cleared = await request(app).patch(`${FIELDS}/net_quantity`).set(admin).send({ unit_family: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.product_type.fields.find((f: any) => f.key === 'net_quantity')).toMatchObject({ variant_forming: false });
    expect(cleared.body.data.product_type.fields.find((f: any) => f.key === 'net_quantity').unit_family).toBeUndefined();

    await request(app).patch(`${FIELDS}/net_quantity`).set(admin).send({ unit_family: 'volume', variant_forming: true });
    expect((await post(app, oil())).status).toBe(201);
    const change = await request(app).patch(`${FIELDS}/net_quantity`).set(admin).send({ unit_family: 'weight', unit: 'g' });
    expect(change.status).toBe(409);
    expect(change.body.message).toMatch(/unit family cannot be changed/);

    expect((await request(app).patch(`${FIELDS}/net_quantity`).set(viewer).send({ unit_family: 'weight' })).status).toBe(403);
  });
});

/* ================================================================ sizes */

describe('measured sizes (R45–R46)', () => {
  beforeEach(async () => {
    expect((await addNetQuantity()).status).toBe(201);
  });

  it('"Sunflower Oil" 500 ml / 1 l / 5 l: base amounts, own stock, price per unit (never stored)', async () => {
    const res = await post(app, oil());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const p = res.body.data;
    expect(bySku(p, 'OIL-500').measure).toEqual({ amount: 500, unit: 'ml', base_amount: 500 });
    expect(bySku(p, 'OIL-1L').measure).toEqual({ amount: 1, unit: 'l', base_amount: 1000 });
    expect(bySku(p, 'OIL-5L').measure).toEqual({ amount: 5, unit: 'l', base_amount: 5000 });
    expect(bySku(p, 'OIL-500').price_per_unit).toMatchObject({ amount_minor: 3600, per: '100 ml' });
    expect(bySku(p, 'OIL-1L').price_per_unit).toMatchObject({ amount_minor: 32000, per: 'l' });
    expect(bySku(p, 'OIL-5L').price_per_unit).toMatchObject({ amount_minor: 30000, per: 'l' });
    expect(bySku(p, 'OIL-1L').availability).toMatchObject({ status: 'tracked', on_hand: 7 });
    /* DB integrity: base = amount × factor; nothing about price per unit stored. */
    for (const doc of await raw('product_items').find({}).toArray()) {
      const factor = doc.measure.unit === 'l' ? 1000 : 1;
      expect(doc.measure.base_amount).toBe(doc.measure.amount * factor);
      expect(doc).not.toHaveProperty('price_per_unit');
    }
  });

  it('variant preview labels sizes and combines them with Colour (4 combinations)', async () => {
    const res = await request(app)
      .post(`${V2}/variant-preview`)
      .set(editor)
      .send({ name: 'Paint', variant_axes: [{ key: 'colour', values: ['red', 'white'] }, { key: 'net_quantity', values: [{ amount: 500, unit: 'ml' }, { amount: 1, unit: 'l' }] }] });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.total).toBe(4);
    expect(res.body.data.combinations.map((c: any) => c.label)).toEqual(['red · 500 ml', 'red · 1 l', 'white · 500 ml', 'white · 1 l']);
    expect(res.body.data.combinations[1].attributes).toEqual([{ key: 'colour', value: 'red' }, { key: 'net_quantity', value: 1000 }]);
  });

  it('refuses 2 kg on a volume attribute (422), 1 l beside 1000 ml (409) and a number without a unit family (422)', async () => {
    const kg = await post(app, oil({ variant_axes: [{ key: 'net_quantity', values: [{ amount: 2, unit: 'kg' }] }], items: [{ attributes: [{ key: 'net_quantity', value: 2000 }] }] }));
    expect(kg.status).toBe(422);

    const twoUnits = await post(app, oil({ variant_axes: [{ key: 'net_quantity', values: [{ amount: 1, unit: 'l' }, { amount: 1000, unit: 'ml' }] }] }));
    expect(twoUnits.status).toBe(409);
    expect(twoUnits.body.message).toMatch(/same size/);

    const twoItems = await post(
      app,
      oil({
        variant_axes: [{ key: 'net_quantity', values: [{ amount: 1, unit: 'l' }] }],
        items: [
          { sku: 'A', attributes: [{ key: 'net_quantity', value: { amount: 1, unit: 'l' } }] },
          { sku: 'B', attributes: [{ key: 'net_quantity', value: { amount: 1000, unit: 'ml' } }] },
        ],
      })
    );
    expect(twoItems.status).toBe(409);

    const warranty = await post(app, { name: { en: 'X' }, variant_axes: [{ key: 'warranty', values: [{ amount: 12, unit: 'piece' }] }], items: [{}] });
    expect(warranty.status).toBe(422);
    expect(warranty.body.message).toMatch(/without a unit family/);
  });

  it('an unpriced sized item has no price per unit ("Not priced")', async () => {
    const p = (await post(app, oil({ items: [{ sku: 'OIL-500', attributes: [{ key: 'net_quantity', value: 500 }] }] }))).body.data;
    expect(bySku(p, 'OIL-500').price_per_unit).toBeNull();
    expect(bySku(p, 'OIL-500').resolved_price).toBeNull();
  });

  it('search sorts by size, filters a size range and reads "1 l" as 1000 ml', async () => {
    await post(app, oil());
    await post(app, oil({ name: { en: 'Groundnut Oil' }, slug: 'groundnut-oil', variant_axes: [{ key: 'net_quantity', values: [{ amount: 200, unit: 'ml' }] }], items: [{ sku: 'GN-200', attributes: [{ key: 'net_quantity', value: 200 }] }] }));
    await post(app, { name: { en: 'Oil funnel' }, items: [{ sku: 'FUNNEL' }] });

    const asc = await search({ sort: 'size_asc' });
    expect(asc.status, JSON.stringify(asc.body)).toBe(200);
    expect(asc.body.data.items.map((i: any) => i.slug)).toEqual(['groundnut-oil', 'sunflower-oil', 'oil-funnel']); // no size last
    const desc = await search({ sort: 'size_desc' });
    expect(desc.body.data.items.map((i: any) => i.slug)).toEqual(['sunflower-oil', 'groundnut-oil', 'oil-funnel']);

    const range = await search({ measure_key: 'net_quantity', measure_min: 900, measure_max: 1100 });
    expect(range.body.data.items.map((i: any) => i.slug)).toEqual(['sunflower-oil']);
    expect((await search({ measure_min: 1 })).status).toBe(422); // which attribute?
    expect((await search({ measure_key: 'warranty', measure_min: 1 })).status).toBe(422);

    const litre = await search({ attributes: { net_quantity: ['1 l'] } });
    expect(litre.body.data.items.map((i: any) => i.slug)).toEqual(['sunflower-oil']);
    const word = await search({ attributes: { net_quantity: ['large'] } });
    expect(word.status).toBe(422);
    expect(word.body.message).toMatch(/measure_min/);
  });
});

/* ======================================================= purchase limits */

describe('purchase limits (R50–R53)', () => {
  it('saves limits and describes them; an item override changes only that item', async () => {
    const p = (
      await post(
        app,
        creta(cats.suv.id, {
          purchase_limits: { min_per_order: 1, max_per_order: 2, per_customer: { month: 4 } },
          items: [
            { sku: 'P-RED', attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'red' }], purchase_limits: { max_per_order: 1 } },
            { sku: 'P-WHT', attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'white' }] },
          ],
        })
      )
    ).body.data;
    expect(p.purchase_limits).toMatchObject({ min_per_order: 1, max_per_order: 2, per_customer: { month: 4 } });
    expect(bySku(p, 'P-WHT').limits_summary).toBe('Max 2 per order · 4 per customer every 30 days');
    expect(bySku(p, 'P-RED').effective_limits).toMatchObject({ max_per_order: 1, per_customer: { month: 4 } });
    expect(bySku(p, 'P-RED').limits_summary).toBe('Max 1 per order · 4 per customer every 30 days');
  });

  it('refuses invalid limits (422 each) and a product change that breaks an item override', async () => {
    for (const bad of [{ min_per_order: 3, max_per_order: 2 }, { per_customer: { day: 5, week: 3 } }, { max_per_order: 0 }, { max_per_order: 1.5 }]) {
      const res = await post(app, creta(cats.suv.id, { purchase_limits: bad }));
      expect(res.status, JSON.stringify(bad)).toBe(422);
    }
    const p = (await post(app, creta(cats.suv.id, { items: [{ sku: 'P-RED', attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'red' }], purchase_limits: { max_per_order: 1 } }] }))).body.data;
    const res = await request(app).patch(`${V2}/${p.id}`).set(editor).send({ purchase_limits: { min_per_order: 2 } });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Item P-RED/);
    expect((await get(p.id)).body.data.purchase_limits).toBeNull();
  });

  it('no limits sent → null and an empty summary; null clears them; a Viewer cannot set them (403)', async () => {
    const p = (await post(app, creta(cats.suv.id))).body.data;
    expect(p.purchase_limits).toBeNull();
    expect(p.items[0].limits_summary).toBe('');
    const set = await request(app).patch(`${V2}/${p.id}`).set(editor).send({ purchase_limits: { max_per_order: 3 } });
    expect(set.body.data.purchase_limits.max_per_order).toBe(3);
    const cleared = await request(app).patch(`${V2}/${p.id}`).set(editor).send({ purchase_limits: null });
    expect(cleared.body.data.purchase_limits).toBeNull();
    expect((await request(app).patch(`${V2}/${p.id}`).set(viewer).send({ purchase_limits: { max_per_order: 1 } })).status).toBe(403);
  });
});

/* =================================================== search: status deleted */

describe('search status "deleted" (1 Oct 2026)', () => {
  it('lists only deleted products for Admins / Editors; a Viewer still sees active ones only', async () => {
    const a = (await post(app, creta(cats.suv.id))).body.data;
    const b = (await post(app, creta(cats.suv.id, { name: { en: 'Venue' }, slug: 'venue', items: [{ sku: 'V-1', attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'red' }] }] }))).body.data;
    await request(app).post(`${V2}/${b.id}/publish`).set(admin);
    await request(app).delete(`${V2}/${a.id}`).set(admin);

    const deleted = await search({ status: 'deleted' });
    expect(deleted.body.data.items.map((i: any) => i.id)).toEqual([a.id]);
    expect(deleted.body.data.items[0].is_deleted).toBe(true);
    const all = await search({ status: 'all' });
    expect(all.body.data.items.map((i: any) => i.id)).toEqual([b.id]);
    const asViewer = await search({ status: 'deleted' }, viewer);
    expect(asViewer.body.data.items.map((i: any) => i.id)).toEqual([b.id]);
  });
});
