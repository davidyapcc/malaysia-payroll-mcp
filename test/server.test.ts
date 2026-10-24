import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { createServer, SERVER_NAME } from "../src/mcp/server.js";
import { VERSION } from "../src/version.js";

describe("MCP server", () => {
  let client: Client | undefined;

  afterEach(async () => {
    await client?.close();
    client = undefined;
  });

  it("completes the handshake and identifies itself", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer().connect(serverTransport);
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(clientTransport);

    expect(client.getServerVersion()).toMatchObject({ name: SERVER_NAME, version: VERSION });
  });
});
