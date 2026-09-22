import { Product, Category } from '../types/index.js';

/**
 * Builds the knowledge-base document for the product catalogue.
 *
 * This runs on the server, not in the browser, for three reasons that matter:
 *
 *  - the catalogue is already here, so shipping every product to the client
 *    just to have it post text back is a round trip for nothing;
 *  - the client could only ever see one page of products, so a catalogue larger
 *    than its page size silently produced a partial document;
 *  - what is left out is a policy decision, not a formatting one. Price, stock
 *    and margin are excluded here, where a caller cannot opt back in.
 */

/**
 * Fields deliberately kept out of the document.
 *
 * A knowledge-base file is a snapshot Perfox indexes and an agent then answers
 * from, so anything that moves on its own becomes a confident wrong answer the
 * moment it changes. Price and stock change constantly; `margin` and
 * `originalPrice` are internal money that should never reach a customer at all.
 */
export const EXCLUDED_FIELDS = [
  'price',
  'originalPrice',
  'discount',
  'margin',
  'stock',
  'stockStatus',
  'committed',
  'reorderPoint',
] as const;

/* Said in the document itself, so an agent retrieving it is told not to answer
   pricing or availability from this text. */
const VOLATILE_NOTE =
  '> Pricing and availability are not recorded here, because they change. ' +
  'Check the live product record for current price and stock.';

export type CatalogTemplate = 'qa' | 'reference';

export interface CatalogOptions {
  includeProducts?: boolean;
  includeCategories?: boolean;
  template?: CatalogTemplate;
}

/* Collapses the blank-line runs the optional sections leave behind. */
const tidy = (lines: string[]): string =>
  lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

/**
 * Pushes every heading in a section down `levels` places.
 *
 * Each section is written as if it were a standalone document starting at `#`.
 * Nested unchanged they would produce many `#` titles in one file, which reads
 * as many documents to anything chunking it.
 */
