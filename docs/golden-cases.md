# Golden test cases

Drafted Oct 23, 2026. These become `test/golden/cases.json` in Phase 1. That JSON file is then the source of truth, and this page keeps the reasoning behind each case.

**How they were derived.** EPF, SOCSO and EIS amounts are looked up directly in the official tables in [`data/`](data/), and each case cites its row. MTD amounts come from the LHDN 2026 formula (see [sources.md](sources.md#mtd--pcb-lhdn-income-tax-deduction-from-remuneration-rules-1994)). Two implementations, written independently, agree on every MTD case, and both reproduce LHDN's four printed worked examples to the sen (verified Oct 24, 2026). On Oct 24, 2026 all five of our MTD cases were also run through [LHDN's online PCB calculator](https://calcpcbplus.hasil.gov.my/HITS_CE/?lang=EN) (2026 version, no SOCSO/EIS or other TP1 deductions). It agrees on MTD-01, 02, 03 and 05. On MTD-04 it showed our band rule was wrong, and MTD-04 now follows the calculator (resolved question 5).

**Status key:** ✅ read straight from an official table, or verified as described above · 🟡 our interpretation, still to confirm with the issuing body · ❓ depends on an open question

All amounts are in RM. "ee" is the employee share and "er" the employer share.

## EPF (Third Schedule from 1 Oct 2025)

| ID | Input | Expected | Source row | Why this case | Status |
| --- | --- | --- | --- | --- | --- |
| EPF-01 | Malaysian, 30, wages 10.00 | er 0, ee 0 | Part A, 0.01–10.00 (NIL) | Bottom band is nil | ✅ |
| EPF-02 | Malaysian, 30, wages 3,000.00 | er 390, ee 330 | Part A, 2,980.01–3,000.00 | Typical salary | ✅ |
| EPF-03 | Malaysian, 30, wages 5,000.00 | er 650, ee 550 | Part A, 4,980.01–5,000.00 | Last band at the 13% employer rate | ✅ |
| EPF-04 | Malaysian, 30, wages 5,000.01 | er 612, ee 561 | Part A, 5,000.01–5,100.00 | Employer rate drops to 12%; bands widen to RM100 | ✅ |
| EPF-05 | Malaysian, 30, wages 25,000.00 | er 3,000, ee 2,750 | Part A, note above RM20,000 (12% / 11%) | Above RM20,000 it's a percentage, not a table lookup | ✅ |
| EPF-09 | Malaysian, 30, wages 25,000.50 | er 3,001, ee 2,751 (total 5,752) | Part A, note above RM20,000; each share rounded up | Rounding with cents | ✅ inferred from how the schedule's own bands round (see resolved question 1) |
| EPF-06 | PR, 62, wages 4,500.00 | er 293, ee 248 | Part C, 4,480.01–4,500.00 | 60 and over, non-citizen (6.5% / 5.5%) | ✅ |
| EPF-07 | Malaysian, 65, wages 3,000.00 | er 120, ee 0 | Part E, 2,980.01–3,000.00 | Malaysian 60 and over: employer only, 4% | ✅ |
| EPF-08 | Non-Malaysian (registered after 1 Aug 1998), 30, wages 3,500.00 | er 70, ee 70 | Part F (2% / 2%) | Flat percentage, no table | ✅ |

## SOCSO and SKBBK (Act 4 table, from 1 Jun 2026)

| ID | Input | Expected | Source row | Why this case | Status |
| --- | --- | --- | --- | --- | --- |
| SOC-01 | Malaysian, 30, wages 3,000.00, pay period 2026-11, SKBBK covered | er 51.65, ee 14.75, SKBBK 22.15 | Row 34 (2,900–3,000) | Default case | ✅ |
| SOC-02 | Same as SOC-01, but opted out of SKBBK | er 51.65, ee 14.75, SKBBK 0 | Row 34 | Opting out removes only the SKBBK line | ✅ |
| SOC-03 | Malaysian, 62 (second category), wages 3,000.00, opted out | er 36.90, ee 0, SKBBK 0 | Row 34, second category | 60 and over and opted out: the employee pays nothing | ✅ |
| SOC-04 | Malaysian, 30, wages 8,000.00, covered | er 104.15, ee 29.75, SKBBK 44.65 | Row 65 (above 6,000) | Wage ceiling | ✅ |
| SOC-05 | Non-Malaysian without PR, 30, wages 3,000.00, opted out | **Validation error**: foreign workers can't opt out of SKBBK | sources.md, SKBBK section | Input guard | ✅ |
| SOC-06 | Malaysian, 30, wages 3,000.00, pay period **2026-05**, covered | er 51.65, ee 14.75, SKBBK **0** | Row 34 without the SKBBK column | Boundary month: deductions start with June 2026 payroll | ✅ |
| SOC-07 | Non-Malaysian without PR, 30, wages 3,000.00, pay period 2026-11, covered | er 36.90, ee 0, SKBBK 22.15, EIS 0 / 0 | Row 34, second category; SKBBK column | Foreign workers: employment injury only (second category), SKBBK still mandatory, EIS exempt | ✅ confirmed by user, Oct 24, 2026 |

## EIS (Act 800 table, from 1 Oct 2024)

| ID | Input | Expected | Source row | Why this case | Status |
| --- | --- | --- | --- | --- | --- |
| EIS-01 | Malaysian, 30, wages 3,000.00 | er 5.90, ee 5.90 | Row 34 (2,900–3,000) | Typical salary | ✅ |
| EIS-02 | Malaysian, 30, wages 8,000.00 | er 11.90, ee 11.90 | Row 65 (above 6,000) | Wage ceiling | ✅ |
| EIS-03 | Malaysian, 58, `eisPayableBefore57: false` (for example, a former civil servant), wages 3,000.00 | er 0, ee 0 (exempt) | Act 800, First Schedule para 9 | Age exemption | ✅ |
| EIS-04 | Malaysian, 58, `eisPayableBefore57: true` (was in insured work before 57, even if the employer never paid), wages 3,000.00 | er 5.90, ee 5.90 | Act 800, First Schedule para 9; row 34 | The test is whether contributions were *payable*, not whether they were *paid* | ✅ |

## MTD / PCB (LHDN 2026 specification, resident, no zakat, no extra TP1 reliefs)

EPF relief K uses the employee EPF from the table. The annual RM4,000 cap applies to K1 as well as K2: once the running total reaches RM4,000, K1 drops to the remainder and then to 0.

### LHDN's own worked examples (Exhibit 5 of the 2026 spec)

These are the most authoritative MTD cases we have, because LHDN printed the answers. The examples are labelled 2025, but the formula and table are unchanged for 2026. All four use: category 3 (married, spouse working), 3 children, wages 5,500.00, EPF 605.00.

| ID | Month | Extra deductions (LP1) | Expected MTD | Key figures as printed | Status |
| --- | --- | --- | --- | --- | --- |
| LHDN-EX1 | Jan | — | **110.00** | K2 308.63, P 47,000.07 | ✅ |
| LHDN-EX2 | Feb (X 110.00) | — | **110.00** | K2 279.00, P 47,000.00 | ✅ |
| LHDN-EX3 | Mar (X 220.00) | 300.00 | **108.20** | K2 242.77, P 46,700.07 | ✅ |
| LHDN-EX4 | Apr (X 328.20) | 300.00 (ΣLP 300.00 so far) | **106.20** | K2 197.50, P 46,400.00 | ✅ |

### Our cases

| ID | Input | Expected MTD | Key figures | Why this case | Status |
| --- | --- | --- | --- | --- | --- |
| MTD-01 | Single (cat 1), wages 5,000.00, Jan, no YTD | **110.00** | K1 550, K2 313.63, P 47,000.07, band 35,001–50,000 | Typical salary | ✅ |
| MTD-02 | Married, spouse not working (cat 2), 2 children, wages 9,500.00, Jan | **672.50** | K1 1,045, K2 268.63, P 93,000.07, band 70,001–100,000 | Spouse and child reliefs | ✅ |
| MTD-03 | Single, wages 2,500.00, Jan | **0.00** | P 17,700.00, formula gives −22.75 | Low income: the rebate wipes out the tax | ✅ |
| MTD-04 | Single, wages 4,000.00, Jan | **16.70** | P 35,000.07, band picked on ⌊P⌋ = 35,000, so band 20,001–35,000 (M 20,000, R 3%, B 150), rebate 400; tax for the year 200.00 | **The rebate cliff.** Picking the band on P with cents would give **50.00**, which doesn't match LHDN's calculator. | ✅ LHDN calculator, Oct 24, 2026 |
| MTD-05 | As MTD-01, **December**, same salary all year, every earlier MTD deducted (X 1,210.00) | **110.00** | K1 **0** (cap reached in Aug: Aug K1 = 150), P 47,000.00, n 0 | **The EPF cap on K1.** If you forget to cap K1, the result drifts to **36.45** by December. | ✅ |

Worked example, MTD-01: P = (5,000 − 550) + (5,000 − 313.63) × 11 − 9,000 = 47,000.07. Then (47,000.07 − 35,000) × 6% = 720.0042, truncated to 720.00. Add 600 to get 1,320.00, and divide by 12: **110.00**. With the same salary all year, every month comes to 110.00, and the year totals 1,320.00, which is exactly the tax on a chargeable income of 47,000.

How the EPF cap runs through the year for MTD-01 and MTD-05:

| Month | Jan | Feb | Mar | Apr | May | Jun | Jul | Aug | Sep–Dec |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| K1 | 550 | 550 | 550 | 550 | 550 | 550 | 550 | 150 | 0 |
| K2 | 313.63 | 290.00 | 261.11 | 225.00 | 178.57 | 116.66 | 30.00 | 0 | 0 |

### Gaps in the spec, and how we handle them

- **P ≤ 5,000 or a negative result.** The spec gives no rule, so we return 0.00 (MTD-03).
- **P between printed bands** (for example 35,000.07). Pick the band and the rebate using P floored to whole ringgit, as LHDN's calculator does, but keep the cents in (P − M) (MTD-04).
- **The spec has a typo.** Examples 2 and 3 print the EPF limit as "RM 6,000.00 (limit)", but the arithmetic uses RM4,000.00. We use 4,000.

## Net pay (combining the tools above)

| ID | Input | Expected | Breakdown | Status |
| --- | --- | --- | --- | --- |
| NP-01 | Malaysian, 30, single, wages 5,000.00, pay period 2026-11, the same salary all year, SKBBK covered | **net 4,268.20** | EPF 550 + SOCSO 24.75 + SKBBK 37.15 + EIS 9.90 + MTD 110.00 | ✅ |
| NP-02 | Same as NP-01, but opted out of SKBBK | **net 4,305.35** | EPF 550 + SOCSO 24.75 + EIS 9.90 + MTD 110.00 | ✅ |

## Resolved questions (Oct 23, 2026)

Checked against the primary sources: the KWSP guidance, the LHDN 2026 spec, PERKESO, and the gazetted Act 800.

1. **EPF rounding above RM20,000: round each share up separately.** Confirmed Oct 24, 2026 from the Third Schedule itself. The note above RM20,000 says "The total contribution which includes cents shall be rounded to the next ringgit", and the same sentence governs the bands below it. In 223 of the schedule's 1,197 bands, rounding each share and rounding the combined total give different answers, and KWSP's printed amounts match per-share rounding in all 223 and total rounding in none. For example, at RM40 the raw shares are 5.20 and 4.40: KWSP prints 6 + 5 = 11, while rounding the total would give 10. The bonus note uses the same sentence for the employer's share alone, and Form A records each share in whole ringgit, so "total contribution" means each party's contribution. For 25,000.50 that gives 3,001 + 2,751 = **5,752**, not 5,751. Several payroll vendors (Talenox, Worksy, HReasily) paraphrase it as rounding the combined total, but none shows a worked example where the two methods differ. No KWSP email is needed; it remains an optional extra check.
2. **MTD rebate cliff: confirmed, but see question 5 for which side of it 35,000.07 falls on.** LHDN keeps the cents in P (its own example has P = 47,000.07). Its REP and knowledge-worker tables say: "35,000 and below: rebate 400; exceeding 35,000: 0".
3. **SOCSO before June 2026: dropping the SKBBK column is right.** SKBBK is paid by the employee only, and the employer's rates didn't change. Payroll vendors model this as going back to the Oct 2024 policy. May 2026 payroll shows SKBBK at 0 (SOC-06).
4. **EIS age exemption: confirmed** in Act 800, First Schedule para 9. The test is whether contributions were *payable* before 57, not whether they were *paid*. This can't be worked out from date of birth, so it needs its own input (`eisPayableBefore57`). Ignore summaries that limit it to people who were 57 when the Act came into force. The Act text doesn't say that. Take EIS **rates** from the PERKESO table (RM6,000 ceiling), never from the Act PDF (which is as at Sep 2022 and has an RM5,000 ceiling).

## Resolved question 5 (Oct 24, 2026): P between 35,000 and 35,001

For MTD-04, P = 35,000.07. LHDN's online calculator gives **16.70** a month and RM200 for the year. That means it puts P in the 20,001–35,000 band and still gives the RM400 rebate, as if P were floored to whole ringgit or the band were matched on its printed lower bound. Our reading of the spec ("exceeding 35,000: no rebate", with cents kept in P) gives **50.00**. The gap only shows up when P falls between two printed bands, which is less than RM1 wide at each boundary. The other four cases agree with the calculator to the sen.

**Decision (Oct 24, 2026): follow the calculator.** It's what employers and LHDN's auditors check payroll results against. Pick the MTD band and the rebate using P floored to whole ringgit, and keep the cents in (P − M). MTD-04 is 16.70. The architecture rule "match on upper bounds" now applies to EPF, SOCSO and EIS only.

## Next steps

- [x] Verify MTD-01 to MTD-04 (Oct 24, 2026): two independent implementations agree, and both reproduce all 4 LHDN worked examples.
- [x] Run MTD-01 to MTD-05 in LHDN's online calculator (Oct 24, 2026, via a local browser). MTD-01 110.00, MTD-02 672.50, MTD-03 0.00, MTD-05 110.00 all match. MTD-04 doesn't: the calculator gives 16.70.
- [x] Decide question 5 (MTD-04): follow LHDN's calculator, 16.70 (Oct 24, 2026).
- [x] Settle open questions 1 to 4 (Oct 23, 2026).
- [x] Confirm per-share rounding above RM20,000 (EPF-09) from the Third Schedule's own bands (Oct 24, 2026). Emailing KWSP is optional.
- [x] Phase 1: turn the EPF, SOCSO and EIS rows into `test/golden/cases.json` (Oct 24, 2026, roadmap 1.3).
- [ ] Phase 2: add the MTD and net pay rows to `test/golden/cases.json`.
