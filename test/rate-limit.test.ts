// Offline tests for abort, 429/403 backoff, and geo lookup dedupe.
//
// Drives the shipped search / deep-search / geo / HTTP funnel with an injected
// dispatcher — never the live willhaben network. Run:
//   npm run test:rate-limit

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  setHttpTestHandler,
  resetHttpClientForTests,
  parseRetryAfter,
  sleep,
  isAbortError,
  runWithAbortSignal,
  WillhabenBlockedError,
  getBackoffRemainingMs,
  DEFAULT_RETRY_AFTER_MS,
  MAX_RETRY_AFTER_MS,
  httpText,
  httpJson,
  resolveWillhabenUrl,
} from "../src/api/httpClient.js";
import { clearCache, resetRateLimiterForTests, scrapeNextData } from "../src/api/scraper.js";
import { clearLocationCaches, resolveLocationDetailed, resolveLocationToAreaId } from "../src/api/geo.js";
import { searchListings } from "../src/api/search.js";
import { searchJobs } from "../src/api/jobs.js";
import { deepSearch } from "../src/api/deepsearch.js";
import { getListingDetail, getListingDetailBySeoUrl } from "../src/api/detail.js";
import { VerticalId } from "../src/api/types.js";
import { CACHE_TTL_MS, RATE_LIMIT_PER_SEC, SEARCH_URL_PATTERNS, clampSearchPaging } from "../src/utils/constants.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const searchHtml = await readFile(join(root, "test", "fixtures", "search-real-estate.html"), "utf8");
const detailHtml = await readFile(join(root, "test", "fixtures", "detail.html"), "utf8");

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

function reset(): void {
  resetHttpClientForTests();
  resetRateLimiterForTests();
  clearCache();
  clearLocationCaches();
}

async function expectThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

function resetBetween(): void {
  reset();
}

resetBetween();

// ---------------------------------------------------------------------------
section("invariants: 1 req/s cap and 5-min cache are unchanged");

assert(RATE_LIMIT_PER_SEC === 1, `RATE_LIMIT_PER_SEC is 1 (got ${RATE_LIMIT_PER_SEC})`);
assert(CACHE_TTL_MS === 5 * 60 * 1000, `CACHE_TTL_MS is 5 minutes (got ${CACHE_TTL_MS})`);
assert(DEFAULT_RETRY_AFTER_MS === 1000, "default Retry-After is 1s (does not raise the cap)");
assert(MAX_RETRY_AFTER_MS === 60_000, "Retry-After is capped at 60s");

// ---------------------------------------------------------------------------
section("parseRetryAfter (shipped parser)");

assert(parseRetryAfter(undefined) === 1000, "missing header → 1000ms");
assert(parseRetryAfter("") === 1000, "empty header → 1000ms");
assert(parseRetryAfter("2") === 2000, "delta-seconds 2 → 2000ms");
assert(parseRetryAfter("0") === 0, "delta-seconds 0 → 0ms");
assert(parseRetryAfter("9999") === 60_000, "huge delta is capped at 60s");
assert(parseRetryAfter("not-a-date") === 1000, "garbage → default 1000ms");

const future = new Date(Date.now() + 3000).toUTCString();
const fromDate = parseRetryAfter(future);
assert(fromDate >= 2000 && fromDate <= 3000, `HTTP-date ~3s from now (got ${fromDate}ms)`);

// ---------------------------------------------------------------------------
section("failed location lookup is remembered — one autocomplete for two resolves");

{
  resetBetween();
  const urls: string[] = [];
  setHttpTestHandler(async (url) => {
    urls.push(url);
    if (url.includes("autocomplete/area")) {
      throw new Error("autocomplete network down");
    }
    return { status: 200, body: searchHtml };
  });

  const first = await resolveLocationDetailed("Nowhereville");
  const second = await resolveLocationToAreaId("Nowhereville");
  const auto = urls.filter((u) => u.includes("autocomplete/area"));

  assert(first.kind === "unresolved", `first resolve is unresolved (got ${first.kind})`);
  assert(second === null, "second resolve is null");
  assert(auto.length === 1, `exactly one autocomplete request (got ${auto.length})`);
}

{
  resetBetween();
  const urls: string[] = [];
  setHttpTestHandler(async (url) => {
    urls.push(url);
    if (url.includes("autocomplete/area")) {
      throw new Error("autocomplete network down");
    }
    return { status: 200, body: searchHtml };
  });

  await resolveLocationDetailed("GhostTown");
  await searchListings({ vertical: "real_estate", location: "GhostTown" });
  const auto = urls.filter((u) => u.includes("autocomplete/area"));
  assert(auto.length === 1, `search path after unresolved does not hit autocomplete again (got ${auto.length})`);
}

// ---------------------------------------------------------------------------
section("aborting the tool signal stops in-flight HTTP and starts no further fetches");

