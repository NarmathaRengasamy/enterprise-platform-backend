import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { store } from '../../src/data/store.js';
import { ProductTypeModel } from '../../src/models/ProductType.model.js';
import { TenantSettingsModel } from '../../src/models/TenantSettings.model.js';
import { CatalogCategoryModel } from '../../src/models/CatalogCategory.model.js';
import { INCLUDE_DELETED } from '../../src/models/plugins/base.plugin.js';
import { dropCategoryOverrides } from '../../src/data/migrations.js';
import { isUuidV7 } from '../../src/utils/id.util.js';
import { bearer, USERS } from '../helpers.js';

let mongo: MongoMemoryServer;
let app: ReturnType<typeof createApp>;

const admin = bearer('Admin');
const editor = bearer('Editor');
const viewer = bearer('Viewer');
const BASE = '/api/v1/catalog-categories';

const setBusiness = (body: Record<string, unknown>, headers = admin) =>
  request(app).put('/api/v1/settings/business').set(headers).send({ business_category: 'car_dealership', ...body });
const useTree = () => setBusiness({ category_mode: 'tree' });

const create = (body: Record<string, unknown>, headers = admin) =>
  request(app).post(BASE).set(headers).send({ name: { en: String(body.code) }, ...body });
const list = async (q = '') => (await request(app).get(`${BASE}${q}`).set(viewer)).body.data;
const idOf = (res: request.Response) => res.body.data.id as string;

/* Products arrive in Phase 3; a raw document stands in for one. */
const addFakeProduct = (category_ids: string[]) =>
  mongoose.connection.db!.collection('products_v2').insertOne({ is_deleted: false, category_ids });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  vi.spyOn(store, 'getUserById').mockImplementation(async (id: string) =>
    Object.values(USERS).find((u) => u.id === id) as any
  );
  app = createApp();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  await Promise.all([ProductTypeModel.init(), TenantSettingsModel.init(), CatalogCategoryModel.init()]);
  await setBusiness({}); // car_dealership, flat
});

/* =================================================================== flat */

describe('flat mode (the default)', () => {
  it('is flat until the tree is switched on', async () => {
    expect((await request(app).get('/api/v1/settings/business').set(viewer)).body.data.category_mode).toBe('flat');
    expect((await list()).mode).toBe('flat');
  });

  it('creates top-level categories with UUIDv7 ids and audit fields', async () => {
    const shirts = await create({ code: 'shirts', name: { en: 'Shirts', ta: 'சட்டைகள்' } });
    await create({ code: 'jeans', name: { en: 'Jeans' } });
    expect(shirts.status).toBe(201);
    expect(isUuidV7(idOf(shirts))).toBe(true);
    const { categories } = await list();
    expect(categories.map((c: any) => c.code)).toEqual(['shirts', 'jeans']);
    expect(categories.every((c: any) => c.parent_id === null && c.children.length === 0)).toBe(true);
    const stored = await CatalogCategoryModel.findOne({ code: 'shirts' }).lean<any>();
    expect(stored.created_by).toBe(USERS.Admin.id);
  });

  it('refuses a parent in flat mode (422)', async () => {
    const shirts = await create({ code: 'shirts' });
    const res = await create({ code: 'polo', parent_id: idOf(shirts) });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/switch it on/);
    const move = await request(app).patch(`${BASE}/${idOf(await create({ code: 'jeans' }))}`).set(admin).send({ parent_id: idOf(shirts) });
    expect(move.status).toBe(422);
  });

  it('creates the Car template starter categories flattened (K17)', async () => {
    const res = await setBusiness({ create_starter_categories: true });
    expect(res.body.data.starter_categories.created).toEqual(['cars', 'suv', 'sedan', 'hatchback', 'accessories', 'service']);
    const { categories } = await list();
    expect(categories.map((c: any) => c.code)).toEqual(['cars', 'suv', 'sedan', 'hatchback', 'accessories', 'service']);
    expect(categories.every((c: any) => c.parent_id === null)).toBe(true);
  });

  it('never duplicates starter categories when saved twice', async () => {
    await setBusiness({ create_starter_categories: true });
    const again = await setBusiness({ create_starter_categories: true });
    expect(again.body.data.starter_categories.created).toEqual([]);
    expect(await CatalogCategoryModel.countDocuments()).toBe(6);
  });
});

