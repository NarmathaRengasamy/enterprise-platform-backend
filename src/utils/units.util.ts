import { AppError } from '../middlewares/errorHandler.js';

/**
 * Measured sizes (design R45–R46): unit families and conversion to each
 * family's base unit, so 1 kg = 1000 g and 1 l = 1000 ml compare as equal.
 * Only the units listed here are accepted; anything else is refused (422).
 */

export const UNIT_FAMILIES = ['weight', 'volume', 'length', 'count'] as const;
export type UnitFamily = (typeof UNIT_FAMILIES)[number];

export const BASE_UNIT: Record<UnitFamily, string> = { weight: 'g', volume: 'ml', length: 'cm', count: 'piece' };

/** Each unit's family and how many base units one of it is. */
export const UNITS: Record<string, { family: UnitFamily; factor: number }> = {
  g: { family: 'weight', factor: 1 },
  kg: { family: 'weight', factor: 1000 },
  ml: { family: 'volume', factor: 1 },
  l: { family: 'volume', factor: 1000 },
  cm: { family: 'length', factor: 1 },
  m: { family: 'length', factor: 100 },
  piece: { family: 'count', factor: 1 },
};

export interface Measure {
  amount: number;
  unit: string;
  /** The amount in the family's base unit (g · ml · cm · piece). */
  base_amount: number;
}

const invalid = (message: string, path: string) => new AppError(message, 422, undefined, { [path]: message });

/* Floating point: 0.3 l is 300 ml, not 299.99999999999994. */
const tidy = (n: number) => Math.round(n * 1e6) / 1e6;

/** "L" → "l", " Kg " → "kg"; null when it is not a known unit. */
export const normaliseUnit = (unit: unknown): string | null => {
  if (typeof unit !== 'string') return null;
  const u = unit.trim().toLowerCase();
  return UNITS[u] ? u : null;
};

export const familyOf = (unit: unknown): UnitFamily | null => {
  const u = normaliseUnit(unit);
  return u ? UNITS[u].family : null;
};

export const unitsOf = (family: UnitFamily): string[] => Object.keys(UNITS).filter((u) => UNITS[u].family === family);

/**
 * An amount with a unit, checked against a family and turned into a measure.
 * Refuses (422) an unknown unit, a unit from another family, an amount that is
 * not positive, and a fractional count of pieces.
 */
export const toMeasure = (amount: unknown, unit: unknown, family: UnitFamily, path: string, name = 'This size'): Measure => {
  const u = normaliseUnit(unit);
  const allowed = unitsOf(family).join(', ');
  if (!u) throw invalid(`${name}: "${String(unit ?? '')}" is not a unit we know — use ${allowed}`, path);
  if (UNITS[u].family !== family) {
    throw invalid(`${name}: ${u} is a ${UNITS[u].family} unit, but this is measured by ${family} (${allowed})`, path);
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) throw invalid(`${name}: the amount must be a number above 0`, path);
  if (family === 'count' && !Number.isInteger(amount)) throw invalid(`${name}: a count of pieces must be a whole number`, path);
  return { amount, unit: u, base_amount: tidy(amount * UNITS[u].factor) };
};

/** "500 ml", "1 l", "1 piece", "6 pieces". */
export const measureLabel = (m: { amount: number; unit: string }): string =>
  m.unit === 'piece' ? `${m.amount} ${m.amount === 1 ? 'piece' : 'pieces'}` : `${m.amount} ${m.unit}`;

/** "500 ml" / "1.5 L" / "2kg" → { amount, unit }; null when it does not read as an amount with a unit. */
export const parseMeasureText = (text: string): { amount: number; unit: string } | null => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-zA-Z]+)\s*$/.exec(text);
  if (!m) return null;
  const unit = normaliseUnit(m[2]) ?? (/^pieces?$|^pcs?$/i.test(m[2]) ? 'piece' : null);
  return unit ? { amount: Number(m[1]), unit } : null;
};
