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
// Redirects are followed only onto allowlisted willhaben hosts, inside that
// same slot (needed for `/iad/object?adId=` → canonical listing URL).
//
// A 429 (and a 403 that carries a usable Retry-After) records a process-wide
// backoff and throws `WillhabenBlockedError`. A 403 without Retry-After is a
// normal non-OK response so callers can skip that listing without freezing.
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

/** Default backoff when 429/403 carries no usable Retry-After (matches 1 req/s). */
export const DEFAULT_RETRY_AFTER_MS = 1000;
/** Cap so a huge Retry-After cannot freeze the MCP server for an hour. */
export const MAX_RETRY_AFTER_MS = 60_000;

const ALLOWED_HOSTS = new Set(["www.willhaben.at", "willhaben.at", "publicapi.willhaben.at"]);
const MAX_REDIRECTS = 5;
const MIN_INTERVAL_MS = 1000 / RATE_LIMIT_PER_SEC;
/** Cap so a pathological willhaben page cannot blow the MCP process. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const abortStore = new AsyncLocalStorage<AbortSignal>();

let fixtureRoutes: FixtureRoute[] | undefined;
let testHandler: HttpTestHandler | undefined;
let blockedUntil = 0;
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

/** Parse a Retry-After header (delta-seconds or HTTP date) into a capped millisecond delay. */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number {
  if (header == null || header.trim() === "") return DEFAULT_RETRY_AFTER_MS;
  const trimmed = header.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(trimmed);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

export function noteWillhabenBackoff(retryAfterMs: number): void {
  const until = Date.now() + retryAfterMs;
  if (until > blockedUntil) blockedUntil = until;
}

export function getBackoffRemainingMs(): number {
  return Math.max(0, blockedUntil - Date.now());
}

/** True when live willhaben is not in use (fixtures or an injected test handler). */
export function isSubstitutedHttp(): boolean {
  return testHandler !== undefined || Boolean(process.env.WILLHABEN_MCP_FIXTURES);
}

export function setHttpTestHandler(handler: HttpTestHandler | undefined): void {
  testHandler = handler;
}

/** Test-only: drop queued spacing so a suite can start from a clean slot. */
export function resetRateLimiterForTests(): void {
  lastStart = 0;
  rateLimitChain = Promise.resolve();
}

export function resetHttpClientForTests(): void {
  testHandler = undefined;
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

function finalizeHttpResult(url: string, raw: HttpRawResult): HttpTextResult {
  const status = raw.status;
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headerValue(raw.headers, "retry-after"));
    noteWillhabenBackoff(retryAfterMs);
    throw new WillhabenBlockedError(status, retryAfterMs, url);
  }
  if (status === 403) {
    const retryAfterHeader = usableRetryAfter(raw.headers);
    if (retryAfterHeader !== undefined) {
      const retryAfterMs = parseRetryAfter(retryAfterHeader);
      noteWillhabenBackoff(retryAfterMs);
      throw new WillhabenBlockedError(status, retryAfterMs, url);
    }
  }
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

function rawFromResponse(response: Response, body: string): HttpRawResult {
  assertBodySize(body);
  return {
    status: response.status,
    statusText: response.statusText,
    body,
    headers: { "retry-after": response.headers.get("retry-after") ?? "" },
  };
}

/** Live fetch with willhaben-only redirect following (max 5 hops). */
async function fetchWillhaben(url: string, accept: string, json: boolean, signal?: AbortSignal): Promise<HttpRawResult> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    throwIfAborted(signal);
    const response = await fetch(current, {
      signal,
      redirect: "manual",
      headers: requestHeaders(accept, json),
    });

    if (isRedirectStatus(response.status) && hop < MAX_REDIRECTS) {
      const location = response.headers.get("location");
      if (location) {
        try {
          const next = resolveWillhabenUrl(location, current);
          await cancelBody(response);
          current = next;
          continue;
        } catch {
          // Off-host Location: do not follow (SSRF). Return the 3xx as-is.
        }
      }
    }

    const body = await response.text();
    return rawFromResponse(response, body);
  }
  throw new Error(`Too many redirects for ${url}`);
}

async function waitForDispatchSlot(abort?: AbortSignal): Promise<void> {
  while (true) {
    throwIfAborted(abort);
    const spacing = isSubstitutedHttp() ? 0 : lastStart + MIN_INTERVAL_MS - Date.now();
    const wait = Math.max(getBackoffRemainingMs(), spacing, 0);
    if (wait === 0) break;
    await sleep(wait, abort);
  }
  lastStart = Date.now();
}

function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = rateLimitChain.then(work);
  // Swallow errors on the chain itself so one failure doesn't poison the queue.
  rateLimitChain = result.catch(() => {});
  return result;
}

async function performFetch(url: string, accept: string, json: boolean, signal?: AbortSignal): Promise<HttpTextResult> {
  if (testHandler) {
    const raw = await testHandler(url, { signal });
    assertBodySize(raw.body);
    return finalizeHttpResult(url, raw);
  }

  const fixture = await loadFixture(url);
  if (fixture) {
    throwIfAborted(signal);
    assertBodySize(fixture.body);
    return finalizeHttpResult(url, fixture);
  }

  return finalizeHttpResult(url, await fetchWillhaben(url, accept, json, signal));
}

async function dispatch(url: string, accept: string, json: boolean, options?: HttpRequestOptions): Promise<HttpTextResult> {
  const base = json ? WILLHABEN_PUBLIC_API : WILLHABEN_BASE_URL;
  const resolved = resolveWillhabenUrl(url, base);
  const signal = getAbortSignal(options?.signal);
  throwIfAborted(signal);

  return enqueue(async () => {
    await waitForDispatchSlot(signal);
    return performFetch(resolved, accept, json, signal);
  });
}

/**
 * Compatibility wrapper: acquire the dispatch slot and release it without
 * fetching. Callers should not use this — `httpText`/`httpJson` already own
 * the slot. Kept so existing imports keep type-checking.
 */
export function rateLimit(signal?: AbortSignal): Promise<void> {
  const abort = getAbortSignal(signal);
  return enqueue(async () => {
    await waitForDispatchSlot(abort);
  });
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
