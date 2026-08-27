// Thin HTTP layer shared by the scraper, the geo lookup, and the jobs API.
//
// All willhaben traffic funnels through `httpText`/`httpJson` so that a single
// place owns headers — and so that the offline test harness can substitute
// recorded fixtures: when the `WILLHABEN_MCP_FIXTURES` environment variable
// points at a directory, requests are answered from `routes.json` in that
// directory instead of the network. This keeps protocol-level tests hermetic
// (no live willhaben traffic) without touching any production code path.
//
// Dispatch is the only network slot: one in-flight willhaben request at a time,
// at least 1s between starts unless fixtures/test-handler are substituting HTTP,
// and Retry-After backoff is observed after the previous fetch has settled.
// Redirects are followed only onto allowlisted willhaben hosts (needed for
// `/iad/object?adId=` → canonical listing URL), and *every hop takes its own
// dispatch slot*: hops used to run inside one slot, so a 302 pair fired 0-2ms
// apart and quietly doubled the real request rate against the documented 1/s.
//
// Every hop is additionally bounded by `FETCH_TIMEOUT_MS`. Without it, a socket
// that connects and never answers holds the single dispatch slot for undici's
// 300s default and freezes every willhaben tool call. A timeout surfaces as
// `WillhabenTimeoutError`, which is deliberately *not* an AbortError: the server
// rethrows AbortErrors as real client cancellations (returning nothing), so a
// timeout must take the ordinary error path and produce a readable message.
//
// A 429 or a 403 records a process-wide backoff and throws
// `WillhabenBlockedError`. Consecutive blocks escalate (exponential + jitter),
// so a bare 403/429 — the standard WAF shape, no Retry-After — costs more each
// time instead of nothing; an explicit Retry-After acts as a floor, and any
// non-error response resets the escalation.
// The MCP request AbortSignal is honored on in-flight work (native `fetch`
// and substituted handlers) so cancellation does not leave willhaben requests
// running.
//
// routes.json format: [{ "match": "<substring of URL>", "file": "<relative path>", "status": 200, "headers": { "Retry-After": "2" } }]
// The first entry whose `match` is contained in the URL wins.

import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  DEFAULT_USER_AGENT,
  RATE_LIMIT_PER_SEC,
  WILLHABEN_BASE_URL,
  WILLHABEN_PUBLIC_API,
} from "../utils/constants.js";

interface FixtureRoute {
  match: string;
  file: string;
  status?: number;
  headers?: Record<string, string>;
}

export interface HttpRequestOptions {
  signal?: AbortSignal;
}

export interface HttpTextResult {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

/** Raw response used by the fixture harness and the test dispatcher. */
export interface HttpRawResult {
  status: number;
  statusText?: string;
  body: string;
  headers?: Record<string, string>;
}

export type HttpTestHandler = (url: string, init: { signal?: AbortSignal }) => Promise<HttpRawResult>;

/**
 * Test-only knobs. Every field is optional and unset by default, so callers that
 * pass only a handler keep the previous behaviour exactly.
 */
export interface HttpTestOptions {
  /**
   * Keep dispatch pacing switched on while a test handler is installed, scaled
   * down to this many ms between request starts. Substituted HTTP otherwise
   * paces at 0ms — which is why the real interval (and redirect pacing) was
   * never actually exercised by the offline suite.
   */
  minIntervalMs?: number;
  /** Scale down `FETCH_TIMEOUT_MS` so a hung request can be tested in ms. */
  timeoutMs?: number;
  /** Scale down `BLOCK_BACKOFF_BASE_MS` so escalation can be tested in ms. */
  blockBackoffBaseMs?: number;
}

/**
 * Fallback used by `parseRetryAfter` when a header is absent or unparseable.
 * A block with no usable Retry-After no longer costs this — it costs the
 * escalating `BLOCK_BACKOFF_BASE_MS` floor, because 1000ms is exactly the normal
 * interval and so was free.
 */
export const DEFAULT_RETRY_AFTER_MS = 1000;
/** Cap so a huge Retry-After cannot freeze the MCP server for an hour. */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Per-hop budget for a single willhaben request. The dispatch slot is a mutex,
 * so an unbounded fetch is a process-wide freeze, not one slow tool call.
 */
export const FETCH_TIMEOUT_MS = 15_000;

/**
 * First cooldown after a block that carries no usable Retry-After. Deliberately
 * above the 1 req/s interval so a bare 403/429 is not free, then doubled per
 * consecutive block (2s, 4s, 8s, 16s, 32s, then capped by MAX_RETRY_AFTER_MS).
 */
export const BLOCK_BACKOFF_BASE_MS = 2000;
/** Doublings applied to the base before the cap takes over. */
export const BLOCK_BACKOFF_MAX_STEPS = 5;
/** Up to +25% random jitter so parallel clients do not resynchronise on the wall. */
export const BLOCK_BACKOFF_JITTER = 0.25;

const ALLOWED_HOSTS = new Set(["www.willhaben.at", "willhaben.at", "publicapi.willhaben.at"]);
const MAX_REDIRECTS = 5;
const MIN_INTERVAL_MS = 1000 / RATE_LIMIT_PER_SEC;
/** Cap so a pathological willhaben page cannot blow the MCP process. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const abortStore = new AsyncLocalStorage<AbortSignal>();

let fixtureRoutes: FixtureRoute[] | undefined;
let testHandler: HttpTestHandler | undefined;
let testOptions: HttpTestOptions = {};
let blockedUntil = 0;
let consecutiveBlocks = 0;
let lastStart = 0;
let rateLimitChain: Promise<unknown> = Promise.resolve();

/**
 * Bind the MCP tool-call AbortSignal for the duration of `fn` so nested
 * willhaben I/O (rate limiter, fetch, fixtures) sees it without every helper
 * having to thread the argument.
 */
export function runWithAbortSignal<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  if (!signal) return fn();
  return abortStore.run(signal, fn);
}

