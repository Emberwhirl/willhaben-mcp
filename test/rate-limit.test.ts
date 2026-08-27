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
  WillhabenTimeoutError,
  getBackoffRemainingMs,
  getConsecutiveBlockCount,
  DEFAULT_RETRY_AFTER_MS,
  MAX_RETRY_AFTER_MS,
  FETCH_TIMEOUT_MS,
  BLOCK_BACKOFF_BASE_MS,
  BLOCK_BACKOFF_MAX_STEPS,
  httpText,
  httpJson,
  resolveWillhabenUrl,
} from "../src/api/httpClient.js";
import { clearCache, resetRateLimiterForTests, scrapeNextData } from "../src/api/scraper.js";
import { clearLocationCaches, resolveLocationDetailed, resolveLocationToAreaId } from "../src/api/geo.js";
import { searchListings } from "../src/api/search.js";
import { searchJobs } from "../src/api/jobs.js";
import { deepSearch } from "../src/api/deepsearch.js";
import { getListingDetail, getListingDetailBySeoUrl, getListingDetailFor } from "../src/api/detail.js";
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

function isDetailUrl(url: string): boolean {
  return url.includes("/iad/object?adId=") || url.includes("/iad/immobilien/d/");
}

function isSearchUrl(url: string): boolean {
  return url.includes("/iad/immobilien/") && !url.includes("/iad/immobilien/d/");
}

function searchHtmlWithCount(count: number): string {
  const marker = 'id="__NEXT_DATA__"';
  const i = searchHtml.indexOf(marker);
  const open = searchHtml.indexOf(">", i);
  const close = searchHtml.indexOf("</script>", open);
  const data = JSON.parse(searchHtml.slice(open + 1, close)) as {
    props: { pageProps: { searchResult: { advertSummaryList: { advertSummary: Array<Record<string, unknown>> }; rowsReturned: number } } };
  };
  const ads = data.props.pageProps.searchResult.advertSummaryList.advertSummary;
  const inflated: Array<Record<string, unknown>> = [];
  for (let n = 0; n < count; n++) {
    inflated.push({ ...ads[n % ads.length], id: String(1_000_000_000 + n) });
  }
  data.props.pageProps.searchResult.advertSummaryList.advertSummary = inflated;
  data.props.pageProps.searchResult.rowsReturned = count;
  return searchHtml.slice(0, open + 1) + JSON.stringify(data) + searchHtml.slice(close);
}

// ---------------------------------------------------------------------------
section("invariants: 1 req/s cap and 5-min cache are unchanged");

{
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { engines?: { node?: string } };
  assert(pkg.engines?.node === ">=20.3.0", `engines.node is >=20.3.0 (got ${pkg.engines?.node})`);
}

assert(RATE_LIMIT_PER_SEC === 1, `RATE_LIMIT_PER_SEC is 1 (got ${RATE_LIMIT_PER_SEC})`);
assert(CACHE_TTL_MS === 5 * 60 * 1000, `CACHE_TTL_MS is 5 minutes (got ${CACHE_TTL_MS})`);
assert(DEFAULT_RETRY_AFTER_MS === 1000, "default Retry-After is 1s (does not raise the cap)");
assert(MAX_RETRY_AFTER_MS === 60_000, "Retry-After is capped at 60s");
assert(FETCH_TIMEOUT_MS === 15_000, `per-hop fetch timeout is 15s (got ${FETCH_TIMEOUT_MS})`);
assert(
  BLOCK_BACKOFF_BASE_MS > 1000 / RATE_LIMIT_PER_SEC,
  `a header-less block costs more than a normal slot (${BLOCK_BACKOFF_BASE_MS}ms vs ${1000 / RATE_LIMIT_PER_SEC}ms)`
);
assert(
  BLOCK_BACKOFF_BASE_MS * 2 ** BLOCK_BACKOFF_MAX_STEPS >= MAX_RETRY_AFTER_MS,
  "block escalation reaches the 60s cap before it stops doubling"
);

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
  assert(!urls.some((u) => isDetailUrl(u)), "no detail fetches after abort");
}

