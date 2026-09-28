import { Router } from 'express';
import { deleteMedia, upload, uploadMedia } from './controllers/media.controller.js';
import { requireRoles } from '../middlewares/auth.js';
import { validateRequest } from '../middlewares/validate.js';
import {
  addField,
  addFieldSchema,
  createType,
  createTypeSchema,
  deleteType,
  deprecateField,
  getType,
  getVocabulary,
  listTypes,
  restoreType,
  updateField,
  updateFieldSchema,
  updateType,
  updateTypeSchema,
} from './controllers/type.controller.js';
import {
  createCategory,
  createCategorySchema,
  deleteCategory,
  getCategory,
  listCategories,
  restoreCategory,
  updateCategory,
  updateCategorySchema,
} from './controllers/category.controller.js';
import {
  addItem,
  createProduct,
  createProductSchema,
  deleteItem,
  deleteProduct,
  getProduct,
  itemSchema,
  listItems,
  listProducts,
  matrixSchema,
  previewMatrix,
  restoreProduct,
  searchProducts,
  searchSchema,
  updateItem,
  updateProduct,
  updateProductSchema,
} from './controllers/product.controller.js';
import {
  createCharge,
  createChargeSchema,
  createPrice,
  createPriceSchema,
  deleteCharge,
  deletePrice,
  listCharges,
  listPrices,
  restoreCharge,
  restorePrice,
  resolveItemCharges,
  updateCharge,
  updateChargeSchema,
  updatePrice,
  updatePriceSchema,
} from './controllers/commerce.controller.js';
import {
  adjustStock,
  adjustStockSchema,
  cancelBooking,
  createBooking,
  createBookingSchema,
  deleteBooking,
  deleteAvailability,
  getItemAvailability,
  getSlots,
  listAvailability,
  listBookings,
  restoreAvailability,
  restoreBooking,
  upsertAvailability,
  updateBooking,
  updateBookingSchema,
  upsertAvailabilitySchema,
} from './controllers/availability.controller.js';

/**
 * CATALOGUE V2 routes, mounted at /api/v1/v2.
 *
 * Behind the same JWT guard as every other authenticated module. The public
 * storefront surface stays where it is, on /public, and reads these collections
 * through the same query service.
 */
const router = Router();

/* Every DELETE below is a SOFT delete: the row is flagged `is_deleted` and
   keeps its UUID, so anything already pointing at it still resolves. Each one
   has a matching restore, because a delete you cannot undo is just a slow hard
   delete. List endpoints take `?includeDeleted=true` to see the tombstones. */

const editor = requireRoles('Admin', 'Editor');
const admin = requireRoles('Admin');

/* ---------------------------------------------------------------- media */

/* Uploading is separate from attaching: the product form gathers files,
   orders them and picks a thumbnail before anything is saved. */
router.post('/media', editor, upload.array('files', 10), uploadMedia);
router.delete('/media/:filename', editor, deleteMedia);

/* ---------------------------------------------------------------- types */

router.get('/types', listTypes);
router.get('/types/:id', getType);
router.get('/types/:id/vocabulary', getVocabulary);
router.post('/types', editor, validateRequest(createTypeSchema), createType);
router.patch('/types/:id', editor, validateRequest(updateTypeSchema), updateType);
router.delete('/types/:id', admin, deleteType);
router.post('/types/:id/restore', admin, restoreType);

router.post('/types/:id/fields', editor, validateRequest(addFieldSchema), addField);
router.patch('/types/:id/fields/:key', editor, validateRequest(updateFieldSchema), updateField);
/* DELETE deprecates rather than destroys — see the controller for why. */
router.delete('/types/:id/fields/:key', editor, deprecateField);

/* ----------------------------------------------------------- categories */

router.get('/categories', listCategories);
router.get('/categories/:id', getCategory);
router.post('/categories', editor, validateRequest(createCategorySchema), createCategory);
router.patch('/categories/:id', editor, validateRequest(updateCategorySchema), updateCategory);
router.delete('/categories/:id', admin, deleteCategory);
router.post('/categories/:id/restore', admin, restoreCategory);

/* ------------------------------------------------------------- products */

/* Declared before /products/:id, or "search" and "matrix" are read as ids. */
router.post('/products/search', validateRequest(searchSchema), searchProducts);
router.post('/products/matrix', editor, validateRequest(matrixSchema), previewMatrix);

router.get('/products', listProducts);
router.get('/products/:id', getProduct);
router.post('/products', editor, validateRequest(createProductSchema), createProduct);
router.patch('/products/:id', editor, validateRequest(updateProductSchema), updateProduct);
router.delete('/products/:id', admin, deleteProduct);
router.post('/products/:id/restore', admin, restoreProduct);

router.get('/products/:id/items', listItems);
router.post('/products/:id/items', editor, validateRequest(itemSchema), addItem);
router.patch('/products/:id/items/:itemId', editor, updateItem);
router.delete('/products/:id/items/:itemId', editor, deleteItem);

/* --------------------------------------------------------------- prices */

router.get('/prices', listPrices);
router.post('/prices', editor, validateRequest(createPriceSchema), createPrice);
router.patch('/prices/:id', editor, validateRequest(updatePriceSchema), updatePrice);
router.delete('/prices/:id', editor, deletePrice);
router.post('/prices/:id/restore', editor, restorePrice);

/* -------------------------------------------------------------- charges */

router.get('/charges', listCharges);
router.post('/charges', editor, validateRequest(createChargeSchema), createCharge);
router.patch('/charges/:id', editor, validateRequest(updateChargeSchema), updateCharge);
router.delete('/charges/:id', editor, deleteCharge);
router.post('/charges/:id/restore', editor, restoreCharge);

/* ---------------------------------------------------------------- items */

router.get('/items/:itemId/charges', resolveItemCharges);
router.get('/items/:itemId/availability', getItemAvailability);
router.get('/items/:itemId/slots', getSlots);

/* --------------------------------------------------------- availability */

router.get('/availability', listAvailability);
router.post('/availability', editor, validateRequest(upsertAvailabilitySchema), upsertAvailability);
router.post('/availability/adjust', editor, validateRequest(adjustStockSchema), adjustStock);
router.delete('/availability/:id', editor, deleteAvailability);
router.post('/availability/:id/restore', editor, restoreAvailability);

/* ------------------------------------------------------------- bookings */

router.get('/bookings', listBookings);
router.post('/bookings', validateRequest(createBookingSchema), createBooking);
router.post('/bookings/:id/cancel', cancelBooking);
router.patch('/bookings/:id', validateRequest(updateBookingSchema), updateBooking);
/* Delete is not the same as cancel: cancel keeps the record visible as a
   called-off booking, delete hides a mistake. Both free the slot. */
router.delete('/bookings/:id', editor, deleteBooking);
router.post('/bookings/:id/restore', editor, restoreBooking);

export default router;
