import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { store } from '../../src/data/store.js';
import { stockService, writeOpeningBalances } from '../../src/services/stock.service.js';
import { transactionsSupported } from '../../src/utils/transaction.util.js';
import { newId } from '../../src/utils/id.util.js';
import { USERS } from '../helpers.js';
import { admin, creta, editor, freshDatabase, post, seedTenant, V2, viewer } from './phase3-helpers.js';

/**
 * Phase 4 — stock, serial / batch units, bundles and packs (plan 4.5), on a
 * replica set so adjustments run in real transactions.
 */

let rs: MongoMemoryReplSet;
let app: ReturnType<typeof createApp>;
let cats: Awaited<ReturnType<typeof seedTenant>>;

const ITEMS = '/api/v2/items';
const raw = (name: string) => mongoose.connection.db!.collection(name);
const get = (id: string, headers = admin) => request(app).get(`${V2}/${id}`).set(headers);
const bySku = (p: any, sku: string) => p.items.find((i: any) => i.sku === sku);
const adjust = (itemId: string, body: object, headers = editor) => request(app).post(`${ITEMS}/${itemId}/stock/adjust`).set(headers).send(body);
const stock = (itemId: string, headers = admin) => request(app).get(`${ITEMS}/${itemId}/stock`).set(headers);
const addUnits = (itemId: string, units: object[], headers = editor) => request(app).post(`${ITEMS}/${itemId}/units`).set(headers).send({ units });

/** A one-item product tracked by quantity. */
const simple = async (name: string, sku: string, over: Record<string, unknown> = {}, item: Record<string, unknown> = {}) => {
  const res = await post(app, { name: { en: name }, tracking: 'none', items: [{ sku, price: { amount_minor: 10000 }, ...item }], ...over });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
};

/** A car tracked by serial number (the type default): no initial stock, units drive stock. */
const serialCar = async () => {
  const res = await post(app, creta(cats.suv.id, { slug: 'creta-serial', tracking: undefined, items: [{ sku: 'CAR-1', attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'red' }] }] }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
};