/* =================================================================== tree */

describe('tree mode', () => {
  beforeEach(async () => {
    await useTree();
  });

  it('switching flat → tree is always allowed', async () => {
    expect((await list()).mode).toBe('tree');
  });

  it('nests, orders and inherits visible fields', async () => {
    const cars = await create({ code: 'cars', visible_field_keys: ['make', 'model'] });
    const suv = await create({ code: 'suv', parent_id: idOf(cars) });
    await create({ code: 'sedan', parent_id: idOf(cars), visible_field_keys: ['body_type'] });
    const { categories } = await list();
    const root = categories.find((c: any) => c.code === 'cars');
    expect(root.children.map((c: any) => c.code)).toEqual(['suv', 'sedan']);
    const suvNode = root.children[0];
    expect(suvNode.resolved_visible_field_keys).toEqual(['make', 'model']); // inherited
    expect(root.children[1].resolved_visible_field_keys).toEqual(['body_type']); // its own

    const detail = (await request(app).get(`${BASE}/${idOf(suv)}`).set(viewer)).body.data;
    expect(detail.ancestors.map((a: any) => a.code)).toEqual(['cars']);
  });

  it('shows every attribute when no category limits them', async () => {
    const root = await create({ code: 'cars' });
    expect(root.body.data.resolved_visible_field_keys).toEqual(['make', 'model', 'body_type']);
  });

  it('creates the starter categories as a tree', async () => {
    await setBusiness({ create_starter_categories: true, category_mode: 'tree' });
    const { categories } = await list();
    const cars = categories.find((c: any) => c.code === 'cars');
    expect(cars.children.map((c: any) => c.code)).toEqual(['suv', 'sedan', 'hatchback']);
    const accessories = categories.find((c: any) => c.code === 'accessories');
    expect(accessories).not.toHaveProperty('tracking');
    expect(accessories).not.toHaveProperty('resolved_tracking');
  });

  it('refuses a move under its own sub-category (cycle, 422)', async () => {
    const cars = await create({ code: 'cars' });
    const suv = await create({ code: 'suv', parent_id: idOf(cars) });
    const res = await request(app).patch(`${BASE}/${idOf(cars)}`).set(admin).send({ parent_id: idOf(suv) });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/own sub-categories/);
    const self = await request(app).patch(`${BASE}/${idOf(cars)}`).set(admin).send({ parent_id: idOf(cars) });
    expect(self.status).toBe(422);
  });

  it('allows 5 levels and refuses a 6th (422)', async () => {
    let parent: string | null = null;
    for (let level = 1; level <= 5; level++) {
      const res = await create({ code: `level-${level}`, parent_id: parent });
      expect(res.status).toBe(201);
      parent = idOf(res);
    }
    const sixth = await create({ code: 'level-6', parent_id: parent });
    expect(sixth.status).toBe(422);
    expect(sixth.body.message).toMatch(/at most 5 levels/);
  });

  it('refuses a move that would make the tree too deep (422)', async () => {
    const a = await create({ code: 'aa' });
    const b = await create({ code: 'bb', parent_id: idOf(a) });
    const c = await create({ code: 'cc', parent_id: idOf(b) });
    const x = await create({ code: 'xx' });
    const y = await create({ code: 'yy', parent_id: idOf(x) });
    await create({ code: 'zz', parent_id: idOf(y) });
    /* a > b > c (3) + x > y > z (height 3) = 6 */
    const res = await request(app).patch(`${BASE}/${idOf(x)}`).set(admin).send({ parent_id: idOf(c) });
    expect(res.status).toBe(422);
  });

  it('moves a category to the top level', async () => {
    const cars = await create({ code: 'cars' });
    const suv = await create({ code: 'suv', parent_id: idOf(cars) });
    const res = await request(app).patch(`${BASE}/${idOf(suv)}`).set(admin).send({ parent_id: null });
    expect(res.status).toBe(200);
    expect(res.body.data.parent_id).toBeNull();
  });

  it('reorders the children of one parent', async () => {
    const cars = await create({ code: 'cars' });
    const ids = [idOf(await create({ code: 'suv', parent_id: idOf(cars) })), idOf(await create({ code: 'sedan', parent_id: idOf(cars) }))];
    const res = await request(app).post(`${BASE}/reorder`).set(editor).send({ parent_id: idOf(cars), ids: [ids[1], ids[0]] });
    expect(res.status).toBe(200);
    const root = res.body.data.categories.find((c: any) => c.code === 'cars');
    expect(root.children.map((c: any) => c.code)).toEqual(['sedan', 'suv']);
    const partial = await request(app).post(`${BASE}/reorder`).set(editor).send({ parent_id: idOf(cars), ids: [ids[0]] });
    expect(partial.status).toBe(422);
  });

  it('refuses switching the tree off while a category has a parent — nothing changes (K16)', async () => {
    const cars = await create({ code: 'cars' });
    await create({ code: 'suv', parent_id: idOf(cars) });
    const res = await setBusiness({ category_mode: 'flat', timezone: 'Asia/Dubai' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/1 category still has a parent/);
    const settings = (await request(app).get('/api/v1/settings/business').set(viewer)).body.data;
    expect(settings).toMatchObject({ category_mode: 'tree', timezone: 'Asia/Kolkata' }); // nothing saved
  });

  it('allows switching the tree off once every category is at the top level', async () => {
    const cars = await create({ code: 'cars' });
    const suv = await create({ code: 'suv', parent_id: idOf(cars) });
    await request(app).patch(`${BASE}/${idOf(suv)}`).set(admin).send({ parent_id: null });
    const res = await setBusiness({ category_mode: 'flat' });
    expect(res.status).toBe(200);
    expect(res.body.data.settings.category_mode).toBe('flat');
  });
});

