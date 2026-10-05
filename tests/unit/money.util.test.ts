import { describe, expect, it } from 'vitest';
import { assertMinor, fromMinor, toMinor } from '../../src/utils/money.util.js';

describe('money.util', () => {
  describe('toMinor (positive)', () => {
    it('converts whole rupees', () => expect(toMinor(1499)).toBe(149900));
    it('converts decimals', () => expect(toMinor(12.5)).toBe(1250));
    it('absorbs floating-point drift', () => expect(toMinor(0.1 + 0.2)).toBe(30));
    it('rounds a half paisa the way a person expects', () => expect(toMinor(1.005)).toBe(101));
    it('keeps very large amounts exact (₹99,99,99,999)', () => expect(toMinor(999999999)).toBe(99999999900));
  });

  describe('toMinor (edge / negative)', () => {
    it('zero is zero', () => expect(toMinor(0)).toBe(0));
    it('rejects NaN', () => expect(() => toMinor(Number.NaN)).toThrow(/finite/));
    it('rejects Infinity', () => expect(() => toMinor(Infinity)).toThrow(/finite/));
    it('rejects non-numbers', () => expect(() => toMinor('10' as unknown as number)).toThrow(/finite/));
  });

  describe('fromMinor', () => {
    it('round-trips', () => expect(fromMinor(toMinor(1499.99))).toBe(1499.99));
    it('rejects decimals', () => expect(() => fromMinor(1.5)).toThrow(/whole number/));
  });

  describe('assertMinor', () => {
    it('accepts integers ≥ 0', () => expect(() => assertMinor(0)).not.toThrow());
    it('rejects negative by default', () => expect(() => assertMinor(-1)).toThrow(/negative/));
    it('allows negative for deltas', () => expect(() => assertMinor(-1, true)).not.toThrow());
    it('rejects fractions', () => expect(() => assertMinor(1.5)).toThrow(/whole number/));
    it('rejects unsafe integers', () => expect(() => assertMinor(2 ** 60)).toThrow(/too large/));
    it('rejects strings', () => expect(() => assertMinor('100')).toThrow(/whole number/));
    it('fails with status 422', () => {
      try {
        assertMinor(-5);
      } catch (e: any) {
        expect(e.statusCode).toBe(422);
      }
    });
  });
});
