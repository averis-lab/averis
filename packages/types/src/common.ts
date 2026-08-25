import { z } from "zod";

/** A probability or normalized score in [0, 1]. */
export const UnitInterval = z.number().min(0).max(1);

/** ISO-8601 timestamp accepted as string or Date, normalized to Date. */
export const Timestamp = z.union([z.string(), z.date()]).transform((v) => new Date(v));

/** A lowercase domain tag such as "crypto", "defi", "security". */
export const DomainTag = z
  .string()
  .min(1)
  .max(64)
  .transform((s) => s.trim().toLowerCase());

export type Result<T, E = Error> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Page-based cursor matching the upstream data-network convention. */
export interface Page {
  page: number;
  limit: number;
}

export const DEFAULT_PAGE: Page = { page: 1, limit: 25 };
