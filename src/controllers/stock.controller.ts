import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { stockService } from '../services/stock.service.js';
import { unitService } from '../services/unit.service.js';
import { bundleService } from '../services/bundle.service.js';
import { UNIT_STATUSES } from '../models/ItemUnit.model.js';
import { ok } from '../utils/response.util.js';
import { toAppError } from '../utils/error.util.js';
import { createLogger } from '../utils/logger.js';

const log = createLogger('StockController');

/**
 * Phase 4 — stock, serial / batch units and bundle components (design §3.5,
 * §7.7; plan 4.3), at /api/v2 beside /api/v2/products:
 *
 *   GET    /items/:id/stock                  any signed-in user
 *   POST   /items/:id/stock/adjust           Admin, Editor
 *   PATCH  /items/:id/stock/reorder-point    Admin, Editor
 *   GET    /items/:id/stock/movements        Admin, Editor
 *   GET    /items/:id/units                  Admin, Editor
 *   POST   /items/:id/units                  Admin, Editor
 *   PATCH  /units/:id                        Admin, Editor
 *   DELETE /units/:id                        Admin, Editor (soft)
 *   GET    /items/:id/bundle-components      Admin, Editor
 *   PUT    /items/:id/bundle-components      Admin, Editor (replaces the list atomically)
 */

const location = z.string().trim().min(1).max(60).optional();

export const adjustSchema = z.object({
  body: z.object({
    delta: z
      .number()
      .int('The change must be a whole number')
      .refine((n) => n !== 0, 'The change cannot be 0')
      .refine((n) => Math.abs(n) <= 1_000_000, 'At most 1,000,000 at a time'),
    reason: z.string().trim().min(1, 'A reason is required').max(200),
    location_id: location,
  }),
});

export const reorderPointSchema = z.object({
  body: z.object({
    reorder_point: z.number().int('A whole number').min(0).max(1_000_000),
    location_id: location,
  }),
});

export const movementsSchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
});

const unit = z.object({
  serial_no: z.string().trim().max(100).nullable().optional(),
  batch_no: z.string().trim().max(100).nullable().optional(),
  location_id: location,
});

export const addUnitsSchema = z.object({
  body: unit.extend({ units: z.array(unit).min(1).max(500).optional() }),
});

export const updateUnitSchema = z.object({
  body: z.object({
    status: z.enum(UNIT_STATUSES).optional(),
    batch_no: z.string().trim().max(100).nullable().optional(),
    location_id: location,
    serial_no: z.undefined({ invalid_type_error: 'A serial number cannot change — remove the unit and add it again' }).optional(),
  }),
});

export const listUnitsSchema = z.object({
  query: z.object({ search: z.string().trim().max(100).optional(), status: z.enum(UNIT_STATUSES).optional() }),
});

export const bundleSchema = z.object({
  body: z.object({
    components: z
      .array(
        z.object({
          component_item_id: z.string().trim().min(1),
          /* A number here; whole and ≥ 1 is a business rule (422 from the service). */
          quantity: z.number(),
        })
      )
      .max(50),
  }),
});

const handle =
  (message: string, fn: (req: Request, res: Response) => Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await fn(req, res);
    } catch (error) {
      next(toAppError(error, message, log));
    }
  };

export const getStock = handle('Could not load the stock', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(ok(await stockService.get(req.params.id)));
});

export const adjustStock = handle('Could not adjust the stock', async (req, res) => {
  res.json(ok(await stockService.adjust(req.params.id, req.body), 'Stock adjusted'));
});

export const setReorderPoint = handle('Could not set the reorder point', async (req, res) => {
  res.json(ok(await stockService.setReorderPoint(req.params.id, req.body), 'Reorder point saved'));
});

export const listMovements = handle('Could not load the stock history', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(ok(await stockService.movements(req.params.id, req.query as any)));
});

export const listUnits = handle('Could not load the units', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(ok(await unitService.list(req.params.id, req.query as any)));
});

export const addUnits = handle('Could not add the units', async (req, res) => {
  res.status(201).json(ok(await unitService.add(req.params.id, req.body), 'Units added'));
});

export const updateUnit = handle('Could not update the unit', async (req, res) => {
  res.json(ok(await unitService.update(req.params.id, req.body), 'Unit updated'));
});

export const deleteUnit = handle('Could not remove the unit', async (req, res) => {
  res.json(ok(await unitService.remove(req.params.id), 'Unit removed'));
});

export const getBundle = handle('Could not load the bundle', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(ok(await bundleService.list(req.params.id)));
});

export const replaceBundle = handle('Could not save the bundle', async (req, res) => {
  res.json(ok(await bundleService.replace(req.params.id, req.body.components), 'Bundle saved'));
});
