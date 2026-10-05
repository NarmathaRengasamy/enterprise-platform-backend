import mongoose from 'mongoose';
import request from 'supertest';
import { ProductTypeModel } from '../../src/models/ProductType.model.js';
import { TenantSettingsModel } from '../../src/models/TenantSettings.model.js';
import { CatalogCategoryModel } from '../../src/models/CatalogCategory.model.js';
import { ProductV2Model } from '../../src/models/ProductV2.model.js';
import { ProductItemModel } from '../../src/models/ProductItem.model.js';
import { ItemStockModel } from '../../src/models/ItemStock.model.js';
import { StockMovementModel } from '../../src/models/StockMovement.model.js';
import { ItemUnitModel } from '../../src/models/ItemUnit.model.js';
import { BundleComponentModel } from '../../src/models/BundleComponent.model.js';
import { bearer } from '../helpers.js';

/**
 * Shared set-up for the Phase 3 suites: a Car Dealership tenant with Fuel and
 * Colour as variant-ready choice lists, a Warranty number and an "Extended
 * warranty" yes / no, and a few categories.
 */

export const admin = bearer('Admin');
export const editor = bearer('Editor');
export const viewer = bearer('Viewer');
export const V2 = '/api/v2/products';

export const freshDatabase = async () => {
  /* Emptied rather than dropped: on a replica set a drop finishes in the
     background and races the next test's writes. Indexes stay in place. */
  const db = mongoose.connection.db!;
  for (const c of await db.collections()) await c.deleteMany({});
  /* Collections and indexes exist before any transaction writes to them. */
  await Promise.all(
    [ProductTypeModel, TenantSettingsModel, CatalogCategoryModel, ProductV2Model, ProductItemModel, ItemStockModel, StockMovementModel, ItemUnitModel, BundleComponentModel].map((m: any) => m.init())
  );
};

export const seedTenant = async (app: any) => {
  const put = (body: object) =>
    request(app).put('/api/v1/settings/business').set(admin).send({ business_category: 'car_dealership', ...body });
  await put({});
  const field = (body: object) => request(app).post('/api/v1/product-type/fields').set(admin).send(body);
  await field({ label: { en: 'Fuel' }, type: 'enum', options: ['Petrol', 'Diesel', 'CNG'], variant_forming: true, filterable: true });
  await field({ label: { en: 'Colour' }, type: 'enum', options: ['Red', 'White', 'Black'], variant_forming: true, filterable: true });
  await field({ label: { en: 'Warranty' }, type: 'number', unit: 'months', min: 0, max: 120 });
  await field({ label: { en: 'Extended warranty' }, type: 'boolean', filterable: true });
  const cat = async (body: object) => (await request(app).post('/api/v1/catalog-categories').set(admin).send(body)).body.data;
  const suv = await cat({ code: 'suv', name: { en: 'SUV' } });
  const sedan = await cat({ code: 'sedan', name: { en: 'Sedan' } });
  const accessories = await cat({ code: 'accessories', name: { en: 'Accessories' }, visible_field_keys: ['make', 'model', 'colour'] });
  return { suv, sedan, accessories, put };
};

/**
 * "Hyundai Creta" in SUV, Fuel × Colour, with the items given (default: three of the four).
 * Tracked by quantity (`tracking: 'none'`) so initial stock is accepted: a car's own
 * default is serial, where units drive stock and initial stock is refused (Phase 4).
 */
export const creta = (categoryId: string, over: Record<string, unknown> = {}) => ({
  name: { en: 'Hyundai Creta', ta: 'ஹூண்டாய் க்ரேட்டா' },
  brand: 'Hyundai',
  category_ids: [categoryId],
  tracking: 'none',
  attributes: [
    { key: 'make', value: 'Hyundai' },
    { key: 'model', value: 'Creta' },
    { key: 'body_type', value: 'suv' },
  ],
  variant_axes: [
    { key: 'fuel', values: ['petrol', 'diesel'] },
    { key: 'colour', values: ['red', 'white'] },
  ],
  hsn_code: '8703',
  gst_rate: 28,
  items: [
    { sku: 'CRETA-P-RED', attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'red' }], price: { amount_minor: 154999950 }, initial_stock: 2 },
    { sku: 'CRETA-P-WHT', attributes: [{ key: 'fuel', value: 'petrol' }, { key: 'colour', value: 'white' }], price: { amount_minor: 155999900 } },
    { sku: 'CRETA-D-RED', attributes: [{ key: 'fuel', value: 'diesel' }, { key: 'colour', value: 'red' }], price: { amount_minor: 169999900 }, initial_stock: 0 },
  ],
  ...over,
});

export const post = (app: any, body: object, headers = admin) => request(app).post(V2).set(headers).send(body);