// ---------------------------------------------------------------------------
section("429 mid-deep-search keeps the scan and stops subsequent detail fetches");

{
  resetBetween();
  const urls: string[] = [];
  setHttpTestHandler(async (url) => {
    urls.push(url);
    if (isDetailUrl(url)) {
      const detailsSoFar = urls.filter((u) => isDetailUrl(u)).length;
      if (detailsSoFar >= 2) {
        return { status: 429, body: "slow down", headers: { "Retry-After": "2" } };
      }
      return { status: 200, body: detailHtml };
    }
    return { status: 200, body: searchHtml };
  });

  const result = await deepSearch({ vertical: "real_estate", area_id: "60101", pages: 1, detail_limit: 3 });

  const detailUrls = urls.filter((u) => isDetailUrl(u));
  assert(result.scanned_listings > 0, `kept scanned listings after 429 (got ${result.scanned_listings})`);
  assert(result.details.length === 1, `kept the detail fetched before the 429 (got ${result.details.length})`);
  assert(typeof result.notice === "string" && result.notice.includes("429"), `block notice mentions 429 (got ${result.notice})`);
  assert(detailUrls.length === 2, `stopped after the 429 detail (got ${detailUrls.length} detail fetches)`);
  assert(!detailUrls.some((u) => u.includes("1230000002")), `third-ranked listing was not fetched (${detailUrls.join(", ")})`);
  assert(!urls.some((u) => u.includes("/iad/object?adId=")), `details used the SEO path, not adId (${urls.filter(isDetailUrl).join(", ")})`);
}

// ---------------------------------------------------------------------------
section("timeout mid-deep-search keeps the scan and stops subsequent detail fetches");

