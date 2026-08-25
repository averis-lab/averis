/**
 * Prisma returns DECIMAL columns as Decimal instances. The protocol works in
 * plain numbers for scoring and in strings for money, so these two helpers are
 * the only place the conversion happens.
 */
export function toNumber(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseFloat(value) || 0;
  if (typeof value === "object" && value !== null && "toString" in value) {
    return Number.parseFloat(String(value)) || 0;
  }
  return 0;
}

/** Money is passed to Prisma as a string to avoid float rounding. */
export function toDecimalInput(value: number): string {
  return value.toFixed(6);
}
