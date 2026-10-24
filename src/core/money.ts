// Country-neutral money helpers. Amounts are held as integer sen; RM appears only at the edges.
import { PayrollInputError } from "./errors.js";

/** Converts RM with at most 2 decimal places to integer sen. */
export function toSen(rm: number): number {
  const sen = Math.round(rm * 100);
  // Tolerance absorbs float noise such as 0.1 + 0.2, while 1.005 (100.4999... sen) is rejected.
  if (!Number.isFinite(rm) || rm < 0 || Math.abs(rm * 100 - sen) > 1e-6) {
    throw new PayrollInputError(
      `Amounts must be zero or more RM with at most 2 decimal places, got ${rm}.`,
    );
  }
  return sen;
}

export function toRm(sen: number): number {
  return sen / 100;
}

/** Formats sen as RM with thousands separators, for example RM2,980.01. */
export function formatRm(sen: number): string {
  const ringgit = Math.trunc(sen / 100).toLocaleString("en-US");
  const cents = String(sen % 100).padStart(2, "0");
  return `RM${ringgit}.${cents}`;
}

/**
 * Applies a rate in per mille (110 = 11%) to an amount in sen and rounds the result up to the
 * next whole ringgit, returning sen. Integer arithmetic, so no float drift.
 */
export function ceilPerMilleToRinggit(sen: number, perMille: number): number {
  return Math.ceil((sen * perMille) / 100_000) * 100;
}
