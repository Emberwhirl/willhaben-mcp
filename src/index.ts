// Willhaben MCP Server - Main Entry Point (stdio)
//
// `serveStdio` owns the protocol-era decision per connection: modern
// 2026-07-28 stateless clients and legacy `initialize` clients are both
// served from the same factory, so older MCP clients keep working unchanged.
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer, SERVER_VERSION } from "./server.js";

serveStdio(() => createServer(), {
  onerror: (error) => {
    console.error("[willhaben-mcp]", error);
  },
});

console.error(`Willhaben MCP server v${SERVER_VERSION} running on stdio (MCP 2026-07-28 + legacy)`);
