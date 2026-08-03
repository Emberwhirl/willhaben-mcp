// Thin HTTP layer shared by the scraper, the geo lookup, and the jobs API.
//
// All willhaben traffic funnels through `httpText`/`httpJson` so that a single
// place owns headers — and so that the offline test harness can substitute
// recorded fixtures: when the `WILLHABEN_MCP_FIXTURES` environment variable
// points at a directory, requests are answered from `routes.json` in that
// directory instead of the network. This keeps protocol-level tests hermetic
// (no live willhaben traffic) without touching any production code path.
//
// routes.json format: [{ "match": "<substring of URL>", "file": "<relative path>", "status": 200 }]
// The first entry whose `match` is contained in the URL wins.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_USER_AGENT } from "../utils/constants.js";

interface FixtureRoute {
  match: string;
  file: string;
  status?: number;
}

let fixtureRoutes: FixtureRoute[] | null | undefined;

async function loadFixture(url: string): Promise<{ status: number; body: string } | null> {
  const dir = process.env.WILLHABEN_MCP_FIXTURES;
  if (!dir) return null;

  if (fixtureRoutes === undefined) {
    try {
      fixtureRoutes = JSON.parse(await readFile(join(dir, "routes.json"), "utf8")) as FixtureRoute[];
    } catch {
      fixtureRoutes = null;
    }
  }
  if (!fixtureRoutes) return null;

  const route = fixtureRoutes.find((r) => url.includes(r.match));
  if (!route) return { status: 404, body: "fixture: no route matched " + url };

  const body = await readFile(join(dir, route.file), "utf8");
  return { status: route.status ?? 200, body };
}

export interface HttpTextResult {
  ok: boolean;
  status: number;
  statusText: string;
  body: string;
}

/** Fetch a URL as text (HTML pages). Honors the fixture harness when active. */
export async function httpText(url: string, accept: string): Promise<HttpTextResult> {
  const fixture = await loadFixture(url);
  if (fixture) {
    return { ok: fixture.status >= 200 && fixture.status < 300, status: fixture.status, statusText: "", body: fixture.body };
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      "Accept": accept,
      "Accept-Language": "de-AT,de;q=0.9,en;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      "Connection": "keep-alive",
    },
  });
  return { ok: response.ok, status: response.status, statusText: response.statusText, body: await response.text() };
}

/** Fetch a URL as JSON. Honors the fixture harness when active. */
export async function httpJson<T>(url: string): Promise<{ ok: boolean; status: number; statusText: string; json: () => T }> {
  const fixture = await loadFixture(url);
  if (fixture) {
    return {
      ok: fixture.status >= 200 && fixture.status < 300,
      status: fixture.status,
      statusText: "",
      json: () => JSON.parse(fixture.body) as T,
    };
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      "Accept": "application/json",
    },
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, statusText: response.statusText, json: () => JSON.parse(text) as T };
}
