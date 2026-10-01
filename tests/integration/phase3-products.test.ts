import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { store } from '../../src/data/store.js';
import { ProductV2Model } from '../../src/models/ProductV2.model.js';
import { ProductItemModel } from '../../src/models/ProductItem.model.js';
import { ItemStockModel } from '../../src/models/ItemStock.model.js';
import { transactionsSupported } from '../../src/utils/transaction.util.js';
import { isUuidV7 } from '../../src/utils/id.util.js';
import { USERS } from '../helpers.js';
import { admin, creta, editor, freshDatabase, post, seedTenant, V2, viewer } from './phase3-helpers.js';

/**
 * Phase 3 — products and items, against a replica set so the real
 * transaction path runs (the standalone fallback has its own suite).
 */

let rs: MongoMemoryReplSet;
let app: ReturnType<typeof createApp>;
let cats: Awaited<ReturnType<typeof seedTenant>>;

const raw = (name: string) => mongoose.connection.db!.collection(name);
const get = (id: string, headers = admin, q = '') => request(app).get(`${V2}/${id}${q}`).set(headers);
const search = (body: object, headers = admin) => request(app).post(`${V2}/search`).set(headers).send(body);
const createCreta = async (over: Record<string, unknown> = {}) => {
  const res = await post(app, creta(cats.suv.id, over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
};
const itemBySku = (p: any, sku: string) => p.items.find((i: any) => i.sku === sku);

beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
  await mongoose.connect(rs.getUri());
  vi.spyOn(store, 'getUserById').mockImplementation(async (id: string) => Object.values(USERS).find((u) => u.id === id) as any);
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

/* ================================================================ models */

describe('models and indexes (3.1)', () => {
  it('runs on a replica set, so writes use real transactions', async () => {
    expect(await transactionsSupported()).toBe(true);
  });

  it('creates every index the plan lists', async () => {
    const names = async (c: string) => (await raw(c).indexes()).map((i: any) => JSON.stringify(i.key) + (i.unique ? ' unique' : ''));
    const products = await names('products_v2');
    expect(products).toEqual(expect.arrayContaining(['{"slug":1} unique', '{"status":1,"category_ids":1,"min_price_minor":1}', '{"attributes.key":1,"attributes.value":1}']));
    expect(products.some((k) => k.includes('"_fts":"text"'))).toBe(true);
    const items = await names('product_items');
    expect(items).toEqual(
      expect.arrayContaining(['{"sku":1} unique', '{"product_id":1,"attribute_signature":1} unique', '{"attributes.key":1,"attributes.value":1,"status":1}'])
    );
    expect(await names('item_stock')).toEqual(expect.arrayContaining(['{"item_id":1,"location_id":1} unique']));
  });
});

/* ================================================================ create */

describe('create (3.2)', () => {
  it('creates "Creta" as a draft with 3 items, paise prices and stock rows only where stock was entered', async () => {
    const p = await createCreta();
    expect(p.status).toBe('draft');
    expect(isUuidV7(p.id)).toBe(true);
    expect(p.slug).toBe('hyundai-creta');
    expect(p.items).toHaveLength(3);
    expect(p.items.every((i: any) => isUuidV7(i.id))).toBe(true);
    expect(itemBySku(p, 'CRETA-P-RED').price).toEqual({ amount_minor: 154999950, currency: 'INR', tax_inclusive: true, price_unit: 'each' });
    expect(p.min_price_minor).toBe(154999950);
    expect(p.primary_category_id).toBe(cats.suv.id);

    /* Car Dealership defaults: goods · on · serial (R13a–R13c). */
    expect(p).toMatchObject({ fulfilment: 'goods', track_inventory: true, tracking: 'serial', effective: { tracking: 'serial' } });

    expect(await raw('products_v2').countDocuments()).toBe(1);
    expect(await raw('product_items').countDocuments()).toBe(3);
    expect(await raw('item_stock').countDocuments()).toBe(2); // P-RED (2) and D-RED (0); P-WHT entered none
    expect(itemBySku(p, 'CRETA-P-RED').availability).toEqual({ status: 'tracked', on_hand: 2, reserved: 0, available: 2 });
    expect(itemBySku(p, 'CRETA-P-WHT').availability).toEqual({ status: 'tracked', on_hand: 0, reserved: 0, available: 0 });
  });

  it('"1st free service": fulfilment service pre-fills Track inventory off, SAC accepted, no stock rows', async () => {
    const res = await post(app, { name: { en: '1st free service' }, fulfilment: 'service', sac_code: '998714', gst_rate: 18, items: [{ price: { amount_minor: 0 } }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ fulfilment: 'service', track_inventory: false, tracking: 'none', availability: { status: 'not_tracked' } });
    expect(res.body.data.items[0].resolved_price.amount_minor).toBe(0); // ₹0 is a price, not "not priced"
    expect(await raw('item_stock').countDocuments()).toBe(0);
  });

  it('floor mats: tracked with Tracking none and stock 40', async () => {
    const res = await post(app, {
      name: { en: 'Floor mats' },
      category_ids: [cats.accessories.id],
      tracking: 'none',
      items: [{ sku: 'MATS', price: { amount_minor: 99900 }, initial_stock: 40 }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data).toMatchObject({ track_inventory: true, tracking: 'none' });
    const rows = await raw('item_stock').find().toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ on_hand: 40, reserved: 0, location_id: 'default' });
  });

  it('a variant can switch Track inventory off; it gets no stock row and shows "Not tracked"', async () => {
    const p = await createCreta({
      items: [
        { sku: 'A', attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'red' }], initial_stock: 3 },
        { sku: 'B', attributes: [{ key: 'fuel', value: 'diesel' }, { key: 'colour', value: 'red' }], track_inventory: false },
      ],
    });
    expect(itemBySku(p, 'B').availability).toEqual({ status: 'not_tracked' });
    expect(itemBySku(p, 'B').effective).toMatchObject({ track_inventory: false, tracking: 'none' });
    expect(itemBySku(p, 'A').availability.available).toBe(3);
    expect(await raw('item_stock').countDocuments()).toBe(1);

    const refused = await post(app, creta(cats.suv.id, {
      slug: 'another',
      items: [{ sku: 'C', attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'red' }], track_inventory: false, initial_stock: 1 }],
    }));
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/^Not tracked/);
  });

  it('refuses serial tracking with Track inventory off (422)', async () => {
    const res = await post(app, creta(cats.suv.id, { track_inventory: false, tracking: 'serial' }));
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Track inventory on/);
  });

  it('creates exactly one item for a product with no variant options (R18)', async () => {
    const res = await post(app, { name: { en: 'Seat cover' } });
    expect(res.status).toBe(201);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0]).toMatchObject({ sku: 'SEAT-COVER', attributes: [], resolved_price: null });
    expect(res.body.data.min_price_minor).toBeNull(); // not priced

    const two = await post(app, { name: { en: 'Two' }, items: [{}, {}] });
    expect(two.status).toBe(422);
  });

  it('suffixes a clashing slug on create; an explicit clash on PATCH is 409', async () => {
    const a = await post(app, { name: { en: 'Creta' } });
    const b = await post(app, { name: { en: 'Creta' } });
    expect([a.body.data.slug, b.body.data.slug]).toEqual(['creta', 'creta-2']);
    expect(b.body.data.items[0].sku).toBe('CRETA-2'); // auto SKU never clashes either
    const clash = await request(app).patch(`${V2}/${b.body.data.id}`).set(editor).send({ slug: 'creta' });
    expect(clash.status).toBe(409);
    expect(clash.body.message).toMatch(/slug "creta"/);
  });

  it('refuses invalid attribute values, naming the allowed ones', async () => {
    const bad = async (over: Record<string, unknown>) => (await post(app, creta(cats.suv.id, over))).body;
    expect((await bad({ attributes: [{ key: 'body_type', value: 'steam' }] })).message).toMatch(/"steam" is not one of hatchback, sedan, suv, muv, pickup/);
    expect((await bad({ attributes: [{ key: 'wings', value: 2 }] })).message).toMatch(/Unknown attribute "wings"/);
    expect((await bad({ attributes: [{ key: 'warranty', value: 500 }] })).message).toMatch(/at most 120/);
    expect((await bad({ attributes: [{ key: 'fuel', value: 'petrol' }] })).message).toMatch(/variant option/);
    expect((await bad({ variant_axes: [{ key: 'make', values: ['x'] }] })).message).toMatch(/not a choice list/);
    expect((await bad({ variant_axes: [{ key: 'fuel', values: ['steam'] }] })).message).toMatch(/"steam" is not one of/);
    const itemBad = await bad({ items: [{ attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'black' }] }] });
    expect(itemBad.message).toMatch(/not one of this product's colour options/);
    const res = await post(app, creta(cats.suv.id, { attributes: [{ key: 'body_type', value: 'steam' }] }));
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('attributes.0');
  });

  it('refuses decimal or negative money and unknown GST rates (422); 40 % is allowed', async () => {
    const one = (price: object) =>
      post(app, { name: { en: `P ${Math.random()}` }, items: [{ price }] });
    expect((await one({ amount_minor: -100 })).status).toBe(422);
    expect((await one({ amount_minor: 1234.5 })).status).toBe(422);
    expect((await post(app, { name: { en: 'G' }, gst_rate: 7 })).status).toBe(422);
    expect((await post(app, { name: { en: 'Big SUV' }, gst_rate: 40 })).status).toBe(201);
    const all = await raw('product_items').find().toArray();
    expect(all.every((i: any) => i.price === null || Number.isInteger(i.price.amount_minor))).toBe(true);
  });

  it('refuses duplicate SKUs and combinations (409), also when two saves race', async () => {
    await createCreta();
    const dup = await post(app, creta(cats.suv.id, { slug: 'x', items: [{ sku: 'CRETA-P-RED', attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'red' }] }] }));
    expect(dup.status).toBe(409);
    expect(dup.body.message).toBe('An item with the SKU "CRETA-P-RED" already exists');

    const combo = [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'red' }];
    const twice = await post(app, creta(cats.suv.id, { slug: 'y', items: [{ sku: 'Y1', attributes: combo }, { sku: 'Y2', attributes: combo }] }));
    expect(twice.status).toBe(409);
    expect(twice.body.message).toMatch(/same combination/);

    const race = await Promise.all(
      ['r1', 'r2'].map((slug) => post(app, { name: { en: slug }, slug, items: [{ sku: 'RACE' }] }))
    );
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await raw('product_items').countDocuments({ sku: 'RACE', is_deleted: false })).toBe(1);
  });

  it('refuses media that was never uploaded (blob:)', async () => {
    const res = await post(app, { name: { en: 'M' }, media: [{ url: 'blob:http://localhost/abc' }] });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/never uploaded/);
    expect((await post(app, { name: { en: 'M2' }, media: [{ url: '/uploads/abc.png' }] })).status).toBe(201);
  });

  it('checks categories: must exist, primary among them, and only their visible fields', async () => {
    expect((await post(app, { name: { en: 'C1' }, category_ids: ['nope'] })).status).toBe(422);
    expect((await post(app, { name: { en: 'C2' }, category_ids: [cats.suv.id], primary_category_id: cats.sedan.id })).status).toBe(422);
    /* Accessories shows make, model and colour only. */
    const hidden = await post(app, { name: { en: 'C3' }, category_ids: [cats.accessories.id], attributes: [{ key: 'body_type', value: 'suv' }] });
    expect(hidden.status).toBe(422);
    expect(hidden.body.message).toMatch(/not shown for this product's categories/);
    /* With SUV as well, the union shows everything (R15b). */
    const both = await post(app, { name: { en: 'C4' }, category_ids: [cats.accessories.id, cats.suv.id], attributes: [{ key: 'body_type', value: 'suv' }] });
    expect(both.status).toBe(201);
    expect(both.body.data.primary_category_id).toBe(cats.accessories.id); // the first chosen
  });
});