/** Socks: a single (₹100) and, in the same request, a box of 4 (₹360). */
const socks = async () => {
  const res = await post(app, {
    name: { en: 'Socks' },
    tracking: 'none',
    items: [
      { sku: 'SOCK', price: { amount_minor: 10000 } },
      { sku: 'SOCK-BOX4', pack_of: { base_sku: 'SOCK', quantity: 4 }, price: { amount_minor: 36000 } },
    ],
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
};

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

/** Every stock row: never negative, and its movements add up to on_hand. */
const assertStockIntegrity = async () => {
  for (const row of await raw('item_stock').find({ is_deleted: false }).toArray()) {
    expect(row.on_hand).toBeGreaterThanOrEqual(0);
    const moves = await raw('stock_movements').find({ item_id: row.item_id, location_id: row.location_id }).toArray();
    expect(moves.reduce((n, m) => n + m.delta, 0)).toBe(row.on_hand);
  }
};

/* ================================================================ stock */

describe('stock adjustments (4.2, R30)', () => {
  it('runs on a replica set', async () => {
    expect(await transactionsSupported()).toBe(true);
  });

  it('+10 then −2 → on hand 8 with two movements (user, reason, on_hand_after)', async () => {
    const p = await simple('Wiper', 'WIPER');
    const id = p.items[0].id;
    expect((await adjust(id, { delta: 10, reason: 'Received from supplier' })).status).toBe(200);
    const after = await adjust(id, { delta: -2, reason: 'Sold at the counter' });
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.data).toMatchObject({ kind: 'item', can_adjust: true, availability: { status: 'tracked', on_hand: 8, available: 8 } });

    const history = await request(app).get(`${ITEMS}/${id}/stock/movements`).set(editor);
    expect(history.status).toBe(200);
    expect(history.body.data.total).toBe(2);
    expect(history.body.data.items.map((m: any) => [m.delta, m.on_hand_after, m.reason, m.source])).toEqual([
      [-2, 8, 'Sold at the counter', 'adjust'],
      [10, 10, 'Received from supplier', 'adjust'],
    ]);
    expect(history.body.data.items[0].created_by).toBe(USERS.Editor.id);
    expect((await get(p.id)).body.data.items[0].availability).toMatchObject({ on_hand: 8 });
    await assertStockIntegrity();
  });

  it('refuses delta 0, 1.5 and an empty reason (400)', async () => {
    const id = (await simple('Wiper', 'WIPER')).items[0].id;
    expect((await adjust(id, { delta: 0, reason: 'x' })).status).toBe(400);
    expect((await adjust(id, { delta: 1.5, reason: 'x' })).status).toBe(400);
    expect((await adjust(id, { delta: 1, reason: '' })).status).toBe(400);
  });

  it('taking out with no stock row → 409 "Only 0 in stock"; an untracked item → 409 "Not tracked", no row', async () => {
    const id = (await simple('Wiper', 'WIPER')).items[0].id;
    const none = await adjust(id, { delta: -1, reason: 'x' });
    expect(none.status).toBe(409);
    expect(none.body.message).toMatch(/Only 0 in stock/);

    const service = (await post(app, { name: { en: '1st free service' }, fulfilment: 'service', items: [{}] })).body.data;
    const nt = await adjust(service.items[0].id, { delta: 5, reason: 'x' });
    expect(nt.status).toBe(409);
    expect(nt.body.message).toMatch(/Not tracked/);
    expect(await raw('item_stock').countDocuments({ item_id: service.items[0].id })).toBe(0);
  });

  it('two −5 at the same moment on 6 → exactly one succeeds, on hand 1 (A9)', async () => {
    const id = (await simple('Wiper', 'WIPER', {}, { initial_stock: 6 })).items[0].id;
    const results = await Promise.all([adjust(id, { delta: -5, reason: 'a' }), adjust(id, { delta: -5, reason: 'b' })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await stock(id)).body.data.availability.on_hand).toBe(1);
    await assertStockIntegrity();
  });

  it('50 parallel adjustments: on hand = Σ accepted deltas, never below 0, movements reconcile', async () => {
    const id = (await simple('Wiper', 'WIPER', {}, { initial_stock: 10 })).items[0].id;
    const deltas = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? 4 : -3));
    const results = await Promise.all(deltas.map((d, i) => adjust(id, { delta: d, reason: `load ${i}` })));
    const accepted = deltas.filter((_, i) => results[i].status === 200).reduce((n, d) => n + d, 0);
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect((await stock(id)).body.data.availability.on_hand).toBe(10 + accepted);
    await assertStockIntegrity();
  });

  it('initial stock writes an "Initial stock" movement; the reorder point flags low stock', async () => {
    const id = (await simple('Wiper', 'WIPER', {}, { initial_stock: 4 })).items[0].id;
    const moves = (await request(app).get(`${ITEMS}/${id}/stock/movements`).set(admin)).body.data.items;
    expect(moves).toMatchObject([{ delta: 4, reason: 'Initial stock', source: 'initial' }]);
    const rp = await request(app).patch(`${ITEMS}/${id}/stock/reorder-point`).set(editor).send({ reorder_point: 5 });
    expect(rp.status).toBe(200);
    expect(rp.body.data.availability).toMatchObject({ reorder_point: 5, low_stock: true });
  });

  it('Track inventory off: 409 with on hand 3, 200 at 0 (R31a)', async () => {
    const p = await simple('Wiper', 'WIPER', {}, { initial_stock: 3 });
    expect((await request(app).patch(`${V2}/${p.id}`).set(editor).send({ track_inventory: false })).status).toBe(409);
    await adjust(p.items[0].id, { delta: -3, reason: 'count' });
    expect((await request(app).patch(`${V2}/${p.id}`).set(editor).send({ track_inventory: false })).status).toBe(200);
  });

  it('roles: a Viewer reads stock but cannot adjust or add units (403)', async () => {
    const id = (await simple('Wiper', 'WIPER')).items[0].id;
    expect((await stock(id, viewer)).status).toBe(200);
    expect((await adjust(id, { delta: 1, reason: 'x' }, viewer)).status).toBe(403);
    const car = await serialCar();
    expect((await addUnits(car.items[0].id, [{ serial_no: 'VIN1' }], viewer)).status).toBe(403);
  });

  it('writes an opening-balance movement once for stock rows without movements', async () => {
    const id = (await simple('Wiper', 'WIPER')).items[0].id;
    await raw('item_stock').insertOne({ id: newId(), item_id: id, location_id: 'default', on_hand: 7, reserved: 0, reorder_point: 0, is_deleted: false, deleted_at: null });
    expect(await writeOpeningBalances()).toBe(1);
    expect(await writeOpeningBalances()).toBe(0);
    expect(await raw('stock_movements').findOne({ item_id: id })).toMatchObject({ delta: 7, reason: 'Opening balance', source: 'opening', on_hand_after: 7 });
    await assertStockIntegrity();
  });
});

