import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { store } from '../../src/data/store.js';
import { ProductTypeModel } from '../../src/models/ProductType.model.js';
import { TenantSettingsModel } from '../../src/models/TenantSettings.model.js';
import { SiteSettingsModel } from '../../src/models/SiteSettings.model.js';
import { INCLUDE_DELETED } from '../../src/models/plugins/base.plugin.js';
import { migrateSiteSettingsToTenantSettings } from '../../src/services/tenantSettings.service.js';
import { isUuidV7 } from '../../src/utils/id.util.js';
import { bearer, USERS } from '../helpers.js';

let mongo: MongoMemoryServer;
let app: ReturnType<typeof createApp>;

const admin = bearer('Admin');
const editor = bearer('Editor');
const viewer = bearer('Viewer');

const setCategory = (code: string, extra: Record<string, unknown> = {}, headers = admin) =>
  request(app).put('/api/v1/settings/business').set(headers).send({ business_category: code, ...extra });

const addField = (body: Record<string, unknown>, headers = admin) =>
  request(app).post('/api/v1/product-type/fields').set(headers).send(body);

const liveTypes = () => ProductTypeModel.find().lean<any[]>();
const activeType = async () => (await request(app).get('/api/v1/product-type').set(viewer)).body.data;
const fieldOf = (type: any, key: string) => type.fields.find((f: any) => f.key === key);

/* Products arrive in Phase 3; a raw document stands in for "products exist". */
const addFakeProduct = (attrs: { key: string; value: string }[] = []) =>
  mongoose.connection.db!.collection('products_v2').insertOne({ is_deleted: false, attributes: attrs });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Promise.all([ProductTypeModel.init(), TenantSettingsModel.init()]);
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
  await Promise.all([ProductTypeModel.init(), TenantSettingsModel.init()]);
});

/* ================================================================ templates */

describe('GET /business-templates', () => {
  it('lists the three templates with their basic-field counts (Phase 1b: 3 / 3 / 2)', async () => {
    const res = await request(app).get('/api/v1/business-templates').set(viewer);
    expect(res.status).toBe(200);
    const counts = Object.fromEntries(res.body.data.map((t: any) => [t.code, t.field_count]));
    expect(counts).toEqual({ ecommerce: 3, car_dealership: 3, general: 2 });
    for (const t of res.body.data) {
      expect(t.version).toBe(2);
      expect(t.fields.every((f: any) => f.variant_forming === false)).toBe(true); // R41
    }
  });

  it('needs a token', async () => {
    expect((await request(app).get('/api/v1/business-templates')).status).toBe(401);
  });
});

/* ======================================================= business category */