const demoteHeadings = (markdown: string, levels: number): string =>
  markdown.replace(/^(#{1,5}) /gm, (_match, hashes: string) => `${'#'.repeat(hashes.length + levels)} `);

const imageLines = (p: any): string[] => {
  const lines: string[] = [];
  if (p.image) lines.push(`![${p.name}](${p.image})`);

  const gallery = Array.isArray(p.gallery) ? p.gallery : Array.isArray(p.images) ? p.images : [];
  gallery.forEach((img: any) => {
    const src = typeof img === 'string' ? img : img?.src;
    if (!src || src === p.image) return;
    const label = typeof img === 'string' ? p.name : img?.label ?? p.name;
    lines.push(`![${label}](${src})`);
  });
  return lines;
};

const videoLines = (p: any): string[] =>
  (Array.isArray(p.videos) ? p.videos : []).map(
    (v: any) => `- ${v?.title ?? 'Video'}${v?.duration ? ` (${v.duration})` : ''}`
  );

/* Variants without their price, stock or status — the choices that exist, which
   is the durable part. */
const variantLines = (p: any): string[] =>
  (Array.isArray(p.variants) ? p.variants : []).map((v: any) => {
    const label = [v?.option, v?.value].filter(Boolean).join(': ');
    return `- ${label || 'Variant'}`;
  });

/** Structured Q&A — phrased as questions, which is what a retrieval agent matches on. */
const productAsQA = (p: any): string => {
  const lines: string[] = [`# ${p.name}`, ''];
  if (p.description) lines.push(p.description, '');

  lines.push(`## What is the SKU for ${p.name}?`, `The SKU is \`${p.sku || 'not set'}\`.`);
  lines.push(
    '',
    `## What category does ${p.name} belong to?`,
    `${p.category || 'Uncategorised'}${p.categoryCode ? ` (${p.categoryCode})` : ''}.`
  );

  if (p.shortName && p.shortName !== p.name) {
    lines.push('', `## Is ${p.name} known by another name?`, `It is also listed as "${p.shortName}".`);
  }
  if (p.brand) lines.push('', `## Who makes ${p.name}?`, `${p.brand}.`);
  if (Array.isArray(p.tags) && p.tags.length) {
    lines.push('', `## What is ${p.name} related to?`, ...p.tags.map((tag: string) => `- ${tag}`));
  }

  const variants = variantLines(p);
  if (variants.length) lines.push('', `## What variants of ${p.name} are available?`, ...variants);

  const images = imageLines(p);
  if (images.length) lines.push('', `## What does ${p.name} look like?`, ...images);

  const videos = videoLines(p);
  if (videos.length) lines.push('', `## Are there videos of ${p.name}?`, ...videos);

  return tidy(lines);
};

/** Reference sheet — a flat fact table rather than questions. */
const productAsReference = (p: any): string => {
  const rows = [
    `| SKU | ${p.sku || '—'} |`,
    `| Category | ${p.category || '—'}${p.categoryCode ? ` (${p.categoryCode})` : ''} |`,
    p.shortName && p.shortName !== p.name ? `| Also listed as | ${p.shortName} |` : '',
    p.brand ? `| Brand | ${p.brand} |` : '',
    Array.isArray(p.tags) && p.tags.length ? `| Tags | ${p.tags.join(', ')} |` : '',
  ].filter(Boolean);

  const lines: string[] = [`# ${p.name}`, ''];
  if (p.description) lines.push(p.description, '');
  lines.push('| Field | Value |', '| --- | --- |', ...rows);

  const variants = variantLines(p);
  if (variants.length) lines.push('', '## Variants', '', ...variants);

  const images = imageLines(p);
  if (images.length) lines.push('', '## Images', '', ...images);

  const videos = videoLines(p);
  if (videos.length) lines.push('', '## Videos', '', ...videos);

  return tidy(lines);
};

const categoryAsMarkdown = (c: any, template: CatalogTemplate): string => {
  const count = c.productsCount ?? 0;
  const lines: string[] = [`# ${c.name}`, ''];
  if (c.description) lines.push(c.description, '');

  if (template === 'qa') {
    lines.push(
      `## What is in the ${c.name} category?`,
      `${count} product(s) are listed under ${c.name}.`,
      '',
      `## How is ${c.name} identified?`,
      `Category code \`${c.id}\`.`
    );
  } else {
    lines.push('| Field | Value |', '| --- | --- |', `| Code | ${c.id} |`, `| Products | ${count} |`);
  }
  return tidy(lines);
};

export interface CatalogDocument {
  name: string;
  content: string;
  productCount: number;
  categoryCount: number;
}

/**
 * One document covering the whole catalogue.
 *
 * A file per product meant an upload per row, a row per product to scan in the
 * knowledge base, and a separate thing to delete whenever the catalogue moved.
 */
export const buildCatalogDocument = (
  products: Product[],
  categories: Category[],
  options: CatalogOptions = {}
): CatalogDocument => {
  const includeProducts = options.includeProducts ?? true;
  const includeCategories = options.includeCategories ?? true;
  const template: CatalogTemplate = options.template ?? 'qa';

  const usedProducts = includeProducts ? products : [];
  const usedCategories = includeCategories ? categories : [];

  /* Stated once, at the top — each section would otherwise repeat it. */
  const sections: string[] = ['# Product Catalog', '', VOLATILE_NOTE, ''];

  if (usedProducts.length) {
    sections.push('## Products', '');
    usedProducts.forEach((p) => {
      const markdown = template === 'qa' ? productAsQA(p) : productAsReference(p);
      sections.push(demoteHeadings(markdown, 2), '');
    });
  }

  if (usedCategories.length) {
    sections.push('## Categories', '');
    usedCategories.forEach((c) => {
      sections.push(demoteHeadings(categoryAsMarkdown(c, template), 2), '');
    });
  }

  return {
    name: 'product-catalog.md',
    content: tidy(sections),
    productCount: usedProducts.length,
    categoryCount: usedCategories.length,
  };
};
