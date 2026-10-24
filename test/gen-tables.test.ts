import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generate, parseCsv, run, TableDataError } from "../scripts/gen-tables.js";

const ROOT = resolve(import.meta.dirname, "..");
const SOURCE = { title: "Test", url: "https://example.com", retrieved: "2026-10-23" };

const EIS_HEADER = "no,wage_above_rm,wage_up_to_rm,employer_sen,employee_sen,total_sen";
const EIS_CSV = "eis-test-from-2026-01-01.csv";

function eis(...rows: string[]): string {
  return [EIS_HEADER, ...rows, ""].join("\n");
}

function parseError(csv: string, text: string): string {
  try {
    parseCsv(csv, text, SOURCE);
  } catch (error) {
    expect(error).toBeInstanceOf(TableDataError);
    return (error as Error).message;
  }
  throw new Error("expected a TableDataError");
}

describe("gen-tables", () => {
  it("has committed generated tables that match docs/data/", () => {
    expect(run(ROOT, true)).toEqual([]);
  });

  it("accepts a well-formed table", () => {
    const parsed = parseCsv(EIS_CSV, eis("1,0,30,5,5,10", "2,30,,10,10,20"), SOURCE);
    expect(parsed).toMatchObject({ kind: "eis", effectiveFrom: "2026-01-01" });
    expect(parsed.body).toContain(
      "{ no: 2, above: 3000, upTo: null, employer: 10, employee: 10 },",
    );
  });

  it.each([
    ["eis-test-2026-01-01.csv", eis("1,0,30,5,5,10"), "name must be"],
    ["eis-test-from-2026-01-15.csv", eis("1,0,30,5,5,10"), "name must be"],
    ["cpf-test-from-2026-01-01.csv", eis("1,0,30,5,5,10"), "name must be"],
    [EIS_CSV, "no,above,up_to\n1,0,30\n", ":1: header must be"],
    [EIS_CSV, eis(), "no rows"],
    [EIS_CSV, eis("1,0,30,5,5"), ":2: expected 6 cells, got 5"],
    [EIS_CSV, eis("1,0,30,5,5,11"), ":2: total is 11 sen but its parts add up to 10"],
    [
      EIS_CSV,
      eis("1,0,30,5,5,10", "2,40,50,10,10,20"),
      ":3: band starts above 4000 sen, expected 3000",
    ],
    [EIS_CSV, eis("1,0,30,5,5,10", "3,30,50,10,10,20"), ":3: row number 3, expected 2"],
    [
      EIS_CSV,
      eis("1,0,,5,5,10", "2,30,50,10,10,20"),
      ":2: only the last band may have no upper limit",
    ],
    [EIS_CSV, eis("1,0,0,5,5,10"), ":2: band upper limit must be above its lower limit"],
    [EIS_CSV, eis("1,0,30.123,5,5,10"), ':2: "30.123" is not a ringgit amount'],
    [EIS_CSV, eis("1,0,30,5.5,5,10"), ':2: "5.5" is not a whole number'],
  ])("rejects %s with %j", (csv, text, message) => {
    expect(parseError(csv, text)).toContain(message);
  });

  describe("EPF parts", () => {
    const header = "part,wage_from_rm,wage_to_rm,employer_rm,employee_rm,total_rm";
    const csv = "epf-test-from-2026-01-01.csv";
    const parts = ["A,0.01,10.00,0,0,0", "C,0.01,10.00,0,0,0", "E,0.01,10.00,0,0,0"];

    it("stores the schedule's RMx.01 to RMy bands as (x, y]", () => {
      const { body } = parseCsv(
        csv,
        [header, ...parts, "E,10.01,20.00,1.00,0,1.00"].join("\n"),
        SOURCE,
      );
      expect(body).toContain("{ above: 1000, upTo: 2000, employer: 100, employee: 0 },");
    });

    it.each([
      [[...parts, "A,10.01,20.00,3.00,3.00,6.00"], "part A rows must be together"],
      [[...parts, "F,0.01,10.00,0,0,0"], 'unknown part "F"'],
      [parts.slice(0, 2), "part E has no rows"],
    ])("rejects %j", (rows, message) => {
      expect(parseError(csv, [header, ...rows].join("\n"))).toContain(message);
    });
  });

  describe("sources.json", () => {
    let dir: string | undefined;
    afterEach(() => {
      if (dir !== undefined) rmSync(dir, { recursive: true });
      dir = undefined;
    });

    function dataDir(sources: unknown, csvs: Record<string, string>): string {
      dir = mkdtempSync(join(tmpdir(), "gen-tables-"));
      writeFileSync(join(dir, "sources.json"), JSON.stringify(sources));
      for (const [name, text] of Object.entries(csvs)) writeFileSync(join(dir, name), text);
      return dir;
    }

    it("requires an entry for every CSV", () => {
      const data = dataDir({}, { [EIS_CSV]: eis("1,0,30,5,5,10") });
      expect(() => generate(data)).toThrow(`${EIS_CSV}: no entry in sources.json.`);
    });

    it("requires a CSV for every entry", () => {
      const data = dataDir({ [EIS_CSV]: SOURCE }, {});
      expect(() => generate(data)).toThrow(`sources.json: "${EIS_CSV}" has no matching CSV.`);
    });

    it.each([[[]], [{ [EIS_CSV]: { ...SOURCE, url: "http://example.com" } }]])(
      "rejects a malformed manifest %j",
      (sources) => {
        const data = dataDir(sources, { [EIS_CSV]: eis("1,0,30,5,5,10") });
        expect(() => generate(data)).toThrow(TableDataError);
      },
    );

    it("rejects two tables of one kind with the same effective date", () => {
      const other = "eis-other-from-2026-01-01.csv";
      const data = dataDir(
        { [EIS_CSV]: SOURCE, [other]: SOURCE },
        { [EIS_CSV]: eis("1,0,30,5,5,10"), [other]: eis("1,0,30,5,5,10") },
      );
      expect(() => generate(data)).toThrow("same kind and effective date as");
    });
  });
});