{
  resetBetween();
  const urls: string[] = [];
  let seenFirst!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    seenFirst = resolve;
  });

  setHttpTestHandler(async (url, { signal }) => {
    urls.push(url);
    seenFirst();
    await sleep(30_000, signal);
    return { status: 200, body: searchHtml };
  });

  const controller = new AbortController();
  const pending = deepSearch(
    { vertical: "real_estate", area_id: "60101", pages: 3, detail_limit: 8 },
    { signal: controller.signal }
  );

  await firstSeen;
  controller.abort();
  const error = await expectThrow(() => pending);
  await sleep(150);

  assert(isAbortError(error), `deep search rejects with AbortError (got ${error instanceof Error ? error.name : error})`);
  assert(urls.length === 1, `no further willhaben fetches after abort (got ${urls.length}: ${urls.join(" | ")})`);
  assert(!urls.some((u) => u.includes("/iad/object")), "no detail fetches after abort");
}

// ---------------------------------------------------------------------------
section("429 mid-deep-search stops subsequent detail fetches");

{
  resetBetween();
  const urls: string[] = [];
  setHttpTestHandler(async (url) => {
    urls.push(url);
    if (url.includes("/iad/object?adId=")) {
      const detailsSoFar = urls.filter((u) => u.includes("/iad/object?adId=")).length;
      if (detailsSoFar >= 2) {
        return { status: 429, body: "slow down", headers: { "Retry-After": "2" } };
      }
      return { status: 200, body: detailHtml };
    }
    return { status: 200, body: searchHtml };
  });

  const error = await expectThrow(() =>
    deepSearch({ vertical: "real_estate", area_id: "60101", pages: 1, detail_limit: 3 })
  );

  const detailUrls = urls.filter((u) => u.includes("/iad/object?adId="));
  assert(error instanceof WillhabenBlockedError, `deep search throws WillhabenBlockedError (got ${error instanceof Error ? error.name : error})`);
  assert((error as WillhabenBlockedError).status === 429, `blocked status is 429 (got ${(error as WillhabenBlockedError).status})`);
  assert(detailUrls.length === 2, `stopped after the 429 detail (got ${detailUrls.length} detail fetches)`);
  assert(!detailUrls.some((u) => u.includes("1230000002")), `third-ranked listing was not fetched (${detailUrls.join(", ")})`);
}

// ---------------------------------------------------------------------------
section("403 is treated like a block; Retry-After is recorded");

{
  resetBetween();
  setHttpTestHandler(async () => ({
    status: 403,
    body: "forbidden",
    headers: { "retry-after": "5" },
  }));

  const error = await expectThrow(() => getListingDetail("999"));
  assert(error instanceof WillhabenBlockedError, "403 throws WillhabenBlockedError");
  assert((error as WillhabenBlockedError).status === 403, "status is 403");
  assert((error as WillhabenBlockedError).retryAfterMs === 5000, `retryAfterMs is 5000 (got ${(error as WillhabenBlockedError).retryAfterMs})`);
  assert(getBackoffRemainingMs() >= 4000, `backoff remaining after 403 (got ${getBackoffRemainingMs()}ms)`);
}

// ---------------------------------------------------------------------------
section("if a retry happens, Retry-After is honored first");

{
  resetBetween();
  const urls: string[] = [];
  setHttpTestHandler(async (url) => {
    urls.push(url);
    return { status: 429, body: "slow down", headers: { "Retry-After": "2" } };
  });

  const firstStarted = Date.now();
  const firstError = await expectThrow(() => getListingDetail("1"));
  const firstElapsed = Date.now() - firstStarted;
  assert(firstError instanceof WillhabenBlockedError, "first attempt throws");
  assert(firstElapsed < 800, `first 429 fails without waiting Retry-After (took ${firstElapsed}ms)`);

  const retryStarted = Date.now();
  await expectThrow(() => getListingDetail("2"));
  const waited = Date.now() - retryStarted;
  assert(waited >= 1800, `retry waited Retry-After 2s first (waited ${waited}ms)`);
  assert(urls.length === 2, `retry issued a second fetch after the wait (got ${urls.length})`);
}

// ---------------------------------------------------------------------------
section("429 on autocomplete does not continue into a search scrape");

{
  resetBetween();
  const urls: string[] = [];
  setHttpTestHandler(async (url) => {
    urls.push(url);
    if (url.includes("autocomplete/area")) {
      return { status: 429, body: "slow down", headers: { "Retry-After": "1" } };
    }
    return { status: 200, body: searchHtml };
  });

  const error = await expectThrow(() => searchListings({ vertical: "real_estate", location: "Linz" }));
  assert(error instanceof WillhabenBlockedError, "search throws on autocomplete 429");
  assert(
    urls.every((u) => u.includes("autocomplete/area")),
    `no search-page fetch after autocomplete 429 (urls: ${urls.join(" | ")})`
  );
}