export function getAbortSignal(explicit?: AbortSignal): AbortSignal | undefined {
  return explicit ?? abortStore.getStore();
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  if (typeof DOMException !== "undefined") {
    return new DOMException("This operation was aborted", "AbortError");
  }
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

export function throwIfAborted(signal?: AbortSignal): void {
  const s = getAbortSignal(signal);
  if (s?.aborted) throw abortError(s);
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  const s = getAbortSignal(signal);
  return new Promise((resolve, reject) => {
    if (s?.aborted) {
      reject(abortError(s));
      return;
    }
    const timer = setTimeout(() => {
      s?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(s));
    };
    s?.addEventListener("abort", onAbort, { once: true });
  });
}

export class WillhabenBlockedError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;
  readonly url: string;

  constructor(status: number, retryAfterMs: number, url: string) {
    super(`willhaben returned ${status} for ${url}; backing off ${retryAfterMs}ms`);
    this.name = "WillhabenBlockedError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.url = url;
  }
}

/**
 * A willhaben hop exceeded its budget. Intentionally **not** an AbortError:
 * `server.ts` rethrows AbortErrors as MCP cancellations (the client gets no
 * result at all), so a timeout reported that way would vanish silently. As an
 * ordinary Error it becomes a legible `isError` tool result.
 */
export class WillhabenTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`willhaben did not respond within ${Math.round(timeoutMs / 100) / 10}s for ${url}`);
    this.name = "WillhabenTimeoutError";
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/** `AbortSignal.timeout()` aborts with a `TimeoutError` DOMException, not an AbortError. */
function isTimeoutReason(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** Retry-After as milliseconds, uncapped; `undefined` when unparseable. */
function retryAfterRawMs(header: string, now: number): number | undefined {
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) return Math.max(0, date - now);
  return undefined;
}

/** Parse a Retry-After header (delta-seconds or HTTP date) into a capped millisecond delay. */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number {
  if (header == null || header.trim() === "") return DEFAULT_RETRY_AFTER_MS;
  const raw = retryAfterRawMs(header, now);
  if (raw === undefined) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(raw, MAX_RETRY_AFTER_MS);
}

export function noteWillhabenBackoff(retryAfterMs: number): void {
  const until = Date.now() + retryAfterMs;
  if (until > blockedUntil) blockedUntil = until;
}

export function getBackoffRemainingMs(): number {
  return Math.max(0, blockedUntil - Date.now());
}

/** Blocks seen back-to-back without an intervening non-error response. */
export function getConsecutiveBlockCount(): number {
  return consecutiveBlocks;
}

function blockBackoffBaseMs(): number {
  return testOptions.blockBackoffBaseMs ?? BLOCK_BACKOFF_BASE_MS;
}

/**
 * Count a block and return the cooldown to observe: an escalating, jittered
 * floor (so a header-less bot wall is not free and repeated hits back off
 * progressively), raised to an explicit Retry-After whenever willhaben sent one.
 * Only reached on 403/429, so the unblocked path is never slowed by this.
 */