/* ================================================================ units */

describe('serial / batch units (4.2)', () => {
  it('serial: units drive stock (+1 added, −1 sold, +1 returned, −1 removed); manual adjust → 409', async () => {
    const car = await serialCar();
    const id = car.items[0].id;
    const added = await addUnits(id, [{ serial_no: 'VIN-1' }, { serial_no: 'VIN-2' }, { serial_no: 'VIN-3' }]);
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    expect(added.body.data.units).toHaveLength(3);
    expect((await stock(id)).body.data.availability.on_hand).toBe(3);

    const unit = added.body.data.units.find((u: any) => u.serial_no === 'VIN-1');
    expect((await request(app).patch(`/api/v2/units/${unit.id}`).set(editor).send({ status: 'sold' })).status).toBe(200);
    expect((await stock(id)).body.data.availability.on_hand).toBe(2);
    expect((await request(app).patch(`/api/v2/units/${unit.id}`).set(editor).send({ status: 'in_stock' })).status).toBe(422); // sold → returned only
    expect((await request(app).patch(`/api/v2/units/${unit.id}`).set(editor).send({ status: 'returned' })).status).toBe(200);
    expect((await stock(id)).body.data.availability.on_hand).toBe(3);

    const other = added.body.data.units.find((u: any) => u.serial_no === 'VIN-2');
    expect((await request(app).delete(`/api/v2/units/${other.id}`).set(editor)).status).toBe(200);
    expect((await stock(id)).body.data.availability.on_hand).toBe(2);

    const manual = await adjust(id, { delta: 1, reason: 'x' });
    expect(manual.status).toBe(409);
    expect(manual.body.message).toMatch(/add or sell units instead/);
    await assertStockIntegrity();
  });

  it('a serial number used by a live unit → 409; serial needs a number (422)', async () => {
    const car = await serialCar();
    await addUnits(car.items[0].id, [{ serial_no: 'VIN-1' }]);
    expect((await addUnits(car.items[0].id, [{ serial_no: 'VIN-1' }])).status).toBe(409);
    expect((await addUnits(car.items[0].id, [{ serial_no: 'A' }, { serial_no: 'A' }])).status).toBe(422);
    expect((await addUnits(car.items[0].id, [{ batch_no: 'B1' }])).status).toBe(422);
  });

  it('refuses units on a quantity-tracked or untracked item (422)', async () => {
    const id = (await simple('Wiper', 'WIPER')).items[0].id;
    expect((await addUnits(id, [{ serial_no: 'X' }])).status).toBe(422);
    const service = (await post(app, { name: { en: 'Service' }, fulfilment: 'service', items: [{}] })).body.data;
    expect((await addUnits(service.items[0].id, [{ serial_no: 'X' }])).status).toBe(422);
  });

  it('tracking cannot leave serial while units are in stock (409); switching to serial with stock on hand → 409', async () => {
    const car = await serialCar();
    await addUnits(car.items[0].id, [{ serial_no: 'VIN-1' }, { serial_no: 'VIN-2' }]);
    const res = await request(app).patch(`${V2}/${car.id}`).set(editor).send({ tracking: 'none' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Units are in stock/);

    const wiper = await simple('Wiper', 'WIPER', {}, { initial_stock: 2 });
    expect((await request(app).patch(`${V2}/${wiper.id}`).set(editor).send({ tracking: 'serial' })).status).toBe(409);
  });

  it('batch: batch_no is a label; stock is adjusted normally', async () => {
    const p = await simple('Paint', 'PAINT', { tracking: 'batch' }, { initial_stock: 10 });
    const id = p.items[0].id;
    expect((await addUnits(id, [{ batch_no: 'B-2026-10' }])).status).toBe(201);
    expect((await stock(id)).body.data.availability.on_hand).toBe(10);
    expect((await adjust(id, { delta: -4, reason: 'used' })).status).toBe(200);
  });

  it('deleting the product takes its units with it; restore brings them back', async () => {
    const car = await serialCar();
    await addUnits(car.items[0].id, [{ serial_no: 'VIN-1' }]);
    await request(app).delete(`${V2}/${car.id}`).set(admin);
    expect(await raw('item_units').countDocuments({ is_deleted: false })).toBe(0);
    await request(app).post(`${V2}/${car.id}/restore`).set(admin);
    expect(await raw('item_units').countDocuments({ is_deleted: false })).toBe(1);
  });
});

/* ================================================================ packs */

describe('packs (R47–R49)', () => {
  it('socks: box of 4 from 10 singles → availability 2, saving 10 %, no stock row; created with base_sku', async () => {
    const p = await socks();
    const single = bySku(p, 'SOCK');
    await adjust(single.id, { delta: 10, reason: 'received' });
    const after = (await get(p.id)).body.data;
    const box = bySku(after, 'SOCK-BOX4');
    expect(box.pack_of).toEqual({ base_item_id: single.id, quantity: 4 });
    expect(box.availability).toMatchObject({ status: 'tracked', available: 2, from: 'pack' });
    expect(box.pack_saving).toEqual({ fraction: 0.1, percent: 10, amount_minor: 4000 });
    expect(after.min_price_minor).toBe(10000); // packs left out of the "from" price
    expect(after.availability).toEqual({ status: 'tracked', available: 10 }); // the box is not added on top
    expect(await raw('item_stock').countDocuments({ item_id: box.id })).toBe(0);
  });

  it('refuses a pack of a pack, a base from another product, quantity 1 and a pack on a serial product (422)', async () => {
    const p = await socks();
    const box = bySku(p, 'SOCK-BOX4');
    const add = (productId: string, body: object) => request(app).post(`${V2}/${productId}/items`).set(editor).send(body);
    expect((await add(p.id, { pack_of: { base_item_id: box.id, quantity: 2 } })).status).toBe(422);
    const other = await simple('Belt', 'BELT');
    expect((await add(p.id, { pack_of: { base_item_id: other.items[0].id, quantity: 2 } })).status).toBe(422);
    expect((await add(p.id, { pack_of: { base_sku: 'SOCK', quantity: 1 } })).status).toBe(422);
    const car = await serialCar();
    expect((await add(car.id, { pack_of: { base_item_id: car.items[0].id, quantity: 2 } })).status).toBe(422);
    /* A valid one, by SKU, on a product without variant options. */
    const ok = await add(p.id, { sku: 'SOCK-BOX10', pack_of: { base_sku: 'SOCK', quantity: 10 }, price: { amount_minor: 85000 } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await add(p.id, { sku: 'SOCK-B4-AGAIN', pack_of: { base_sku: 'SOCK', quantity: 4 } })).status).toBe(409); // same pack twice
  });

  it('adjusting the box → 409; deleting the single while the box is live → 409; restoring a pack without its base → 409', async () => {
    const p = await socks();
    const single = bySku(p, 'SOCK');
    const box = bySku(p, 'SOCK-BOX4');
    const res = await adjust(box.id, { delta: 1, reason: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/adjust the base item/);
    const del = await request(app).delete(`${V2}/${p.id}/items/${single.id}`).set(admin);
    expect(del.status).toBe(409);
    expect(del.body.message).toMatch(/has packs/);

    /* Delete the box, then the single (the box is gone) — restoring the box alone is refused. */
    await request(app).delete(`${V2}/${p.id}/items/${box.id}`).set(admin);
    await raw('product_items').updateOne({ id: single.id }, { $set: { is_deleted: true, deleted_at: new Date() } });
    const restore = await request(app).post(`${V2}/${p.id}/items/${box.id}/restore`).set(admin);
    expect(restore.status).toBe(409);
    expect(restore.body.message).toMatch(/base item/);
  });

  it('sellPack: a box of 4 sold twice at once with 6 singles → one succeeds (6 → 2), one 409', async () => {
    const p = await socks();
    const single = bySku(p, 'SOCK');
    const box = bySku(p, 'SOCK-BOX4');
    await adjust(single.id, { delta: 6, reason: 'received' });
    const results = await Promise.allSettled([stockService.sellPack(box.id), stockService.sellPack(box.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason.statusCode).toBe(409);
    expect((await stock(single.id)).body.data.availability.on_hand).toBe(2);
    await assertStockIntegrity();
  });

  it('a product with only packs priced uses the cheapest pack as its "from" price', async () => {
    const res = await post(app, {
      name: { en: 'Batteries' },
      tracking: 'none',
      items: [
        { sku: 'AA' }, // not priced
        { sku: 'AA-4', pack_of: { base_sku: 'AA', quantity: 4 }, price: { amount_minor: 12000 } },
        { sku: 'AA-8', pack_of: { base_sku: 'AA', quantity: 8 }, price: { amount_minor: 22000 } },
      ],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.data.min_price_minor).toBe(12000);
  });

  it('a pack takes no Track inventory override and no initial stock', async () => {
    const p = await socks();
    const add = (body: object) => request(app).post(`${V2}/${p.id}/items`).set(editor).send(body);
    expect((await add({ pack_of: { base_sku: 'SOCK', quantity: 6 }, track_inventory: false })).status).toBe(422);
    expect((await add({ pack_of: { base_sku: 'SOCK', quantity: 6 }, initial_stock: 2 })).status).toBe(409);
  });
});

/* ============================================================== bundles */

describe('bundles (4.2)', () => {
  const kit = async () => {
    const res = await post(app, { name: { en: 'Service kit' }, is_bundle: true, items: [{ sku: 'KIT' }] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data;
  };
  const setComponents = (itemId: string, components: object[]) => request(app).put(`${ITEMS}/${itemId}/bundle-components`).set(editor).send({ components });

  it('2× A (5 available) + 1× B (1 available) → bundle availability 1; no stock of its own', async () => {
    const a = (await simple('Oil filter', 'FILTER', {}, { initial_stock: 5 })).items[0];
    const b = (await simple('Spark plug', 'PLUG', {}, { initial_stock: 1 })).items[0];
    const k = await kit();
    const res = await setComponents(k.items[0].id, [{ component_item_id: a.id, quantity: 2 }, { component_item_id: b.id, quantity: 1 }]);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.data.availability).toMatchObject({ status: 'tracked', available: 1, from: 'bundle' });
    expect(res.body.data.components.map((c: any) => [c.sku, c.quantity])).toEqual([['FILTER', 2], ['PLUG', 1]]);
    expect(bySku((await get(k.id)).body.data, 'KIT').availability).toMatchObject({ available: 1, from: 'bundle' });

    /* Stock of a component moves the bundle. */
    await adjust(b.id, { delta: 4, reason: 'received' });
    expect((await request(app).get(`${ITEMS}/${k.items[0].id}/bundle-components`).set(editor)).body.data.availability.available).toBe(2);
    expect((await adjust(k.items[0].id, { delta: 1, reason: 'x' })).status).toBe(409);

    /* A product whose item another bundle uses cannot be deleted. */
    const del = await request(app).delete(`${V2}/${a.product_id}`).set(admin);
    expect(del.status).toBe(409);
    expect(del.body.message).toMatch(/in other bundles \(KIT\)/);
  });

  it('refuses itself, another bundle, a pack and a fraction (422); replaces the list atomically', async () => {
    const k = await kit();
    const k2 = (await post(app, { name: { en: 'Big kit' }, slug: 'big-kit', is_bundle: true, items: [{ sku: 'KIT2' }] })).body.data;
    const p = await socks();
    expect((await setComponents(k.items[0].id, [{ component_item_id: k.items[0].id, quantity: 1 }])).status).toBe(422);
    expect((await setComponents(k2.items[0].id, [{ component_item_id: k.items[0].id, quantity: 1 }])).status).toBe(422);
    expect((await setComponents(k.items[0].id, [{ component_item_id: bySku(p, 'SOCK-BOX4').id, quantity: 1 }])).status).toBe(422);
    expect((await setComponents(k.items[0].id, [{ component_item_id: bySku(p, 'SOCK').id, quantity: 1.5 }])).status).toBe(422);
    const ok = await setComponents(k.items[0].id, [{ component_item_id: bySku(p, 'SOCK').id, quantity: 3 }]);
    expect(ok.status).toBe(200);
    const cleared = await setComponents(k.items[0].id, []);
    expect(cleared.body.data.components).toEqual([]);
    expect(await raw('bundle_components').countDocuments({ is_deleted: false })).toBe(0);
  });

  it('components only on bundle products (422); a bundle item takes no initial stock (409)', async () => {
    const w = await simple('Wiper', 'WIPER');
    const p = await socks();
    expect((await setComponents(w.items[0].id, [{ component_item_id: bySku(p, 'SOCK').id, quantity: 1 }])).status).toBe(422);
    const res = await post(app, { name: { en: 'Kit' }, is_bundle: true, items: [{ sku: 'K', initial_stock: 1 }] });
    expect(res.status).toBe(409);
  });
});