/* ============================================== more kinds and edge sizes */

describe('other kinds of product and larger products (testing steps)', () => {
  it('creates digital, rental (priced per day) and bundle-flagged products', async () => {
    const digital = await post(app, { name: { en: 'Service manual PDF' }, fulfilment: 'digital', items: [{ price: { amount_minor: 49900 }, digital_delivery: 'download' }] });
    expect(digital.status, JSON.stringify(digital.body)).toBe(201);
    expect(digital.body.data).toMatchObject({ fulfilment: 'digital', track_inventory: false, availability: { status: 'not_tracked' } });
    expect(digital.body.data.items[0].digital_delivery).toBe('download');

    const rental = await post(app, { name: { en: 'Self-drive Creta' }, fulfilment: 'rental', items: [{ price: { amount_minor: 350000, price_unit: 'day' } }] });
    expect(rental.body.data).toMatchObject({ fulfilment: 'rental', track_inventory: false });
    expect(rental.body.data.items[0].resolved_price).toMatchObject({ amount_minor: 350000, price_unit: 'day' });

    const bundle = await post(app, { name: { en: 'Accessory kit' }, is_bundle: true });
    expect(bundle.body.data.is_bundle).toBe(true);
  });

  it('pre-fills Track inventory / Tracking / Fulfilment from each template', async () => {
    const templates = (await request(app).get('/api/v1/business-templates').set(admin)).body.data;
    for (const t of templates) {
      /* No live products, so switching replaces the product type outright. */
      await request(app).put('/api/v1/settings/business').set(admin).send({ business_category: t.code });
      const res = await post(app, { name: { en: `P ${t.code}` } });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.data).toMatchObject({
        fulfilment: t.default_fulfilment,
        track_inventory: t.default_fulfilment === 'goods',
        tracking: t.default_fulfilment === 'goods' ? t.default_tracking : 'none',
      });
      await request(app).delete(`${V2}/${res.body.data.id}`).set(admin);
    }
  });

  it('takes 100 items, 5 categories and emoji / Tamil / Hindi names', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `S${i}`);
    for (const label of ['Size', 'Trim']) {
      await request(app).post('/api/v1/product-type/fields').set(admin).send({ label: { en: label }, type: 'enum', options: ten, variant_forming: true });
    }
    const five = [cats.suv.id, cats.sedan.id];
    for (const code of ['c3', 'c4', 'c5']) five.push((await request(app).post('/api/v1/catalog-categories').set(admin).send({ code, name: { en: code } })).body.data.id);
    const values = ten.map((v) => v.toLowerCase());
    const items = values.flatMap((a) => values.map((b) => ({ attributes: [{ key: 'size', value: a }, { key: 'trim', value: b }] })));
    const res = await post(app, {
      name: { en: '🚗 Creta 😊', ta: 'க்ரேட்டா', hi: 'क्रेटा' },
      category_ids: five,
      variant_axes: [{ key: 'size', values }, { key: 'trim', values }],
      items,
    });
    expect(res.status, JSON.stringify(res.body).slice(0, 300)).toBe(201);
    expect(res.body.data.items).toHaveLength(100);
    expect(res.body.data.category_ids).toHaveLength(5);
    expect(res.body.data.slug).toBe('creta');
    expect(new Set(res.body.data.items.map((i: any) => i.sku)).size).toBe(100);
    expect(res.body.data.name).toEqual({ en: '🚗 Creta 😊', ta: 'க்ரேட்டா', hi: 'क्रेटा' });
  });
});