describe('PUT /settings/business — correct data', () => {
  it('Car Dealership pre-loads the basic fields only (A1)', async () => {
    const res = await setCategory('car_dealership', { timezone: 'Asia/Kolkata', default_currency: 'INR', languages: ['en', 'ta'] });
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('created');
    expect(res.body.data.settings).toMatchObject({
      business_category: 'car_dealership',
      timezone: 'Asia/Kolkata',
      default_currency: 'INR',
      languages: ['en', 'ta'],
    });
    const type = res.body.data.product_type;
    expect(type.fields.map((f: any) => f.key)).toEqual(['make', 'model', 'body_type']);
    expect(type.fields.some((f: any) => f.variant_forming)).toBe(false);
    expect(type.type_version).toBe(1);
    expect(type.template_version).toBe(2);
    expect(isUuidV7(type.id)).toBe(true);

    /* Database integrity */
    const types = await liveTypes();
    expect(types).toHaveLength(1);
    const settings = await TenantSettingsModel.findOne().lean<any>();
    expect(settings.active_product_type_id).toBe(types[0].id);
    expect(settings.updated_by).toBe(USERS.Admin.id);
  });

  it.each([
    ['ecommerce', ['brand', 'material', 'gender']],
    ['general', ['brand', 'material']],
  ])('%s pre-loads %j', async (code, keys) => {
    const res = await setCategory(code as string);
    expect(res.status).toBe(200);
    expect(res.body.data.product_type.fields.map((f: any) => f.key)).toEqual(keys);
  });

  it('keeps the type when the same category is saved again', async () => {
    const first = (await setCategory('ecommerce')).body.data.product_type.id;
    const res = await setCategory('ecommerce', { timezone: 'Asia/Dubai' });
    expect(res.body.data.outcome).toBe('unchanged');
    expect(res.body.data.product_type.id).toBe(first);
    expect(res.body.data.settings.timezone).toBe('Asia/Dubai');
  });

  it('replaces the type when the category changes and no products exist', async () => {
    const old = (await setCategory('ecommerce')).body.data.product_type.id;
    const res = await setCategory('car_dealership');
    expect(res.body.data.outcome).toBe('replaced');
    expect(res.body.data.product_type.fields).toHaveLength(3);
    const all = await ProductTypeModel.find({ ...INCLUDE_DELETED }).lean<any[]>();
    expect(all.find((t) => t.id === old).is_deleted).toBe(true);
    expect(await liveTypes()).toHaveLength(1);
  });

  it('handles changing the category twice in a row', async () => {
    await setCategory('ecommerce');
    expect((await setCategory('car_dealership')).body.data.outcome).toBe('replaced');
    const res = await setCategory('general');
    expect(res.body.data.outcome).toBe('replaced');
    expect(res.body.data.product_type.fields).toHaveLength(2);
    expect(await liveTypes()).toHaveLength(1);
    expect(await ProductTypeModel.countDocuments({ is_deleted: true })).toBe(2);
  });

  it('merges — never removes — when the category changes after products exist (K1)', async () => {
    await setCategory('general');
    await addField({ label: { en: 'Warranty' }, type: 'number' });
    await addFakeProduct();
    const res = await setCategory('ecommerce');
    expect(res.body.data.outcome).toBe('merged');
    expect(res.body.data.notice).toMatch(/nothing was removed/);
    const keys = res.body.data.product_type.fields.map((f: any) => f.key);
    expect(keys).toEqual(['brand', 'material', 'warranty', 'gender']); // custom field kept, gender added
    /* material is text in "general" and enum in "ecommerce": kept as text, reported */
    expect(res.body.data.notice).toMatch(/material/);
    expect(fieldOf(res.body.data.product_type, 'material').type).toBe('text');
  });
});