function registerBlock(explicitMs: number | undefined): number {
  consecutiveBlocks++;
  const step = Math.min(consecutiveBlocks - 1, BLOCK_BACKOFF_MAX_STEPS);
  const escalated = blockBackoffBaseMs() * 2 ** step;
  const jittered = Math.round(escalated * (1 + Math.random() * BLOCK_BACKOFF_JITTER));
  const floor = Math.min(jittered, MAX_RETRY_AFTER_MS);
  const retryAfterMs = Math.max(explicitMs ?? 0, floor);
  noteWillhabenBackoff(retryAfterMs);
  return retryAfterMs;
}

/** True when live willhaben is not in use (fixtures or an injected test handler). */
export function isSubstitutedHttp(): boolean {
  return testHandler !== undefined || Boolean(process.env.WILLHABEN_MCP_FIXTURES);
}

/**
 * Install (or clear) the injected dispatcher used by the offline suites.
 * `options` lets a test keep pacing/timeout/backoff behaviour switched on at a
 * scaled-down magnitude; omitting it reproduces the previous behaviour (pacing
 * off, production timeout and block base).
 */
export function setHttpTestHandler(handler: HttpTestHandler | undefined, options?: HttpTestOptions): void {
  testHandler = handler;
  testOptions = handler ? options ?? {} : {};
}

/** Test-only: drop queued spacing so a suite can start from a clean slot. */
export function resetRateLimiterForTests(): void {
  lastStart = 0;
  consecutiveBlocks = 0;
  rateLimitChain = Promise.resolve();
}

export function resetHttpClientForTests(): void {
  testHandler = undefined;
  testOptions = {};
  fixtureRoutes = undefined;
  blockedUntil = 0;
  resetRateLimiterForTests();
}

/**
 * Resolve `url` against `base` and reject anything that is not an allowlisted
 * willhaben host. Relative paths use `base` (HTML → www, JSON → publicapi).
 * Absolute URLs are still checked — they are never used as-is.
 */
export function resolveWillhabenUrl(url: string, base: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    throw new Error(`Invalid willhaben URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Refusing to fetch non-HTTP(S) URL (${parsed.protocol})`);
  }
  const host = parsed.hostname.replace(/\.+$/, "").toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) {
    throw new Error(
      `Refusing to fetch non-willhaben host "${parsed.hostname}" (allowed: www.willhaben.at, willhaben.at, publicapi.willhaben.at)`
    );
  }
  return parsed.href;
}

function headerValue(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === needle) return value;
  }
  return undefined;
}

function usableRetryAfter(headers: Record<string, string> | undefined): string | undefined {
  const value = headerValue(headers, "retry-after");
  if (value == null || value.trim() === "") return undefined;
  return value;
}

function explicitRetryAfterMs(headers: Record<string, string> | undefined, url: string): number | undefined {
  const header = usableRetryAfter(headers);
  if (header === undefined) return undefined;
  const raw = retryAfterRawMs(header, Date.now());
  if (raw === undefined) return undefined;
  if (raw > MAX_RETRY_AFTER_MS) {
    // Truncating this silently used to hide "come back in an hour" behind a
    // 60s cooldown; say so instead of pretending the block is short.
    console.error(
      `[willhaben-mcp] willhaben asked for Retry-After ${Math.round(raw / 1000)}s on ${url}; ` +
        `capping the cooldown at ${MAX_RETRY_AFTER_MS / 1000}s — expect further blocks`
    );
  }
  return Math.min(raw, MAX_RETRY_AFTER_MS);
}

function finalizeHttpResult(url: string, raw: HttpRawResult): HttpTextResult {
  const status = raw.status;
  // A bare 403 (no Retry-After) is the standard WAF shape. Treating it as a
  // normal error let deep search walk into the wall once per remaining listing.
  if (status === 429 || status === 403) {
    const retryAfterMs = registerBlock(explicitRetryAfterMs(raw.headers, url));
    throw new WillhabenBlockedError(status, retryAfterMs, url);
  }
  if (status < 400) consecutiveBlocks = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: raw.statusText ?? "",
    body: raw.body,
  };
}