/* =============================================================== publish */

describe('publish, archive, visibility', () => {
  it('lists every reason publishing is blocked, then publishes; Viewers see only active products', async () => {
    const draft = (await post(app, { name: { en: 'Incomplete' }, attributes: [{ key: 'model', value: 'X' }] })).body.data;
    const blocked = await request(app).post(`${V2}/${draft.id}/publish`).set(editor);
    expect(blocked.status).toBe(422);
    expect(blocked.body.message).toMatch(/Make is required/);
    expect(blocked.body.message).toMatch(/HSN code/);
    expect(blocked.body.message).toMatch(/GST rate/);
    expect((await get(draft.id)).body.data.status).toBe('draft');
    expect((await get(draft.id, viewer)).status).toBe(404);

    const p = await createCreta();
    const ok = await request(app).post(`${V2}/${p.id}/publish`).set(editor);
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('active');
    expect((await search({}, viewer)).body.data.items.map((i: any) => i.slug)).toEqual(['hyundai-creta']);
    expect((await get(p.id, viewer)).status).toBe(200);

    await request(app).post(`${V2}/${p.id}/archive`).set(editor);
    expect((await search({}, viewer)).body.data.total).toBe(0);
  });
});

/* ================================================================== edit */

describe('edit — items by id (R21)', () => {
  it('renames a SKU, adds one item and removes one; existing ids never change', async () => {
    const p = await createCreta();
    const ids = Object.fromEntries(p.items.map((i: any) => [i.sku, i.id]));

    const renamed = await request(app).patch(`${V2}/${p.id}/items/${ids['CRETA-P-RED']}`).set(editor).send({ sku: 'CRETA-PETROL-RED' });
    expect(renamed.status).toBe(200);
    const added = await request(app).post(`${V2}/${p.id}/items`).set(editor).send({
      sku: 'CRETA-D-WHT',
      attributes: [{ key: 'fuel', value: 'diesel' }, { key: 'colour', value: 'white' }],
      price: { amount_minor: 100000000 },
    });
    expect(added.status).toBe(201);
    const removed = await request(app).delete(`${V2}/${p.id}/items/${ids['CRETA-P-WHT']}`).set(admin);
    expect(removed.status).toBe(200);

    const after = (await get(p.id)).body.data;
    expect(itemBySku(after, 'CRETA-PETROL-RED').id).toBe(ids['CRETA-P-RED']);
    expect(itemBySku(after, 'CRETA-D-RED').id).toBe(ids['CRETA-D-RED']);
    expect(itemBySku(after, 'CRETA-P-WHT')).toBeUndefined();
    expect(Object.values(ids)).not.toContain(itemBySku(after, 'CRETA-D-WHT').id);
    expect(after.min_price_minor).toBe(100000000);
    const gone = await raw('product_items').findOne({ id: ids['CRETA-P-WHT'] });
    expect(gone).toMatchObject({ is_deleted: true });

    const restored = await request(app).post(`${V2}/${p.id}/items/${ids['CRETA-P-WHT']}/restore`).set(admin);
    expect(restored.status).toBe(200);
    expect(itemBySku(restored.body.data, 'CRETA-P-WHT').id).toBe(ids['CRETA-P-WHT']);
  });

  it('refuses deleting the last active item (409)', async () => {
    const p = (await post(app, { name: { en: 'Solo' } })).body.data;
    const res = await request(app).delete(`${V2}/${p.id}/items/${p.items[0].id}`).set(admin);
    expect(res.status).toBe(409);
  });

  it('refuses items or stock in a product PATCH (400) and changes nothing', async () => {
    const p = await createCreta();
    const items = await request(app).patch(`${V2}/${p.id}`).set(editor).send({ items: [] });
    expect(items.status).toBe(400);
    const stock = await request(app).patch(`${V2}/${p.id}`).set(editor).send({ initial_stock: 5 });
    expect(stock.status).toBe(400);
    const combo = await request(app).patch(`${V2}/${p.id}/items/${p.items[0].id}`).set(editor).send({ attributes: [] });
    expect(combo.status).toBe(400);
    expect(await raw('product_items').countDocuments({ is_deleted: false })).toBe(3);
    expect((await raw('item_stock').findOne({ item_id: itemBySku(p, 'CRETA-P-RED').id }))!.on_hand).toBe(2);
  });

  it('variant options: values can be added (only new combinations offered), not removed while used', async () => {
    const p = await createCreta();
    const add = await request(app).patch(`${V2}/${p.id}`).set(editor).send({
      variant_axes: [{ key: 'fuel', values: ['petrol', 'diesel', 'cng'] }, { key: 'colour', values: ['red', 'white'] }],
    });
    expect(add.status).toBe(200);
    const preview = await request(app).post(`${V2}/variant-preview`).set(editor).send({ product_id: p.id, variant_axes: add.body.data.variant_axes });
    expect(preview.body.data).toMatchObject({ total: 6, new: 3 });
    expect(preview.body.data.combinations.filter((c: any) => !c.exists).map((c: any) => c.suggested_sku)).toEqual([
      'HYUNDAI-CRETA-DIESEL-WHITE',
      'HYUNDAI-CRETA-CNG-RED',
      'HYUNDAI-CRETA-CNG-WHITE',
    ]);
    const drop = await request(app).patch(`${V2}/${p.id}`).set(editor).send({ variant_axes: [{ key: 'fuel', values: ['diesel'] }, { key: 'colour', values: ['red', 'white'] }] });
    expect(drop.status).toBe(409);
    expect(drop.body.message).toMatch(/CRETA-P-RED uses a value being removed/);
  });

  it('Track inventory cannot go off while stock is on hand (R31a); at 0 it goes off and the empty rows go', async () => {
    const p = await createCreta();
    const off = await request(app).patch(`${V2}/${p.id}`).set(editor).send({ track_inventory: false });
    expect(off.status).toBe(409);
    expect(off.body.message).toMatch(/adjust it to 0 first/);
    expect((await get(p.id)).body.data.track_inventory).toBe(true);

    /* Only 0-stock rows left → allowed. */
    await raw('item_stock').updateMany({}, { $set: { on_hand: 0 } });
    const ok = await request(app).patch(`${V2}/${p.id}`).set(editor).send({ track_inventory: false });
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ track_inventory: false, tracking: 'none', availability: { status: 'not_tracked' } });
    expect(await raw('item_stock').countDocuments({ is_deleted: false })).toBe(0);

    const on = await request(app).patch(`${V2}/${p.id}`).set(editor).send({ track_inventory: true });
    expect(on.body.data.tracking).toBe('serial'); // back to the type default
    expect(await raw('item_stock').countDocuments({ is_deleted: false })).toBe(0); // no rows until stock is entered
  });

  it('an item override cannot switch off while that item has stock', async () => {
    const p = await createCreta();
    const res = await request(app).patch(`${V2}/${p.id}/items/${itemBySku(p, 'CRETA-P-RED').id}`).set(editor).send({ track_inventory: false });
    expect(res.status).toBe(409);
    const zero = await request(app).patch(`${V2}/${p.id}/items/${itemBySku(p, 'CRETA-D-RED').id}`).set(editor).send({ track_inventory: false });
    expect(zero.status).toBe(200);
    expect(itemBySku(zero.body.data, 'CRETA-D-RED').availability).toEqual({ status: 'not_tracked' });
  });

  it('removing the primary category makes the next one primary', async () => {
    const p = await createCreta({ category_ids: [cats.suv.id, cats.sedan.id] });
    const res = await request(app).patch(`${V2}/${p.id}`).set(editor).send({ category_ids: [cats.sedan.id] });
    expect(res.body.data.primary_category_id).toBe(cats.sedan.id);
  });

  it('keeps a retired attribute value on save but takes no new value for it', async () => {
    const p = await createCreta({ attributes: [{ key: 'make', value: 'Hyundai' }, { key: 'model', value: 'Creta' }, { key: 'warranty', value: 24 }] });
    await request(app).patch('/api/v1/product-type/fields/warranty').set(admin).send({ deprecated: true });
    const keep = await request(app).patch(`${V2}/${p.id}`).set(editor).send({ brand: 'Hyundai India' });
    expect(keep.status).toBe(200);
    expect(keep.body.data.attributes).toContainEqual({ key: 'warranty', value: 24 });
    const change = await request(app)
      .patch(`${V2}/${p.id}`)
      .set(editor)
      .send({ attributes: [{ key: 'make', value: 'Hyundai' }, { key: 'model', value: 'Creta' }, { key: 'warranty', value: 36 }] });
    expect(change.status).toBe(422);
    expect(change.body.message).toMatch(/retired/);
  });
});

