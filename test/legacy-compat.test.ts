// Backward-compatibility test: a 2025-era MCP client (v1 SDK, classic
// `initialize` handshake) against the 2026-07-28 server.
//
// Verifies that `serveStdio`'s era pinning keeps old clients working, and
// that the SDK's legacy shim converts the server's `input_required` returns
// into real server→client `elicitation/create` requests on this era.
//
// Run: npm run build && tsx test/legacy-compat.test.ts

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = join(root, "dist", "index.js");
const fixturesDir = join(root, "test", "fixtures");

let passed = 0;
let failed = 0;
function assert(condition: unknown, label: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    failed++;
    console.error(`  ❌ ${label}`);
  }
}

if (!existsSync(serverPath)) {
  console.error("dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}

console.log("\n== legacy 2025-era client (v1 SDK) against the 2026-07-28 server ==");

const elicitations: string[][] = [];

const client = new Client({ name: "legacy-compat-test", version: "1.0.0" }, { capabilities: { elicitation: {} } });

client.setRequestHandler(ElicitRequestSchema, async (request) => {
  const schema = request.params?.requestedSchema as { properties?: { area?: { enum?: string[] } } } | undefined;
  const options = schema?.properties?.area?.enum ?? [];
  elicitations.push(options);
  const pick = options.find((o) => o.includes("Zaya")) ?? options[0] ?? "";
  return { action: "accept" as const, content: { area: pick } };
});

const transport = new StdioClientTransport({
  command: "node",
  args: [serverPath],
  env: { ...process.env, WILLHABEN_MCP_FIXTURES: fixturesDir } as Record<string, string>,
  cwd: root,
});

try {
  await client.connect(transport);
  assert(true, "legacy initialize handshake accepted");

  const serverVersion = client.getServerVersion();
  assert(serverVersion?.name === "willhaben", `serverInfo.name (got ${serverVersion?.name})`);

  const tools = (await client.listTools()).tools;
  assert(tools.length === 8, `8 tools visible to legacy client (got ${tools.length})`);
  const realEstate = tools.find((t) => t.name === "willhaben_search_real_estate");
  assert(realEstate?.annotations?.readOnlyHint === true, "annotations survive era translation");

  const search = await client.callTool({
    name: "willhaben_search_real_estate",
    arguments: { location: "Graz", rows: 3 },
  });
  const payload = search.structuredContent as { listings?: unknown[]; total?: number } | undefined;
  assert(search.isError !== true, "search succeeds on legacy era");
  assert(payload?.listings?.length === 3, `structuredContent delivered on legacy era (got ${payload?.listings?.length})`);

  const ambiguous = await client.callTool({
    name: "willhaben_search_real_estate",
    arguments: { location: "Neusiedl", rows: 3 },
  });
  const ambiguousPayload = ambiguous.structuredContent as { query?: { args?: { area_id?: string } } } | undefined;
  assert(elicitations.length === 1, `legacy shim delivered a real elicitation/create (got ${elicitations.length})`);
  assert(elicitations[0]?.length === 3, `3 candidates offered (got ${elicitations[0]?.length})`);
  assert(ambiguous.isError !== true, "ambiguous search completes after legacy elicitation");
  assert(ambiguousPayload?.query?.args?.area_id === "31234", `chosen area applied (got ${ambiguousPayload?.query?.args?.area_id})`);
} catch (error) {
  failed++;
  console.error("\n❌ Unhandled legacy test error:", error);
} finally {
  await client.close();
}

console.log(`\n${"=".repeat(50)}\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