// ---------------------------------------------------------------------------
section("jobs public API abort/429/403 must not fall through to scraping");

{
  resetBetween();
  const urls: string[] = [];
  let seenFirst!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    seenFirst = resolve;
  });

  setHttpTestHandler(async (url, { signal }) => {
    urls.push(url);
    seenFirst();
    await sleep(30_000, signal);
    return { status: 200, body: "{}" };
  });

  const controller = new AbortController();
  const pending = runWithAbortSignal(controller.signal, () => searchJobs({ keyword: "entwickler" }));
  await firstSeen;
  controller.abort();
  const error = await expectThrow(() => pending);
  await sleep(150);

  assert(isAbortError(error), `searchJobs abort is AbortError (got ${error instanceof Error ? error.name : error})`);
  assert(urls.length === 1, `abort does not scrape stellenmarkt (got ${urls.length}: ${urls.join(" | ")})`);
  assert(urls[0]?.includes("/jobs/v2/adverts"), "abort hit the public jobs API");
  assert(!urls.some((u) => u.includes("stellenmarkt")), "no jobs HTML scrape after abort");
}

{
  resetBetween();
  const urls: string[] = [];
  setHttpTestHandler(async (url) => {
    urls.push(url);
    return { status: 429, body: "slow down", headers: { "Retry-After": "2" } };
  });

  const error = await expectThrow(() => searchJobs({ keyword: "entwickler" }));
  assert(error instanceof WillhabenBlockedError, "searchJobs 429 throws WillhabenBlockedError");
  assert((error as WillhabenBlockedError).status === 429, "jobs 429 status");
  assert(urls.length === 1, `429 on /jobs/v2/adverts does not issue a second fetch (got ${urls.length}: ${urls.join(" | ")})`);
  assert(urls[0]?.includes("/jobs/v2/adverts"), "429 URL is the public jobs API");
  assert(!urls.some((u) => u.includes("stellenmarkt")), "no jobs HTML scrape after 429");
}

{
  resetBetween();
  const urls: string[] = [];
  setHttpTestHandler(async (url) => {
    urls.push(url);
    return { status: 403, body: "forbidden", headers: { "retry-after": "5" } };
  });

  const error = await expectThrow(() => searchListings({ vertical: "jobs", keyword: "entwickler" }));
  assert(error instanceof WillhabenBlockedError, "willhaben_search jobs path throws on 403");
  assert((error as WillhabenBlockedError).status === 403, "jobs 403 status");
  assert(urls.length === 1, `403 on /jobs/v2/adverts does not issue a second fetch (got ${urls.length}: ${urls.join(" | ")})`);
  assert(urls[0]?.includes("/jobs/v2/adverts"), "403 URL is the public jobs API");
  assert(!urls.some((u) => u.includes("stellenmarkt") || u.includes("/iad/")), "no scrape fallback after jobs 403");
}

// ---------------------------------------------------------------------------
section("completion mutex: one in-flight willhaben request");

{
  resetBetween();
  let inFlight = 0;
  let maxInFlight = 0;
  setHttpTestHandler(async () => {
    inFlight++;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    await sleep(80);
    inFlight--;
    return { status: 200, body: detailHtml };
  });

  await Promise.all([getListingDetail("1"), getListingDetail("2")]);
  assert(maxInFlight === 1, `maxInFlight is 1 (got ${maxInFlight})`);
}

// ---------------------------------------------------------------------------
section("concurrent 429: second fetch starts only after Retry-After backoff");

{
  resetBetween();
  const urls: string[] = [];
  let first429At = 0;
  let secondFetchAt = 0;
  let calls = 0;
  setHttpTestHandler(async (url) => {
    const n = ++calls;
    if (n === 2) secondFetchAt = Date.now();
    urls.push(url);
    if (n === 1) {
      await sleep(40);
      first429At = Date.now();
      return { status: 429, body: "slow down", headers: { "Retry-After": "2" } };
    }
    return { status: 200, body: detailHtml };
  });

  const results = await Promise.allSettled([getListingDetail("1"), getListingDetail("2")]);
  const delay = secondFetchAt - first429At;
  const firstRejected = results[0].status === "rejected" ? results[0].reason : undefined;

  assert(firstRejected instanceof WillhabenBlockedError, "first concurrent call is WillhabenBlockedError");
  assert(urls.length === 2, `second fetch did run after backoff (got ${urls.length} urls)`);
  assert(delay >= 1800, `second fetch delayed >= ~1800ms from the 429 (got ${delay}ms)`);
}

// ---------------------------------------------------------------------------
section("host allowlist: non-willhaben URLs are rejected before fetch");