async function loadFixture(url: string): Promise<HttpRawResult | null> {
  const dir = process.env.WILLHABEN_MCP_FIXTURES;
  if (!dir) return null;

  if (fixtureRoutes === undefined) {
    try {
      fixtureRoutes = JSON.parse(await readFile(join(dir, "routes.json"), "utf8")) as FixtureRoute[];
    } catch (error) {
      // Fail loudly: silently falling back to the live network here would
      // defeat the hermetic-test guarantee and hit willhaben from CI.
      throw new Error(
        `WILLHABEN_MCP_FIXTURES is set but ${join(dir, "routes.json")} could not be read or parsed: ` +
          (error instanceof Error ? error.message : String(error))
      );
    }
  }

  const route = fixtureRoutes.find((r) => url.includes(r.match));
  if (!route) return { status: 404, body: "fixture: no route matched " + url };

  // Fixture files must stay inside the fixtures directory (no ../ or absolute paths).
  const filePath = resolve(dir, route.file);
  if (!filePath.startsWith(resolve(dir) + sep)) {
    throw new Error(`fixture route file escapes the fixtures directory: ${route.file}`);
  }

  const body = await readFile(filePath, "utf8");
  return { status: route.status ?? 200, body, headers: route.headers };
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already consumed or not cancellable.
  }
}

function requestHeaders(accept: string, json: boolean): Record<string, string> {
  return json
    ? {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept": "application/json",
      }
    : {
        "User-Agent": DEFAULT_USER_AGENT,
        "Accept": accept,
        "Accept-Language": "de-AT,de;q=0.9,en;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
      };
}

function assertBodySize(body: string): void {
  if (body.length > MAX_BODY_BYTES) {
    throw new Error(`willhaben response exceeded ${MAX_BODY_BYTES} bytes`);
  }
}

function rawFromResponse(response: Response, body: string, location?: string): HttpRawResult {
  assertBodySize(body);
  return {
    status: response.status,
    statusText: response.statusText,
    body,
    headers: {
      "retry-after": response.headers.get("retry-after") ?? "",
      ...(location !== undefined ? { location } : {}),
    },
  };
}

function isFollowableLocation(location: string, base: string): boolean {
  try {
    resolveWillhabenUrl(location, base);
    return true;
  } catch {
    return false;
  }
}

/** One live hop. Redirect following lives in `fetchWithRedirects`. */
async function fetchOnce(url: string, accept: string, json: boolean, signal: AbortSignal): Promise<HttpRawResult> {
  const response = await fetch(url, {
    signal,
    redirect: "manual",
    headers: requestHeaders(accept, json),
  });

  const location = response.headers.get("location");
  if (isRedirectStatus(response.status) && location && isFollowableLocation(location, url)) {
    // Don't download a page we are about to leave; cancelling releases the socket.
    await cancelBody(response);
    return rawFromResponse(response, "", location);
  }

  const body = await response.text();
  return rawFromResponse(response, body, location ?? undefined);
}

function fetchTimeoutMs(): number {
  return testOptions.timeoutMs ?? FETCH_TIMEOUT_MS;
}

/**
 * Run one hop under `signal` **and** a fresh timeout, keeping the two apart in
 * the failure path: a caller cancel stays an AbortError (the server turns that
 * into a real MCP cancellation), a timeout becomes a `WillhabenTimeoutError`.
 * `AbortSignal.any` propagates the timeout's `TimeoutError` reason, so without
 * this split a 15s hang would look exactly like a client hanging up.
 */
async function withHopTimeout<T>(
  url: string,
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const budget = fetchTimeoutMs();
  const timeout = AbortSignal.timeout(budget);
  const composed = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
  try {
    return await run(composed);
  } catch (error) {
    if (callerSignal?.aborted) throw abortError(callerSignal);
    if (timeout.aborted || isTimeoutReason(error)) throw new WillhabenTimeoutError(url, budget);
    throw error;
  }
}

/** One hop through whichever transport is active: test handler, fixture, or live fetch. */
async function transportHop(url: string, accept: string, json: boolean, signal?: AbortSignal): Promise<HttpRawResult> {
  const handler = testHandler;
  if (handler) {
    const raw = await withHopTimeout(url, signal, (s) => handler(url, { signal: s }));
    assertBodySize(raw.body);
    return raw;
  }

  const fixture = await loadFixture(url);
  if (fixture) {
    throwIfAborted(signal);
    assertBodySize(fixture.body);
    return fixture;
  }

  return withHopTimeout(url, signal, (s) => fetchOnce(url, accept, json, s));
}

