import { describe, expect, it } from "vitest";
import { hasDisclaimer } from "../../evals/disclaimer.js";
import { DISCLAIMER } from "../../src/mcp/tools/shared.js";

describe("hasDisclaimer", () => {
  it("accepts the disclaimer wording every tool result returns", () => {
    // Arrange
    const finalAnswer = `The employee pays RM330.00.\n\n${DISCLAIMER}`;

    // Act
    const result = hasDisclaimer(finalAnswer);

    // Assert
    expect(result).toBe(true);
  });

  it("accepts a paraphrase that keeps both the non-advice and the fixed-salary limits", () => {
    // Arrange
    const finalAnswer =
      "This is not tax advice. It applies to fixed monthly salaries only, with no overtime.";

    // Act
    const result = hasDisclaimer(finalAnswer);

    // Assert
    expect(result).toBe(true);
  });

  it("matches regardless of case", () => {
    // Arrange
    const finalAnswer = "NOT LEGAL ADVICE. FIXED MONTHLY SALARIES ONLY.";

    // Act
    const result = hasDisclaimer(finalAnswer);

    // Assert
    expect(result).toBe(true);
  });

  it("rejects an answer with no disclaimer", () => {
    // Arrange
    const finalAnswer = "Employee: RM330.00. Employer: RM390.00. Total: RM720.00.";

    // Act
    const result = hasDisclaimer(finalAnswer);

    // Assert
    expect(result).toBe(false);
  });

  it("rejects an answer that has only the non-advice clause", () => {
    // Arrange
    const finalAnswer = "Employee: RM330.00. This is not tax advice.";

    // Act
    const result = hasDisclaimer(finalAnswer);

    // Assert
    expect(result).toBe(false);
  });

  it("rejects an answer that has only the fixed-salary clause", () => {
    // Arrange
    const finalAnswer = "Employee: RM330.00. Fixed monthly salaries only.";

    // Act
    const result = hasDisclaimer(finalAnswer);

    // Assert
    expect(result).toBe(false);
  });
});