{
  resetBetween();
  const urls: string[] = [];
  setHttpTestHandler(
    async (url, { signal }) => {
      urls.push(url);
      if (isDetailUrl(url)) {
        await sleep(30_000, signal);
      }
      return { status: 200, body: searchHtml };
    },
    { timeoutMs: 150 }
  );

  const result = await deepSearch({ vertical: "real_estate", area_id: "60101", pages: 1, detail_limit: 3 });
  const detailUrls = urls.filter((u) => isDetailUrl(u));
  assert(result.scanned_listings > 0, `kept scanned listings after timeout (got ${result.scanned_listings})`);
  assert(result.details.length === 0, `no details after the hung first detail (got ${result.details.length})`);
  assert(typeof result.notice === "string" && /time/i.test(result.notice), `timeout notice (got ${result.notice})`);
  assert(detailUrls.length === 1, `stopped after the hung detail (got ${detailUrls.length} detail fetches)`);
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
section("hung autocomplete is a timeout, not a nationwide miss");

{
  resetBetween();
  const urls: string[] = [];
  setHttpTestHandler(
    async (url, { signal }) => {
      urls.push(url);
      if (url.includes("autocomplete/area")) {
        await sleep(30_000, signal);
      }
      return { status: 200, body: searchHtml };
    },
    { timeoutMs: 150 }
  );

  const first = await expectThrow(() => resolveLocationDetailed("Graz"));
  assert(
    first instanceof WillhabenTimeoutError,
    `first resolve throws WillhabenTimeoutError (got ${first instanceof Error ? first.name : first})`
  );
  assert(
    !(first && typeof first === "object" && "kind" in first),
    "a hung autocomplete is not an unresolved resolution"
  );

  const second = await expectThrow(() => resolveLocationDetailed("Graz"));
  assert(second instanceof WillhabenTimeoutError, "second resolve of the same term also times out");
  const autosAfterTwo = urls.filter((u) => u.includes("autocomplete/area"));
  assert(autosAfterTwo.length === 2, `timeout is not negative-cached (got ${autosAfterTwo.length} autocomplete requests)`);

  const searchError = await expectThrow(() => searchListings({ vertical: "real_estate", location: "Graz" }));
  assert(
    searchError instanceof WillhabenTimeoutError,
    `searchListings throws WillhabenTimeoutError (got ${searchError instanceof Error ? searchError.name : searchError})`
  );
  assert(
    urls.every((u) => u.includes("autocomplete/area")),
    `no search-page fetch after hung autocomplete (urls: ${urls.join(" | ")})`
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
  setHttpTestHandler(
    async (url, { signal }) => {
      urls.push(url);
      if (url.includes("/jobs/v2/adverts")) {
        await sleep(30_000, signal);
      }
      return { status: 200, body: searchHtml };
    },
    { timeoutMs: 150 }
  );

  const error = await expectThrow(() => searchJobs({ keyword: "entwickler" }));
  assert(
    error instanceof WillhabenTimeoutError,
    `searchJobs timeout is WillhabenTimeoutError (got ${error instanceof Error ? error.name : error})`
  );
  assert(urls.length === 1, `timeout on /jobs/v2/adverts does not scrape stellenmarkt (got ${urls.length}: ${urls.join(" | ")})`);
  assert(urls[0]?.includes("/jobs/v2/adverts"), "timeout URL is the public jobs API");
  assert(!urls.some((u) => u.includes("stellenmarkt")), "no jobs HTML scrape after public-API timeout");
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
// A bare 403 (no Retry-After) is the standard WAF shape. It used to be a plain
// non-OK response, so deep search walked into the wall once per remaining
// listing and still returned a non-error result.
section("a bare 403 is a block, not a free error");

{
  resetBetween();
  setHttpTestHandler(async () => ({ status: 403, body: "forbidden" }), { blockBackoffBaseMs: 100 });

  const error = await expectThrow(() => getListingDetail("999"));
  assert(error instanceof WillhabenBlockedError, "bare 403 is a WillhabenBlockedError");
  assert((error as WillhabenBlockedError).status === 403, "bare 403 status is 403");
  assert(
    (error as WillhabenBlockedError).retryAfterMs >= 100,
    `bare 403 costs a real cooldown (got ${(error as WillhabenBlockedError).retryAfterMs}ms)`
  );
  assert(getBackoffRemainingMs() > 0, `bare 403 records a process-wide backoff (got ${getBackoffRemainingMs()}ms)`);
  assert(getConsecutiveBlockCount() === 1, `one consecutive block counted (got ${getConsecutiveBlockCount()})`);
}

// ---------------------------------------------------------------------------
section("a bare 429 is a block, and consecutive blocks escalate");

{
  resetBetween();
  const seen: number[] = [];
  setHttpTestHandler(async () => ({ status: 429, body: "slow down" }), { blockBackoffBaseMs: 100 });

  for (const id of ["1", "2", "3"]) {
    const error = (await expectThrow(() => getListingDetail(id))) as WillhabenBlockedError;
    assert(error instanceof WillhabenBlockedError && error.status === 429, `bare 429 #${id} is a block`);
    seen.push(error.retryAfterMs);
  }

  assert(seen[0]! >= 100, `a bare 429 is not free (first cooldown ${seen[0]}ms)`);
  assert(seen[1]! >= seen[0]! * 1.5, `second block escalates (${seen[0]}ms → ${seen[1]}ms)`);
  assert(seen[2]! >= seen[1]! * 1.5, `third block escalates (${seen[1]}ms → ${seen[2]}ms)`);
  assert(getConsecutiveBlockCount() === 3, `three consecutive blocks counted (got ${getConsecutiveBlockCount()})`);
}

{
  resetBetween();
  let calls = 0;
  setHttpTestHandler(
    async () => {
      calls++;
      return calls === 1 ? { status: 403, body: "forbidden" } : { status: 200, body: detailHtml };
    },
    { blockBackoffBaseMs: 100 }
  );

  await expectThrow(() => getListingDetail("1"));
  assert(getConsecutiveBlockCount() === 1, "the first block is counted");
  const recovered = await expectThrow(() => getListingDetail("2"));
  assert(recovered === undefined, "the next request succeeds after the cooldown");
  assert(getConsecutiveBlockCount() === 0, `a good response resets the escalation (got ${getConsecutiveBlockCount()})`);
}

// ---------------------------------------------------------------------------
// The dispatch interval used to be switched off whenever a test handler was
// installed, so none of the pacing below was actually exercised. `minIntervalMs`
// keeps it on at a scaled-down magnitude; callers that pass no options are
// unchanged (pacing off).
section("dispatch pacing is enforced — and now observable under test");

{
  resetBetween();
  const starts: number[] = [];
  setHttpTestHandler(
    async () => {
      starts.push(Date.now());
      return { status: 200, body: detailHtml };
    },
    { minIntervalMs: 120 }
  );

  await getListingDetail("1");
  await getListingDetail("2");
  await getListingDetail("3");
  const gaps = starts.slice(1).map((t, i) => t - starts[i]!);
  assert(starts.length === 3, `three requests dispatched (got ${starts.length})`);
  assert(gaps.every((g) => g >= 110), `request starts are spaced by the interval (gaps: ${gaps.join(", ")}ms)`);
}

{
  resetBetween();
  const starts: number[] = [];
  setHttpTestHandler(async () => {
    starts.push(Date.now());
    return { status: 200, body: detailHtml };
  });

  await getListingDetail("1");
  await getListingDetail("2");
  assert(
    starts[1]! - starts[0]! < 100,
    `a handler installed without options still runs unpaced (gap ${starts[1]! - starts[0]!}ms)`
  );
}

// ---------------------------------------------------------------------------
// Redirect hops used to share one dispatch slot: a detail fetch is a 302 pair
// 0-2ms apart, so the real rate was double the documented one.
section("redirect hops each take their own dispatch slot");

{
  resetBetween();
  const hops: { url: string; at: number }[] = [];
  setHttpTestHandler(
    async (url) => {
      hops.push({ url, at: Date.now() });
      if (hops.length < 3) {
        return { status: 302, body: "", headers: { location: `/iad/immobilien/hop-${hops.length}` } };
      }
      return { status: 200, body: searchHtml };
    },
    { minIntervalMs: 120 }
  );

  const started = Date.now();
  const response = await httpText("https://www.willhaben.at/iad/object?adId=1", "text/html");
  const chainMs = Date.now() - started;
  const gaps = hops.slice(1).map((h, i) => h.at - hops[i]!.at);

  assert(hops.length === 3, `both redirects were followed (got ${hops.length} hops)`);
  assert(response.ok && response.body === searchHtml, "the final hop's body is what the caller gets");
  assert(hops[2]!.url.includes("/iad/immobilien/hop-2"), `Location was followed (got ${hops[2]!.url})`);
  assert(gaps.every((g) => g >= 110), `every extra hop waited its slot (gaps: ${gaps.join(", ")}ms)`);
  assert(chainMs >= 240, `a 3-hop chain costs 3 slots, not 1 (took ${chainMs}ms)`);

  await httpText("https://www.willhaben.at/iad/object?adId=2", "text/html");
  const afterChain = hops[3]!.at - hops[2]!.at;
  assert(afterChain >= 110, `the request after a redirect chain is still paced (gap ${afterChain}ms)`);
}

// ---------------------------------------------------------------------------
// The dispatch slot is a mutex, so an unbounded fetch is a process-wide freeze.
section("a hung request times out — as a timeout, not as a cancellation");

{
  resetBetween();
  let calls = 0;
  setHttpTestHandler(
    async (url, { signal }) => {
      calls++;
      if (calls === 1) {
        await sleep(30_000, signal); // socket that connects and never answers
      }
      return { status: 200, body: detailHtml };
    },
    { timeoutMs: 150 }
  );

  const started = Date.now();
  const error = await expectThrow(() => getListingDetail("1"));
  const elapsed = Date.now() - started;

  assert(
    error instanceof WillhabenTimeoutError,
    `a hung fetch throws WillhabenTimeoutError (got ${error instanceof Error ? error.name : error})`
  );
  assert(!isAbortError(error), "a timeout is NOT an AbortError (server.ts rethrows those as client cancellations)");
  assert(
    error instanceof Error && /did not respond/i.test(error.message),
    `the timeout message is legible (got ${error instanceof Error ? error.message : error})`
  );
  assert(elapsed >= 100 && elapsed < 5000, `the timeout fired at its budget (took ${elapsed}ms)`);

  const after = await expectThrow(() => getListingDetail("2"));
  assert(after === undefined, "a later request still succeeds — the hung socket did not wedge the slot");
  assert(calls === 2, `the second request reached the transport (calls=${calls})`);
}

{
  resetBetween();
  let seenFirst!: () => void;
  const firstSeen = new Promise<void>((resolve) => {
    seenFirst = resolve;
  });
  setHttpTestHandler(
    async (url, { signal }) => {
      seenFirst();
      await sleep(30_000, signal);
      return { status: 200, body: detailHtml };
    },
    { timeoutMs: 5000 }
  );

  const controller = new AbortController();
  const pending = runWithAbortSignal(controller.signal, () => getListingDetail("1"));
  await firstSeen;
  controller.abort();
  const error = await expectThrow(() => pending);

  assert(isAbortError(error), `a client cancel is still an AbortError (got ${error instanceof Error ? error.name : error})`);
  assert(!(error instanceof WillhabenTimeoutError), "a client cancel is not reported as a timeout");
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

{
  resetBetween();
  const hops: string[] = [];
  setHttpTestHandler(async (url) => {
    hops.push(url);
    if (url.includes("/iad/object?adId=")) {
      return {
        status: 308,
        body: "",
        headers: { location: "/iad/immobilien/d/eigentumswohnung/steiermark/graz/test-3-1230000003/" },
      };
    }
    return { status: 200, body: detailHtml };
  });

  const byId = await getListingDetail("999");
  assert(byId?.id === "999", "id lookup still returns the detail");
  const idHops = hops.filter((u) => u.includes("/iad/object?adId=") || u.includes("/iad/immobilien/d/"));
  assert(idHops.length === 2, `adId lookup follows 308 onto the canonical path (got ${idHops.length}: ${idHops.join(" | ")})`);

  clearCache();
  hops.length = 0;
  const bySeo = await getListingDetailBySeoUrl("/iad/immobilien/d/eigentumswohnung/steiermark/graz/test-3-1230000003/");
  assert(bySeo?.id === "999", "SEO-path lookup returns the detail");
  assert(hops.length === 1, `known SEO path is one hop (got ${hops.length}: ${hops.join(" | ")})`);
  assert(!hops.some((u) => u.includes("/iad/object?adId=")), "SEO-path lookup does not hit adId");

  clearCache();
  hops.length = 0;
  const byListing = await getListingDetailFor({
    id: "1230000003",
    url: "https://www.willhaben.at/iad/immobilien/d/eigentumswohnung/steiermark/graz/test-3-1230000003/",
  });
  assert(byListing?.id === "999", "getListingDetailFor uses the listing URL");
  assert(hops.length === 1, `getListingDetailFor is one hop (got ${hops.length}: ${hops.join(" | ")})`);
}

{
  resetBetween();
  const urls: string[] = [];
  const page1 = searchHtmlWithCount(30);
  setHttpTestHandler(async (url) => {
    urls.push(url);
    if (isSearchUrl(url)) {
      const searches = urls.filter((u) => isSearchUrl(u)).length;
      if (searches >= 2) return { status: 403, body: "forbidden" };
      return { status: 200, body: page1 };
    }
    return { status: 200, body: detailHtml };
  });

  const result = await deepSearch({ vertical: "real_estate", area_id: "60101", pages: 2, detail_limit: 0 });
  assert(result.scanned_listings > 0, `page-2 403 keeps page-1 listings (got ${result.scanned_listings})`);
  assert(result.scanned_pages === 1, `stopped after the blocked second page (scanned_pages=${result.scanned_pages})`);
  assert(typeof result.notice === "string" && result.notice.includes("403"), `notice mentions 403 (got ${result.notice})`);
  assert(result.details.length === 0, "no details fetched after a page-scan block");
  assert(urls.filter((u) => isSearchUrl(u)).length === 2, "second page was attempted");
}

console.log(`\n${"=".repeat(50)}\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
