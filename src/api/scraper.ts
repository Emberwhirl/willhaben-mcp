// Willhaben HTML Scraper - Extracts __NEXT_DATA__ JSON from willhaben.at pages
import * as cheerio from "cheerio";
import { WILLHABEN_BASE_URL, WILLHABEN_PUBLIC_API, DEFAULT_USER_AGENT, CACHE_TTL_MS, RATE_LIMIT_PER_SEC } from "../utils/constants.js";

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

// Rate limiter — serializes through a promise chain so that concurrent callers
// each reserve a distinct time slot instead of all reading the same timestamp
// and firing simultaneously (TOCTOU race).
let rateLimitChain: Promise<void> = Promise.resolve();

export function rateLimit(): Promise<void> {
  const minInterval = 1000 / RATE_LIMIT_PER_SEC;
  const result = rateLimitChain.then(async () => {
    const wait = lastScheduledTime + minInterval - Date.now();
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    lastScheduledTime = Date.now();
  });
  // Swallow errors on the chain itself so one failure doesn't poison the queue.
  rateLimitChain = result.catch(() => {});
  return result;
}

let lastScheduledTime = 0;

/**
 * Fetch a willhaben.at page and extract __NEXT_DATA__ JSON
 */
export async function scrapeNextData<T>(urlPath: string): Promise<T | null> {
  const url = urlPath.startsWith("http") ? urlPath : `${WILLHABEN_BASE_URL}${urlPath}`;

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

  await rateLimit();

  const response = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "de-AT,de;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const data = extractNextData<T>(html);

  if (data) {
    cacheSet(cacheKey, data);
  }

  return data;
}

/**
 * Extract __NEXT_DATA__ JSON from HTML
 */
export function extractNextData<T>(html: string): T | null {
  const $ = cheerio.load(html);
  const scriptTag = $('script#__NEXT_DATA__').first();

  if (!scriptTag.length) {
    return null;
  }

  const jsonStr = scriptTag.html();
  if (!jsonStr) {
    return null;
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return parsed.props?.pageProps as T ?? null;
  } catch (e) {
    // Try to find it manually in the HTML
    const startTag = '<script id="__NEXT_DATA__" type="application/json">';
    const startIdx = html.indexOf(startTag);
    if (startIdx === -1) return null;

    const jsonStart = startIdx + startTag.length;
    const jsonEnd = html.indexOf("</script>", jsonStart);
    if (jsonEnd === -1) return null;

    try {
      const manualParsed = JSON.parse(html.substring(jsonStart, jsonEnd));
      return manualParsed.props?.pageProps as T ?? null;
    } catch {
      return null;
    }
  }
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
): Promise<{ result: import("../api/types.js").WillhabenSearchResult | null; isInitial: boolean }> {
  const pageProps = await scrapeNextData<SearchResultPageProps>(urlPath);

  if (!pageProps) {
    return { result: null, isInitial: false };
  }

  // Check for 404 pages
  if (pageProps.is404) {
    return { result: null, isInitial: false };
  }

  // Try searchResult first, then initialSearchResult
  if (pageProps.searchResult) {
    return { result: pageProps.searchResult, isInitial: false };
  }

  if (pageProps.initialSearchResult) {
    return { result: pageProps.initialSearchResult, isInitial: true };
  }

  return { result: null, isInitial: false };
}

/**
 * Fetch ad detail from a willhaben.at detail page
 */
export async function scrapeAdDetail(
  urlPath: string
): Promise<import("../api/types.js").WillhabenAdDetail | null> {
  const pageProps = await scrapeNextData<SearchResultPageProps>(urlPath);
  return pageProps?.advertDetails ?? null;
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
  await rateLimit();

  const url = urlPath.startsWith("http") ? urlPath : `${WILLHABEN_PUBLIC_API}${urlPath}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      "Accept": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Public API error: ${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}