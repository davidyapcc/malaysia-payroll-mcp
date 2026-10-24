import { describe, expect, it } from "vitest";
import { type Citation, renderExplanation } from "../../src/core/citation.js";

const source = { title: "Test schedule", url: "https://example.com", retrieved: "2026-10-23" };

describe("renderExplanation", () => {
  it("renders one sentence group per citation, from the citation alone", () => {
    const citations: Citation[] = [
      {
        item: "EPF",
        employee: 330,
        employer: 390,
        rule: "Part A applies.",
        tableRow: "Part A, RM2,980.01 to RM3,000.00",
        source,
        effectiveFrom: "2025-10-01",
      },
      {
        item: "EIS",
        employee: 0,
        employer: 0,
        rule: "Not covered.",
        source,
        effectiveFrom: "2024-10-01",
      },
    ];
    expect(renderExplanation(citations)).toBe(
      [
        "EPF: employee RM330.00, employer RM390.00. Part A applies. Table row: Part A, RM2,980.01 to RM3,000.00. Source: Test schedule, in effect from 2025-10-01.",
        "EIS: employee RM0.00, employer RM0.00. Not covered. Source: Test schedule, in effect from 2024-10-01.",
      ].join("\n"),
    );
  });
});