{
  resetBetween();
  let invoked = 0;
  setHttpTestHandler(async () => {
    invoked++;
    return { status: 200, body: "<html></html>" };
  });

  const textError = await expectThrow(() => httpText("https://evil.example/steal", "text/html"));
  assert(textError instanceof Error, "httpText throws for evil host");
  assert(
    textError instanceof Error && /non-willhaben host/i.test(textError.message),
    `httpText error names the host policy (got ${textError instanceof Error ? textError.message : textError})`
  );
  assert(invoked === 0, `httpText did not invoke the test handler (got ${invoked})`);

  const jsonError = await expectThrow(() => httpJson("https://evil.example/steal"));
  assert(jsonError instanceof Error, "httpJson throws for evil host");
  assert(invoked === 0, `httpJson did not invoke the test handler (got ${invoked})`);

  const scrapeError = await expectThrow(() => scrapeNextData("https://evil.example/steal"));
  assert(scrapeError instanceof Error, "scrapeNextData throws for evil host");
  assert(invoked === 0, `scrapeNextData did not invoke the test handler (got ${invoked})`);

  let resolveThrew = false;
  try {
    resolveWillhabenUrl("https://evil.example/steal", "https://www.willhaben.at");
  } catch {
    resolveThrew = true;
  }
  assert(resolveThrew, "resolveWillhabenUrl rejects evil.example");
  assert(
    resolveWillhabenUrl("/iad/object?adId=1", "https://www.willhaben.at") ===
      "https://www.willhaben.at/iad/object?adId=1",
    "relative HTML path resolves against www.willhaben.at"
  );
}

// ---------------------------------------------------------------------------
section("403 without Retry-After is a normal error, not a process-wide block");

{
  resetBetween();
  setHttpTestHandler(async () => ({
    status: 403,
    body: "forbidden",
  }));

  const error = await expectThrow(() => getListingDetail("999"));
  assert(error instanceof Error, "403 without Retry-After throws");
  assert(!(error instanceof WillhabenBlockedError), "403 without Retry-After is NOT WillhabenBlockedError");
  assert(getBackoffRemainingMs() === 0, `no backoff recorded (got ${getBackoffRemainingMs()}ms)`);
}

resetBetween();

// ---------------------------------------------------------------------------
section("API-layer sanitization (no HTTP)");

{
  const paging = clampSearchPaging(5000, 0);
  assert(paging.rows === 100 && paging.page === 1, `clampSearchPaging(5000, 0) → 100/1 (got ${paging.rows}/${paging.page})`);
  const defaults = clampSearchPaging(undefined, undefined);
  assert(defaults.rows === 30 && defaults.page === 1, "clampSearchPaging defaults to 30/1");

  const house = SEARCH_URL_PATTERNS[VerticalId.IMMOBILIEN]({ category: "haus-kaufen/haus-angebote" });
  assert(house.startsWith("/iad/immobilien/haus-kaufen/haus-angebote"), "verified house slug is accepted");
  const market = SEARCH_URL_PATTERNS[VerticalId.MARKTPLATZ]({ category: "computer-software-5824" });
  assert(market.includes("/marktplatz/computer-software-5824"), "verified marketplace slug is accepted");
  const empty = SEARCH_URL_PATTERNS[VerticalId.MARKTPLATZ]({});
  assert(empty.startsWith("/iad/kaufen-und-verkaufen/marktplatz?") || empty === "/iad/kaufen-und-verkaufen/marktplatz", "empty marketplace category stays unfiltered");

  const rejected: string[] = [];
  for (const bad of ["foo?rows=5000", "../escape", "a//b", "http:evil", "x#y"]) {
    try {
      SEARCH_URL_PATTERNS[VerticalId.MARKTPLATZ]({ category: bad });
    } catch (error) {
      if (error instanceof Error && error.message.includes("Invalid category path")) rejected.push(bad);
    }
  }
  assert(rejected.length === 5, `invalid category paths rejected (got ${rejected.join(", ")})`);
}

{
  const idError = await expectThrow(() => getListingDetail("not-an-id"));
  assert(idError instanceof Error && idError.message.includes("Invalid listing id"), "non-digit listing id is rejected before fetch");
  const seoErrors = await Promise.all([
    expectThrow(() => getListingDetailBySeoUrl("https://evil.example/iad/foo")),
    expectThrow(() => getListingDetailBySeoUrl("../etc/passwd")),
    expectThrow(() => getListingDetailBySeoUrl("foo?bar=1")),
    expectThrow(() => getListingDetailBySeoUrl("//evil.example/iad/foo")),
  ]);
  assert(
    seoErrors.every((e) => e instanceof Error && e.message.includes("Invalid SEO path")),
    "absolute / traversal / query SEO paths are rejected before fetch"
  );
}

console.log(`\n${"=".repeat(50)}\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
