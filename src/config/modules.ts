/**
 * The modules a workspace can rename.
 *
 * The key is the identity and never changes — it is what the code, the routes
 * and the stored settings all use. Only the words shown to a person are
 * configurable, which is what keeps a rename from being able to break a link,
 * an integration or a query.
 *
 * `plural` names the section (the menu item, the page heading). `singular`
 * names one of the things in it ("New conversation"). Both are needed because
 * no reliable rule turns one into the other — "Enquiries" would become
 * "Enquirie".
 */
export interface ModuleLabel {
  plural: string;
  singular: string;
}

export const MODULE_KEYS = [
  'dashboard',
  'conversations',
  'products',
  /* The two entries under Products. They are separate keys rather than
     something derived from `products`, because a shop that renames Products
     to "Catalogue" does not necessarily want "All Catalogue" — the wording of
     a sub-item is its own decision. */
  'allProducts',
  'categories',
  'schedule',
  'teams',
  'knowledgeBase',
  'developer',
] as const;

export type ModuleKey = (typeof MODULE_KEYS)[number];

export const DEFAULT_LABELS: Record<ModuleKey, ModuleLabel> = {
  dashboard: { plural: 'Dashboard', singular: 'Dashboard' },
  conversations: { plural: 'Conversations', singular: 'Conversation' },
  products: { plural: 'Products', singular: 'Product' },
  allProducts: { plural: 'All Products', singular: 'Product' },
  categories: { plural: 'Categories', singular: 'Category' },
  schedule: { plural: 'Schedule', singular: 'Appointment' },
  teams: { plural: 'Teams', singular: 'Member' },
  knowledgeBase: { plural: 'Knowledge Base', singular: 'Article' },
  developer: { plural: 'Developer', singular: 'Endpoint' },
};

export const isModuleKey = (value: string): value is ModuleKey =>
  (MODULE_KEYS as readonly string[]).includes(value);
