// Willhaben HTML Scraper - Extracts __NEXT_DATA__ JSON from willhaben.at pages
import * as cheerio from "cheerio";
import { WILLHABEN_BASE_URL, WILLHABEN_PUBLIC_API, CACHE_TTL_MS } from "../utils/constants.js";
import { httpText, httpJson, resolveWillhabenUrl } from "./httpClient.js";

export { resetRateLimiterForTests } from "./httpClient.js";

interface CacheEntry {
  data: unknown;
  timestamp: number;
}

// Simple in-memory cache, bounded so a long-running session with many unique
// searches doesn't grow without limit (expired entries are also evicted on read).
const CACHE_MAX_ENTRIES = 100;
const cache = new Map<string, CacheEntry>();

function cacheSet(key: string, data: unknown): void {
  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(key)) {
    // Map iterates in insertion order, so the first key is the oldest entry.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { data, timestamp: Date.now() });
}

/**
 * Fetch a willhaben.at page and extract __NEXT_DATA__ JSON
 */
export async function scrapeNextData<T>(urlPath: string): Promise<T> {
  const url = resolveWillhabenUrl(urlPath, WILLHABEN_BASE_URL);

  // Cache keyed on the fully-resolved URL so a relative path and its absolute
  // form don't produce two entries for the same resource.
  const cacheKey = url;
  const cached = cache.get(cacheKey);
  if (cached) {
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.data as T;
    }
    cache.delete(cacheKey);
  }

  const response = await httpText(url, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const data = extractNextData<T>(response.body);

  if (data === null) {
    // The fetch succeeded, so this is not a network or blocking failure: the
    // page itself is unreadable. Markup drift, a truncated body and a bot-check
    // interstitial all land here, and all three used to surface to the user as
    // "0 listings found" — indistinguishable from a genuinely empty market.
    const body = response.body;
    const hasMarker = body.includes("__NEXT_DATA__");
    throw new WillhabenParseError(
      hasMarker ? "invalid_json" : "no_next_data",
      url,
      hasMarker
        ? "found the embedded __NEXT_DATA__ payload but could not parse it"
        : `no embedded __NEXT_DATA__ payload in the response (${body.length} bytes) — ` +
          "willhaben's page markup may have changed, or this request was served a bot check"
    );
  }

  cacheSet(cacheKey, data);

  return data;
}

/**
 * Raised when a page was fetched successfully but its contents could not be
 * understood. This is deliberately distinct from "the search matched nothing":
 * markup drift, an empty body or a bot-check page must never be reported to the
 * caller as an empty market. See `scrapeNextData` / `scrapeSearchResults`.
 */
export class WillhabenParseError extends Error {
  readonly reason: "no_next_data" | "invalid_json" | "unexpected_page_shape" | "not_found";
  readonly url: string;

  constructor(reason: WillhabenParseError["reason"], url: string, detail: string) {
    super(`Could not read willhaben's response for ${url}: ${detail}`);
    this.name = "WillhabenParseError";
    this.reason = reason;
    this.url = url;
  }
}

/**
 * Locate the `__NEXT_DATA__` payload by string scan.
 *
 * This is the primary path, not an optimisation: `cheerio.load` parses the
 * entire document (25-96 ms of blocked event loop on a willhaben result page)
 * to read a single script tag that `indexOf`/`substring` finds in under 3 ms.
 * The id attribute is matched tolerantly so attribute order or quoting changes
 * fall through to the DOM tier below rather than breaking extraction.
 */
function sliceNextDataJson(html: string): string | null {
  const idIdx = html.indexOf('id="__NEXT_DATA__"');
  if (idIdx === -1) return null;

  const openStart = html.lastIndexOf("<script", idIdx);
  if (openStart === -1) return null;

  const openEnd = html.indexOf(">", idIdx);
  if (openEnd === -1) return null;

  const closeIdx = html.indexOf("</script>", openEnd);
  if (closeIdx === -1) return null;

  return html.substring(openEnd + 1, closeIdx);
}

