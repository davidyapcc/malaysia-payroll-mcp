import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { calculateMtd, SAME_SALARY_ALL_YEAR } from "../../core/mtd.js";
import { monthlySalary, payPeriod, resultTail, run } from "./shared.js";

const rm = z.number().min(0).max(100_000_000);

/** The MTD inputs other than salary and EPF, shared with calculate_net_pay. */
export const mtdFields = {
  taxResident: z
    .boolean()
    .optional()
    .describe(
      "Defaults to true. false if the employee is not resident, or not known to be resident, in Malaysia for tax (usually under 182 days in the calendar year): MTD is then a flat 30% of the salary, with no reliefs, and taxCategory, children, tp1Reliefs and yearToDate are ignored.",
    ),
  taxCategory: z
    .union([z.literal(1), z.literal(2), z.literal(3)])
    .optional()
    .describe(
      "Required for a tax resident. LHDN tax category. 1: single. 2: married and the spouse has no income (or is jointly assessed). 3: married with a working spouse, or divorced, widowed, or single with an adopted child.",
    ),
  children: z
    .number()
    .int()
    .min(0)
    .max(50)
    .optional()
    .describe(
      "Qualifying children at RM2,000 relief each: unmarried and under 18, or 18 and over in full-time education below diploma level. Must be 0 in category 1. Defaults to 0. Children in higher education or with a disability (which LHDN counts as 4 or 8) are not supported.",
    ),
  tp1Reliefs: rm
    .optional()
    .describe(
      "Other reliefs the employee claimed through payroll this month on form TP1 (LP1), in RM. Defaults to 0.",
    ),
  yearToDate: z
    .union([
      z.literal(SAME_SALARY_ALL_YEAR),
      z.object({
        remuneration: rm.describe("Gross monthly salary paid in earlier months this year, in RM."),
        epf: rm.describe("The employee's EPF contributions in earlier months this year, in RM."),
        mtd: rm.describe("MTD deducted in earlier months this year, in RM."),
        tp1Reliefs: rm
          .optional()
          .describe("TP1 reliefs claimed in earlier months this year, in RM. Defaults to 0."),
      }),
    ])
    .optional()
    .describe(
      `Required from February. Totals from earlier months of the same calendar year, including any previous employer's (all 0 for someone with no earlier income this year). Or "${SAME_SALARY_ALL_YEAR}" if every earlier month had this salary and EPF, no TP1 reliefs, and its MTD deducted.`,
    ),
};

const inputSchema = z.object({
  monthlySalary,
  epfEmployee: rm.describe(
    "The employee's EPF contribution this month in RM (the employee share from calculate_epf). 0 if none.",
  ),
  ...mtdFields,
  payPeriod,
});

const outputSchema = z.object({
  payPeriod: z.string(),
  monthlySalary: z.number(),
  taxResident: z.boolean(),
  taxCategory: z.number().nullable().describe("null for a non-resident."),
  children: z.number(),
  mtd: z.number().describe("RM, deducted from pay."),
  yearToDate: z
    .object({ remuneration: z.number(), epf: z.number(), mtd: z.number(), tp1Reliefs: z.number() })
    .optional()
    .describe("The year-to-date figures used, in RM. Residents only."),
  working: z
    .object({
      monthsRemaining: z.number().describe("n"),
      epfThisMonth: z.number().describe("K1 after the RM4,000 cap, RM"),
      epfEachRemainingMonth: z.number().describe("K2, RM"),
      chargeableIncome: z.number().describe("P, RM"),
      taxForYear: z.number().describe("(P − M) × R + B, RM"),
      taxBand: z
        .object({
          above: z.number(),
          upTo: z.number().nullable(),
          m: z.number(),
          ratePercent: z.number(),
          b: z.number(),
        })
        .optional(),
    })
    .optional()
    .describe("The LHDN formula's working, so it can be checked line by line. Residents only."),
  ...resultTail,
});

export function registerMtdTool(server: McpServer): void {
  server.registerTool(
    "calculate_mtd",
    {
      title: "Calculate MTD (PCB) income tax deduction",
      description:
        "Works out the monthly tax deduction (MTD, also called PCB) for one employee in Malaysia. For a tax resident it uses LHDN's computerised formula, from the schedule in effect for the pay period, and shows the working; for a non-resident it applies the flat 30%. Fixed monthly salaries and standard reliefs only (individual, spouse, children, EPF, plus a TP1 total); no bonuses or zakat.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => run(() => calculateMtd(input)),
  );
}
