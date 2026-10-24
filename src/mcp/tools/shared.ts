import type { CallToolResult } from "@modelcontextprotocol/server";
import * as z from "zod";
import { PayrollInputError } from "../../core/errors.js";

export const DISCLAIMER =
  "Not tax or legal advice, and not verified by KWSP, PERKESO or LHDN. Fixed monthly salaries only: overtime, commission, bonuses and arrears are not supported. Check results against the cited source.";

export const monthlySalary = z
  .number()
  .positive()
  .max(1_000_000)
  .describe(
    "Monthly salary in RM, at most 2 decimal places: basic pay plus fixed allowances. Excludes overtime, commission, bonuses and arrears.",
  );

export const age = z.number().int().min(0).max(120).describe("The employee's age in whole years.");

export const citizenship = z
  .enum(["malaysian", "permanent_resident", "non_malaysian"])
  .describe("malaysian, permanent_resident, or non_malaysian (a foreign worker without PR).");

export const payPeriod = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .optional()
  .describe(
    "The calendar month the salary is paid for, as YYYY-MM. It decides which rate tables apply. Defaults to the current month in Malaysia.",
  );

const source = z.object({ title: z.string(), url: z.string(), retrieved: z.string() });

export const citation = z.object({
  item: z.string(),
  employee: z.number().describe("RM"),
  employer: z.number().describe("RM"),
  rule: z.string(),
  tableRow: z.string().optional(),
  source,
  effectiveFrom: z.string(),
});

/** Fields every tool result ends with. */
export const resultTail = {
  citations: z.array(citation),
  explanation: z.string(),
  disclaimer: z.string(),
};

/**
 * Runs a core calculation and returns it as structured content. An input the core rejects comes
 * back as a tool error whose message tells the agent what to fix.
 */
export function run<T extends object>(calculate: () => T): CallToolResult {
  try {
    const output = { ...calculate(), disclaimer: DISCLAIMER };
    return {
      content: [{ type: "text", text: JSON.stringify(output) }],
      structuredContent: output,
    };
  } catch (error) {
    if (!(error instanceof PayrollInputError)) throw error;
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
}
