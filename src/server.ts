// willhaben-mcp server assembly (MCP protocol revision 2026-07-28).
//
// Registered per instance by `createServer()` so the same factory can serve
// both protocol eras: the SDK's stdio entry (`serveStdio`) answers modern
// stateless 2026-07-28 clients and legacy `initialize` clients alike.
//
// What this adds over the pre-2026-07-28 server:
//  - Tool annotations (read-only / idempotent / open-world) and titles
//  - `outputSchema` + `structuredContent` on every tool (typed results)
//  - Cache hints (`ttlMs`/`cacheScope`) on list results and resources
//  - Multi-round-trip location disambiguation (`input_required` elicitation,
//    with the SDK's legacy shim covering 2025-era clients automatically)
//  - An MCP Apps results gallery (`ui://willhaben/results.html`)
//  - `willhaben_deep_search` with `notifications/progress` reporting
//  - An MCP prompt (`willhaben-search`) mirroring the bundled slash command

import {
  McpServer,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type ServerContext,
  type ToolAnnotations,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { searchListings, searchRealEstate, searchCars, searchMarketplace } from "./api/search.js";
import { searchJobs } from "./api/jobs.js";
import { getListingDetail } from "./api/detail.js";
import { deepSearch, DEEP_SEARCH_MAX_PAGES, DEEP_SEARCH_MAX_DETAILS } from "./api/deepsearch.js";
import { resolveLocationDetailed, rememberLocationChoice, type AreaCandidate } from "./api/geo.js";
import { REAL_ESTATE_CATEGORIES, MARKETPLACE_CATEGORIES } from "./utils/constants.js";
import { formatSearchResults, formatDetail, formatCategories, formatListings } from "./utils/formatters.js";
import {
  searchInputSchema,
  realEstateInputSchema,
  carsInputSchema,
  jobsInputSchema,
  marketplaceInputSchema,
  getListingInputSchema,
  getCategoriesInputSchema,
  deepSearchInputSchema,
  searchResultSchema,
  detailResultSchema,
  categoriesResultSchema,
  deepSearchResultSchema,
  type SearchResultPayload,
} from "./schemas.js";
import { RESULTS_APP_HTML } from "./generated/appHtml.js";

// Keep in sync with package.json and ui/app.js.
export const SERVER_VERSION = "1.1.0";

// ---------------------------------------------------------------------------
// Shared metadata
// ---------------------------------------------------------------------------

/** Every tool on this server only reads public data from willhaben.at. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  idempotentHint: true,
  openWorldHint: true,
};

/** MCP Apps: the interactive results gallery rendered by capable hosts. */
export const RESULTS_UI_URI = "ui://willhaben/results.html";
const UI_TOOL_META = {
  ui: { resourceUri: RESULTS_UI_URI },
  // Legacy key kept for older MCP Apps hosts.
  "ui/resourceUri": RESULTS_UI_URI,
};

/** Origins the sandboxed app may load images from (willhaben's CDN). */
const UI_CSP = {
  resourceDomains: ["https://cache.willhaben.at", "https://www.willhaben.at"],
};

const INSTRUCTIONS = [
  "Search willhaben.at (Austria's largest classifieds marketplace) across real estate, cars, jobs, and the second-hand marketplace.",
  "Use the vertical-specific search tools for filtered searches, `willhaben_get_listing` for full details on one ad, and `willhaben_deep_search` to scan several pages and pull details for the best-value matches in one call.",
  "Location inputs accept Austrian states, cities, places, and postal codes; ambiguous names may trigger a follow-up question.",
  "The server is polite by design (1 request/second, response cache); keep result counts modest. Personal, non-commercial use only — see the project DISCLAIMER.",
].join(" ");

// ---------------------------------------------------------------------------
// Interactive location resolution (multi-round-trip elicitation)
// ---------------------------------------------------------------------------

const AREA_INPUT_KEY = "willhaben_area";

type LocationOutcome =
  | { status: "ok"; areaId?: string; note?: string }
  | { status: "ask"; result: InputRequiredResult }
  | { status: "cancelled" };

function candidateLabel(candidate: AreaCandidate): string {
  return `${candidate.label} (${candidate.group})`;
}

function clientSupportsElicitation(server: McpServer): boolean {
  try {
    return server.server.getClientCapabilities()?.elicitation !== undefined;
  } catch {
    return false;
  }
}

/**
 * Resolve a free-text location, asking the user which area they meant when
 * the willhaben autocomplete returns several distinct matches and the client
 * supports elicitation. Falls back to the best candidate (the previous
 * behavior) on clients without elicitation support.
 */
async function resolveLocationInteractive(
  server: McpServer,
  location: string | undefined,
  ctx: ServerContext
): Promise<LocationOutcome> {
  if (!location) return { status: "ok" };

  const resolution = await resolveLocationDetailed(location);

  if (resolution.kind === "resolved") {
    return { status: "ok", areaId: resolution.areaId };
  }
  if (resolution.kind === "unresolved") {
    return { status: "ok", note: `Location "${location}" could not be resolved to a willhaben area; searching all of Austria.` };
  }

  // Ambiguous. Did the retry carry the user's answer?
  const labels = resolution.candidates.map(candidateLabel);
  const answer = inputResponse(ctx.mcpReq.inputResponses, AREA_INPUT_KEY);

  if (answer.kind === "elicit") {
    if (answer.action === "decline") {
      return { status: "ok", note: `Location filter skipped (declined); searching all of Austria.` };
    }
    if (answer.action === "cancel") {
      return { status: "cancelled" };
    }
    const picked = typeof answer.content?.area === "string" ? answer.content.area : undefined;
    const chosen = resolution.candidates.find((c) => candidateLabel(c) === picked);
    if (chosen) {
      rememberLocationChoice(location, chosen.areaId);
      return { status: "ok", areaId: chosen.areaId, note: `Location "${location}" resolved to ${chosen.label} (${chosen.group}).` };
    }
    // Unexpected echo — fall through to the non-interactive fallback below.
  }

  if (answer.kind === "missing" && clientSupportsElicitation(server)) {
    return {
      status: "ask",
      result: inputRequired({
        inputRequests: {
          [AREA_INPUT_KEY]: inputRequired.elicit({
            message: `"${location}" matches several areas on willhaben. Which one did you mean?`,
            requestedSchema: {
              type: "object",
              properties: {
                area: {
                  type: "string",
                  title: "Area",
                  description: "The willhaben area to search in",
                  enum: labels,
                },
              },
              required: ["area"],
            },
          }),
        },
      }),
    };
  }

  // No elicitation support (or an unusable answer): keep the historical
  // behavior of using the best-group candidate, but say so.
  const first = resolution.candidates[0];
  rememberLocationChoice(location, first.areaId);
  const others = resolution.candidates.slice(1).map(candidateLabel).join(", ");
  return {
    status: "ok",
    areaId: first.areaId,
    note: `Location "${location}" matched several areas; using ${first.label} (${first.group}).${others ? ` Other matches: ${others}.` : ""}`,
  };
}

const CANCELLED_RESULT: CallToolResult = {
  content: [{ type: "text", text: "Search cancelled — no area was selected." }],
  isError: true,
};

// ---------------------------------------------------------------------------
// Result assembly helpers
// ---------------------------------------------------------------------------

/** Strip undefined values so the query echo in structuredContent stays clean. */
function cleanArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

interface RawSearchResult {
  total: number;
  page: number;
  rows_per_page: number;
  listings: SearchResultPayload["listings"];
  vertical: string;
  description?: string;
}

function searchToolResult(
  tool: string,
  args: Record<string, unknown>,
  result: RawSearchResult,
  locationNote?: string
): CallToolResult {
  const payload: SearchResultPayload = {
    query: { tool, args: cleanArgs(args) },
    total: result.total,
    page: result.page,
    rows_per_page: result.rows_per_page,
    vertical: result.vertical,
    ...(result.description !== undefined ? { description: result.description } : {}),
    ...(locationNote !== undefined ? { location_note: locationNote } : {}),
    listings: result.listings,
  };

  const text = [
    formatSearchResults(result.total, result.page, result.rows_per_page, result.listings, result.vertical, result.description),
    ...(locationNote ? ["", `ℹ️ ${locationNote}`] : []),
  ].join("\n");

  return { content: [{ type: "text", text }], structuredContent: payload };
}

function errorResult(prefix: string, error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: `${prefix}: ${error instanceof Error ? error.message : String(error)}` }],
    isError: true,
  };
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "willhaben",
      version: SERVER_VERSION,
      title: "willhaben.at search",
      description:
        "Search willhaben.at - Austria's largest classifieds marketplace. Search real estate, cars, jobs, and marketplace listings.",
      websiteUrl: "https://github.com/aliildan/willhaben-mcp",
    },
    {
      instructions: INSTRUCTIONS,
      // The tool/prompt/resource sets are static for the lifetime of the
      // process, so clients may cache the lists aggressively (SEP-2549).
      cacheHints: {
        "tools/list": { ttlMs: 6 * 60 * 60 * 1000, cacheScope: "public" },
        "prompts/list": { ttlMs: 6 * 60 * 60 * 1000, cacheScope: "public" },
        "resources/list": { ttlMs: 6 * 60 * 60 * 1000, cacheScope: "public" },
        "server/discover": { ttlMs: 60 * 60 * 1000, cacheScope: "public" },
      },
    }
  );

  // -------------------------------------------------------------------------
  // Tool 1: willhaben_search — universal search
  // -------------------------------------------------------------------------
  server.registerTool(
    "willhaben_search",
    {
      title: "Search willhaben (all verticals)",
      description:
        "Search willhaben.at across all verticals (marketplace, real estate, cars, jobs). Returns listing summaries with prices, locations, and key attributes.",
      inputSchema: searchInputSchema,
      outputSchema: searchResultSchema,
      annotations: READ_ONLY,
      _meta: UI_TOOL_META,
    },
    async (params, ctx) => {
      try {
        let areaId: string | undefined;
        let note: string | undefined;

        if (params.vertical === "jobs") {
          if (params.location) {
            note = "The jobs API does not support location filtering — include the place in `keyword` instead.";
          }
        } else {
          const outcome = await resolveLocationInteractive(server, params.location, ctx);
          if (outcome.status === "ask") return outcome.result;
          if (outcome.status === "cancelled") return CANCELLED_RESULT;
          areaId = outcome.areaId;
          note = outcome.note;
        }

        const result = await searchListings({
          vertical: params.vertical,
          keyword: params.keyword,
          category: params.category,
          location: params.location,
          area_id: areaId,
          price_from: params.price_from,
          price_to: params.price_to,
          sort: params.sort,
          rows: Math.min(params.rows ?? 30, 100),
          page: params.page ?? 1,
        });

        return searchToolResult("willhaben_search", { ...params, area_id: areaId }, result, note);
      } catch (error) {
        return errorResult("Error searching willhaben", error);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 2: willhaben_search_real_estate
  // -------------------------------------------------------------------------
  server.registerTool(
    "willhaben_search_real_estate",
    {
      title: "Search real estate",
      description:
        "Search willhaben.at real estate listings (apartments, houses for sale/rent). Filter by property type, price, rooms, area, and location.",
      inputSchema: realEstateInputSchema,
      outputSchema: searchResultSchema,
      annotations: READ_ONLY,
      _meta: UI_TOOL_META,
    },
    async (params, ctx) => {
      try {
        const outcome = await resolveLocationInteractive(server, params.location, ctx);
        if (outcome.status === "ask") return outcome.result;
        if (outcome.status === "cancelled") return CANCELLED_RESULT;

        const result = await searchRealEstate({
          property_type: params.property_type,
          action: params.action,
          location: params.location,
          area_id: outcome.areaId,
          price_from: params.price_from,
          price_to: params.price_to,
          rooms: params.rooms,
          area_from: params.area_from,
          area_to: params.area_to,
          sort: params.sort,
          rows: Math.min(params.rows ?? 30, 100),
          page: params.page ?? 1,
        });

        return searchToolResult("willhaben_search_real_estate", { ...params, area_id: outcome.areaId }, result, outcome.note);
      } catch (error) {
        return errorResult("Error searching real estate", error);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 3: willhaben_search_cars
  // -------------------------------------------------------------------------
  server.registerTool(
    "willhaben_search_cars",
    {
      title: "Search cars",
      description:
        "Search willhaben.at car listings (used cars, new cars). Filter by make, model, price, year, mileage, fuel type, and transmission.",
      inputSchema: carsInputSchema,
      outputSchema: searchResultSchema,
      annotations: READ_ONLY,
      _meta: UI_TOOL_META,
    },
    async (params, ctx) => {
      try {
        const outcome = await resolveLocationInteractive(server, params.location, ctx);
        if (outcome.status === "ask") return outcome.result;
        if (outcome.status === "cancelled") return CANCELLED_RESULT;

        const result = await searchCars({
          make: params.make,
          model: params.model,
          location: params.location,
          area_id: outcome.areaId,
          price_from: params.price_from,
          price_to: params.price_to,
          year_from: params.year_from,
          year_to: params.year_to,
          mileage_from: params.mileage_from,
          mileage_to: params.mileage_to,
          fuel_type: params.fuel_type,
          transmission: params.transmission,
          condition: params.condition,
          sort: params.sort,
          rows: Math.min(params.rows ?? 30, 100),
          page: params.page ?? 1,
        });

        return searchToolResult("willhaben_search_cars", { ...params, area_id: outcome.areaId }, result, outcome.note);
      } catch (error) {
        return errorResult("Error searching cars", error);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 4: willhaben_search_jobs
  // -------------------------------------------------------------------------
  server.registerTool(
    "willhaben_search_jobs",
    {
      title: "Search jobs",
      description: "Search willhaben.at job listings. Filter by keyword and job type.",
      inputSchema: jobsInputSchema,
      outputSchema: searchResultSchema,
      annotations: READ_ONLY,
      _meta: UI_TOOL_META,
    },
    async (params) => {
      try {
        const result = await searchJobs({
          keyword: params.keyword,
          job_type: params.job_type,
          sort: params.sort,
          rows: Math.min(params.rows ?? 30, 100),
          page: params.page ?? 1,
        });

        return searchToolResult("willhaben_search_jobs", { ...params }, result);
      } catch (error) {
        return errorResult("Error searching jobs", error);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 5: willhaben_search_marketplace
  // -------------------------------------------------------------------------
  server.registerTool(
    "willhaben_search_marketplace",
    {
      title: "Search marketplace",
      description:
        "Search willhaben.at marketplace (Marktplatz) for second-hand items. Filter by keyword, category, condition, price, and location.",
      inputSchema: marketplaceInputSchema,
      outputSchema: searchResultSchema,
      annotations: READ_ONLY,
      _meta: UI_TOOL_META,
    },
    async (params, ctx) => {
      try {
        const outcome = await resolveLocationInteractive(server, params.location, ctx);
        if (outcome.status === "ask") return outcome.result;
        if (outcome.status === "cancelled") return CANCELLED_RESULT;

        const result = await searchMarketplace({
          keyword: params.keyword,
          category: params.category,
          condition: params.condition,
          location: params.location,
          area_id: outcome.areaId,
          price_from: params.price_from,
          price_to: params.price_to,
          sort: params.sort,
          rows: Math.min(params.rows ?? 30, 100),
          page: params.page ?? 1,
        });

        return searchToolResult("willhaben_search_marketplace", { ...params, area_id: outcome.areaId }, result, outcome.note);
      } catch (error) {
        return errorResult("Error searching marketplace", error);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 6: willhaben_deep_search — multi-page scan + top-N details
  // -------------------------------------------------------------------------
  server.registerTool(
    "willhaben_deep_search",
    {
      title: "Deep search (scan + rank + details)",
      description:
        `Thorough search in one call: scans up to ${DEEP_SEARCH_MAX_PAGES} result pages, deduplicates and ranks all listings (e.g. by €/m² for real estate), then fetches full details for the top ${DEEP_SEARCH_MAX_DETAILS} matches. ` +
        "Runs at the polite built-in rate limit (~1 request/second), so expect roughly one second per page/detail; progress is reported while it works. Ideal for apartment hunting and bargain scanning.",
      inputSchema: deepSearchInputSchema,
      outputSchema: deepSearchResultSchema,
      annotations: READ_ONLY,
      _meta: UI_TOOL_META,
    },
    async (params, ctx) => {
      try {
        const outcome = await resolveLocationInteractive(server, params.location, ctx);
        if (outcome.status === "ask") return outcome.result;
        if (outcome.status === "cancelled") return CANCELLED_RESULT;

        const progressToken = (ctx.mcpReq._meta as { progressToken?: string | number } | undefined)?.progressToken;
        const onProgress =
          progressToken !== undefined
            ? async (progress: number, total: number, message: string) => {
                try {
                  await ctx.mcpReq.notify({
                    method: "notifications/progress",
                    params: { progressToken, progress, total, message },
                  });
                } catch {
                  // Progress is best-effort; never fail the search over it.
                }
              }
            : undefined;

        const result = await deepSearch(
          {
            vertical: params.vertical,
            keyword: params.keyword,
            category: params.category,
            location: params.location,
            area_id: outcome.areaId,
            price_from: params.price_from,
            price_to: params.price_to,
            sort: params.sort,
            pages: params.pages,
            detail_limit: params.detail_limit,
            rank_by: params.rank_by,
          },
          { signal: ctx.mcpReq.signal, onProgress }
        );

        const payload = {
          query: { tool: "willhaben_deep_search", args: cleanArgs({ ...params, area_id: outcome.areaId }) },
          total: result.total,
          scanned_pages: result.scanned_pages,
          scanned_listings: result.scanned_listings,
          vertical: result.vertical,
          ...(result.description !== undefined ? { description: result.description } : {}),
          ...(outcome.note !== undefined ? { location_note: outcome.note } : {}),
          ranked_by: result.ranked_by,
          listings: result.listings,
          details: result.details,
        };

        const text = [
          `## Deep Search${result.description ? `: ${result.description}` : ""}`,
          "",
          `Scanned **${result.scanned_pages}** page(s) → **${result.scanned_listings}** distinct listings (of ${result.total.toLocaleString()} total), ranked by **${result.ranked_by}**. Full details fetched for the top **${result.details.length}**.`,
          ...(outcome.note ? [`ℹ️ ${outcome.note}`] : []),
          "",
          "### Top matches",
          formatListings(result.listings.slice(0, 10)),
          "",
          `Full attribute sets, images, seller and address info for the top ${result.details.length} listings are in \`structuredContent.details\`.`,
        ].join("\n");

        return { content: [{ type: "text", text }], structuredContent: payload };
      } catch (error) {
        return errorResult("Error in deep search", error);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 7: willhaben_get_listing
  // -------------------------------------------------------------------------
  server.registerTool(
    "willhaben_get_listing",
    {
      title: "Get listing details",
      description:
        "Get full details for a specific willhaben.at listing by ID. Returns all attributes, images, seller info, contact details, and description.",
      inputSchema: getListingInputSchema,
      outputSchema: detailResultSchema,
      annotations: READ_ONLY,
      _meta: UI_TOOL_META,
    },
    async (params) => {
      try {
        const detail = await getListingDetail(params.id);

        if (!detail) {
          return {
            content: [{ type: "text", text: `Listing ${params.id} not found. Make sure the ID is correct.` }],
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: formatDetail(detail) }],
          structuredContent: { listing: detail },
        };
      } catch (error) {
        return errorResult("Error getting listing detail", error);
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool 8: willhaben_get_categories
  // -------------------------------------------------------------------------
  server.registerTool(
    "willhaben_get_categories",
    {
      title: "List categories",
      description: "Get available category paths for a willhaben.at vertical. Use these categories in search queries.",
      inputSchema: getCategoriesInputSchema,
      outputSchema: categoriesResultSchema,
      annotations: READ_ONLY,
    },
    async (params) => {
      try {
        const toEntries = (map: Record<string, { path: string; name: string }>) =>
          Object.entries(map).map(([key, cat]) => ({ key, path: cat.path, name: cat.name }));

        if (params.vertical === "real_estate") {
          return {
            content: [{ type: "text", text: formatCategories("Real Estate", REAL_ESTATE_CATEGORIES) }],
            structuredContent: { vertical: "real_estate", categories: toEntries(REAL_ESTATE_CATEGORIES) },
          };
        }

        if (params.vertical === "marketplace") {
          return {
            content: [{ type: "text", text: formatCategories("Marketplace", MARKETPLACE_CATEGORIES) }],
            structuredContent: { vertical: "marketplace", categories: toEntries(MARKETPLACE_CATEGORIES) },
          };
        }

        if (params.vertical === "cars") {
          return {
            content: [
              {
                type: "text",
                text: `## Cars Categories\n\n- **gebrauchtwagenboerse** (Used cars): Main car search category\n\nUse "willhaben_search_cars" with make, model, and other filters for detailed car searches.`,
              },
            ],
            structuredContent: {
              vertical: "cars",
              categories: [{ key: "gebrauchtwagenboerse", path: "gebrauchtwagenboerse", name: "Used cars (main category)" }],
              note: "Use willhaben_search_cars with make/model and filters; categories are not needed.",
            },
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `## Jobs Categories\n\nJobs on willhaben.at can be searched with keyword and location filters.\nUse "willhaben_search_jobs" with keyword and job_type parameters.\n\nJob types: Vollzeit, Teilzeit, etc.`,
            },
          ],
          structuredContent: {
            vertical: "jobs",
            categories: [],
            note: "Jobs have no category tree; search with keyword and job_type (Vollzeit, Teilzeit, ...).",
          },
        };
      } catch (error) {
        return errorResult("Error getting categories", error);
      }
    }
  );

  // -------------------------------------------------------------------------
  // MCP App: interactive results gallery
  // -------------------------------------------------------------------------
  server.registerResource(
    "willhaben-results-app",
    RESULTS_UI_URI,
    {
      title: "willhaben results gallery",
      description: "Interactive card gallery for willhaben search results and listing details (MCP Apps).",
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { csp: UI_CSP } },
      cacheHint: { ttlMs: 24 * 60 * 60 * 1000, cacheScope: "public" },
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/html;profile=mcp-app",
          text: RESULTS_APP_HTML,
          _meta: { ui: { csp: UI_CSP } },
        },
      ],
    })
  );

  // -------------------------------------------------------------------------
  // Prompt: natural-language search → comparison table
  // -------------------------------------------------------------------------
  server.registerPrompt(
    "willhaben-search",
    {
      title: "Search willhaben from natural language",
      description: "Turn a natural-language request into the right willhaben tool call and a clean comparison table.",
      argsSchema: z.object({
        query: z
          .string()
          .describe("e.g. '2-room apartment in Graz under 300k' | 'used BMW diesel automatic under 15k' | 'iPhone 15 in Wien'"),
      }),
    },
    ({ query }) => ({
      description: `willhaben search: ${query}`,
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "You are a willhaben.at search assistant. Turn the request below into the right willhaben MCP tool call(s) and present the results as a clean, scannable comparison table.",
              "",
              `## Request\n\n${query}`,
              "",
              "## Steps",
              "1. Pick the vertical: real_estate (apartment/Wohnung/house/rent/m²/rooms) → willhaben_search_real_estate; cars (brand/model, diesel/petrol, km, automatic) → willhaben_search_cars; jobs → willhaben_search_jobs; anything else → willhaben_search_marketplace.",
              "2. Map filters: 'under/below X' → price_to, 'over/from X' → price_from (parse 300k/€300.000 → 300000); location → `location` (jobs: fold the place into `keyword` instead); real estate: rooms/area_from/area_to/property_type/action; cars: make/model/year_from/year_to/mileage_to/fuel_type/transmission/condition. Default sort 'newest'; keep rows modest (12).",
              "3. For a thorough value hunt ('best deal', 'compare', 'find me the best...'), prefer willhaben_deep_search with rank_by 'price_per_m2' (real estate) or 'price_asc'.",
              "4. Present a markdown table (columns per vertical: real estate # · Title · Price · €/m² · Size · Rooms · Location · Link; cars # · Title · Price · Year · km · Fuel · Gearbox · Location · Link; jobs # · Title · Company · Location · Type · Link; marketplace # · Title · Price · Condition · Location · Link). Below the table: total match count and a one-line verdict naming the best 1–2 options and any red flags.",
              "5. If asked for more on a row, call willhaben_get_listing with that id.",
              "",
              "Keep result counts modest and don't bulk-paginate: personal, non-commercial use only.",
            ].join("\n"),
          },
        },
      ],
    })
  );

  return server;
}
