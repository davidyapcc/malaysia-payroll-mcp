import type { RateTableMeta } from "./loader.js";

// Row shapes of the generated tables. Every amount is in sen (MTD's B can be negative). A band covers wages above `above`
// and up to and including `upTo`; `upTo` is null only on a table's open-ended top band.

/** EPF Third Schedule parts that have a wage table. Part F has none (2% + 2% of wages). */
export type EpfPart = "A" | "C" | "E";

export interface EpfBand {
  readonly above: number;
  readonly upTo: number;
  readonly employer: number;
  readonly employee: number;
}

export interface EpfTable extends RateTableMeta {
  readonly kind: "epf";
  readonly parts: Readonly<Record<EpfPart, readonly EpfBand[]>>;
}

export interface SocsoBand {
  /** Row number in the PERKESO table, for citations. */
  readonly no: number;
  readonly above: number;
  readonly upTo: number | null;
  /** First category (employment injury and invalidity), employer share. */
  readonly cat1Employer: number;
  /** First category, employee share for invalidity. SKBBK is its own table. */
  readonly cat1EmployeeInvalidity: number;
  /** Second category (employment injury only), employer share. */
  readonly cat2Employer: number;
}

export interface SocsoTable extends RateTableMeta {
  readonly kind: "socso";
  readonly bands: readonly SocsoBand[];
}

/** SKBBK (Lindung 24 Jam): employee only, the same in both SOCSO categories. */
export interface SkbbkBand {
  /** Row number in the PERKESO Act 4 table, for citations. */
  readonly no: number;
  readonly above: number;
  readonly upTo: number | null;
  readonly employee: number;
}

export interface SkbbkTable extends RateTableMeta {
  readonly kind: "skbbk";
  readonly bands: readonly SkbbkBand[];
}

export interface EisBand {
  /** Row number in the PERKESO table, for citations. */
  readonly no: number;
  readonly above: number;
  readonly upTo: number | null;
  readonly employer: number;
  readonly employee: number;
}

export interface EisTable extends RateTableMeta {
  readonly kind: "eis";
  readonly bands: readonly EisBand[];
}

/**
 * One tax band of LHDN's MTD (PCB) schedule. Unlike the contribution tables, it bands chargeable
 * income P for the year, and is matched on P floored to whole ringgit (ADR 0002).
 */
export interface MtdBand {
  /** Row number in the schedule, for citations. */
  readonly no: number;
  readonly above: number;
  readonly upTo: number | null;
  /** M: the amount of P the band starts from. Always equal to `above`. */
  readonly m: number;
  /** R: the rate on P above M, in whole percent. */
  readonly ratePercent: number;
  /** B for categories 1 and 3: tax on M, less the RM400 individual rebate where it applies. */
  readonly bCat1And3: number;
  /** B for category 2: as for 1 and 3, less the RM400 spouse rebate too. */
  readonly bCat2: number;
}

export interface MtdTable extends RateTableMeta {
  readonly kind: "mtd";
  readonly bands: readonly MtdBand[];
}
