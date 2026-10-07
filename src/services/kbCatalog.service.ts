import { ProductV2Model } from '../models/ProductV2.model.js';
import { ProductItemModel } from '../models/ProductItem.model.js';
import { CatalogCategoryModel } from '../models/CatalogCategory.model.js';
import { bundleService } from './bundle.service.js';
import { assetUrl, context, fieldName, optionsOf, pickLang, tr, valueText } from './aiCatalog.service.js';
import type { CatalogInput, KbCategory, KbProduct } from './catalogMarkdown.js';

/**
 * What goes into the knowledge-base catalogue document (product module v2).
 *
 *  - PUBLISHED products only (status active, not deleted), with their ACTIVE
 *    variants; a product with no active variant is skipped — nothing to sell.
 *  - VISIBLE categories only (a hidden category hides its sub-categories).
 *  - Names and labels come from the same helpers the MCP tools use, so the KB
 *    file and the agent's live answers say the same thing.
 *  - Never price, MRP, tax or stock: a KB file is a snapshot, and those change.
 *    Attributes that look like money or stock are left out for the same reason.
 */

const BATCH = 200;

/* Attribute names that would put prices, tax or stock into a snapshot. */
const looksVolatile = (text: string) => /\b(price|prices|mrp|cost|gst|tax|stock|margin|discount)\b/i.test(text.replace(/_/g, ' '));

/* Plain separators only, so the document reads the same whatever the indexer assumes. */
const asciiPath = (path: string) => path.replace(/ › /g, ' > ');
const absolute = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : null);

export interface CollectedCatalog extends CatalogInput {
  skipped: { drafts: number; archived: number; no_active_variants: number };
}

export const kbCatalogService = {
  async collect(language?: string): Promise<CollectedCatalog> {
    const ctx = await context(pickLang(language));
    const products: KbProduct[] = [];
    const perCategory = new Map<string, string[]>();
    let noActiveVariants = 0;

    for (let skip = 0; ; skip += BATCH) {
      const batch = await ProductV2Model.find({ status: 'active', is_deleted: false })
        .sort({ 'name.en': 1, id: 1 })
        .skip(skip)
        .limit(BATCH)
        .lean<any[]>();
      if (!batch.length) break;

      const items = await ProductItemModel.find({ product_id: { $in: batch.map((p) => p.id) }, status: 'active', is_deleted: false })
        .sort({ sort_order: 1, created_at: 1 })
        .lean<any[]>();

      for (const p of batch) {
        const own = items.filter((i) => i.product_id === p.id);
        if (!own.length) {
          noActiveVariants++;
          continue;
        }
        const axisKeys = new Set((p.variant_axes ?? []).map((a: any) => a.key));
        const attributes = (p.attributes ?? [])
          .filter((a: any) => {
            const f = ctx.fields.get(a.key);
            if (!f || f.deprecated || axisKeys.has(a.key)) return false;
            if (a.value === null || a.value === undefined || a.value === '') return false;
            return !looksVolatile(a.key) && !looksVolatile(f.label?.en ?? '');
          })
          .map((a: any) => ({ name: fieldName(ctx, ctx.fields.get(a.key)), value: valueText(ctx, a.key, a.value) }));

        const variants = own.map((i) => ({
          label:
            [...(i.attributes ?? []).map((a: any) => valueText(ctx, a.key, a.value, i)), ...(i.pack_of ? [`Pack of ${i.pack_of.quantity}`] : [])]
              .filter(Boolean)
              .join(' / ') || 'Standard',
          sku: i.sku,
        }));

        let bundle: string[] = [];
        if (p.is_bundle) {
          for (const i of own) {
            const list = await bundleService.list(i.id).catch(() => null);
            bundle.push(...(list?.components ?? []).map((c: any) => `${c.quantity} x ${c.product_name ?? c.sku}`));
          }
          bundle = [...new Set(bundle)];
        }

        const visibleCategories = (p.category_ids ?? []).filter((id: string) => ctx.paths.has(id));
        const productName = tr(p.name, ctx.lang);
        visibleCategories.forEach((id: string) => perCategory.set(id, [...(perCategory.get(id) ?? []), productName]));

        products.push({
          name: productName,
          otherNames: [p.name?.en, p.name?.ta, p.name?.hi].filter((n: string | undefined) => n && n !== tr(p.name, ctx.lang)),
          brand: p.brand || null,
          description: tr(p.description, ctx.lang) || null,
          categories: visibleCategories.map((id: string) => asciiPath(ctx.paths.get(id)!)),
          attributes,
          options: Object.fromEntries(Object.entries(optionsOf(ctx, p, own)).filter(([name]) => !looksVolatile(name))),
          variants,
          bundle,
          fulfilment: p.fulfilment ?? null,
          /* Only a full link is useful to an agent or a customer: "/uploads/…" is left
             out until images live on S3 (or PUBLIC_ASSET_BASE_URL is set). */
          image: absolute(assetUrl(p.media?.[0]?.url ?? own.find((i) => i.media?.length)?.media?.[0]?.url)),
        });
      }
      if (batch.length < BATCH) break;
    }

    const rows = await CatalogCategoryModel.find({ id: { $in: [...ctx.paths.keys()] } }).lean<any[]>();
    const categories: KbCategory[] = [...ctx.paths.entries()].map(([id, path]) => ({
      path: asciiPath(path),
      description: tr(rows.find((r) => r.id === id)?.description, ctx.lang) || null,
      products: perCategory.get(id) ?? [],
    }));

    const [drafts, archived] = await Promise.all([
      ProductV2Model.countDocuments({ status: 'draft', is_deleted: false }),
      ProductV2Model.countDocuments({ status: 'archived', is_deleted: false }),
    ]);
    return { products, categories, skipped: { drafts, archived, no_active_variants: noActiveVariants } };
  },
};
