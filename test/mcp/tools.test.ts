// MCP contract: the tools as an agent sees them, through an in-memory client.
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../../src/mcp/server.js";
import { DISCLAIMER } from "../../src/mcp/tools/shared.js";
import golden from "../golden/cases.json" with { type: "json" };

let client: Client;

beforeEach(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverTransport);
  client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(clientTransport);
});

afterEach(async () => {
  await client.close();
});

function text(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as { type: string; text: string }[];
  return first?.text ?? "";
}

describe("tools/list", () => {
  it("lists every tool with input and output schemas", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "calculate_epf",
      "calculate_mtd",
      "calculate_socso_eis",
    ]);
    for (const tool of tools) {
      expect(tool.outputSchema).toBeDefined();
      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    }
    const epf = tools.find((t) => t.name === "calculate_epf");
    expect(epf?.inputSchema.required).toEqual(["monthlySalary", "age", "citizenship"]);
    const socso = tools.find((t) => t.name === "calculate_socso_eis");
    expect(Object.keys(socso?.inputSchema.properties ?? {})).toEqual([
      "monthlySalary",
      "age",
      "citizenship",
      "skbbkStatus",
      "eisPayableBefore57",
      "payPeriod",
    ]);
    const mtd = tools.find((t) => t.name === "calculate_mtd");
    expect(mtd?.inputSchema.required).toEqual(["monthlySalary", "epfEmployee", "taxCategory"]);
  });
});

describe("calculate_epf", () => {
  it.each(golden.epf.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const result = await client.callTool({ name: "calculate_epf", arguments: c.input });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ...c.expected, disclaimer: DISCLAIMER });
    expect(JSON.parse(text(result))).toEqual(result.structuredContent);
  });

  it("returns a pay period before the schedule as a tool error", async () => {
    const result = await client.callTool({
      name: "calculate_epf",
      arguments: { monthlySalary: 3000, age: 30, citizenship: "malaysian", payPeriod: "2025-09" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("No epf rate table is in effect for pay period 2025-09");
  });

  it("rejects an invalid input before calculating", async () => {
    const result = await client.callTool({
      name: "calculate_epf",
      arguments: { monthlySalary: -1, age: 30, citizenship: "martian" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/monthlySalary|citizenship/);
  });

  it("echoes the defaulted pay period", async () => {
    const result = await client.callTool({
      name: "calculate_epf",
      arguments: { monthlySalary: 3000, age: 30, citizenship: "malaysian" },
    });
    expect(result.structuredContent).toMatchObject({
      payPeriod: expect.stringMatching(/^\d{4}-\d{2}$/),
    });
  });
});

describe("calculate_socso_eis", () => {
  it.each(golden.socsoEis.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const result = await client.callTool({ name: "calculate_socso_eis", arguments: c.input });
    if ("error" in c) {
      expect(result.isError).toBe(true);
      expect(text(result)).toContain(c.error);
    } else {
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ ...c.expected, disclaimer: DISCLAIMER });
    }
  });
});

describe("calculate_mtd", () => {
  it.each(golden.mtd.map((c) => [c.id, c] as const))("%s", async (_id, c) => {
    const result = await client.callTool({ name: "calculate_mtd", arguments: c.input });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ ...c.expected, disclaimer: DISCLAIMER });
    expect(JSON.parse(text(result))).toEqual(result.structuredContent);
  });

  it("accepts same_salary_all_year for the year to date", async () => {
    const result = await client.callTool({
      name: "calculate_mtd",
      arguments: {
        monthlySalary: 5000,
        epfEmployee: 550,
        taxCategory: 1,
        yearToDate: "same_salary_all_year",
        payPeriod: "2026-11",
      },
    });
    expect(result.structuredContent).toMatchObject({
      mtd: 110,
      yearToDate: { remuneration: 50000, epf: 5500, mtd: 1100 },
    });
  });

  it("returns a missing year to date as a tool error the agent can act on", async () => {
    const result = await client.callTool({
      name: "calculate_mtd",
      arguments: { monthlySalary: 5000, epfEmployee: 550, taxCategory: 1, payPeriod: "2026-11" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("yearToDate is required for pay period 2026-11");
  });

  it("rejects a tax category LHDN doesn't have", async () => {
    const result = await client.callTool({
      name: "calculate_mtd",
      arguments: { monthlySalary: 5000, epfEmployee: 550, taxCategory: 4, payPeriod: "2026-01" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("taxCategory");
  });
});
