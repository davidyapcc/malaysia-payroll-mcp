import type { RateTableMeta } from "./loader.js";

// Row shapes of the generated tables. Every amount is in sen. A band covers wages above `above`
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
  /** First category, employee share for invalidity. Excludes SKBBK. */
  readonly cat1EmployeeInvalidity: number;
  /** SKBBK (Lindung 24 Jam), employee only, the same in both categories. */
  readonly skbbkEmployee: number;
  /** Second category (employment injury only), employer share. */
  readonly cat2Employer: number;
}

export interface SocsoTable extends RateTableMeta {
  readonly kind: "socso";
  readonly bands: readonly SocsoBand[];
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
