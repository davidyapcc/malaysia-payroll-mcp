#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "../mcp/server.js";

serveStdio(createServer);
