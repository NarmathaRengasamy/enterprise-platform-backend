import { ProductV2Model } from '../models/ProductV2.model.js';
import { ProductItemModel } from '../models/ProductItem.model.js';
import { INCLUDE_DELETED } from '../models/plugins/base.plugin.js';
import { productTypeService } from './productType.service.js';
import { catalogCategoryService, csvCell } from './catalogCategory.service.js';
import { MAX_LIMIT, productSearchService, SearchFilters } from './productSearch.service.js';
import { availabilityFor } from './availability.service.js';
import { pricePerUnit, resolvePrice } from './price.service.js';
import { limitsService } from './limits.service.js';
import { measureLabel } from '../utils/units.util.js';

/**
 * Products list → CSV (Oct 2026): what the list matches (search, category,
 * status, attribute filters, sort) across ALL pages, one row per variant.
 * Money as ₹ with 2 decimals (stored in paise). Tax columns are filled only
 * for products with tax. Cells are formula-safe (csvCell).
 */

const HEADER = [
  'Product',
  'Slug',
  'Brand',
  'Product status',
  'Primary category',
  'Categories',
  'SKU',
  'Variant',
  'Variant status',
  'Price (₹)',
  'MRP (₹)',
  'Price per unit',
  'Incl. GST',
  'GST %',
  'HSN / SAC',
  'Track inventory',
  'On hand',
  'Available',
  'Pack of',
  'Purchase limits',
];

const rupees = (minor: number | null | undefined) => (typeof minor === 'number' ? (minor / 100).toFixed(2) : '');
const MAX_PAGES = 500; // 50,000 products at 100 a page

export const productExportService = {
  async csv(filters: SearchFilters): Promise<string> {
    /* The list's own search, every page, in its order. */
    const ids: string[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await productSearchService.search({ ...filters, page, limit: MAX_LIMIT }, { viewer: false });
      ids.push(...res.items.map((i: any) => i.id));
      if (page >= res.pages) break;
    }
    if (!ids.length) return [HEADER].map((r) => r.map(csvCell).join(',')).join('\r\n');

    const products = await ProductV2Model.find({ id: { $in: ids }, ...INCLUDE_DELETED }).lean<any[]>();
    const byId = new Map(products.map((p) => [p.id, p]));
    const allItems = await ProductItemModel.find({ product_id: { $in: ids }, ...INCLUDE_DELETED }).sort({ sort_order: 1, created_at: 1 }).lean<any[]>();
    /* A deleted product brings the items deleted with it; a live one its live items. */
    const items = allItems.filter((i) => {
      const p = byId.get(i.product_id);
      return p && (p.is_deleted ? i.deleted_at?.getTime?.() === p.deleted_at?.getTime?.() : !i.is_deleted);
    });
    const availability = await availabilityFor(items.filter((i) => !i.is_deleted).map((i) => i.id));

    const type: any = await productTypeService.getActive();
    const fields = new Map<string, any>(((type?.fields ?? []) as any[]).map((f) => [f.key, f]));
    const categories = new Map<string, string>();
    const walk = (nodes: any[]) =>
      nodes.forEach((n) => {
        categories.set(n.id, n.name?.en ?? n.code);
        walk(n.children ?? []);
      });
    walk(await catalogCategoryService.tree(true));

    const valueText = (key: string, value: unknown, item: any) => {
      if (item.measure && typeof value === 'number') return measureLabel(item.measure);
      const f = fields.get(key);
      return f?.options?.find((o: any) => o.value === value)?.label?.en ?? String(value);
    };
    const itemsOf = new Map<string, any[]>();
    for (const i of items) itemsOf.set(i.product_id, [...(itemsOf.get(i.product_id) ?? []), i]);

    const lines: string[][] = [HEADER];
    for (const id of ids) {
      const p = byId.get(id);
      if (!p) continue;
      const list = itemsOf.get(id) ?? [];
      const hasTax = Boolean(p.hsn_code || p.sac_code || p.gst_rate !== null || list.some((i) => i.gst_rate !== null || i.hsn_code));
      const status = p.is_deleted ? 'deleted' : p.status;
      for (const i of list) {
        const base = i.pack_of ? list.find((x) => x.id === i.pack_of.base_item_id) : undefined;
        const variant = [
          ...(i.attributes ?? []).map((a: any) => valueText(a.key, a.value, i)),
          ...(i.pack_of ? [`Pack of ${i.pack_of.quantity}`] : []),
        ].join(' · ');
        const price = resolvePrice(i);
        const measure = i.pack_of && i.measure ? { ...i.measure, base_amount: i.measure.base_amount * i.pack_of.quantity } : i.measure;
        const ppu = pricePerUnit({ ...i, measure });
        const a = availability.get(i.id);
        const tracked = a?.status === 'tracked';
        lines.push([
          p.name?.en ?? '',
          p.slug,
          p.brand ?? '',
          status,
          p.primary_category_id ? categories.get(p.primary_category_id) ?? '' : '',
          (p.category_ids ?? []).map((c: string) => categories.get(c) ?? c).join('; '),
          i.sku,
          variant,
          i.is_deleted ? 'deleted' : i.status,
          rupees(price?.amount_minor),
          rupees(i.compare_at_minor),
          ppu ? `${rupees(ppu.amount_minor)} / ${ppu.per}` : '',
          hasTax && price ? (price.tax_inclusive ? 'Yes' : 'No') : '',
          hasTax ? String(i.gst_rate ?? p.gst_rate ?? '') : '',
          hasTax ? i.hsn_code ?? p.hsn_code ?? p.sac_code ?? '' : '',
          (i.pack_of ? base?.track_inventory ?? p.track_inventory : i.track_inventory ?? p.track_inventory) ? 'On' : 'Off',
          tracked && !(a as any).from ? String((a as any).on_hand) : tracked ? '' : 'Not tracked',
          tracked ? String((a as any).available) : 'Not tracked',
          i.pack_of ? `${i.pack_of.quantity} × ${base?.sku ?? ''}` : '',
          limitsService.summary(limitsService.effective(p.purchase_limits, i.purchase_limits)),
        ]);
      }
    }
    return lines.map((r) => r.map(csvCell).join(',')).join('\r\n');
  },
};