/** Pull `props.pageProps` out of a `__NEXT_DATA__` JSON string. */
function pagePropsFrom<T>(jsonStr: string): { ok: true; data: T } | { ok: false } {
  try {
    const parsed = JSON.parse(jsonStr);
    const pageProps = parsed?.props?.pageProps;
    if (pageProps == null) return { ok: false };
    return { ok: true, data: pageProps as T };
  } catch {
    return { ok: false };
  }
}

/**
 * Extract __NEXT_DATA__ JSON from HTML.
 *
 * Two genuinely different tiers: a string scan first, then a real DOM parse as
 * a fallback (the previous fallback re-scanned the same substring with a
 * *stricter* matcher than the primary path, so it could never rescue anything).
 * Returns `null` when neither tier finds usable data — callers that fetched the
 * page should treat that as a parse failure, not as an empty result.
 */
export function extractNextData<T>(html: string): T | null {
  const scanned = sliceNextDataJson(html);
  if (scanned !== null && scanned.trim() !== "") {
    const result = pagePropsFrom<T>(scanned);
    if (result.ok) return result.data;
  }

  // DOM tier: handles entity-escaped or otherwise awkward markup the scan missed.
  const $ = cheerio.load(html);
  const jsonStr = $("script#__NEXT_DATA__").first().html();
  if (!jsonStr || jsonStr.trim() === "") return null;

  const result = pagePropsFrom<T>(jsonStr);
  return result.ok ? result.data : null;
}

/**
 * Search result page data structure
 */
export interface SearchResultPageProps {
  searchResult?: import("../api/types.js").WillhabenSearchResult;
  initialSearchResult?: import("../api/types.js").WillhabenSearchResult;
  advertDetails?: import("../api/types.js").WillhabenAdDetail;
  searchTerms?: unknown;
  metaTagInfo?: unknown;
  story?: unknown;
  brandedSearch?: unknown;
  is404?: boolean;
}

/**
 * Fetch search results from a willhaben.at page
 */
export async function scrapeSearchResults(
  urlPath: string
): Promise<{ result: import("../api/types.js").WillhabenSearchResult; isInitial: boolean }> {
  const url = resolveWillhabenUrl(urlPath, WILLHABEN_BASE_URL);
  const pageProps = await scrapeNextData<SearchResultPageProps>(urlPath);

  // A search page that matched nothing still carries a `searchResult` with
  // `rowsFound: 0`, so every branch below is a genuine failure to understand the
  // page — never an empty result set. Returning `total: 0` for these is what
  // made a broken scraper look like an empty market.
  if (pageProps.is404) {
    throw new WillhabenParseError(
      "not_found",
      url,
      "willhaben returned its 404 page — the category path or filter combination does not exist"
    );
  }

  // Result lists use `searchResult`; auto/landing pages use `initialSearchResult`.
  if (pageProps.searchResult) {
    return { result: pageProps.searchResult, isInitial: false };
  }

  if (pageProps.initialSearchResult) {
    return { result: pageProps.initialSearchResult, isInitial: true };
  }

  throw new WillhabenParseError(
    "unexpected_page_shape",
    url,
    `the page parsed but contained no search result (keys: ${Object.keys(pageProps).join(", ") || "none"}) — ` +
      "willhaben's page structure may have changed"
  );
}

/**
 * Fetch ad detail from a willhaben.at detail page
 */
export async function scrapeAdDetail(
  urlPath: string
): Promise<import("../api/types.js").WillhabenAdDetail | null> {
  const pageProps = await scrapeNextData<SearchResultPageProps>(urlPath);
  // `scrapeNextData` throws if the page could not be read at all, so `null` here
  // has one unambiguous meaning: the page was understood and holds no ad — the
  // listing was removed or the id does not exist.
  return pageProps.advertDetails ?? null;
}

/**
 * Clear the cache
 */
export function clearCache(): void {
  cache.clear();
}

/**
 * Make a direct fetch to publicapi.willhaben.at (no scraping needed)
 */
export async function fetchPublicApi<T>(urlPath: string): Promise<T> {
  const url = resolveWillhabenUrl(urlPath, WILLHABEN_PUBLIC_API);

  const response = await httpJson<T>(url);

  if (!response.ok) {
    throw new Error(`Public API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}