/* ============================================ validation / delete / restore */

describe('validation', () => {
  it('refuses a bad code format (422) and a missing name (400)', async () => {
    expect((await create({ code: 'Cars & Bikes' })).status).toBe(422);
    expect((await create({ code: 'x' })).status).toBe(422); // too short
    expect((await request(app).post(BASE).set(admin).send({ code: 'cars' })).status).toBe(400);
  });

  it('stores codes in lower case', async () => {
    const res = await create({ code: 'SUV' });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe('suv');
  });

  it('refuses a duplicate live code (409) but allows it again after a delete', async () => {
    const first = await create({ code: 'cars' });
    expect((await create({ code: 'cars' })).status).toBe(409);
    await request(app).delete(`${BASE}/${idOf(first)}`).set(admin);
    expect((await create({ code: 'cars' })).status).toBe(201);
  });

  it('refuses unknown or retired visible fields (422)', async () => {
    const res = await create({ code: 'cars', visible_field_keys: ['wings'] });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/wings/);
    await request(app).patch('/api/v1/product-type/fields/body_type').set(admin).send({ deprecated: true });
    expect((await create({ code: 'vans', visible_field_keys: ['body_type'] })).status).toBe(422);
  });

  it('drops a field retired later from the resolved list rather than failing', async () => {
    await create({ code: 'cars', visible_field_keys: ['make', 'body_type'] });
    await request(app).patch('/api/v1/product-type/fields/body_type').set(admin).send({ deprecated: true });
    const { categories } = await list();
    expect(categories[0].resolved_visible_field_keys).toEqual(['make']);
  });

  it('refuses changing a code (409)', async () => {
    const cars = await create({ code: 'cars' });
    expect((await request(app).patch(`${BASE}/${idOf(cars)}`).set(admin).send({ code: 'autos' })).status).toBe(409);
  });

  it('updates names and status, and keeps visible fields when they are not sent', async () => {
    const cars = await create({ code: 'cars', visible_field_keys: ['make'] });
    const res = await request(app)
      .patch(`${BASE}/${idOf(cars)}`)
      .set(editor)
      .send({ name: { en: 'Cars & SUVs', hi: 'कारें' }, status: 'hidden' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: { en: 'Cars & SUVs', hi: 'कारें' }, status: 'hidden', visible_field_keys: ['make'] });
  });
});