/* ================================================================ preview */

describe('variant preview', () => {
  it('previews combinations with suggested SKUs and saves nothing', async () => {
    const res = await request(app).post(`${V2}/variant-preview`).set(editor).send({
      name: 'Creta',
      variant_axes: [{ key: 'fuel', values: ['petrol', 'diesel'] }, { key: 'colour', values: ['red', 'white'] }],
    });
    expect(res.body.data.total).toBe(4);
    expect(res.body.data.combinations[0]).toMatchObject({ suggested_sku: 'CRETA-PETROL-RED', attribute_signature: 'colour=red|fuel=petrol', exists: false });
    expect(await raw('products_v2').countDocuments()).toBe(0);
  });

  it('caps a preview at 500 combinations (422)', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `V${i}`);
    for (const label of ['Size', 'Trim', 'Seat']) {
      await request(app).post('/api/v1/product-type/fields').set(admin).send({ label: { en: label }, type: 'enum', options: ten, variant_forming: true });
    }
    const values = ten.map((v) => v.toLowerCase());
    const res = await request(app)
      .post(`${V2}/variant-preview`)
      .set(editor)
      .send({ variant_axes: ['size', 'trim', 'seat'].map((key) => ({ key, values })) });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/1000 combinations — at most 500/);
  });
});