describe('PUT /settings/business — invalid / missing', () => {
  it('rejects an unknown business category with 422 and changes nothing', async () => {
    const res = await setCategory('bakery');
    expect(res.status).toBe(422);
    expect(res.body.errors[0].path).toBe('business_category');
    expect(await liveTypes()).toHaveLength(0);
    expect(await TenantSettingsModel.countDocuments()).toBe(0);
  });

  it('rejects a bad time zone, currency and language with a per-field error each', async () => {
    const res = await setCategory('ecommerce', { timezone: 'Mars/Base', default_currency: 'RS', languages: ['fr'] });
    expect(res.status).toBe(400);
    const paths = res.body.errors.map((e: any) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['body.timezone', 'body.default_currency', 'body.languages.0']));
    expect(await liveTypes()).toHaveLength(0);
  });

  it('requires English among the languages', async () => {
    expect((await setCategory('ecommerce', { languages: ['ta'] })).status).toBe(400);
  });

  it('rejects a missing business category', async () => {
    const res = await request(app).put('/api/v1/settings/business').set(admin).send({ timezone: 'Asia/Kolkata' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /settings/business — permissions', () => {
  it('is Admin-only', async () => {
    expect((await setCategory('ecommerce', {}, editor)).status).toBe(403);
    expect((await setCategory('ecommerce', {}, viewer)).status).toBe(403);
    expect((await request(app).put('/api/v1/settings/business').send({ business_category: 'ecommerce' })).status).toBe(401);
    expect(await liveTypes()).toHaveLength(0);
  });

  it('is readable by any signed-in user, with defaults before anything is saved', async () => {
    const res = await request(app).get('/api/v1/settings/business').set(viewer);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      business_category: null,
      active_product_type_id: null,
      timezone: 'Asia/Kolkata',
      default_currency: 'INR',
      languages: ['en'],
    });
  });
});

/* =============================================================== attributes */

describe('GET /product-type', () => {
  it('is null before a category is chosen', async () => {
    const res = await request(app).get('/api/v1/product-type').set(viewer);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('returns fields in display order', async () => {
    await setCategory('car_dealership');
    const type = await activeType();
    expect(type.fields.map((f: any) => f.sort_order)).toEqual([1, 2, 3]);
    expect(type.template_update_available).toBe(false);
  });
});

describe('POST /product-type/fields', () => {
  beforeEach(async () => {
    await setCategory('car_dealership');
  });

  it('adds a custom attribute with a key made from its label (A2)', async () => {
    const res = await addField({ label: { en: 'Warranty (Months)' }, type: 'number', unit: 'months', min: 0 });
    expect(res.status).toBe(201);
    const type = res.body.data.product_type;
    expect(fieldOf(type, 'warranty_months')).toMatchObject({ source: 'custom', type: 'number', unit: 'months', added_in_version: 2, sort_order: 4, variant_forming: false });
    expect(type.type_version).toBe(2);
  });

  it('makes a new choice list usable for variants by default (Phase 1b)', async () => {
    const res = await addField({ label: { en: 'Fuel' }, type: 'enum', options: ['Petrol', 'Diesel'] });
    expect(fieldOf(res.body.data.product_type, 'fuel').variant_forming).toBe(true);
  });

  it('lets the admin turn "usable for variants" off', async () => {
    const res = await addField({ label: { en: 'Condition' }, type: 'enum', options: ['New', 'Used'], variant_forming: false });
    expect(fieldOf(res.body.data.product_type, 'condition').variant_forming).toBe(false);
  });

  it('adds an enum with options and Tamil / Hindi labels', async () => {
    const res = await addField({
      label: { en: 'Insurance', ta: 'காப்பீடு', hi: 'बीमा' },
      type: 'enum',
      options: ['Comprehensive', { label: { en: 'Third party' } }],
      filterable: true,
    });
    expect(res.status).toBe(201);
    const f = fieldOf(res.body.data.product_type, 'insurance');
    expect(f.label).toEqual({ en: 'Insurance', ta: 'காப்பீடு', hi: 'बीमा' });
    expect(f.options.map((o: any) => o.value)).toEqual(['comprehensive', 'third_party']);
  });

  it.each(['boolean', 'date', 'text', 'translated_text'])('accepts type %s', async (type) => {
    expect((await addField({ label: { en: `My ${type}` }, type })).status).toBe(201);
  });

  it('refuses a duplicate key (409) and leaves type_version unchanged', async () => {
    const res = await addField({ label: { en: 'Make' }, type: 'text' });
    expect(res.status).toBe(409);
    expect((await activeType()).type_version).toBe(1);
  });

  it('refuses an enum with no options (422)', async () => {
    const res = await addField({ label: { en: 'Grade' }, type: 'enum', options: [] });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/at least one option/);
  });

  it('refuses variant use on a number field (422)', async () => {
    const res = await addField({ label: { en: 'Doors' }, type: 'number', variant_forming: true });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/Only enum fields can form variants/);
  });

  it('refuses min greater than max (422)', async () => {
    expect((await addField({ label: { en: 'Owners' }, type: 'number', min: 5, max: 1 })).status).toBe(422);
  });

  it('refuses duplicate options (422)', async () => {
    expect((await addField({ label: { en: 'Grade' }, type: 'enum', options: ['A', 'a'] })).status).toBe(422);
  });

  it('refuses a missing label / unknown type (400)', async () => {
    expect((await addField({ type: 'text' })).status).toBe(400);
    expect((await addField({ label: { en: 'X' }, type: 'colour_picker' })).status).toBe(400);
  });

  it('refuses a label of only spaces (400)', async () => {
    expect((await addField({ label: { en: '   ' }, type: 'text' })).status).toBe(400);
  });

  it('refuses a label over 120 characters (400) and accepts exactly 120', async () => {
    expect((await addField({ label: { en: 'x'.repeat(121) }, type: 'text' })).status).toBe(400);
    expect((await addField({ label: { en: 'y'.repeat(120) }, type: 'text' })).status).toBe(201);
  });

  it('accepts an enum with 200 options', async () => {
    const options = Array.from({ length: 200 }, (_, i) => `Option ${i + 1}`);
    const res = await addField({ label: { en: 'Big list' }, type: 'enum', options });
    expect(res.status).toBe(201);
    expect(fieldOf(res.body.data.product_type, 'big_list').options).toHaveLength(200);
  });

  it('saves a required field as optional once products exist (K3)', async () => {
    await addFakeProduct();
    const res = await addField({ label: { en: 'VIN verified' }, type: 'boolean', required: true });
    expect(res.status).toBe(201);
    expect(res.body.data.notice).toMatch(/added as optional/);
    expect(fieldOf(res.body.data.product_type, 'vin_verified').required).toBe(false);
  });

  it('is Admin-only', async () => {
    expect((await addField({ label: { en: 'X' }, type: 'text' }, editor)).status).toBe(403);
    expect((await addField({ label: { en: 'X' }, type: 'text' }, viewer)).status).toBe(403);
  });

  it('asks for a business category first when there is no type', async () => {
    await mongoose.connection.db!.dropDatabase();
    const res = await addField({ label: { en: 'X' }, type: 'text' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/business category/);
  });
});

describe('PATCH / DELETE /product-type/fields/:key', () => {
  beforeEach(async () => {
    await setCategory('car_dealership');
  });

  const patch = (key: string, body: Record<string, unknown>, headers = admin) =>
    request(app).patch(`/api/v1/product-type/fields/${key}`).set(headers).send(body);

  it('relabels, regroups and makes a template field optional', async () => {
    const res = await patch('make', { label: { en: 'Manufacturer', ta: 'உற்பத்தியாளர்' }, group: 'brand', required: false });
    expect(res.status).toBe(200);
    expect(fieldOf(res.body.data.product_type, 'make')).toMatchObject({
      label: { en: 'Manufacturer', ta: 'உற்பத்தியாளர்' },
      group: 'brand',
      required: false,
    });
    expect(res.body.data.product_type.type_version).toBe(2);
  });

  it('adds options to a template enum and retires one (add-only)', async () => {
    const body = fieldOf(await activeType(), 'body_type');
    const options = [
      ...body.options.map((o: any) => (o.value === 'muv' ? { ...o, deprecated: true } : o)),
      { label: { en: 'Coupe' } },
    ];
    const res = await patch('body_type', { options });
    expect(res.status).toBe(200);
    const next = fieldOf(res.body.data.product_type, 'body_type').options;
    expect(next.find((o: any) => o.value === 'muv').deprecated).toBe(true);
    expect(next.map((o: any) => o.value)).toContain('coupe');
  });

  it('refuses removing an option (409)', async () => {
    const res = await patch('body_type', { options: [{ label: { en: 'Sedan' } }] });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/only be added or retired/);
  });

  it('refuses renaming an existing option (409)', async () => {
    const body = fieldOf(await activeType(), 'body_type');
    const options = body.options.map((o: any) => (o.value === 'sedan' ? { ...o, label: { en: 'Saloon' } } : o));
    expect((await patch('body_type', { options })).status).toBe(409);
  });

  it('refuses retyping a template field (409)', async () => {
    const res = await patch('body_type', { type: 'text' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/type cannot be changed/);
  });

  it('refuses changing a key (409)', async () => {
    expect((await patch('make', { key: 'manufacturer' })).status).toBe(409);
  });

  it('refuses giving a template field a unit (409)', async () => {
    expect((await patch('body_type', { unit: 'litres' })).status).toBe(409);
  });

  it('retires and restores a field', async () => {
    let res = await patch('model', { deprecated: true });
    expect(fieldOf(res.body.data.product_type, 'model').deprecated).toBe(true);
    res = await patch('model', { deprecated: false });
    expect(fieldOf(res.body.data.product_type, 'model').deprecated).toBe(false);
  });

  it('refuses deleting a template field (409)', async () => {
    const res = await request(app).delete('/api/v1/product-type/fields/make').set(admin);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/retire it instead/);
  });

  it('lets an unused custom field be reshaped, then deleted', async () => {
    await addField({ label: { en: 'Grade' }, type: 'text' });
    expect((await patch('grade', { type: 'enum', options: ['A', 'B'] })).status).toBe(200);
    expect((await patch('grade', { options: ['A'] })).status).toBe(200); // removing is fine while unused
    const res = await request(app).delete('/api/v1/product-type/fields/grade').set(admin);
    expect(res.status).toBe(200);
    expect(fieldOf(res.body.data.product_type, 'grade')).toBeUndefined();
  });

  it('locks a custom field once a product uses it', async () => {
    await addField({ label: { en: 'Grade' }, type: 'text' });
    await addFakeProduct([{ key: 'grade', value: 'A' }]);
    expect((await patch('grade', { type: 'number' })).status).toBe(409);
    expect((await request(app).delete('/api/v1/product-type/fields/grade').set(admin)).status).toBe(409);
  });

  it('treats "no unit" as unchanged on a used field (not a 409)', async () => {
    await addField({ label: { en: 'Owners' }, type: 'number' });
    await addFakeProduct([{ key: 'owners', value: '1' }]);
    const res = await patch('owners', { label: { en: 'Previous owners' }, unit: null, min: null, max: null });
    expect(res.status).toBe(200);
    expect(fieldOf(res.body.data.product_type, 'owners').label.en).toBe('Previous owners');
  });

  it('keeps a field optional when asked to make it required after products exist (K3)', async () => {
    await addFakeProduct();
    const res = await patch('body_type', { required: true });
    expect(res.status).toBe(200);
    expect(res.body.data.notice).toMatch(/stays optional/);
    expect(fieldOf(res.body.data.product_type, 'body_type').required).toBe(false);
  });

  it('404s for an unknown key', async () => {
    expect((await patch('wings', { label: { en: 'Wings' } })).status).toBe(404);
  });

  it('is Admin-only', async () => {
    expect((await patch('make', { label: { en: 'X' } }, editor)).status).toBe(403);
    expect((await request(app).delete('/api/v1/product-type/fields/make').set(viewer)).status).toBe(403);
  });
});

/* ========================================= Phase 1b — add options from a product */

describe('POST /product-type/fields/:key/options (Phase 1b)', () => {
  beforeEach(async () => {
    await setCategory('ecommerce');
    await addField({ label: { en: 'Colour' }, type: 'enum', options: ['Red', 'Blue'] });
  });

  const addOptions = (key: string, body: Record<string, unknown>, headers = editor) =>
    request(app).post(`/api/v1/product-type/fields/${key}/options`).set(headers).send(body);

  it('lets an Editor add an option to the shared attribute, audited', async () => {
    const res = await addOptions('colour', { options: ['Maroon'] });
    expect(res.status).toBe(200);
    expect(res.body.data.added).toEqual(['maroon']);
    const colour = fieldOf(res.body.data.product_type, 'colour');
    expect(colour.options.map((o: any) => o.value)).toEqual(['red', 'blue', 'maroon']);
    expect(res.body.data.product_type.type_version).toBe(3);
    const stored = await ProductTypeModel.findOne().lean<any>();
    expect(stored.updated_by).toBe(USERS.Editor.id);
  });

  it('lets an Admin add options too', async () => {
    expect((await addOptions('colour', { options: ['Green'] }, admin)).status).toBe(200);
  });

  it('returns an existing option instead of duplicating it', async () => {
    const res = await addOptions('colour', { options: ['red', ' RED '] });
    expect(res.status).toBe(200);
    expect(res.body.data.added).toEqual([]);
    expect(res.body.data.existing).toEqual(['red']); // the same option twice in one request is one
    expect(res.body.message).toMatch(/already exist/);
    expect(res.body.data.product_type.type_version).toBe(2); // nothing written
  });

  it.each([
    ['Rde', 'Red'],
    ['Reds', 'Red'],
    ['Bleu', 'Blue'],
  ])('holds back the near-duplicate "%s" (looks like %s) until confirmed', async (typed, like) => {
    const res = await addOptions('colour', { options: [typed] });
    expect(res.status).toBe(200);
    expect(res.body.data.added).toEqual([]);
    expect(res.body.data.warnings[0]).toMatchObject({ label: typed, similar_to: like });
    expect(fieldOf(res.body.data.product_type, 'colour').options).toHaveLength(2);

    const confirmed = await addOptions('colour', { options: [typed], confirm: true });
    expect(confirmed.body.data.added).toHaveLength(1);
    expect(fieldOf(confirmed.body.data.product_type, 'colour').options).toHaveLength(3);
  });

  it('writes nothing when any option in the batch needs confirming', async () => {
    const res = await addOptions('colour', { options: ['Green', 'Rde'] });
    expect(res.body.data.warnings).toHaveLength(1);
    expect(fieldOf(res.body.data.product_type, 'colour').options).toHaveLength(2);
  });

  it('does not treat genuinely different short values as near-duplicates', async () => {
    await addField({ label: { en: 'Size' }, type: 'enum', options: ['S', 'M'] });
    const res = await addOptions('size', { options: ['L', 'XL'] });
    expect(res.body.data.added).toEqual(['l', 'xl']);
  });

  it('saves both when two options are added at the same moment (retry on clash)', async () => {
    const [a, b] = await Promise.all([addOptions('colour', { options: ['Green'] }), addOptions('colour', { options: ['Yellow'] })]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const values = fieldOf(await activeType(), 'colour').options.map((o: any) => o.value);
    expect(values).toEqual(expect.arrayContaining(['red', 'blue', 'green', 'yellow']));
  });

  it('refuses options on a non-choice attribute (422)', async () => {
    expect((await addOptions('brand', { options: ['Nike'] })).status).toBe(422);
  });

  it('refuses an empty list (400) and an unknown attribute (404)', async () => {
    expect((await addOptions('colour', { options: [] })).status).toBe(400);
    expect((await addOptions('wings', { options: ['Big'] })).status).toBe(404);
  });

  it('refuses a retired attribute (409)', async () => {
    await request(app).patch('/api/v1/product-type/fields/colour').set(admin).send({ deprecated: true });
    expect((await addOptions('colour', { options: ['Green'] })).status).toBe(409);
  });

  it('refuses a Viewer (403) and no token (401)', async () => {
    expect((await addOptions('colour', { options: ['Green'] }, viewer)).status).toBe(403);
    expect((await request(app).post('/api/v1/product-type/fields/colour/options').send({ options: ['Green'] })).status).toBe(401);
  });
});

describe('POST /product-type/fields/reorder and /upgrade', () => {
  beforeEach(async () => {
    await setCategory('ecommerce');
  });

  it('reorders all fields', async () => {
    const keys = ['gender', 'material', 'brand'];
    const res = await request(app).post('/api/v1/product-type/fields/reorder').set(admin).send({ keys });
    expect(res.status).toBe(200);
    expect(res.body.data.product_type.fields.map((f: any) => f.key)).toEqual(keys);
  });

  it('refuses a partial or duplicated key list (422)', async () => {
    const r1 = await request(app).post('/api/v1/product-type/fields/reorder').set(admin).send({ keys: ['brand'] });
    const r2 = await request(app)
      .post('/api/v1/product-type/fields/reorder')
      .set(admin)
      .send({ keys: ['brand', 'brand', 'gender'] });
    expect(r1.status).toBe(422);
    expect(r2.status).toBe(422);
  });

  it('upgrade is a no-op when already on the latest template', async () => {
    const res = await request(app).post('/api/v1/product-type/upgrade').set(admin);
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('up_to_date');
    expect(res.body.data.product_type.type_version).toBe(1);
  });

  it('an existing tenant on template v1 keeps every field when moved to v2 (K2, Phase 1b)', async () => {
    /* Simulate a tenant loaded from the old, larger v1 template. */
    await ProductTypeModel.updateOne(
      {},
      {
        $set: { template_version: 1 },
        $push: {
          fields: {
            key: 'size', label: { en: 'Size' }, type: 'enum', options: [{ value: 's', label: { en: 'S' }, deprecated: false }],
            variant_forming: true, filterable: true, required: false, sort_order: 4, source: 'template', deprecated: false, added_in_version: 1,
          },
        },
      }
    );
    expect((await activeType()).template_update_available).toBe(true);
    const res = await request(app).post('/api/v1/product-type/upgrade').set(admin);
    expect(res.body.data.outcome).toBe('upgraded');
    expect(res.body.data.product_type.template_version).toBe(2);
    expect(res.body.data.product_type.fields.map((f: any) => f.key)).toEqual(['brand', 'material', 'gender', 'size']);
  });
});

/* ====================================================== site settings kept */

describe('Site settings live in tenant_settings with the same API', () => {
  it('GET /settings/site answers with the same fields as before, and no business fields', async () => {
    const res = await request(app).get('/api/v1/settings/site').set(viewer);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(
      ['businessType', 'faviconUrl', 'id', 'labels', 'legalName', 'logoUrl', 'siteName', 'tagline', 'updatedBy'].sort()
    );
    expect(res.body.data.siteName).toBe('OmniFlow');
  });

  it('PUT /settings/site saves into tenant_settings, alongside the business settings', async () => {
    await setCategory('ecommerce');
    const res = await request(app)
      .put('/api/v1/settings/site')
      .set(admin)
      .send({ siteName: 'Test Motors', labels: { products: { plural: 'Cars', singular: 'Car' } } });
    expect(res.status).toBe(200);
    expect(res.body.data.siteName).toBe('Test Motors');
    expect(res.body.data.labels.products).toEqual({ plural: 'Cars', singular: 'Car' });
    expect(res.body.data.updatedAt).toBeTruthy();

    const docs = await TenantSettingsModel.find().lean<any[]>();
    expect(docs).toHaveLength(1); // one document for both
    expect(docs[0]).toMatchObject({ siteName: 'Test Motors', business_category: 'ecommerce' });
  });

  it('saving business settings does not touch site settings, and vice versa', async () => {
    await request(app).put('/api/v1/settings/site').set(admin).send({ siteName: 'Kept' });
    await setCategory('car_dealership', { timezone: 'Asia/Dubai' });
    expect((await request(app).get('/api/v1/settings/site').set(viewer)).body.data.siteName).toBe('Kept');
    await request(app).put('/api/v1/settings/site').set(admin).send({ tagline: 'New' });
    expect((await request(app).get('/api/v1/settings/business').set(viewer)).body.data.timezone).toBe('Asia/Dubai');
  });

  it('public settings still publish only the allow-listed fields', async () => {
    await setCategory('ecommerce');
    const res = await request(app).get('/public/settings');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data).sort()).toEqual(['faviconUrl', 'labels', 'logoUrl', 'siteName', 'tagline']);
  });
});

