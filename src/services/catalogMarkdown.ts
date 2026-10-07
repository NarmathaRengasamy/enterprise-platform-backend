/**
 * Builds the knowledge-base document for the product catalogue (product module v2).
 *
 * The data is collected by kbCatalog.service (published products and their
 * active variants, visible categories); this file only turns it into markdown,
 * so it stays simple and testable.
 *
 * Built on the server, as one document:
 *
 *  - the catalogue is already here, so shipping it to the browser just to have
 *    it posted back as text is a round trip for nothing;
 *  - the browser only ever sees one page, so a large catalogue would silently
 *    become a partial document;
 *  - what is left out is policy, not formatting. Price, MRP, tax and stock are
 *    never written: a knowledge-base file is a snapshot the agent answers from,
 *    so anything that moves becomes a confident wrong answer. The agent reads
 *    those live through the MCP tools instead.
 */

/* Said in the document itself, so an agent retrieving it knows where prices live. */
const VOLATILE_NOTE =
  '> Prices, offers and availability are not recorded here, because they change. ' +
  'Check the live product (the catalogue tools) for the current price and stock.';

export type CatalogTemplate = 'qa' | 'reference';

export interface CatalogOptions {
  includeProducts?: boolean;
  includeCategories?: boolean;
  template?: CatalogTemplate;
}

export interface KbProduct {
  name: string;
  /** The name in the other languages, when different. */
  otherNames: string[];
  brand: string | null;
  description: string | null;
  /** Category paths, e.g. "Vehicles › SUV". */
  categories: string[];
  /** Product-level attributes with labels, e.g. { name: "Pieces per box", value: "42" }. */
  attributes: { name: string; value: string }[];
  /** Every option of the active variants, e.g. { "Tape Size": ["6inch(144mm)"], "Colour": ["Brown", …] }. */
  options: Record<string, string[]>;
  /** Active variants: "Petrol · Red" / "Pack of 4" and their SKU. */
  variants: { label: string; sku: string }[];
  /** For a bundle: "1 × Oil filter". */
  bundle: string[];
  fulfilment: string | null;
  image: string | null;
}

export interface KbCategory {
  path: string;
  description: string | null;
  /** Names of the published products listed directly in this category. */
  products: string[];
}

export interface CatalogInput {
  products: KbProduct[];
  categories: KbCategory[];
}

export interface CatalogDocument {
  name: string;
  content: string;
  productCount: number;
  categoryCount: number;
}

const FULFILMENT_TEXT: Record<string, string> = {
  service: 'It is a service.',
  rental: 'It is available for rent.',
  digital: 'It is delivered digitally.',
};

/* Collapses the blank-line runs the optional sections leave behind. */
const tidy = (lines: string[]): string =>
  lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();

/**
 * Pushes every heading in a section down `levels` places, so each product,
 * written as if it started at `#`, nests under the document's own headings
 * instead of reading as many separate documents.
 */
