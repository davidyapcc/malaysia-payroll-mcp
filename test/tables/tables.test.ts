// Checks the generated tables against the published rules they come from. The CSVs stay the
// authority (ADR 0003); these catch transcription slips and band lookups that drift.
import { describe, expect, it } from "vitest";
import {
  type EisBand,
  type EpfBand,
  eisTableFor,
  epfTableFor,
  NoTableInEffectError,
  type SkbbkBand,
  type SocsoBand,
  skbbkTableFor,
  socsoTableFor,
} from "../../src/tables/index.js";

const RM5000 = 500_000;

function bandFor<B extends { above: number; upTo: number | null }>(
  bands: readonly B[],
  sen: number,
) {
  const band = bands.find((b) => b.above < sen && (b.upTo === null || sen <= b.upTo));
  if (band === undefined) throw new Error(`no band for ${sen} sen`);
  return band;
}

/** ceil(rate × wage) to whole ringgit, in sen. `perMille` keeps the arithmetic in integers. */
function ceilRinggit(perMille: number, sen: number): number {
  return Math.ceil((perMille * sen) / 100_000) * 100;
}

describe("EPF Third Schedule from 1 Oct 2025", () => {
  const table = epfTableFor("2026-11");

  it("is the table in effect for current pay periods", () => {
    expect(table).toMatchObject({ kind: "epf", effectiveFrom: "2025-10-01" });
    expect(epfTableFor("2025-10")).toBe(table);
  });

  it("covers RM0.01 to RM20,000 in 401 bands per part", () => {
    for (const bands of Object.values(table.parts)) {
      expect(bands).toHaveLength(401);
      expect(bands.at(-1)?.upTo).toBe(2_000_000);
    }
  });

  // sources.md: every band amount is ceil(rate × band upper limit), each share separately.
  const rates: Record<"A" | "C" | "E", (upTo: number) => [employer: number, employee: number]> = {
    A: (upTo) => [upTo <= RM5000 ? 130 : 120, 110],
    C: (upTo) => [upTo <= RM5000 ? 65 : 60, 55],
    E: () => [40, 0],
  };
  it.each(["A", "C", "E"] as const)("part %s matches ceil(rate × upper limit)", (part) => {
    const bands: readonly EpfBand[] = table.parts[part];
    for (const band of bands.slice(1)) {
      const [employer, employee] = rates[part](band.upTo);
      expect(band).toMatchObject({
        employer: ceilRinggit(employer, band.upTo),
        employee: ceilRinggit(employee, band.upTo),
      });
    }
  });

  it("finds the golden EPF-02 band (part A, RM3,000)", () => {
    expect(bandFor(table.parts.A, 300_000)).toEqual({
      above: 298_000,
      upTo: 300_000,
      employer: 39_000,
      employee: 33_000,
    });
  });
});

describe("SOCSO Act 4 table from 1 Oct 2024", () => {
  const table = socsoTableFor("2026-11");

  it("is the table in effect for current pay periods, and before SKBBK started (SOC-06)", () => {
    expect(table).toMatchObject({ kind: "socso", effectiveFrom: "2024-10-01" });
    expect(socsoTableFor("2026-05")).toBe(table);
  });

  it("has 65 bands, the last one open above the RM6,000 ceiling", () => {
    expect(table.bands).toHaveLength(65);
    expect(table.bands.at(-1)).toMatchObject({ no: 65, above: 600_000, upTo: null });
  });

  it("finds the golden SOC-01 band (row 34, RM3,000)", () => {
    expect(bandFor<SocsoBand>(table.bands, 300_000)).toMatchObject({
      no: 34,
      cat1Employer: 5165,
      cat1EmployeeInvalidity: 1475,
      cat2Employer: 3690,
    });
  });

  it("puts wages with cents into the band above, not a gap", () => {
    expect(bandFor<SocsoBand>(table.bands, 300_001).no).toBe(35);
  });
});

describe("SKBBK table from 1 Jun 2026", () => {
  const table = skbbkTableFor("2026-11");

  it("starts with June 2026 payroll", () => {
    expect(table).toMatchObject({ kind: "skbbk", effectiveFrom: "2026-06-01" });
    expect(skbbkTableFor("2026-06")).toBe(table);
    expect(() => skbbkTableFor("2026-05")).toThrow(NoTableInEffectError);
  });

  it("uses the same 65 bands as the SOCSO table", () => {
    const socso = socsoTableFor("2026-11").bands;
    expect(table.bands.map(({ no, above, upTo }) => ({ no, above, upTo }))).toEqual(
      socso.map(({ no, above, upTo }) => ({ no, above, upTo })),
    );
  });

  it("finds the golden SOC-01 band (row 34, RM3,000) and caps at RM44.65", () => {
    expect(bandFor<SkbbkBand>(table.bands, 300_000)).toMatchObject({ no: 34, employee: 2215 });
    expect(bandFor<SkbbkBand>(table.bands, 1_000_000)).toMatchObject({ no: 65, employee: 4465 });
  });
});

describe("EIS Act 800 table from 1 Oct 2024", () => {
  const table = eisTableFor("2026-11");

  it("is the table in effect for current pay periods", () => {
    expect(table).toMatchObject({ kind: "eis", effectiveFrom: "2024-10-01" });
  });

  // sources.md: from RM500 the bands are RM100 wide and each side pays 0.2% of the midpoint.
  it("pays 0.2% of the band midpoint per side from RM500 to RM6,000", () => {
    const regular = table.bands.filter((b): b is EisBand & { upTo: number } => {
      return b.above >= 50_000 && b.upTo !== null;
    });
    expect(regular).toHaveLength(55);
    for (const band of regular) {
      const share = ((band.above + band.upTo) / 2) * 0.002;
      expect(band).toMatchObject({ employer: share, employee: share });
    }
  });

  it("caps wages above RM6,000 at RM11.90 per side", () => {
    expect(bandFor(table.bands, 1_000_000)).toMatchObject({
      no: 65,
      employer: 1190,
      employee: 1190,
    });
  });

  it("finds the golden EIS-01 band (row 34, RM3,000)", () => {
    expect(bandFor(table.bands, 300_000)).toMatchObject({ no: 34, employer: 590, employee: 590 });
  });
});