describe('Migration from the old sitesettings collection', () => {
  it('copies the old row once, keeps its values and leaves the old row untouched', async () => {
    const updatedAt = new Date('2026-05-01T10:00:00Z');
    await SiteSettingsModel.collection.insertOne({
      id: 'site',
      siteName: 'Legacy Cars',
      legalName: 'Legacy Pvt Ltd',
      tagline: 'Drive',
      logoUrl: '',
      faviconUrl: '',
      businessType: 'Cars',
      labels: { products: { plural: 'My Cars', singular: 'My Car' } },
      updatedBy: 'owner@legacy.test',
      updatedAt,
    });

    expect(await migrateSiteSettingsToTenantSettings()).toBe('migrated');
    expect(await migrateSiteSettingsToTenantSettings()).toBe('skipped'); // idempotent

    const res = await request(app).get('/api/v1/settings/site').set(viewer);
    expect(res.body.data).toMatchObject({
      siteName: 'Legacy Cars',
      legalName: 'Legacy Pvt Ltd',
      businessType: 'Cars',
      updatedBy: 'owner@legacy.test',
    });
    expect(res.body.data.labels.products).toEqual({ plural: 'My Cars', singular: 'My Car' });
    expect(new Date(res.body.data.updatedAt).toISOString()).toBe(updatedAt.toISOString());

    const old = await SiteSettingsModel.collection.findOne({ id: 'site' });
    expect(old?.siteName).toBe('Legacy Cars');
    expect(await TenantSettingsModel.countDocuments()).toBe(1);
  });

  it('does nothing when there is no old row', async () => {
    expect(await migrateSiteSettingsToTenantSettings()).toBe('nothing');
    expect(await TenantSettingsModel.countDocuments()).toBe(0);
  });
});
