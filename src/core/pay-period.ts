import { PayrollInputError } from "./errors.js";

const PAY_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;

const MALAYSIA_MONTH = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kuala_Lumpur",
  year: "numeric",
  month: "2-digit",
});

/** The calendar month (YYYY-MM) it is now in Malaysia. */
export function currentPayPeriod(now: Date): string {
  const parts = MALAYSIA_MONTH.formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}`;
}

/** Validates a pay period, or defaults to the current month in Malaysia when none is given. */
export function resolvePayPeriod(payPeriod: string | undefined, now: Date = new Date()): string {
  if (payPeriod === undefined) return currentPayPeriod(now);
  if (!PAY_PERIOD.test(payPeriod)) {
    throw new PayrollInputError(`Pay period must be YYYY-MM, got "${payPeriod}".`);
  }
  return payPeriod;
}
