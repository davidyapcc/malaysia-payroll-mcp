import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { calculateNetPay } from "../../core/net-pay.js";
import { registeredWithEpfBefore1Aug1998 } from "./epf.js";
import { mtdFields } from "./mtd.js";
import { age, citizenship, monthlySalary, payPeriod, resultTail, run } from "./shared.js";
import { eisPayableBefore57, skbbkStatus } from "./socso-eis.js";

const inputSchema = z.object({
  monthlySalary,
  age,
  citizenship,
  registeredWithEpfBefore1Aug1998,
  skbbkStatus,
  eisPayableBefore57,
  ...mtdFields,
  taxResident: mtdFields.taxResident.describe(
    "Required for a non_malaysian employee; defaults to true otherwise. true if tax resident in Malaysia (usually 182 days or more in the calendar year). false for the flat 30% non-resident MTD, with no reliefs: taxCategory, children, tp1Reliefs and yearToDate are then ignored.",
  ),
  payPeriod,
});

const rm = (what: string) => z.number().describe(`RM, ${what}`);

const outputSchema = z.object({
  payPeriod: z.string(),
  monthlySalary: z.number(),
  deductions: z
    .object({
      epf: rm("employee share"),
      socso: rm("employee share"),
      skbbk: rm("employee only"),
      eis: rm("employee share"),
      mtd: rm("income tax withheld"),
      total: rm("all statutory deductions"),
    })
    .describe("What comes off the employee's pay."),
  netPay: rm("monthly salary minus every statutory deduction"),
  employerContributions: z
    .object({
      epf: rm("employer share"),
      socso: rm("employer share"),
      eis: rm("employer share"),
      total: rm("all employer contributions"),
    })
    .describe("What the employer pays on top of the salary."),
  employerCost: rm("monthly salary plus the employer's contributions"),
  basis: z
    .object({
      epfPart: z.enum(["A", "C", "E", "F"]),
      socsoCategory: z.enum(["first", "second"]),
      skbbkStatus: z.enum(["covered", "opted_out"]),
      eisCovered: z.boolean(),
      taxResident: z.boolean(),
      taxCategory: z.number().nullable().describe("null for a non-resident."),
      children: z.number(),
      mtdYearToDate: z
        .object({
          remuneration: z.number(),
          epf: z.number(),
          mtd: z.number(),
          tp1Reliefs: z.number(),
        })
        .optional()
        .describe("Residents only."),
    })
    .describe(
      "The rules each calculation used. Call calculate_epf, calculate_socso_eis or calculate_mtd for the full working.",
    ),
  ...resultTail,
});

export function registerNetPayTool(server: McpServer): void {
  server.registerTool(
    "calculate_net_pay",
    {
      title: "Calculate net pay (payslip)",
      description:
        "Works out one month's payslip for one employee in Malaysia: EPF, SOCSO, SKBBK, EIS and MTD (PCB) deductions, net pay, and the employer's contributions and total cost. Runs the same calculations as calculate_epf, calculate_socso_eis and calculate_mtd, feeding the employee EPF into MTD, and cites the source of every line. For a non_malaysian employee, say whether they are tax resident (taxResident). Fixed monthly salaries and standard reliefs only; no bonuses or zakat.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => run(() => calculateNetPay(input)),
  );
}