/* ============================================================== lifecycle */

describe('delete and restore (cascade)', () => {
  it('soft-deletes with items and stock at one moment; restore brings back exactly those', async () => {
    const p = await createCreta();
    expect((await request(app).delete(`${V2}/${p.id}`).set(admin)).status).toBe(200);
    const at = (await raw('products_v2').findOne({ id: p.id }))!.deleted_at.getTime();
    const items = await raw('product_items').find({ product_id: p.id }).toArray();
    expect(items.every((i: any) => i.is_deleted && i.deleted_at.getTime() === at)).toBe(true);
    const stock = await raw('item_stock').find().toArray();
    expect(stock.every((s: any) => s.is_deleted && s.deleted_at.getTime() === at)).toBe(true);
    expect((await get(p.id)).status).toBe(404);
    expect((await get(p.id, admin, '?include_deleted=true')).body.data.is_deleted).toBe(true);

    const back = await request(app).post(`${V2}/${p.id}/restore`).set(admin);
    expect(back.status).toBe(200);
    expect(back.body.data.items).toHaveLength(3);
    expect(await raw('item_stock').countDocuments({ is_deleted: false })).toBe(2);
  });

  it('refuses a restore when a SKU is now used by another live item (409 naming it)', async () => {
    const p = await createCreta();
    await request(app).delete(`${V2}/${p.id}`).set(admin);
    await post(app, { name: { en: 'Other' }, items: [{ sku: 'CRETA-D-RED' }] });
    const res = await request(app).post(`${V2}/${p.id}/restore`).set(admin);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Another live item now uses the SKU "CRETA-D-RED"');
  });
});