describe('delete and restore', () => {
  it('refuses deleting a category with sub-categories (409)', async () => {
    await useTree();
    const cars = await create({ code: 'cars' });
    await create({ code: 'suv', parent_id: idOf(cars) });
    const res = await request(app).delete(`${BASE}/${idOf(cars)}`).set(admin);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Has live sub-categories \(suv\)/);
  });

  it('refuses deleting a category that products use (409)', async () => {
    const cars = await create({ code: 'cars' });
    await addFakeProduct(['other', idOf(cars)]); // in any position
    const res = await request(app).delete(`${BASE}/${idOf(cars)}`).set(admin);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/1 product/);
  });

  it('soft-deletes and restores; shows deleted only when asked', async () => {
    const cars = await create({ code: 'cars' });
    expect((await request(app).delete(`${BASE}/${idOf(cars)}`).set(admin)).status).toBe(200);
    expect((await list()).categories).toHaveLength(0);
    expect((await list('?include_deleted=true')).categories[0].is_deleted).toBe(true);
    const raw = await CatalogCategoryModel.findOne({ code: 'cars', ...INCLUDE_DELETED }).lean<any>();
    expect(raw.is_deleted).toBe(true);
    const back = await request(app).post(`${BASE}/${idOf(cars)}/restore`).set(admin);
    expect(back.status).toBe(200);
    expect((await list()).categories).toHaveLength(1);
  });

  it('refuses restoring a child whose parent is still deleted (409)', async () => {
    await useTree();
    const cars = await create({ code: 'cars' });
    const suv = await create({ code: 'suv', parent_id: idOf(cars) });
    await request(app).delete(`${BASE}/${idOf(suv)}`).set(admin);
    await request(app).delete(`${BASE}/${idOf(cars)}`).set(admin);
    const res = await request(app).post(`${BASE}/${idOf(suv)}/restore`).set(admin);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Restore its parent "cars" first/);
  });

  it('refuses restoring when the code has been reused (409)', async () => {
    const first = await create({ code: 'cars' });
    await request(app).delete(`${BASE}/${idOf(first)}`).set(admin);
    await create({ code: 'cars' });
    expect((await request(app).post(`${BASE}/${idOf(first)}/restore`).set(admin)).status).toBe(409);
  });

  it('404s for an unknown id', async () => {
    expect((await request(app).get(`${BASE}/nope`).set(viewer)).status).toBe(404);
    expect((await request(app).delete(`${BASE}/nope`).set(admin)).status).toBe(404);
  });
});

describe('permissions', () => {
  it('Viewers read only; Editors create / edit / reorder; only Admins delete, restore or switch the mode', async () => {
    expect((await create({ code: 'cars' }, viewer)).status).toBe(403);
    const cars = await create({ code: 'cars' }, editor);
    expect(cars.status).toBe(201);
    expect((await request(app).patch(`${BASE}/${idOf(cars)}`).set(editor).send({ status: 'hidden' })).status).toBe(200);
    expect((await request(app).delete(`${BASE}/${idOf(cars)}`).set(editor)).status).toBe(403);
    expect((await request(app).post(`${BASE}/${idOf(cars)}/restore`).set(editor)).status).toBe(403);
    expect((await setBusiness({ category_mode: 'tree' }, editor)).status).toBe(403);
    expect((await request(app).get(BASE)).status).toBe(401);
  });
});