const demoteHeadings = (markdown: string, levels: number): string =>
  markdown.replace(/^(#{1,5}) /gm, (_match, hashes: string) => `${'#'.repeat(hashes.length + levels)} `);

/* A value inside a markdown table cell. */
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

const optionLines = (p: KbProduct) => Object.entries(p.options).map(([name, values]) => `- ${name}: ${values.join(', ')}`);
/* Plain ASCII separators: a non-ASCII dash or dot turns into "â€”" when an indexer guesses the wrong encoding. */
const variantLines = (p: KbProduct) => p.variants.map((v) => `- ${v.label} - SKU \`${v.sku}\``);
const listNames = (names: string[]) => names.join(', ');

/**
 * Overview: every product with its category, and for each option which
 * products have it ("Engine: Electric — Tata Nexon, Tata Tiago").
 *
 * Retrieval returns only a few chunks, so a question about the whole range
 * ("what SUVs / electric cars do you have?") must find its full answer in ONE
 * place — not spread across a dozen product sections.
 */
const overview = (products: KbProduct[], template: CatalogTemplate): string => {
  const index = new Map<string, Map<string, string[]>>();
  for (const p of products) {
    for (const [option, values] of Object.entries(p.options)) {
      const byValue = index.get(option) ?? new Map<string, string[]>();
      for (const v of values) byValue.set(v, [...(byValue.get(v) ?? []), p.name]);
      index.set(option, byValue);
    }
  }

  const lines: string[] = [];
  const all = products.map((p) => `- ${p.name}${p.categories.length ? ` (${p.categories.join('; ')})` : ''}`);
  if (template === 'qa') {
    lines.push(`# What products do you have?`, `${products.length} product(s) are available:`, ...all);
    for (const [option, byValue] of index) {
      lines.push('', `# Which products are available by ${option}?`);
      for (const [value, names] of byValue) lines.push(`- ${option} ${value}: ${listNames(names)}`);
    }
  } else {
    lines.push('# All products', '', ...all);
    for (const [option, byValue] of index) {
      lines.push('', `# By ${option}`, '', '| Option | Products |', '| --- | --- |');
      for (const [value, names] of byValue) lines.push(`| ${cell(value)} | ${cell(listNames(names))} |`);
    }
  }
  return tidy(lines);
};

/** Structured Q&A — phrased as questions, which is what a retrieval agent matches on. */
const productAsQA = (p: KbProduct): string => {
  const lines: string[] = [`# ${p.name}`, ''];
  if (p.description) lines.push(p.description, '');

  lines.push(`## Which category is ${p.name} in?`, p.categories.length ? p.categories.join('; ') + '.' : 'It is not in a category.');
  if (p.otherNames.length) lines.push('', `## Is ${p.name} known by another name?`, `It is also listed as ${p.otherNames.map((n) => `"${n}"`).join(', ')}.`);
  if (p.brand) lines.push('', `## Who makes ${p.name}?`, `${p.brand}.`);
  if (p.fulfilment && FULFILMENT_TEXT[p.fulfilment]) lines.push('', `## How is ${p.name} provided?`, FULFILMENT_TEXT[p.fulfilment]);

  const options = optionLines(p);
  if (options.length) lines.push('', `## What options does ${p.name} come in?`, ...options);
  if (p.attributes.length) lines.push('', `## What are the details of ${p.name}?`, ...p.attributes.map((a) => `- ${a.name}: ${a.value}`));
  if (p.bundle.length) lines.push('', `## What is included in ${p.name}?`, ...p.bundle.map((b) => `- ${b}`));

  lines.push('', `## Which variants of ${p.name} are available?`, ...variantLines(p));
  if (p.image) lines.push('', `## What does ${p.name} look like?`, `![${p.name}](${p.image})`);
  return tidy(lines);
};

/** Reference sheet — a fact table and a variant table. */
const productAsReference = (p: KbProduct): string => {
  const rows = [
    `| Category | ${cell(p.categories.join('; ') || '—')} |`,
    p.otherNames.length ? `| Also listed as | ${cell(p.otherNames.join(', '))} |` : '',
    p.brand ? `| Brand | ${cell(p.brand)} |` : '',
    p.fulfilment && FULFILMENT_TEXT[p.fulfilment] ? `| Provided as | ${cell(p.fulfilment)} |` : '',
    ...Object.entries(p.options).map(([name, values]) => `| ${cell(name)} | ${cell(values.join(', '))} |`),
    ...p.attributes.map((a) => `| ${cell(a.name)} | ${cell(a.value)} |`),
  ].filter(Boolean);

  const lines: string[] = [`# ${p.name}`, ''];
  if (p.description) lines.push(p.description, '');
  lines.push('| Field | Value |', '| --- | --- |', ...rows);
  if (p.bundle.length) lines.push('', '## Included', '', ...p.bundle.map((b) => `- ${b}`));
  lines.push('', '## Variants', '', '| Variant | SKU |', '| --- | --- |', ...p.variants.map((v) => `| ${cell(v.label)} | \`${cell(v.sku)}\` |`));
  if (p.image) lines.push('', '## Image', '', `![${p.name}](${p.image})`);
  return tidy(lines);
};

/* The category's own product names, so "what SUVs do you have?" is answered in one chunk. */
const categoryAsMarkdown = (c: KbCategory, template: CatalogTemplate): string => {
  const lines: string[] = [`# ${c.path}`, ''];
  if (c.description) lines.push(c.description, '');
  const names = c.products.length ? listNames(c.products) : 'none yet';
  if (template === 'qa') {
    lines.push(`## Which products are in the ${c.path} category?`, `${c.path} has ${c.products.length} product(s): ${names}.`);
  } else {
    lines.push('| Field | Value |', '| --- | --- |', `| Products (${c.products.length}) | ${cell(names)} |`);
  }
  return tidy(lines);
};

/**
 * One document covering the whole published catalogue.
 *
 * A file per product meant an upload per row, a row per product to scan in the
 * knowledge base, and a separate thing to delete whenever the catalogue moved.
 */
export const buildCatalogDocument = (input: CatalogInput, options: CatalogOptions = {}): CatalogDocument => {
  const includeProducts = options.includeProducts ?? true;
  const includeCategories = options.includeCategories ?? true;
  const template: CatalogTemplate = options.template ?? 'qa';

  const products = includeProducts ? input.products : [];
  const categories = includeCategories ? input.categories : [];

  /* Stated once, at the top — each section would otherwise repeat it. */
  const sections: string[] = ['# Product Catalog', '', VOLATILE_NOTE, ''];

  /* Whole-range answers first (overview, categories), then one section per product. */
  if (products.length) sections.push('## Overview', '', demoteHeadings(overview(products, template), 2), '');
  if (categories.length) {
    sections.push('## Categories', '');
    categories.forEach((c) => sections.push(demoteHeadings(categoryAsMarkdown(c, template), 2), ''));
  }
  if (products.length) {
    sections.push('## Products', '');
    products.forEach((p) => sections.push(demoteHeadings(template === 'qa' ? productAsQA(p) : productAsReference(p), 2), ''));
  }

  return {
    name: 'product-catalog.md',
    content: tidy(sections),
    productCount: products.length,
    categoryCount: categories.length,
  };
};