/* ================================================================= roles */

describe('permissions', () => {
  it('Viewer reads only; Editor writes but cannot delete; drafts stay hidden from Viewers', async () => {
    expect((await post(app, { name: { en: 'V' } }, viewer)).status).toBe(403);
    expect((await request(app).post(`${V2}/variant-preview`).set(viewer).send({ variant_axes: [{ key: 'fuel', values: ['petrol'] }] })).status).toBe(403);
    const p = await createCreta();
    expect((await request(app).delete(`${V2}/${p.id}`).set(editor)).status).toBe(403);
    expect((await request(app).post(`${V2}/${p.id}/restore`).set(editor)).status).toBe(403);
    expect((await request(app).delete(`${V2}/${p.id}/items/${p.items[0].id}`).set(editor)).status).toBe(403);
    expect((await search({ status: 'draft' }, viewer)).body.data.total).toBe(0);
    expect((await search({ include_deleted: true }, viewer)).body.data.total).toBe(0);
    expect((await request(app).post(`${V2}/search`).send({})).status).toBe(401);
  });
});

/* ================================================================ search */

describe('search (one aggregation)', () => {
  const seed = async () => {
    await put('tree');
    const creta = await createCreta({ brand: 'Hyundai' });
    const city = (
      await post(app, {
        name: { en: 'Honda City', hi: 'होंडा सिटी' },
        brand: 'Honda',
        category_ids: [cats.sedan.id],
        attributes: [{ key: 'make', value: 'Honda' }, { key: 'model', value: 'City' }, { key: 'colour', value: 'black' }, { key: 'extended_warranty', value: true }],
        items: [{ sku: 'CITY', price: { amount_minor: 120000000 } }],
      })
    ).body.data;
    const unpriced = (await post(app, { name: { en: 'Mystery car' }, category_ids: [cats.sedan.id] })).body.data;
    return { creta, city, unpriced };
  };
  const put = (mode: string) => request(app).put('/api/v1/settings/business').set(admin).send({ business_category: 'car_dealership', category_mode: mode });
  const slugs = (res: request.Response) => res.body.data.items.map((i: any) => i.slug);

  it('finds by text in English, Tamil and Hindi (whole words)', async () => {
    await seed();
    expect(slugs(await search({ search: 'creta' }))).toEqual(['hyundai-creta']);
    expect(slugs(await search({ search: 'க்ரேட்டா' }))).toEqual(['hyundai-creta']);
    expect(slugs(await search({ search: 'होंडा' }))).toEqual(['honda-city']);
    expect(slugs(await search({ search: 'hyundai' }))).toEqual(['hyundai-creta']); // name and brand
  });

  it('filters by category including sub-categories, brand and price range', async () => {
    await seed();
    const cars = (await request(app).post('/api/v1/catalog-categories').set(admin).send({ code: 'cars', name: { en: 'Cars' } })).body.data;
    await request(app).patch(`/api/v1/catalog-categories/${cats.sedan.id}`).set(admin).send({ parent_id: cars.id });
    expect(slugs(await search({ category_id: cars.id, sort: 'name' }))).toEqual(['honda-city', 'mystery-car']);
    expect(slugs(await search({ brand: 'honda' }))).toEqual(['honda-city']);
    expect(slugs(await search({ price_min_minor: 125000000, price_max_minor: 160000000 }))).toEqual(['hyundai-creta']);
  });

  it('matches an attribute filter on product values and item values alike', async () => {
    await seed();
    /* Colour is a single value on the City and a variant on the Creta. */
    expect(slugs(await search({ attributes: { colour: ['red'] } }))).toEqual(['hyundai-creta']);
    expect(slugs(await search({ attributes: { colour: ['black'] } }))).toEqual(['honda-city']);
    expect(slugs(await search({ attributes: { colour: ['red', 'black'] }, sort: 'name' }))).toEqual(['honda-city', 'hyundai-creta']);
    expect(slugs(await search({ attributes: { extended_warranty: ['true'] } }))).toEqual(['honda-city']);
    expect((await search({ attributes: { wings: ['x'] } })).status).toBe(422);
  });

  it('sorts by price both ways with unpriced last, by name and newest', async () => {
    await seed();
    expect(slugs(await search({ sort: 'price_asc' }))).toEqual(['honda-city', 'hyundai-creta', 'mystery-car']);
    expect(slugs(await search({ sort: 'price_desc' }))).toEqual(['hyundai-creta', 'honda-city', 'mystery-car']);
    expect(slugs(await search({ sort: 'name' }))).toEqual(['honda-city', 'hyundai-creta', 'mystery-car']);
    expect(slugs(await search({ sort: 'newest' }))).toEqual(['mystery-car', 'honda-city', 'hyundai-creta']);
  });

  it('pages with a total and summarises price and availability', async () => {
    const { creta } = await seed();
    const page1 = (await search({ sort: 'name', limit: 2, page: 1 })).body.data;
    expect(page1).toMatchObject({ total: 3, pages: 2, page: 1, limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect((await search({ sort: 'name', limit: 2, page: 2 })).body.data.items.map((i: any) => i.slug)).toEqual(['mystery-car']);
    const card = (await search({ search: 'creta' })).body.data.items[0];
    expect(card).toMatchObject({ id: creta.id, item_count: 3, from_price: { amount_minor: 154999950, tax_inclusive: true }, availability: { status: 'tracked', available: 2 } });
    expect((await search({ limit: 101 })).status).toBe(400);
  });

  it('counts facets in products, each ignoring its own filter', async () => {
    await seed();
    const all = (await search({})).body.data.facets;
    expect(all.colour).toEqual(
      expect.arrayContaining([{ value: 'red', count: 1 }, { value: 'white', count: 1 }, { value: 'black', count: 1 }])
    );
    expect(all.fuel).toEqual(expect.arrayContaining([{ value: 'petrol', count: 1 }, { value: 'diesel', count: 1 }]));
    /* Filtering by colour keeps every colour option visible, but narrows the other facets. */
    const red = (await search({ attributes: { colour: ['red'] } })).body.data.facets;
    expect(red.colour.map((b: any) => b.value).sort()).toEqual(['black', 'red', 'white']);
    expect(red.extended_warranty).toEqual([]);
  });

  it('shows deleted products to Admins and Editors only when asked', async () => {
    const { city } = await seed();
    await request(app).delete(`${V2}/${city.id}`).set(admin);
    expect(slugs(await search({}))).not.toContain('honda-city');
    expect(slugs(await search({ include_deleted: true }))).toContain('honda-city');
  });
});

/* ================================================================ guards */

describe('guards from Phases 1–2 now count products', () => {
  it('a category with live products cannot be deleted', async () => {
    await createCreta();
    const res = await request(app).delete(`/api/v1/catalog-categories/${cats.suv.id}`).set(admin);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/product\(s\) are in this category/);
  });

  it('the category list and KPI figures count the new products', async () => {
    await createCreta({ category_ids: [cats.suv.id, cats.sedan.id] });
    await post(app, { name: { en: 'Seat cover' }, category_ids: [cats.suv.id] });
    await post(app, { name: { en: 'No category' } });
    const list = (await request(app).get('/api/v1/catalog-categories').set(viewer)).body.data.categories;
    const count = (code: string) => list.find((c: any) => c.code === code).product_count;
    expect([count('suv'), count('sedan'), count('accessories')]).toEqual([2, 1, 0]);

    const stats = (await request(app).get('/api/v1/catalog-categories/stats').set(viewer)).body.data;
    expect(stats).toMatchObject({
      total_categories: 3,
      assigned_skus: 4, // 3 Creta items + 1 seat cover item; the uncategorised product's item is not counted
      categorised_products: 2,
      top_distribution: { code: 'suv', count: 2, percentage: 100 },
      average_per_category: 1, // (2 + 1 + 0) / 3
    });
  });

  it('an attribute used as a variant option cannot be deleted', async () => {
    await createCreta({ items: [{ sku: 'ONE', attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'red' }] }] });
    const res = await request(app).delete('/api/v1/product-type/fields/fuel').set(admin);
    expect(res.status).toBe(409);
  });
});

