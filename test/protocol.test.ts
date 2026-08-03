// Offline MCP protocol test (no live willhaben traffic).
//
// Spawns the built server (dist/index.js) over stdio with recorded fixtures
// (WILLHABEN_MCP_FIXTURES) and exercises the 2026-07-28 feature set:
//   - tool annotations, titles, outputSchema, MCP Apps _meta
//   - cache hints (ttlMs/cacheScope) on tools/list (raw wire probe)
//   - structuredContent on search / detail / categories / deep search
//   - multi-round-trip location elicitation (ambiguous location)
//   - notifications/progress from willhaben_deep_search
//   - the ui:// results app resource and the willhaben-search prompt
//
// Run: npm run build && npm run test:protocol

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

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

function section(title: string): void {
  console.log(`\n== ${title} ==`);
}

if (!existsSync(serverPath)) {
  console.error("dist/index.js not found — run `npm run build` first.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Raw wire probe: modern stateless request → cache hints on tools/list
// ---------------------------------------------------------------------------
async function rawWireProbe(): Promise<void> {
  section("raw 2026-07-28 wire: tools/list carries cache hints");

  const child = spawn("node", [serverPath], {
    env: { ...process.env, WILLHABEN_MCP_FIXTURES: fixturesDir },
    stdio: ["pipe", "pipe", "ignore"],
  });

  const envelope = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "raw-probe", version: "0.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  const response = await new Promise<Record<string, unknown> | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000);
    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, newline)));
        } catch {
          resolve(null);
        }
      }
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: envelope } }) + "\n"
    );
  });
  child.kill();

  const result = (response as { result?: { ttlMs?: number; cacheScope?: string; tools?: unknown[] } } | null)?.result;
  assert(result !== undefined && result !== null, "modern stateless request answered without initialize handshake");
  assert(Array.isArray(result?.tools) && result!.tools!.length === 8, `8 tools listed (got ${result?.tools?.length})`);
  assert(result?.ttlMs === 6 * 60 * 60 * 1000, `tools/list ttlMs is 6h (got ${result?.ttlMs})`);
  assert(result?.cacheScope === "public", `tools/list cacheScope is public (got ${result?.cacheScope})`);
}

