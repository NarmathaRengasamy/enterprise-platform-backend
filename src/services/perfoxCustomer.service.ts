import { perfoxFetch } from '../utils/perfox.util.js';

/**
 * Customer lookups against the Perfox platform.
 *
 * A conversation carries only a `customer_id`, so without this every thread
 * reads as "Customer #26814B92560B".
 *
 * Two endpoints, used differently on purpose:
 *
 *  - `GET /customers` returns only the **identified** customers — 15 of the 101
 *    who appear in the conversation list. It takes no pagination parameters, so
 *    it is fetched once and cached, and used to name rows in the list.
 *  - `GET /customers/{id}` resolves anyone, including the ~90 anonymous
 *    ephemeral visitors. Called only for the thread being opened: doing it per
 *    row would be 170 requests and the API rate-limits well below that.
 */

export interface PerfoxCustomer {
  id: string;
  name: string;
  email: string;
  phone: string;
  tags: string[];
  preferredLanguage: string;
  /** True for a visitor who never identified themselves. */
  anonymous: boolean;
  createdAt: string;
  updatedAt: string;
}

const CACHE_TTL_MS = 60_000;

let cachedById: Map<string, PerfoxCustomer> | null = null;
let cachedAt = 0;

/* A single customer is cached too — opening the same thread repeatedly should
   not re-ask, and the record barely changes. */
const singles = new Map<string, { customer: PerfoxCustomer; at: number }>();

const toCustomer = (raw: any): PerfoxCustomer => {
  const tags: string[] = Array.isArray(raw?.tags) ? raw.tags.map(String) : [];
  return {
    id: String(raw?.id ?? ''),
    name: String(raw?.name ?? ''),
    email: String(raw?.email ?? ''),
    phone: String(raw?.phone ?? ''),
    tags,
    preferredLanguage: String(raw?.preferred_language ?? ''),
    /* Perfox marks these with a tag rather than a flag, and also names them
       literally "Anonymous" — either is enough to know not to show it as a
       person's name. */
    anonymous: tags.includes('anonymous') || String(raw?.name ?? '').toLowerCase() === 'anonymous',
    createdAt: String(raw?.created_at ?? ''),
    updatedAt: String(raw?.updated_at ?? ''),
  };
};

/** The identified customers, keyed by id. Cached — the endpoint has no filter. */
export const fetchCustomerIndex = async (): Promise<Map<string, PerfoxCustomer>> => {
  const now = Date.now();
  if (cachedById && now - cachedAt < CACHE_TTL_MS) return cachedById;

  const payload = await perfoxFetch<{ data?: any[] }>('/customers');
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  const index = new Map<string, PerfoxCustomer>();
  rows.map(toCustomer).forEach((customer) => {
    if (customer.id) index.set(customer.id, customer);
  });

  cachedById = index;
  cachedAt = now;
  return index;
};

/** One customer, including anonymous ones the list does not return. */
export const fetchCustomerById = async (id: string): Promise<PerfoxCustomer | undefined> => {
  if (!id) return undefined;

  const hit = singles.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.customer;

  try {
    const payload = await perfoxFetch<any>(`/customers/${encodeURIComponent(id)}`);
    const customer = toCustomer(payload?.data ?? payload);
    if (!customer.id) return undefined;

    singles.set(id, { customer, at: Date.now() });
    return customer;
  } catch {
    /* A thread whose customer cannot be read is still a thread worth showing. */
    return undefined;
  }
};

/**
 * What to call this customer in the UI.
 *
 * Falls back to a short form of the id rather than an empty string, so a row
 * always has something to identify it by.
 */
export const displayName = (customer: PerfoxCustomer | undefined, customerId?: string): string => {
  if (customer && customer.name && !customer.anonymous) return customer.name;
  if (customer?.anonymous) return 'Anonymous visitor';
  if (customerId) return `Customer #${customerId.slice(-12).toUpperCase()}`;
  return 'Unknown customer';
};
