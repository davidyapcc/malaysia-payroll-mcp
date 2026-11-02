// Layer 1 check that an answer carries the disclaimer every tool result returns (DISCLAIMER in src/mcp/tools/shared.ts).

const NON_ADVICE_RE = /\bnot (?:tax or legal|tax|legal) advice\b/i;
const FIXED_SALARY_RE = /\bfixed (?:monthly )?salar(?:y|ies)\b/i;

/** True when the answer states both halves of the disclaimer: the non-advice and the fixed-salary limits. */
export function hasDisclaimer(finalAnswer: string): boolean {
  return NON_ADVICE_RE.test(finalAnswer) && FIXED_SALARY_RE.test(finalAnswer);
}
