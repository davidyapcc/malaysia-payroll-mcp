# MTD tax band and rebate are picked on P floored to whole ringgit

LHDN's specification reads as if the tax band and the RM400 rebate should be picked on chargeable income P with its cents, and the obvious implementation does that. LHDN's own online PCB calculator doesn't: for P = 35,000.07 it uses the 20,001–35,000 band and still gives the rebate (golden case MTD-04: 16.70, not 50.00). We follow the calculator, because that's what employers and LHDN's auditors check payroll against. The band and the rebate are picked on ⌊P⌋, and the cents still count in (P − M). EPF, SOCSO and EIS bands are unaffected: they match on `above < x <= upTo` using the wage as is.

Evidence and the full reasoning: [golden-cases.md](../golden-cases.md), resolved question 5 (Oct 24, 2026).

## Consequences

- Don't "fix" this to match the spec text. If LHDN changes its calculator, MTD-04 will catch it and this ADR gets superseded.
