// Turns the canonical rate-table CSVs in docs/data/ into typed modules in src/tables/generated/
// (ADR 0003). Run `pnpm gen:tables` after editing a CSV; CI runs `pnpm gen:tables --check`.
//
// This file runs directly under Node's type stripping, so it imports only `node:` modules at
// runtime. The output is written already formatted the way Biome would format it, so the check
// needs nothing but this script.

import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TableSource } from "../src/tables/loader.js";
import type { EisBand, EpfBand, EpfPart, SkbbkBand, SocsoBand } from "../src/tables/types.js";

const KINDS = ["epf", "socso", "skbbk", "eis"] as const;
type Kind = (typeof KINDS)[number];

const CSV_NAME = /^(epf|socso|skbbk|eis)-[a-z0-9-]+-from-(\d{4}-(?:0[1-9]|1[0-2])-01)\.csv$/;
const RM = /^\d+(?:\.\d{1,2})?$/;
const SEN = /^\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TITLE_MAX = 80;

const HEADERS: Record<Kind, string> = {
  epf: "part,wage_from_rm,wage_to_rm,employer_rm,employee_rm,total_rm",
  socso:
    "no,wage_above_rm,wage_up_to_rm,cat1_employer_sen,cat1_employee_invalidity_sen,cat1_total_sen,cat2_employer_sen,cat2_total_sen",
  skbbk: "no,wage_above_rm,wage_up_to_rm,employee_sen",
  eis: "no,wage_above_rm,wage_up_to_rm,employer_sen,employee_sen,total_sen",
};

export interface GeneratedFile {
  /** File name inside src/tables/generated/. */
  readonly name: string;
  readonly content: string;
}

/** A CSV or the sources manifest broke a rule. Messages name the file and line. */
export class TableDataError extends Error {
  override readonly name = "TableDataError";
}

interface Parsed {
  readonly kind: Kind;
  readonly csv: string;
  readonly effectiveFrom: string;
  readonly ident: string;
  readonly body: string;
}

/** Generates every module from the CSVs in `dataDir` and their entries in sources.json. */
export function generate(dataDir: string): GeneratedFile[] {
  const sources = readSources(join(dataDir, "sources.json"));
  const csvs = readdirSync(dataDir)
    .filter((name) => name.endsWith(".csv"))
    .sort();

  for (const name of Object.keys(sources)) {
    if (!csvs.includes(name)) {
      throw new TableDataError(`sources.json: "${name}" has no matching CSV.`);
    }
  }

  const parsed: Parsed[] = [];
  for (const csv of csvs) {
    const source = sources[csv];
    if (source === undefined) throw new TableDataError(`${csv}: no entry in sources.json.`);
    parsed.push(parseCsv(csv, readFileSync(join(dataDir, csv), "utf8"), source));
  }

  const seen = new Map<string, string>();
  for (const table of parsed) {
    const key = `${table.kind} ${table.effectiveFrom}`;
    const other = seen.get(key);
    if (other !== undefined) {
      throw new TableDataError(`${table.csv}: same kind and effective date as ${other}.`);
    }
    seen.set(key, table.csv);
  }

  return [
    ...parsed.map((table) => ({ name: moduleName(table.csv), content: table.body })),
    { name: "index.ts", content: renderIndex(parsed) },
  ];
}

function readSources(path: string): Record<string, TableSource> {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TableDataError("sources.json: expected an object keyed by CSV file name.");
  }
  const sources: Record<string, TableSource> = {};
  for (const [name, entry] of Object.entries(raw)) {
    const { title, url, retrieved } = (entry ?? {}) as Record<string, unknown>;
    if (
      typeof title !== "string" ||
      title === "" ||
      // Longer titles make Biome wrap the line, and the output would no longer match it.
      title.length > TITLE_MAX ||
      typeof url !== "string" ||
      !url.startsWith("https://") ||
      typeof retrieved !== "string" ||
      !DATE.test(retrieved)
    ) {
      throw new TableDataError(
        `sources.json: "${name}" needs a title of at most ${TITLE_MAX} characters, an https url and a retrieved date (YYYY-MM-DD).`,
      );
    }
    sources[name] = { title, url, retrieved };
  }
  return sources;
}

