// Country-neutral: picks a rate table by effective date. Keep Malaysia-specific logic out of
// this file so it can move into a shared package if a second country server happens.

/** Where a rate table was transcribed from. */
export interface TableSource {
  readonly title: string;
  readonly url: string;
  /** YYYY-MM-DD */
  readonly retrieved: string;
}

/** What every generated rate table carries, whatever its rows look like. */
export interface RateTableMeta {
  readonly kind: string;
  /** The first day the table applies to, YYYY-MM-DD. Always the 1st of a month. */
  readonly effectiveFrom: string;
  /** The CSV under docs/data/ the table was generated from. */
  readonly csv: string;
  readonly source: TableSource;
}

const PAY_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

/** No table of this kind was in effect yet for the pay period. */
export class NoTableInEffectError extends Error {
  override readonly name = "NoTableInEffectError";

  constructor(
    readonly kind: string,
    readonly payPeriod: string,
    readonly earliest: string | undefined,
  ) {
    super(
      earliest === undefined
        ? `No ${kind} rate table exists.`
        : `No ${kind} rate table is in effect for pay period ${payPeriod}; the earliest starts ${earliest}.`,
    );
  }
}

/**
 * Returns the newest table in effect for a pay period (YYYY-MM). A table applies from the month
 * of its effective date onwards, until a newer table of the same kind takes over.
 */
export function selectTable<T extends RateTableMeta>(
  kind: string,
  tables: readonly T[],
  payPeriod: string,
): T {
  if (!PAY_PERIOD.test(payPeriod)) {
    throw new RangeError(`Pay period must be YYYY-MM, got "${payPeriod}".`);
  }
  let selected: T | undefined;
  let earliest: string | undefined;
  for (const table of tables) {
    if (earliest === undefined || table.effectiveFrom < earliest) earliest = table.effectiveFrom;
    if (table.effectiveFrom.slice(0, 7) > payPeriod) continue;
    if (selected === undefined || table.effectiveFrom > selected.effectiveFrom) selected = table;
  }
  if (selected === undefined) throw new NoTableInEffectError(kind, payPeriod, earliest);
  return selected;
}
