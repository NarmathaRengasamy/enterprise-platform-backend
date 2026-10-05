import mongoose, { Schema } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { basePlugin, INCLUDE_DELETED } from '../../src/models/plugins/base.plugin.js';
import { restore, softDelete } from '../../src/utils/soft-delete.util.js';
import { runWithRequestContext } from '../../src/utils/request-context.js';
import { isUuidV7 } from '../../src/utils/id.util.js';

let mongo: MongoMemoryServer;

const WidgetSchema = new Schema({ name: { type: String, required: true } });
WidgetSchema.plugin(basePlugin);
const Widget = mongoose.model('TestWidget', WidgetSchema, 'test_widgets');

const as = <T>(user_id: string, fn: () => Promise<T>) => runWithRequestContext({ user_id, role: 'Editor' }, fn);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await Widget.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Widget.deleteMany({ ...INCLUDE_DELETED });
});

describe('basePlugin — identity and audit', () => {
  it('mints a UUIDv7 id and stamps created/updated by the acting user', async () => {
    const w = await as('user-1', () => Widget.create({ name: 'A' }));
    expect(isUuidV7(w.get('id'))).toBe(true);
    expect(w.get('created_by')).toBe('user-1');
    expect(w.get('updated_by')).toBe('user-1');
    expect(w.get('created_at')).toBeInstanceOf(Date);
    expect(w.get('is_deleted')).toBe(false);
  });

  it('records "system" outside a request', async () => {
    const w = await Widget.create({ name: 'A' });
    expect(w.get('created_by')).toBe('system');
  });

  it('stamps updated_by on save and on query updates, keeping created_by', async () => {
    const w = await as('user-1', () => Widget.create({ name: 'A' }));
    await as('user-2', async () => {
      w.set('name', 'B');
      await w.save();
    });
    expect(w.get('updated_by')).toBe('user-2');
    expect(w.get('created_by')).toBe('user-1');

    /* A Query only runs when awaited, so it must be awaited INSIDE the context —
       exactly as a controller does within a request. */
    await as('user-3', async () => {
      await Widget.updateOne({ id: w.get('id') }, { $set: { name: 'C' } });
    });
    const reread = await Widget.findOne({ id: w.get('id') }).lean();
    expect(reread?.updated_by).toBe('user-3');
    expect(reread?.created_by).toBe('user-1');
  });

  it('refuses to rewrite id or created_by through an update', async () => {
    const w = await as('user-1', () => Widget.create({ name: 'A' }));
    const id = w.get('id');
    await Widget.updateOne({ id }, { $set: { id: 'hijack', created_by: 'mallory' } });
    const reread = await Widget.findOne({ id }).lean();
    expect(reread?.id).toBe(id);
    expect(reread?.created_by).toBe('user-1');
  });

  it('enforces a unique id', async () => {
    const w = await Widget.create({ name: 'A' });
    await expect(Widget.create({ name: 'B', id: w.get('id') })).rejects.toThrow(/duplicate key/);
  });

  it('serialises without _id or __v', async () => {
    const w = await Widget.create({ name: 'A' });
    const json = w.toJSON() as any;
    expect(json._id).toBeUndefined();
    expect(json.__v).toBeUndefined();
    expect(json.id).toBe(w.get('id'));
  });
});

describe('basePlugin — soft delete', () => {
  it('hides deleted rows from find, findOne, countDocuments and aggregate', async () => {
    const a = await Widget.create({ name: 'A' });
    await Widget.create({ name: 'B' });
    await softDelete(Widget, a.get('id'));

    expect(await Widget.countDocuments()).toBe(1);
    expect(await Widget.find()).toHaveLength(1);
    expect(await Widget.findOne({ id: a.get('id') })).toBeNull();
    expect(await Widget.aggregate([{ $match: {} }])).toHaveLength(1);
  });

  it('includes deleted rows when asked', async () => {
    const a = await Widget.create({ name: 'A' });
    await softDelete(Widget, a.get('id'));
    expect(await Widget.countDocuments({ ...INCLUDE_DELETED })).toBe(1);
    expect(await Widget.find({ is_deleted: true })).toHaveLength(1);
    expect(await Widget.aggregate([{ $match: { ...INCLUDE_DELETED } }])).toHaveLength(1);
  });

  it('sets deleted_at and keeps the row', async () => {
    const a = await Widget.create({ name: 'A' });
    const when = new Date('2026-01-01T00:00:00Z');
    await softDelete(Widget, a.get('id'), when);
    const raw = await Widget.collection.findOne({ id: a.get('id') });
    expect(raw?.is_deleted).toBe(true);
    expect(raw?.deleted_at?.toISOString()).toBe(when.toISOString());
  });

  it('restores, and restore / delete are idempotent', async () => {
    const a = await Widget.create({ name: 'A' });
    const id = a.get('id');
    await softDelete(Widget, id);
    await softDelete(Widget, id); // already deleted: no error
    await restore(Widget, id);
    await restore(Widget, id); // already live: no error
    const back = await Widget.findOne({ id });
    expect(back?.get('is_deleted')).toBe(false);
    expect(back?.get('deleted_at')).toBeNull();
  });

  it('404s for an unknown id', async () => {
    await expect(softDelete(Widget, 'missing')).rejects.toMatchObject({ statusCode: 404 });
    await expect(restore(Widget, 'missing')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('does not let an update touch a deleted row by default', async () => {
    const a = await Widget.create({ name: 'A' });
    await softDelete(Widget, a.get('id'));
    const result = await Widget.updateOne({ id: a.get('id') }, { $set: { name: 'Z' } });
    expect(result.matchedCount).toBe(0);
  });
});