/** Parses and checks one CSV, returning the rendered module. */
export function parseCsv(csv: string, text: string, source: TableSource): Parsed {
  const match = CSV_NAME.exec(csv);
  if (match === null) {
    throw new TableDataError(
      `${csv}: name must be <epf|socso|skbbk|eis>-<description>-from-<YYYY-MM-01>.csv.`,
    );
  }
  const kind = match[1] as Kind;
  const effectiveFrom = match[2] as string;

  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines[0] !== HEADERS[kind]) {
    throw new TableDataError(`${csv}:1: header must be "${HEADERS[kind]}".`);
  }
  const rows = lines.slice(1).map((line, i) => new Row(csv, i + 2, line));
  if (rows.length === 0) throw new TableDataError(`${csv}: no rows.`);

  const meta = { kind, effectiveFrom, csv, source };
  const ident = `${kind}${effectiveFrom.replaceAll("-", "")}`;
  const parsed = { kind, csv, effectiveFrom, ident };
  switch (kind) {
    case "epf":
      return { ...parsed, body: renderEpf(meta, parseEpf(rows)) };
    case "socso":
      return { ...parsed, body: renderBanded(meta, "SocsoTable", "bands", parseSocso(rows)) };
    case "skbbk":
      return { ...parsed, body: renderBanded(meta, "SkbbkTable", "bands", parseSkbbk(rows)) };
    case "eis":
      return { ...parsed, body: renderBanded(meta, "EisTable", "bands", parseEis(rows)) };
  }
}

// No parameter properties in this file: Node's type stripping can't run them.
class Row {
  readonly csv: string;
  readonly line: number;
  private readonly cells: string[];

  constructor(csv: string, line: number, text: string) {
    this.csv = csv;
    this.line = line;
    this.cells = text.split(",");
  }

  fail(message: string): never {
    throw new TableDataError(`${this.csv}:${this.line}: ${message}`);
  }

  expectCells(count: number): void {
    if (this.cells.length !== count)
      this.fail(`expected ${count} cells, got ${this.cells.length}.`);
  }

  cell(index: number): string {
    return this.cells[index] as string;
  }

  /** A ringgit amount with at most 2 decimals, as integer sen. */
  rm(index: number): number {
    const value = this.cell(index);
    if (!RM.test(value)) this.fail(`"${value}" is not a ringgit amount.`);
    const [whole, cents = ""] = value.split(".");
    return Number(whole) * 100 + Number(cents.padEnd(2, "0"));
  }

  /** Like `rm`, but an empty cell means "no upper limit". */
  rmOrOpen(index: number): number | null {
    return this.cell(index) === "" ? null : this.rm(index);
  }

  /** A whole number: a sen amount or a row number. */
  int(index: number): number {
    const value = this.cell(index);
    if (!SEN.test(value)) this.fail(`"${value}" is not a whole number.`);
    return Number(value);
  }
}

/** Checks that bands start at 0, follow on with no gap or overlap, and only the last is open. */
function checkBands(
  rows: readonly Row[],
  bands: readonly { above: number; upTo: number | null }[],
) {
  let previous = 0;
  bands.forEach((band, i) => {
    const row = rows[i] as Row;
    if (band.above !== previous) {
      row.fail(`band starts above ${band.above} sen, expected ${previous} (gap or overlap).`);
    }
    if (band.upTo === null) {
      if (i !== bands.length - 1) row.fail("only the last band may have no upper limit.");
      return;
    }
    if (band.upTo <= band.above) row.fail("band upper limit must be above its lower limit.");
    previous = band.upTo;
  });
}

function checkNumbering(rows: readonly Row[], numbers: readonly number[]): void {
  numbers.forEach((no, i) => {
    if (no !== i + 1) (rows[i] as Row).fail(`row number ${no}, expected ${i + 1}.`);
  });
}

function checkTotal(row: Row, total: number, parts: readonly number[], what: string): void {
  const sum = parts.reduce((a, b) => a + b, 0);
  if (sum !== total) row.fail(`${what} is ${total} sen but its parts add up to ${sum}.`);
}

