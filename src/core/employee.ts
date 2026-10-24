import { PayrollInputError } from "./errors.js";
import { toSen } from "./money.js";

/**
 * EPF, SOCSO and EIS treat these three groups differently. Permanent residents are locals for
 * SOCSO, SKBBK and EIS, and follow the Malaysian parts of the EPF schedule except at 60 and over.
 */
export type Citizenship = "malaysian" | "permanent_resident" | "non_malaysian";

/** The monthly salary in sen. It has to be above 0: every rate table starts above RM0. */
export function monthlySalarySen(rm: number): number {
  const sen = toSen(rm);
  if (sen === 0) throw new PayrollInputError("Monthly salary must be more than RM0.");
  return sen;
}