/* =========================================================== transaction */

describe('transaction rollback', () => {
  it('leaves no product, items or stock when the 3rd item insert fails', async () => {
    const original = ProductItemModel.create.bind(ProductItemModel);
    let calls = 0;
    vi.spyOn(ProductItemModel, 'create').mockImplementation(async (...args: any[]) => {
      calls += 1;
      if (calls === 3) throw new Error('forced failure on the 3rd item');
      return (original as any)(...args);
    });
    const res = await post(app, creta(cats.suv.id));
    expect(res.status).toBe(500);
    expect(await raw('products_v2').countDocuments()).toBe(0);
    expect(await raw('product_items').countDocuments()).toBe(0);
    expect(await raw('item_stock').countDocuments()).toBe(0);
  });
});

/* ======================================================== DB integrity */

describe('database integrity after a mixed run', () => {
  it('keeps references, one live item per live product, min price, integer money and no blob URLs', async () => {
    const p = await createCreta();
    await post(app, { name: { en: 'Solo' }, items: [{ price: { amount_minor: 500 } }] });
    await request(app).delete(`${V2}/${p.id}/items/${itemBySku(p, 'CRETA-P-WHT').id}`).set(admin);
    const products = await raw('products_v2').find({ is_deleted: false }).toArray();
    const items = await raw('product_items').find({ is_deleted: false }).toArray();
    for (const i of items) expect(products.some((x: any) => x.id === i.product_id)).toBe(true);
    for (const x of products) {
      const mine = items.filter((i: any) => i.product_id === x.id);
      expect(mine.length).toBeGreaterThan(0);
      const prices = mine.filter((i: any) => i.status === 'active' && i.price).map((i: any) => i.price.amount_minor);
      expect(x.min_price_minor).toBe(prices.length ? Math.min(...prices) : null);
    }
    expect(items.every((i: any) => !i.price || Number.isInteger(i.price.amount_minor))).toBe(true);
    const text = JSON.stringify([products, items]);
    expect(text).not.toMatch(/blob:/);
  });
});
