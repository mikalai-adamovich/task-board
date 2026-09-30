import { numberAttribute } from '@angular/core';

/**
 * Strict numeric query-param transform — `numberAttribute` yields
 * `NaN` for empty/garbage values which previously leaked into the URL as
 * `?limit=NaN`. Non-finite or non-positive values fall back to 0 so callers
 * apply their own defaults.
 *
 * Shared so URL-bound `input({ transform })` params use one implementation
 * instead of per-component copies.
 */
export function safeNumericParam(value: unknown): number {
  const n = numberAttribute(value);

  return Number.isFinite(n) && n > 0 ? n : 0;
}
