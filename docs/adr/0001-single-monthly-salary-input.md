# v1 takes a single monthly salary, not separate wage figures per statute

EPF, SOCSO, EIS and LHDN each define "wages" or "remuneration" differently. Overtime, for example, counts for SOCSO and EIS but not for EPF. Getting this right needs a separate input for each pay component, plus the rules for which statute counts which component. That's a lot of input surface for an agent to fill in correctly, and it isn't what v1 is about. So v1 accepts one **monthly salary** (basic pay plus fixed allowances; see [CONTEXT.md](../../CONTEXT.md)), uses it as the wage for every statute, and says in the README and tool descriptions that overtime, commission, bonuses and arrears aren't supported.

## Consequences

- Results are exact for fixed-salary employees, and wrong for anyone with variable pay. The disclaimer has to say so, not just "not tax advice".
- Adding pay components later is a breaking change to the tool schemas (a major version), not a new optional field. Optional fields would silently keep the old, wrong behaviour for callers that don't send them.