function parseEpf(rows: readonly Row[]): Record<EpfPart, EpfBand[]> {
  const parts: Record<EpfPart, EpfBand[]> = { A: [], C: [], E: [] };
  const partRows: Record<EpfPart, Row[]> = { A: [], C: [], E: [] };
  let order = "";
  for (const row of rows) {
    row.expectCells(6);
    const part = row.cell(0);
    if (part !== "A" && part !== "C" && part !== "E") row.fail(`unknown part "${part}".`);
    if (!order.endsWith(part)) {
      if (order.includes(part)) row.fail(`part ${part} rows must be together.`);
      order += part;
    }
    const band: EpfBand = {
      // The schedule writes bands as RM10.01 to RM20.00; store them as (10.00, 20.00].
      above: row.rm(1) - 1,
      upTo: row.rm(2),
      employer: row.rm(3),
      employee: row.rm(4),
    };
    checkTotal(row, row.rm(5), [band.employer, band.employee], "total");
    parts[part].push(band);
    partRows[part].push(row);
  }
  for (const part of ["A", "C", "E"] as const) {
    if (parts[part].length === 0) {
      throw new TableDataError(`${(rows[0] as Row).csv}: part ${part} has no rows.`);
    }
    checkBands(partRows[part], parts[part]);
  }
  return parts;
}

function parseSocso(rows: readonly Row[]): SocsoBand[] {
  const bands = rows.map((row): SocsoBand => {
    row.expectCells(8);
    const band: SocsoBand = {
      no: row.int(0),
      above: row.rm(1),
      upTo: row.rmOrOpen(2),
      cat1Employer: row.int(3),
      cat1EmployeeInvalidity: row.int(4),
      cat2Employer: row.int(6),
    };
    checkTotal(
      row,
      row.int(5),
      [band.cat1Employer, band.cat1EmployeeInvalidity],
      "first category total",
    );
    checkTotal(row, row.int(7), [band.cat2Employer], "second category total");
    return band;
  });
  checkNumbering(
    rows,
    bands.map((band) => band.no),
  );
  checkBands(rows, bands);
  return bands;
}

function parseSkbbk(rows: readonly Row[]): SkbbkBand[] {
  const bands = rows.map((row): SkbbkBand => {
    row.expectCells(4);
    return { no: row.int(0), above: row.rm(1), upTo: row.rmOrOpen(2), employee: row.int(3) };
  });
  checkNumbering(
    rows,
    bands.map((band) => band.no),
  );
  checkBands(rows, bands);
  return bands;
}

function parseEis(rows: readonly Row[]): EisBand[] {
  const bands = rows.map((row): EisBand => {
    row.expectCells(6);
    const band: EisBand = {
      no: row.int(0),
      above: row.rm(1),
      upTo: row.rmOrOpen(2),
      employer: row.int(3),
      employee: row.int(4),
    };
    checkTotal(row, row.int(5), [band.employer, band.employee], "total");
    return band;
  });
  checkNumbering(
    rows,
    bands.map((band) => band.no),
  );
  checkBands(rows, bands);
  return bands;
}

// Rendering. Output must match what `biome format` would produce, or `pnpm lint` fails.

interface Meta {
  readonly kind: Kind;
  readonly effectiveFrom: string;
  readonly csv: string;
  readonly source: TableSource;
}

function moduleName(csv: string): string {
  return `${basename(csv, ".csv")}.ts`;
}

function header(csv: string): string {
  return [
    `// Generated by scripts/gen-tables.ts from docs/data/${csv}.`,
    "// Do not edit: change the CSV and run `pnpm gen:tables` (ADR 0003).",
    "",
  ].join("\n");
}

function str(value: string): string {
  return JSON.stringify(value);
}

function renderMeta(meta: Meta): string[] {
  return [
    `  kind: ${str(meta.kind)},`,
    `  effectiveFrom: ${str(meta.effectiveFrom)},`,
    `  csv: ${str(`docs/data/${meta.csv}`)},`,
    "  source: {",
    `    title: ${str(meta.source.title)},`,
    `    url: ${str(meta.source.url)},`,
    `    retrieved: ${str(meta.source.retrieved)},`,
    "  },",
  ];
}

