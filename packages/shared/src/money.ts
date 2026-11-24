/**
 * Precision monetary utilities for USD (2 decimal places).
 * Converts Prisma Decimals, strings, or numbers safely via integer cents.
 */

export function toMoney(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 0;
    return Math.round(value * 100) / 100;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
  }
  if (typeof value === 'object' && value !== null && 'toString' in value) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0;
  }
  return 0;
}

export function toCents(value: unknown): number {
  return Math.round(toMoney(value) * 100);
}

export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function sumMoney(values: unknown[]): number {
  const totalCents = values.reduce<number>((acc, val) => acc + toCents(val), 0);
  return fromCents(totalCents);
}

export function subtractMoney(a: unknown, b: unknown): number {
  return fromCents(toCents(a) - toCents(b));
}

export function formatUsd(value: unknown): string {
  const amount = toMoney(value);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}