/**
 * Follow willhaben-only redirects (max 5 hops), pacing every extra hop.
 *
 * The caller is already inside `enqueue`, and `waitForDispatchSlot` only sleeps
 * on the dispatch interval — it never touches `rateLimitChain` — so re-entering
 * it here paces the hops without deadlocking the in-flight task. Aborts and the
 * per-hop timeout still cut through, because the wait is an abortable `sleep`.
 * Process-wide 403/429 backoff is waited *outside* the mutex (see `dispatch`).
 */
async function fetchWithRedirects(
  url: string,
  accept: string,
  json: boolean,
  signal?: AbortSignal
): Promise<{ url: string; raw: HttpRawResult }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    throwIfAborted(signal);
    // Hop 0 was paced by dispatch() already — waiting again would halve the rate.
    if (hop > 0) await waitForDispatchSlot(signal);

    const raw = await transportHop(current, accept, json, signal);
    if (!isRedirectStatus(raw.status) || hop === MAX_REDIRECTS) return { url: current, raw };

    const location = headerValue(raw.headers, "location");
    if (!location) return { url: current, raw };
    try {
      current = resolveWillhabenUrl(location, current);
    } catch {
      // Off-host Location: do not follow (SSRF). Return the 3xx as-is.
      return { url: current, raw };
    }
  }
  throw new Error(`Too many redirects for ${url}`);
}

/** Spacing between request starts; 0 disables pacing (fixtures / plain test handler). */
function dispatchIntervalMs(): number {
  if (!isSubstitutedHttp()) return MIN_INTERVAL_MS;
  return testOptions.minIntervalMs ?? 0;
}

async function waitForDispatchSlot(abort?: AbortSignal): Promise<void> {
  const interval = dispatchIntervalMs();
  while (true) {
    throwIfAborted(abort);
    const spacing = interval > 0 ? lastStart + interval - Date.now() : 0;
    const wait = Math.max(spacing, 0);
    if (wait === 0) break;
    await sleep(wait, abort);
  }
  lastStart = Date.now();
}

async function waitForBlockBackoff(signal?: AbortSignal): Promise<void> {
  const remaining = getBackoffRemainingMs();
  if (remaining <= 0) return;
  console.error(
    `[willhaben-mcp] waiting ${Math.round(remaining / 100) / 10}s before the next willhaben request (403/429 backoff)`
  );
  await sleep(remaining, signal);
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = rateLimitChain.then(work);
  // Swallow errors on the chain itself so one failure doesn't poison the queue.
  rateLimitChain = result.catch(() => {});
  return result;
}

async function performFetch(url: string, accept: string, json: boolean, signal?: AbortSignal): Promise<HttpTextResult> {
  const { url: finalUrl, raw } = await fetchWithRedirects(url, accept, json, signal);
  return finalizeHttpResult(finalUrl, raw);
}

async function dispatch(url: string, accept: string, json: boolean, options?: HttpRequestOptions): Promise<HttpTextResult> {
  const base = json ? WILLHABEN_PUBLIC_API : WILLHABEN_BASE_URL;
  const resolved = resolveWillhabenUrl(url, base);
  const signal = getAbortSignal(options?.signal);
  throwIfAborted(signal);

  // 403/429 cooldown is process-wide and can last up to 60s. Sleep it *before*
  // taking the dispatch mutex so a waiting caller is abortable independently
  // and stderr is the user-visible signal (MCP progress only exists mid-tool).
  for (;;) {
    throwIfAborted(signal);
    if (getBackoffRemainingMs() > 0) {
      await waitForBlockBackoff(signal);
      continue;
    }

    const outcome = await enqueue(async (): Promise<{ kind: "backoff" } | { kind: "ok"; result: HttpTextResult }> => {
      if (getBackoffRemainingMs() > 0) return { kind: "backoff" };
      await waitForDispatchSlot(signal);
      const result = await performFetch(resolved, accept, json, signal);
      return { kind: "ok", result };
    });

    if (outcome.kind === "ok") return outcome.result;
  }
}

/** Fetch a URL as text (HTML pages). Honors the fixture harness when active. */
export async function httpText(url: string, accept: string, options?: HttpRequestOptions): Promise<HttpTextResult> {
  return dispatch(url, accept, false, options);
}

/** Fetch a URL as JSON. Honors the fixture harness when active. */
export async function httpJson<T>(url: string, options?: HttpRequestOptions): Promise<{ ok: boolean; status: number; statusText: string; json: () => T }> {
  const response = await dispatch(url, "application/json", true, options);
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    json: () => JSON.parse(response.body) as T,
  };
}