describe('database integrity', () => {
  it('leaves no parents in flat mode, unique live codes and no fulfilment / tracking', async () => {
    await setBusiness({ create_starter_categories: true });
    const rows = await CatalogCategoryModel.find().lean<any[]>();
    expect(rows.every((r) => r.parent_id === null)).toBe(true);
    expect(rows.some((r) => 'fulfilment' in r || 'tracking' in r)).toBe(false);
    expect(new Set(rows.map((r) => r.code)).size).toBe(rows.length);
  });
});

/* ============================================================ Phase 2b */

describe('Phase 2b: categories carry no fulfilment / tracking (R13)', () => {
  const RETIRED = ['fulfilment', 'tracking', 'resolved_fulfilment', 'resolved_tracking'];
  const expectNone = (obj: any) => RETIRED.forEach((k) => expect(obj).not.toHaveProperty(k));

  it('ignores them when sent on create and update — 2xx, nothing stored', async () => {
    const res = await create({ code: 'service', fulfilment: 'service', tracking: 'serial' });
    expect(res.status).toBe(201);
    expectNone(res.body.data);

    const patch = await request(app).patch(`${BASE}/${idOf(res)}`).set(editor).send({ fulfilment: 'rental', tracking: 'batch' });
    expect(patch.status).toBe(200);
    expectNone(patch.body.data);

    const stored = await CatalogCategoryModel.collection.findOne({ code: 'service' });
    expect(stored).not.toHaveProperty('fulfilment');
    expect(stored).not.toHaveProperty('tracking');
  });

  it('leaves them out of the list, the tree and the detail', async () => {
    await useTree();
    const parent = await create({ code: 'cars' });
    const child = await create({ code: 'suv', parent_id: idOf(parent) });
    const { categories } = await list();
    expectNone(categories[0]);
    expectNone(categories[0].children[0]);
    expectNone((await request(app).get(`${BASE}/${idOf(child)}`).set(viewer)).body.data);
  });

  it('creates the Car starter categories without overrides; the product type stays serial', async () => {
    for (const mode of ['flat', 'tree'] as const) {
      await mongoose.connection.db!.dropDatabase();
      await Promise.all([ProductTypeModel.init(), TenantSettingsModel.init(), CatalogCategoryModel.init()]);
      await setBusiness({ create_starter_categories: true, category_mode: mode });
      const rows = await CatalogCategoryModel.collection.find().toArray();
      expect(rows.map((r) => r.code).sort()).toEqual(['accessories', 'cars', 'hatchback', 'sedan', 'service', 'suv']);
      for (const r of rows) {
        expect(r).not.toHaveProperty('fulfilment');
        expect(r).not.toHaveProperty('tracking');
      }
      expect(rows.some((r) => r.parent_id !== null)).toBe(mode === 'tree');
      const type = (await request(app).get('/api/v1/product-type').set(viewer)).body.data;
      expect(type).toMatchObject({ tracking: 'serial', fulfilment: 'goods' });
    }
  });

  it('the start-up clean-up removes old values once, without touching audit fields', async () => {
    const a = await create({ code: 'accessories' });
    await create({ code: 'service' });
    await create({ code: 'plain' });
    await CatalogCategoryModel.collection.updateOne({ code: 'accessories' }, { $set: { tracking: 'none' } });
    await CatalogCategoryModel.collection.updateOne({ code: 'service' }, { $set: { fulfilment: 'service', tracking: null } });
    await request(app).delete(`${BASE}/${idOf(a)}`).set(admin); // deleted rows are cleaned too
    const before = await CatalogCategoryModel.collection.findOne({ code: 'service' });

    expect(await dropCategoryOverrides()).toBe(2);
    expect(await dropCategoryOverrides()).toBe(0); // idempotent

    const rows = await CatalogCategoryModel.collection.find().toArray();
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).not.toHaveProperty('fulfilment');
      expect(r).not.toHaveProperty('tracking');
    }
    const after = await CatalogCategoryModel.collection.findOne({ code: 'service' });
    expect(after!.updated_at).toEqual(before!.updated_at);
    expect(after!.updated_by).toEqual(before!.updated_by);
  });
});

