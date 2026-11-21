import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import serverJson from "../server.json" with { type: "json" };

// server.json is what the MCP Registry lists; it must describe the npm package being published.
const REGISTRY_DESCRIPTION_MAX_LENGTH = 100;

describe("server.json (MCP Registry metadata)", () => {
  it("matches package.json so a release lists the version it publishes", () => {
    expect(serverJson.name).toBe(pkg.mcpName);
    expect(serverJson.version).toBe(pkg.version);
    expect(serverJson.repository.url).toBe(pkg.homepage.replace(/#readme$/, ""));
    expect(serverJson.packages).toEqual([
      {
        registryType: "npm",
        identifier: pkg.name,
        version: pkg.version,
        transport: { type: "stdio" },
      },
    ]);
  });

  it("keeps the description within the registry's limit", () => {
    expect(serverJson.description.length).toBeLessThanOrEqual(REGISTRY_DESCRIPTION_MAX_LENGTH);
  });
});