const LINE_WIDTH = 100; // biome.json formatter.lineWidth

/** One row per line, or one field per line when the row is too wide, as Biome does. */
function renderRow(row: object, indent: string): string {
  const fields = Object.entries(row).map(([key, value]) => `${key}: ${value}`);
  const line = `${indent}{ ${fields.join(", ")} },`;
  if (line.length <= LINE_WIDTH) return line;
  return [`${indent}{`, ...fields.map((field) => `${indent}  ${field},`), `${indent}},`].join("\n");
}

function renderEpf(meta: Meta, parts: Record<EpfPart, EpfBand[]>): string {
  const lines = [
    header(meta.csv),
    'import type { EpfTable } from "../types.js";',
    "",
    "export const table: EpfTable = {",
    ...renderMeta(meta),
    "  parts: {",
  ];
  for (const part of ["A", "C", "E"] as const) {
    lines.push(`    ${part}: [`, ...parts[part].map((band) => renderRow(band, "      ")), "    ],");
  }
  lines.push("  },", "};", "");
  return lines.join("\n");
}

function renderBanded(meta: Meta, type: string, key: string, bands: readonly object[]): string {
  return [
    header(meta.csv),
    `import type { ${type} } from "../types.js";`,
    "",
    `export const table: ${type} = {`,
    ...renderMeta(meta),
    `  ${key}: [`,
    ...bands.map((band) => renderRow(band, "    ")),
    "  ],",
    "};",
    "",
  ].join("\n");
}

const TABLE_TYPES: Record<Kind, string> = {
  epf: "EpfTable",
  socso: "SocsoTable",
  skbbk: "SkbbkTable",
  eis: "EisTable",
};

function renderIndex(tables: readonly Parsed[]): string {
  const sorted = [...tables].sort((a, b) => (a.csv < b.csv ? -1 : 1));
  const lines = [
    "// Generated by scripts/gen-tables.ts from docs/data/.",
    "// Do not edit: add or change a CSV and run `pnpm gen:tables` (ADR 0003).",
    "",
    `import type { ${Object.values(TABLE_TYPES).sort().join(", ")} } from "../types.js";`,
    ...sorted.map(
      (table) => `import { table as ${table.ident} } from "./${basename(table.csv, ".csv")}.js";`,
    ),
  ];
  for (const kind of KINDS) {
    const idents = tables
      .filter((table) => table.kind === kind)
      .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1))
      .map((table) => table.ident);
    lines.push(
      "",
      "/** Oldest first. */",
      `export const ${kind}Tables: readonly ${TABLE_TYPES[kind]}[] = [${idents.join(", ")}];`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

// CLI

/** Writes the generated modules, or with `check` only reports what is out of date. */
export function run(root: string, check: boolean): string[] {
  const outDir = join(root, "src/tables/generated");
  const files = generate(join(root, "docs/data"));
  const wanted = new Set(files.map((file) => file.name));
  const existing = readdirSync(outDir).filter((name) => name.endsWith(".ts"));
  const problems: string[] = [];

  for (const file of files) {
    const path = join(outDir, file.name);
    let current: string | undefined;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = undefined;
    }
    if (current === file.content) continue;
    problems.push(`${current === undefined ? "missing" : "out of date"}: ${file.name}`);
    if (!check) writeFileSync(path, file.content);
  }
  for (const name of existing) {
    if (wanted.has(name)) continue;
    problems.push(`stale: ${name}`);
    if (!check) rmSync(join(outDir, name));
  }
  return problems;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const check = process.argv.includes("--check");
  try {
    const problems = run(root, check);
    if (check && problems.length > 0) {
      console.error(problems.join("\n"));
      console.error("Generated tables don't match docs/data/. Run `pnpm gen:tables` and commit.");
      process.exitCode = 1;
    } else {
      console.log(problems.length === 0 ? "Tables up to date." : problems.join("\n"));
    }
  } catch (error) {
    if (!(error instanceof TableDataError)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
