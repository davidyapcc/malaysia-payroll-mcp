# Official sources

Roadmap task 0.2. Every rate table in `malaysia-payroll-mcp` must trace back to a row here. Retrieved Oct 23, 2026.

**Status key:** ✅ read from the official source · ⚠️ from secondary sources only, so check it against the official PDF before you code it

## EPF (KWSP): Third Schedule, EPF Act 1991

| Item | Value | Status |
| --- | --- | --- |
| Current schedule | [Third Schedule from 1 Oct 2025](https://www.kwsp.gov.my/documents/d/guest/third_schedule_from_-1-october-2025) | ✅ |
| Previous schedule | [Third Schedule from 1 Jul 2022](https://www.kwsp.gov.my/documents/d/guest/third_schedule_from_-1-july-2022) (wage months Jul 2022 to Sep 2025) | ✅ |
| PDF read in full | 55 pages, read Oct 23, 2026 from the copy you uploaded | ✅ |
| Machine-readable copy | [`data/epf-third-schedule-from-2025-10-01.csv`](data/epf-third-schedule-from-2025-10-01.csv): Parts A, C and E, 401 bands each, RM0.01 to RM20,000 | ✅ every row passes `employer + employee = total`, and the bands are contiguous |
| Rules page | [KWSP: Employer mandatory contribution](https://www.kwsp.gov.my/en/employer/responsibilities/mandatory-contribution) | ✅ |

Rates (employee / employer), effective 1 Oct 2025:

| Part | Who | Wages | Below 60 | 60 and above |
| --- | --- | --- | --- | --- |
| A | Malaysian, PR, or non-Malaysian registered before 1 Aug 1998 | ≤ RM5,000 | 11% / 13% | — |
| A | same | > RM5,000 | 11% / 12% | — |
| C | PR, or non-Malaysian registered before 1 Aug 1998 | ≤ RM5,000 / > RM5,000 | — | 5.5% / 6.5%, 5.5% / 6% |
| E | Malaysian | any | — | 0% / 4% |
| F | Non-Malaysian registered from 1 Aug 1998 | any | 2% / 2% | 2% / 2% |

Structure (from the PDF):

- **Parts B and D were deleted** by Act A1760/2025, so they no longer exist.
- Parts A, C and E each have 401 bands: RM20 wide up to RM5,000, then RM100 wide up to RM20,000.
- **Part F** (non-Malaysians) has no table, just 2% + 2% of wages.
- **Every band amount equals `ceil(rate × band upper limit)` for each side, in whole ringgit.** This holds for all 1,200 bands. For example, Part A RM4,980.01 to RM5,000 gives 13% × 5,000 = RM650 and 11% × 5,000 = RM550. Use it as a test that checks the CSV, but keep the CSV as the source of truth.
- **Bonus rule:** if someone normally earns ≤ RM5,000 and a bonus pushes the month above RM5,000, the employer still pays 13% (or 6.5% under Part C), worked out as a percentage. Bonuses are out of scope for v1, but `explain_calculation` should say so when wages are just above RM5,000.

Rules that matter for the code:

- Up to RM20,000, use the **wage-band amounts in the schedule**, not percentages. Percentages apply only above RM20,000, and to Part F.
- A total that includes cents is **rounded up to the next ringgit**, **for each share separately**. The schedule's own bands do this in all 223 bands where it differs from rounding the combined total (checked Oct 24, 2026), so apply the same rule above RM20,000 and to Part F.
- Contributions are due by the 15th of the following month.

## SOCSO (PERKESO): Employees' Social Security Act 1969 (Act 4)

| Item | Value | Status |
| --- | --- | --- |
| Rates page | [PERKESO: Contribution rate](https://www.perkeso.gov.my/en/rate-of-contribution.html) | ✅ |
| Act 4 table, including SKBBK | [NewContributionRateIncludingSKBBK.pdf](https://www.perkeso.gov.my/images/lindung/lindung-24-jam/NewContributionRateIncludingSKBBK.pdf) | ✅ all 8 pages read on Oct 23, 2026 |
| Machine-readable copy | Split into two tables (decided Oct 24, 2026), because SKBBK's rate changes on its own dates: [`data/socso-act4-from-2024-10-01.csv`](data/socso-act4-from-2024-10-01.csv) (employer and invalidity, 65 bands, in sen) and [`data/skbbk-act4-from-2026-06-01.csv`](data/skbbk-act4-from-2026-06-01.csv) (the SKBBK column, same bands) | ✅ in the PDF every row passes `employer + invalidity + skbbk = total` (cat 1) and `employer + skbbk = total` (cat 2). ✅ All 65 rows of the SOCSO CSV match the pre-SKBBK Act 4 table, checked Oct 24, 2026 (see below) |
| Act 4 table before SKBBK | [151124-Rate Contribution ACT 4.pdf](https://www.perkeso.gov.my/images/dokumen/151124-Rate%20Contribution%20ACT%204.pdf), for wage months from Oct 2024. No longer linked from PERKESO's rates page; a [Feb 2026 web-archive copy](https://web.archive.org/web/20260207013319id_/https://www.perkeso.gov.my/images/dokumen/151124-Rate%20Contribution%20ACT%204.pdf) still has it | ✅ read Oct 24, 2026 from the copy you uploaded. Employer, employee and second-category amounts equal the 2026 table's for all 65 rows, so SKBBK changed nothing else |
| Wage ceiling FAQ | [FAQ: ceiling RM5k to RM6k](https://www.perkeso.gov.my/images/dokumen/011024%20-%20FAQ%20PENINGKATAN%20HAD%20SILING%20GAJI%20DARI%20RM5K%20KEPADA%20RM6K%20DI%20BAWAH%20AKSP%20969%20AKTA%204%20%20ASIP%202017%20AKTA%20800.pdf) | ✅ (linked, not read) |

- Wage ceiling: **RM6,000 from 1 Oct 2024** (it was RM5,000 before). ✅
- First category (employment injury plus invalidity, generally under 60): about 3% of wages in total. Second category (employment injury only, generally 60 and above): about 2%. Top band (wages above RM6,000): RM178.55 and RM119.05 in total. ✅ from the table
- **Lindung 24 Jam / SKBBK (non-employment injury scheme).** See the dedicated section below.

## SKBBK / Lindung 24 Jam (Act 4 amendment, Act A1788)

Researched Oct 23, 2026. ⚠️ No PERKESO primary source could be fetched from here, so everything below comes from secondary sources that agree with each other.

| Item | Finding | Sources |
| --- | --- | --- |
| Legal basis | Act A1788 (gazetted 5 Mar 2026), P.U. (B) 196/2026 | Mercans, pcbcalculator.my |
| Start | Contributions began **1 Jun 2026**, mandatory for all First Category contributors | all |
| Who pays | **Employee only.** The employer's SOCSO and EIS shares are unchanged. | all |
| Rate | **0.75%** from 1 Jun 2026 to 31 May 2028, **1.00%** from 1 Jun 2028, **1.25%** from 1 Jun 2031. Capped at RM6,000 of wages, so the maximum is RM45, RM60 and RM75. | DataOn, pcbcalculator.my |
| Change to voluntary | Cabinet decision on 8 Jul 2026. KESUMA clarified on 9 Jul 2026 that it covers **local employees only**. | Mercans |
| Foreign workers | **Still mandatory.** They can't opt out. | Mercans, DataOn, Swingvy |
| Opt-out mechanics | It's an **opt-out** (not opt-in) system. The first window ran from 13 Jul to 31 Aug 2026, and **doing nothing kept you in**. New local employees have **30 days from PERKESO registration** to opt out. An employee who opted out can opt back in, but generally can't opt out again. Employers keep deducting until PERKESO approves the opt-out. | JustLogin, DataOn, Swingvy |
| June/July deductions already taken | No refund rule found | Mercans, pcbcalculator.my |
| Amounts per band | ✅ **Published as their own column** in the Act 4 table, and the same for both categories. They range from RM0.20 (wages up to RM30) to **RM44.65** (wages above RM5,900). See the CSV. | PERKESO PDF |

Note: early reports (around Jul 8 to 10) described it as *opt-in*. The later employer guidance (JustLogin, DataOn, Swingvy) agrees on *opt-out*, with coverage on by default. We go with that.

Sources: [Mercans: made voluntary](https://mercans.com/resources/statutory-alerts/malaysia-skbbk-lindung-24-jam-contribution-made-voluntary-for-local-employees-8-july-2026/) · [Mercans: opt-out form](https://mercans.com/resources/statutory-alerts/malaysia-skbbk-lindung-24-jam-opt-out-form-now-available-13-july-2026/) · [DataOn](https://dataon.com/en-my/blog/lindung-24-jam-skbbk-socso/) · [JustLogin](https://www.justlogin.com.my/blogpost/skbbk-lindung-24-jam-opt-out-2026) · [JustLogin help](https://support.justlogin.com/hc/en-us/articles/59401393385369-Malaysia-SKBBK) · [Swingvy](https://help.swingvy.com/knowledge/socso-invalidity-and-skbbk) · [pcbcalculator.my](https://pcbcalculator.my/blog/lindung-24-jam-now-voluntary-july-2026)

### How the tool should model it

- Input `skbbkStatus`: `"covered"` (the default) or `"opted_out"`. Reject `"opted_out"` when `citizenship` is non-Malaysian, because foreign workers can't opt out.
- Choose the rate by `payPeriod`: nothing before Jun 2026, then 0.75%, 1.00% from Jun 2028, and 1.25% from Jun 2031. Each is its own `skbbk-*` table file by effective date, separate from the SOCSO table.
- Return SKBBK as its own employee line with its own citation, and never fold it into the SOCSO line.
- **Opted out, or a pay period before Jun 2026:** no SKBBK line. The SOCSO table (employer share and employee invalidity share) is the same either way.
- **Second category (60 and above):** the employee's only SOCSO share is SKBBK. So a local employee aged 60 or over who opted out pays **nothing** to SOCSO, and the employer pays everything. Add this as a golden test case.

## EIS (SIP): Employment Insurance System Act 2017 (Act 800)

| Item | Value | Status |
| --- | --- | --- |
| Act 800 table | [151124-Rate Contribution ACT 800.pdf](https://www.perkeso.gov.my/images/dokumen/151124-Rate%20Contribution%20ACT%20800.pdf) | ✅ read from the PDF on Oct 23, 2026 |
| Machine-readable copy | [`data/eis-act800-from-2024-10-01.csv`](data/eis-act800-from-2024-10-01.csv) (65 bands, in sen) | ✅ all 65 rows checked against the PDF on Oct 24, 2026 |

- 65 wage bands. Employer and employee pay the same amount. ✅
- Bands 1 to 9 (up to RM500) are irregular: 5, 10, 15, 20, 25, 35, 50, 70 and 90 sen.
- From RM500, the bands are RM100 wide and each side pays **0.2% of the band midpoint**. For example, RM2,900 to RM3,000 gives RM5.90. Use this as a cross-check in tests, not as the formula: the table is the authority. ✅
- Wages above RM6,000 are capped at **RM11.90 per side (RM23.80 in total)**. ✅
- Covers ages 18 to 60. Not payable if the employee is 57 or older with no EIS contributions before turning 57. Foreign workers are exempt. ⚠️ ([BrioHR](https://briohr.com/blog/eis-contribution-malaysia/))

## MTD / PCB (LHDN): Income Tax (Deduction from Remuneration) Rules 1994

| Item | Value | Status |
| --- | --- | --- |
| 2026 specification | [Spesifikasi Kaedah Pengiraan Berkomputer PCB 2026](https://www.hasil.gov.my/media/arvlrzh5/spesifikasi-kaedah-pengiraan-berkomputer-pcb-2026.pdf) (last updated 1 Jan 2026) | ✅ |

- The formula is **unchanged from 2025**: `MTD = [(P − M) × R + B − (Z + X)] / (n + 1)`, then net MTD is that figure minus the current month's zakat. ✅
- The tax table runs from 0% up to 30%. B values differ by category (1 and 3 vs 2) only in the RM5,001 to RM35,000 bands, because they include the RM400 individual and spouse rebates. ✅
- Reliefs v1 needs: individual RM9,000, spouse RM4,000, child RM2,000 each, and EPF capped at RM4,000. ✅
- **Rounding:** keep 2 decimal places and drop the rest, then round the MTD **up to the next 5 sen**. No deduction if MTD is below RM10 before zakat. ✅
- **Categories** (spec pp. 10 to 11): 1 is single, with no spouse or child relief (C = 0). 2 is married with a spouse who has no income or is jointly assessed: spouse relief RM4,000, and B includes the RM400 spouse rebate. 3 is married with a working spouse, divorced, widowed, or single with an adopted child: child relief but no spouse relief. ✅
- **Children** (spec p. 27): RM2,000 each. Children in diploma-level or higher education count as 4, disabled children as 4, and both as 8. v1 takes only the plain RM2,000 count. ✅
- **The RM10 minimum** is applied after rounding to 5 sen. The spec lists rounding (item 2) before the minimum (item 3) but doesn't say which value the minimum is tested on; the two only differ between RM9.96 and RM9.99. 🟡
- **Not supported in v1:** zakat (Z), additional remuneration such as bonuses (Yt, Kt), and disabled individual or spouse reliefs (DU, SU).
- **Non-residents** (Section D.a, p. 9): a flat 30% of the remuneration, with no reliefs; the spec's example is RM3,000 → RM900 (MTD-06). The spec doesn't say whether Section E's rounding and RM10 minimum apply to them; we apply both. `calculate_mtd` takes `taxResident` (default true), and `calculate_net_pay` requires it for non-Malaysians. Exempt allowances aren't modelled, since the input is a single monthly salary. 🟡
- **TP1 reliefs** (LP1, and ∑LP for earlier months) are taken as one RM total, which is what LHDN's worked examples 3 and 4 use. The caller decides what qualifies and applies each relief's limit, so the 2026 relief changes (vaccines, childcare up to RM3,000, insurance covering children, and so on) need no code. ✅

## Scope impact for v1

1. **`calculate_socso_eis` has to handle SKBBK from June 2026.** See "How the tool should model it" above.
2. EPF Part F (non-Malaysians, 2% each) is a one-row addition. That makes it cheap to support even though v1 is "residents only", because the EPF input already takes citizenship.
3. EPF uses **lookup bands, not percentages**, below RM20,000. So the tables need the full band rows from the PDF. A rate alone isn't enough.

## Still to do (before Phase 1)

- [x] Download the Act 800 (EIS) PDF and confirm the bands (Oct 23, 2026).
- [x] SKBBK opt-out confirmed (user, Oct 23, 2026).
- [x] Research SKBBK rules (Oct 23, 2026): opt-out, default covered, locals only.
- [x] Official per-band SKBBK amounts, taken from the PERKESO Act 4 PDF (Oct 23, 2026).
- [x] Check against the Oct 2024 Act 4 table (before SKBBK) that employer and invalidity amounts didn't change in Jun 2026 (Oct 24, 2026: all 65 rows match).
- [x] All three rate tables (EPF, SOCSO + SKBBK, EIS) are in `docs/data/` as CSV (Oct 23, 2026). They stay there as the source of truth, and Phase 1 generates TS modules from them (ADR 0003).