/* ======================================================== 2b.4a export */

describe('GET /catalog-categories/export (2b.4a)', () => {
  const HEADER = 'code,name_en,name_ta,name_hi,parent_code,status,sort_order,visible_field_keys';
  const exportCsv = (q = '', headers = editor) => request(app).get(`${BASE}/export${q}`).set(headers);
  /* Rows without the BOM and header; each line split into its unquoted cells. */
  const rowsOf = (text: string) =>
    text
      .replace(/^\uFEFF/, '')
      .split('\r\n')
      .slice(1)
      .map((line) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')));

  it('sends a CSV attachment with the agreed columns, parents before children', async () => {
    await useTree();
    const cars = await create({ code: 'cars', name: { en: 'Cars', ta: 'கார்கள்' }, visible_field_keys: ['make', 'model'] });
    await create({ code: 'suv', name: { en: 'SUV' }, parent_id: idOf(cars) });

    const res = await exportCsv();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="categories\.csv"/);
    const [header] = res.text.replace(/^\uFEFF/, '').split('\r\n');
    expect(header).toBe(HEADER);
    expect(rowsOf(res.text)).toEqual([
      ['cars', 'Cars', 'கார்கள்', '', '', 'active', '1', 'make|model'],
      ['suv', 'SUV', '', '', 'cars', 'active', '1', ''],
    ]);
  });

  it('escapes commas, quotes and newlines, and neutralises formulas', async () => {
    await create({ code: 'odd', name: { en: 'Cars, "Bikes" & more' }, description: { en: 'x' } });
    await create({ code: 'formula', name: { en: '=HYPERLINK("x")' } });
    const res = await exportCsv('?search=odd');
    expect(res.text).toContain('"Cars, ""Bikes"" & more"');
    expect(rowsOf(res.text)[0][1]).toBe('Cars, "Bikes" & more');
    const formula = await exportCsv('?search=formula');
    expect(rowsOf(formula.text)[0][1]).toBe(`'=HYPERLINK("x")`);
  });

  it('respects search, status and include_deleted like the list', async () => {
    await create({ code: 'shirts', name: { en: 'Shirts', hi: 'कमीज़' } });
    await create({ code: 'jeans', name: { en: 'Jeans' }, status: 'hidden' });
    const old = await create({ code: 'socks', name: { en: 'Socks' } });
    await request(app).delete(`${BASE}/${idOf(old)}`).set(admin);

    const codes = async (q: string) => rowsOf((await exportCsv(q)).text).map((r) => r[0]);
    expect(await codes('')).toEqual(['shirts', 'jeans']);
    expect(await codes('?search=SHI')).toEqual(['shirts']);
    expect(await codes('?search=कमीज़')).toEqual(['shirts']); // any language
    expect(await codes('?status=hidden')).toEqual(['jeans']);
    expect(await codes('?status=active')).toEqual(['shirts']);
    expect(await codes('?include_deleted=true')).toEqual(['shirts', 'jeans', 'socks']);
    expect(await codes('?search=nothing')).toEqual([]);
    expect((await exportCsv('?status=gone')).status).toBe(400);
  });

  it('is for Admins and Editors only, and "export" is never read as an id', async () => {
    await create({ code: 'shirts' });
    expect((await exportCsv('', admin)).status).toBe(200);
    expect((await exportCsv('', editor)).status).toBe(200);
    expect((await exportCsv('', viewer)).status).toBe(403);
    expect((await request(app).get(`${BASE}/export`)).status).toBe(401);
    /* Were it routed as /:id, an Admin would get a 404 "Category not found" JSON. */
    const res = await exportCsv('', admin);
    expect(res.headers['content-type']).not.toMatch(/json/);
  });
});
