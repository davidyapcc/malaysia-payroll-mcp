import { McpServer } from "@modelcontextprotocol/server";
import { VERSION } from "../version.js";

export const SERVER_NAME = "malaysia-payroll-mcp";

/** Builds a fresh server. Tools and resources are registered here as they land. */
export function createServer(): McpServer {
  return new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );
}
