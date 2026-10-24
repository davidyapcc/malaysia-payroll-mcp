import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod";
import { calculateSocsoEis } from "../../core/socso-eis.js";
import { age, citizenship, monthlySalary, payPeriod, resultTail, run } from "./shared.js";

const inputSchema = z.object({
  monthlySalary,
  age,
  citizenship,
  skbbkStatus: z
    .enum(["covered", "opted_out"])
    .optional()
    .describe(
      "SOCSO's 24-hour protection scheme (SKBBK, Lindung 24 Jam). Everyone is covered by default; opted_out only if PERKESO approved the employee's opt-out, which foreign workers can't do. Defaults to covered.",
    ),
  eisPayableBefore57: z
    .boolean()
    .optional()
    .describe(
      "Required for employees aged 57 to 59: true if EIS contributions were payable for them before they turned 57 (even if never paid). Can't be worked out from age.",
    ),
  payPeriod,
});

const amounts = { employee: z.number().describe("RM"), employer: z.number().describe("RM") };

const outputSchema = z.object({
  payPeriod: z.string(),
  monthlySalary: z.number(),
  skbbkStatus: z.enum(["covered", "opted_out"]),
  socso: z.object({ category: z.enum(["first", "second"]), ...amounts }),
  skbbk: z.object({ employee: z.number().describe("RM, employee only") }),
  eis: z.object({ covered: z.boolean(), ...amounts }),
  totals: z.object(amounts),
  ...resultTail,
});

export function registerSocsoEisTool(server: McpServer): void {
  server.registerTool(
    "calculate_socso_eis",
    {
      title: "Calculate SOCSO, SKBBK and EIS contributions",
      description:
        "Works out the monthly SOCSO (PERKESO, Act 4), SKBBK (Lindung 24 Jam) and EIS (Act 800) contributions for one employee in Malaysia, from the PERKESO tables in effect for the pay period, and cites the row used for each. Fixed monthly salaries only.",
      inputSchema,
      outputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (input) => run(() => calculateSocsoEis(input)),
  );
}
