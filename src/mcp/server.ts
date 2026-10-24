import { McpServer } from "@modelcontextprotocol/server";
import { VERSION } from "../version.js";
import { registerTableResources } from "./resources.js";
import { registerEpfTool } from "./tools/epf.js";
import { registerSocsoEisTool } from "./tools/socso-eis.js";

export const SERVER_NAME = "malaysia-payroll-mcp";

/** Builds a fresh server. Tools and resources are registered here as they land. */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: VERSION },
    { capabilities: { tools: {}, resources: {} } },
  );
  registerEpfTool(server);
  registerSocsoEisTool(server);
  registerTableResources(server);
  return server;
}
