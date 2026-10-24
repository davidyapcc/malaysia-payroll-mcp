import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { calculateEpf } from "../../core/epf.js";
import { age, citizenship, monthlySalary, payPeriod, resultTail, run } from "./shared.js";

const inputSchema = z.object({
  monthlySalary,
  age,
  citizenship,
  registeredWithEpfBefore1Aug1998: z
    .boolean()
    .optional()
    .describe(
      "Only for non_malaysian: true if the employee registered with EPF before 1 Aug 1998, which puts them on the Malaysian rates. Defaults to false.",
    ),
  payPeriod,
});

const outputSchema = z.object({
  payPeriod: z.string(),
  monthlySalary: z.number(),
  part: z.enum(["A", "C", "E", "F"]).describe("The EPF Third Schedule part applied."),
  employee: z.number().describe("RM, deducted from pay."),
  employer: z.number().describe("RM, paid on top of pay."),
  total: z.number().describe("RM"),
  ...resultTail,
});

export function registerEpfTool(server: McpServer): void {
  server.registerTool(
    "calculate_epf",
    {
      title: "Calculate EPF (KWSP) contributions",
      description:
        "Works out the monthly EPF (KWSP) employee and employer contributions for one employee in Malaysia, from the EPF Third Schedule in effect for the pay period, and cites the band used. Fixed monthly salaries only.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => run(() => calculateEpf(input)),
  );
}
