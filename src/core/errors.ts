import { NoTableInEffectError } from "../tables/index.js";

/**
 * An input the calculation can't accept. The message is written for the caller (often an agent)
 * to read and act on, so the MCP layer returns it as a tool error rather than a protocol error.
 */
export class PayrollInputError extends Error {
  override readonly name = "PayrollInputError";
}

/** Runs a table lookup, turning "no table in effect" into an input error the caller can fix. */
export function tableInEffect<T>(lookup: (payPeriod: string) => T, payPeriod: string): T {
  try {
    return lookup(payPeriod);
  } catch (error) {
    if (error instanceof NoTableInEffectError) throw new PayrollInputError(error.message);
    throw error;
  }
}
