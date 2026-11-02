import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type EvalCase, evaluateLayer1, headlineAmounts } from "../../evals/grading.js";
import { loadEvalCases } from "../../evals/runner.js";

const liveAnswers = JSON.parse(
  readFileSync(new URL("./fixtures/net-pay-answers.json", import.meta.url), "utf8"),
) as Record<string, string>;

function netPayCase(id: string): EvalCase {
  const found = loadEvalCases().find((c) => c.id === id);
  if (found === undefined) throw new Error(`Missing eval case ${id}`);
  return found;
}

function netPayCall(evalCase: EvalCase) {
  return {
    name: "calculate_net_pay",
    arguments: evalCase.expectedInput,
    isError: false,
    textContent: "{}",
    structuredContent: {},
  };
}

function prose(id: string, answer: string) {
  const evalCase = netPayCase(id);
  return evaluateLayer1(evalCase, [netPayCall(evalCase)], answer);
}

describe("net pay party attribution", () => {
  it("names the party for each employee deduction and employer contribution", () => {
    const amounts = headlineAmounts(netPayCase("NP-01"));
    expect(amounts).toContainEqual({ amount: 550, party: "employee" });
    expect(amounts).toContainEqual({ amount: 650, party: "employer" });
    expect(amounts).toContainEqual({ amount: 86.65, party: "employer" });
    expect(amounts).toContainEqual({ amount: 5746.55, party: null });
  });

  it("adds the hand-worked employer figures for NP-02 and the employer cost for NP-02 to NP-05", () => {
    expect(headlineAmounts(netPayCase("NP-02"))).toContainEqual({ amount: 650, party: "employer" });
    expect(headlineAmounts(netPayCase("NP-02"))).toContainEqual({ amount: 746.55, party: null });
    expect(headlineAmounts(netPayCase("NP-02"))).toContainEqual({ amount: 5746.55, party: null });
    expect(headlineAmounts(netPayCase("NP-03"))).toContainEqual({ amount: 5261.9, party: null });
    expect(headlineAmounts(netPayCase("NP-04"))).toContainEqual({ amount: 5161.9, party: null });
    expect(headlineAmounts(netPayCase("NP-05"))).toContainEqual({ amount: 5161.9, party: null });
  });

  it("accepts the live answers for NP-01 to NP-05, which name each party under headings", () => {
    for (const id of ["NP-01", "NP-02", "NP-03", "NP-04", "NP-05"]) {
      const answer = liveAnswers[id];
      if (answer === undefined) throw new Error(`Missing live answer ${id}`);
      expect(prose(id, answer).hasValidProse, id).toBe(true);
    }
  });

  it("fails the live NP-01 answer once its EPF employee and employer shares are swapped", () => {
    const original = liveAnswers["NP-01"] ?? "";
    const swapped = original
      .replace("Employee Contribution: RM 550.00", "Employee Contribution: RM 650.00")
      .replace("Employer Contribution: RM 650.00", "Employer Contribution: RM 550.00");
    expect(swapped).not.toBe(original);
    const result = prose("NP-01", swapped);
    expect(result.hasValidProse).toBe(false);
    expect(result.missingAmounts).toContain(650);
  });

  it("fails an employee share that is listed under the employer heading", () => {
    const swapped = [
      "### Employer Contributions:",
      "1. **EPF:** RM 550.00",
      "2. **SOCSO:** RM 86.65",
      "3. **EIS:** RM 9.90",
      "### Employee Deductions:",
      "1. **EPF:** RM 650.00",
      "2. **SOCSO:** RM 24.75",
      "3. **SKBBK:** RM 37.15",
      "4. **EIS:** RM 9.90",
      "5. **MTD:** RM 110.00",
      "Net pay: RM 4,268.20. Total employer cost RM 5,746.55.",
    ].join("\n");
    const result = prose("NP-01", swapped);
    expect(result.hasValidProse).toBe(false);
    expect(result.missingAmounts).toContain(550);
  });

  it("accepts a figure that both parties pay when one amount names both", () => {
    const shared = [
      "### Deductions",
      "- EIS: RM 9.90",
      "- EPF: RM 100.00 each for the employee and the employer",
    ].join("\n");
    const result = prose("NP-04", shared);
    expect(result.missingAmounts).not.toContain(100);
  });

  it("attributes figures under a Deductions heading to the employee, past a line naming the employer", () => {
    const answer = [
      "### Deductions:",
      "- **EPF:** RM 100.00",
      "- **SOCSO:** RM 0.00 (employee pays nothing, employer pays)",
      "- **SKBBK:** RM 37.15",
      "- **EIS:** RM 0.00",
      "- **MTD:** RM 124.00",
      "**Total Deductions:** RM 261.15",
      "**Net Pay:** RM 4,738.85",
      "### Employer Contributions:",
      "- **EPF:** RM 100.00",
      "- **SOCSO:** RM 61.90",
      "- **EIS:** RM 0.00",
      "**Total Employer Contributions:** RM 161.90",
      "**Total Cost:** RM 5,161.90",
    ].join("\n");
    expect(prose("NP-04", answer).missingAmounts).toEqual([]);
  });

  it("fails an employer contribution listed only under a Deductions heading", () => {
    const answer = ["### Statutory Deductions:", "- **EPF:** RM 650.00"].join("\n");
    expect(prose("NP-01", answer).missingAmounts).toContain(650);
  });

  it("does not carry a party from a line with a figure onto the next line", () => {
    const answer = ["- **SOCSO:** RM 61.90 (employer pays)", "- **EPF:** RM 100.00"].join("\n");
    expect(prose("NP-04", answer).missingAmounts).toContain(100);
  });

  it("does not carry a party from a rule quoted under a figure", () => {
    const answer = [
      "### Employee Deductions:",
      "1. **EPF:** RM 100.00",
      "   - **Rule:** Part F is 2% employee and 2% employer.",
      "2. **SKBBK:** RM 37.15",
    ].join("\n");
    const { missingAmounts } = prose("NP-05", answer);
    expect(missingAmounts).not.toContain(37.15);
  });

  it("carries a party from an all-bold label with no colon", () => {
    const answer = ["**Employee**", "- **SKBBK:** RM 37.15"].join("\n");
    expect(prose("NP-05", answer).missingAmounts).not.toContain(37.15);
  });

  it("does not treat a line that only mentions deductions as a heading", () => {
    const answer = ["These are the deductions you asked about:", "- **MTD:** RM 124.00"].join("\n");
    expect(prose("NP-04", answer).missingAmounts).toContain(124);
  });

  it("fails a deduction that the answer never attributes to a party", () => {
    const result = prose(
      "NP-02",
      "Net pay RM 4,305.35. Deductions: RM 550.00, RM 24.75, RM 9.90, RM 110.00.",
    );
    expect(result.hasValidProse).toBe(false);
    expect(result.missingAmounts).toContain(550);
  });
});
