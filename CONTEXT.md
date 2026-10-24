# Malaysia payroll statutory calculations

Works out what the law requires to be deducted from, and paid on top of, one resident employee's pay for one month in Malaysia, and cites the rule behind every number.

## Inputs

**Monthly salary**:
The fixed amount an employee earns each month: basic pay plus fixed allowances. It excludes overtime, commission, bonuses and arrears, which v1 doesn't support.
_Avoid_: wages, gross pay, remuneration (each statute defines these differently)

**Pay period**:
The calendar month (YYYY-MM) a salary is paid for. It decides which rate tables apply.
_Avoid_: month, payroll date, pay date

**SKBBK status**:
Whether an employee is covered by SOCSO's 24-hour protection scheme (Lindung 24 Jam) or has been opted out with PERKESO's approval. Everyone is covered by default.
_Avoid_: opt-in, Lindung status

## Rules and data

**Rate table**:
An official schedule of contribution amounts or tax rates, published by EPF, PERKESO or LHDN and in force from one effective date.
_Avoid_: rates file, lookup, schedule (unless you're quoting the source's own title)

**Effective date**:
The first day a rate table applies to.
_Avoid_: start date, valid from, version

**Band**:
One row of a rate table, covering salaries above one amount and up to and including the next.
_Avoid_: bracket, tier, range (for "chargeable income" tax, use **Tax band**)

**Tax band**:
A range of chargeable income that has its own MTD rate and fixed tax amount.
_Avoid_: tax bracket

## Outputs

**Contribution**:
An amount paid to EPF, SOCSO, SKBBK or EIS. It's split into an employee share, which is deducted from pay, and an employer share, which is paid on top.
_Avoid_: deduction (for the employer share), levy

**MTD**:
Monthly Tax Deduction: the income tax an employer withholds each month under LHDN's formula.
_Avoid_: PCB (the Malay name; mention it once for search but don't use it as the term), tax, withholding

**Statutory deduction**:
Any amount the law requires to be taken off a monthly salary: the employee share of each contribution, plus MTD.
_Avoid_: deductions (unqualified)

**Net pay**:
Monthly salary minus every statutory deduction.
_Avoid_: take-home pay, nett

**Citation**:
The record behind one output number: the rule applied, the rate-table band used if there was one, the source document and its effective date.
_Avoid_: reference, source (on its own)

## Verification

**Golden case**:
A hand-worked input and expected output, taken from an official table or worked example, that the calculations must reproduce exactly.
_Avoid_: fixture, sample, test vector