// ---------------------------------------------------------------------------
// Full client session
// ---------------------------------------------------------------------------
async function clientSession(): Promise<void> {
  const elicitations: Array<{ message: string; options: string[] }> = [];
  const progressMessages: string[] = [];

  const client = new Client(
    { name: "willhaben-protocol-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } }
  );

  client.setRequestHandler("elicitation/create", async (request: any) => {
    const schema = request.params?.requestedSchema;
    const options: string[] = schema?.properties?.area?.enum ?? [];
    elicitations.push({ message: request.params?.message ?? "", options });
    const pick = options.find((o) => o.includes("Zaya")) ?? options[0];
    return { action: "accept", content: { area: pick } };
  });

  client.setNotificationHandler("notifications/progress", (notification: any) => {
    progressMessages.push(String(notification.params?.message ?? ""));
  });

  const transport = new StdioClientTransport({
    command: "node",
    args: [serverPath],
    env: { ...process.env, WILLHABEN_MCP_FIXTURES: fixturesDir } as Record<string, string>,
    cwd: root,
  });

  await client.connect(transport);

  try {
    // -- tools/list metadata ------------------------------------------------
    section("tools/list: annotations, titles, output schemas, app metadata");
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    assert(names.length === 8, `8 tools (got ${names.length}: ${names.join(", ")})`);
    assert(names.includes("willhaben_deep_search"), "willhaben_deep_search is registered");

    const realEstate = tools.find((t) => t.name === "willhaben_search_real_estate");
    assert(realEstate?.annotations?.readOnlyHint === true, "readOnlyHint on search tool");
    assert(realEstate?.annotations?.openWorldHint === true, "openWorldHint on search tool");
    assert(realEstate?.title === "Search real estate", "title on search tool");
    assert(realEstate?.outputSchema !== undefined, "outputSchema on search tool");
    const uiMeta = (realEstate?._meta as { ui?: { resourceUri?: string } } | undefined)?.ui;
    assert(uiMeta?.resourceUri === "ui://willhaben/results.html", "MCP Apps resourceUri on search tool");

    // -- categories (static, no network) ------------------------------------
    section("willhaben_get_categories: structured output");
    const categories = await client.callTool({ name: "willhaben_get_categories", arguments: { vertical: "real_estate" } });
    const catPayload = categories.structuredContent as { vertical: string; categories: Array<{ key: string }> };
    assert(catPayload?.vertical === "real_estate", "structuredContent.vertical");
    assert(catPayload?.categories?.length >= 8, `category entries present (got ${catPayload?.categories?.length})`);

    // -- unambiguous search --------------------------------------------------
    section("search with exact location match (Graz): no elicitation");
    const search = await client.callTool({
      name: "willhaben_search_real_estate",
      arguments: { location: "Graz", rows: 3 },
    });
    const searchPayload = search.structuredContent as any;
    assert(search.isError !== true, "search succeeded");
    assert(searchPayload?.listings?.length === 3, `3 listings (got ${searchPayload?.listings?.length})`);
    assert(searchPayload?.total === 333, `total 333 (got ${searchPayload?.total})`);
    assert(searchPayload?.query?.tool === "willhaben_search_real_estate", "query echo: tool name");
    assert(searchPayload?.query?.args?.area_id === "60101", `query echo: resolved area_id (got ${searchPayload?.query?.args?.area_id})`);
    assert(searchPayload?.listings?.[0]?.price_number === 185000, "listing price_number parsed");
    assert(String(searchPayload?.listings?.[0]?.image_url ?? "").startsWith("https://cache.willhaben.at/"), "listing image_url present");
    assert(elicitations.length === 0, "no elicitation for exact match");

    // -- ambiguous search → MRTR elicitation --------------------------------
    section("ambiguous location (Neusiedl): multi-round-trip elicitation");
    const ambiguous = await client.callTool({
      name: "willhaben_search_real_estate",
      arguments: { location: "Neusiedl", rows: 3 },
    });
    const ambiguousPayload = ambiguous.structuredContent as any;
    assert(elicitations.length === 1, `exactly one elicitation (got ${elicitations.length})`);
    assert(elicitations[0]?.options.length === 3, `3 area candidates offered (got ${elicitations[0]?.options.length})`);
    assert(elicitations[0]?.message.includes("Neusiedl"), "elicitation message names the ambiguous input");
    assert(ambiguous.isError !== true, "search completed after disambiguation");
    assert(ambiguousPayload?.query?.args?.area_id === "31234", `chosen area applied (got ${ambiguousPayload?.query?.args?.area_id})`);
    assert(String(ambiguousPayload?.location_note ?? "").includes("Neusiedl an der Zaya"), "location_note reports the choice");

    // -- listing detail ------------------------------------------------------
    section("willhaben_get_listing: structured detail");
    const detail = await client.callTool({ name: "willhaben_get_listing", arguments: { id: "999" } });
    const detailPayload = detail.structuredContent as any;
    assert(detailPayload?.listing?.id === "999", "listing id");
    assert(detailPayload?.listing?.images?.length === 2, "listing images");
    assert(detailPayload?.listing?.advertiser?.name === "Mustermakler GmbH", "advertiser name");
    assert(detailPayload?.listing?.address?.postcode === "8020", "address postcode");

    // -- deep search ---------------------------------------------------------
    section("willhaben_deep_search: rank by €/m², details, progress");
    const deep = await client.callTool({
      name: "willhaben_deep_search",
      arguments: { vertical: "real_estate", location: "Graz", pages: 1, detail_limit: 1 },
      _meta: { progressToken: "deep-1" },
    } as any);
    const deepPayload = deep.structuredContent as any;
    assert(deep.isError !== true, "deep search succeeded");
    assert(deepPayload?.ranked_by === "price_per_m2", "real estate defaults to price_per_m2 ranking");
    assert(deepPayload?.scanned_listings === 3, `3 distinct listings scanned (got ${deepPayload?.scanned_listings})`);
    assert(deepPayload?.listings?.[0]?.id === "1230000003", `best €/m² listing ranked first (got ${deepPayload?.listings?.[0]?.id})`);
    assert(deepPayload?.details?.length === 1, "one detail fetched");
    assert(progressMessages.length >= 2, `progress notifications received (got ${progressMessages.length})`);

    // -- MCP Apps resource ---------------------------------------------------
    section("ui://willhaben/results.html: MCP Apps resource");
    const resources = (await client.listResources()).resources;
    assert(resources.some((r) => r.uri === "ui://willhaben/results.html"), "app resource listed");
    const appResource = await client.readResource({ uri: "ui://willhaben/results.html" });
    const content = appResource.contents?.[0] as any;
    assert(content?.mimeType === "text/html;profile=mcp-app", `MCP Apps MIME type (got ${content?.mimeType})`);
    assert(String(content?.text ?? "").trimStart().toLowerCase().startsWith("<!doctype html>"), "self-contained HTML document");
    assert(
      JSON.stringify(content?._meta?.ui?.csp?.resourceDomains ?? []).includes("cache.willhaben.at"),
      "CSP allows willhaben image CDN"
    );

    // -- prompt --------------------------------------------------------------
    section("willhaben-search prompt");
    const prompts = (await client.listPrompts()).prompts;
    assert(prompts.some((p) => p.name === "willhaben-search"), "prompt listed");
    const prompt = await client.getPrompt({ name: "willhaben-search", arguments: { query: "2-room flat in Graz under 300k" } });
    const promptText = (prompt.messages?.[0]?.content as { text?: string })?.text ?? "";
    assert(promptText.includes("willhaben_search_real_estate"), "prompt instructs tool usage");
    assert(promptText.includes("2-room flat in Graz under 300k"), "prompt embeds the query");
  } finally {
    await client.close();
  }
}

try {
  await rawWireProbe();
  await clientSession();
} catch (error) {
  failed++;
  console.error("\n❌ Unhandled test error:", error);
}

console.log(`\n${"=".repeat(50)}\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
