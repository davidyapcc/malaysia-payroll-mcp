// MCP contract: the rate tables as a client sees them, through an in-memory client.
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TABLE_URI_TEMPLATE } from "../../src/mcp/resources.js";
import { createServer } from "../../src/mcp/server.js";
import { allTables, epfTableFor, skbbkTableFor } from "../../src/tables/index.js";

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

async function readJson(uri: string): Promise<unknown> {
  const { contents } = await client.readResource({ uri });
  expect(contents).toHaveLength(1);
  const [first] = contents as { uri: string; mimeType: string; text: string }[];
  expect(first).toMatchObject({ uri, mimeType: "application/json" });
  return JSON.parse(first?.text ?? "");
}

describe("resources/templates/list", () => {
  it("offers one template for every rate table", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates).toEqual([
      expect.objectContaining({
        name: "rate-table",
        uriTemplate: TABLE_URI_TEMPLATE,
        mimeType: "application/json",
      }),
    ]);
  });
});

describe("resources/list", () => {
  it("lists each generated table once, SKBBK as its own kind", async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual([
      "payroll://tables/eis/2024-10-01",
      "payroll://tables/epf/2025-10-01",
      "payroll://tables/skbbk/2026-06-01",
      "payroll://tables/socso/2024-10-01",
    ]);
    expect(resources).toHaveLength(allTables.length);
    for (const resource of resources) {
      expect(resource.mimeType).toBe("application/json");
      expect(resource.description).toContain("sen");
    }
  });
});

describe("resources/read", () => {
  it.each(allTables.map((t) => [`${t.kind}/${t.effectiveFrom}`, t] as const))(
    "returns %s exactly as generated",
    async (path, table) => {
      expect(await readJson(`payroll://tables/${path}`)).toEqual(table);
    },
  );

  it("serves the table the tools pick for a pay period", async () => {
    expect(await readJson("payroll://tables/epf/2025-10-01")).toEqual(epfTableFor("2026-10"));
    expect(await readJson("payroll://tables/skbbk/2026-06-01")).toEqual(skbbkTableFor("2026-10"));
  });

  it.each([
    "payroll://tables/epf/2024-01-01",
    "payroll://tables/pcb/2025-10-01",
    "payroll://tables/epf/2025-10",
  ])("rejects %s as not found", async (uri) => {
    await expect(client.readResource({ uri })).rejects.toThrow(/not found/i);
  });
});

describe("completion/complete", () => {
  const ref = { type: "ref/resource", uri: TABLE_URI_TEMPLATE } as const;

  it("completes table kinds", async () => {
    const all = await client.complete({ ref, argument: { name: "kind", value: "" } });
    expect(all.completion.values.sort()).toEqual(["eis", "epf", "skbbk", "socso"]);
    const s = await client.complete({ ref, argument: { name: "kind", value: "s" } });
    expect(s.completion.values.sort()).toEqual(["skbbk", "socso"]);
  });

  it("completes effective dates for the chosen kind", async () => {
    const result = await client.complete({
      ref,
      argument: { name: "effectiveFrom", value: "20" },
      context: { arguments: { kind: "skbbk" } },
    });
    expect(result.completion.values).toEqual(["2026-06-01"]);
  });

  it("completes effective dates across kinds when none is chosen", async () => {
    const result = await client.complete({
      ref,
      argument: { name: "effectiveFrom", value: "2024" },
    });
    expect(result.completion.values).toEqual(["2024-10-01"]);
  });
});
