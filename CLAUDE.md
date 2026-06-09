# CLAUDE.md

Guidance for working **on** this codebase. End-user install/usage lives in `README.md`;
legal posture lives in `DISCLAIMER.md` (do not weaken either — see Invariants).

## What this is

An MCP server (`@modelcontextprotocol/sdk`, stdio) that searches willhaben.at by scraping the
`__NEXT_DATA__` JSON embedded in public pages, plus the public `publicapi.willhaben.at` (jobs)
and `/webapi/autocomplete/area` (location). No auth, no API keys, no reverse-engineered tokens.
TypeScript, ESM, Node ≥ 18 (global `fetch`).

## Commands

```bash
npm install
npm run build                      # tsup → dist/index.js (shebang banner, ESM)
npm run dev                        # tsx src/index.ts
npx tsc --noEmit --noUnusedLocals --noUnusedParameters   # strict type check
npx tsx test/integration.test.ts   # smoke test per vertical (hits live willhaben)
npx tsx test/filters.test.ts       # asserts every filter actually narrows results
```

After editing `src/`, run the build and at least `filters.test.ts` before claiming done.
Tests hit the live site, so failures can be network/markup drift — check before assuming a bug.

## Layout

- `src/index.ts` — MCP server + tool definitions (zod schemas). Row count capped at 100.
- `src/api/scraper.ts` — `__NEXT_DATA__` extraction (cheerio), rate limiter, cache, `fetchPublicApi`.
- `src/api/search.ts` — real-estate / cars / marketplace search + result simplification.
- `src/api/jobs.ts` — jobs via `publicapi.willhaben.at/jobs/v2/adverts`.
- `src/api/detail.ts` — single-listing detail (scrape `/iad/object?adId=<id>`).
- `src/api/geo.ts` — `resolveLocationToAreaId`: numeric → static state map → live autocomplete.
- `src/utils/constants.ts` — verticals, `SEARCH_URL_PATTERNS`, sort codes, car filter names, area IDs.
- `src/utils/formatters.ts` — human-readable output.

## Hard-won facts (do not relearn the hard way)

- **Verticals:** 1 = jobs, 2 = immobilien, 3 = auto, 5 = marktplatz.
- **URL builders must pass *every* param through.** `buildQuery` in `constants.ts` emits all params
  except `category` (which is path, not query). A previous bug only emitted `rows/page/sort/keyword`,
  silently dropping every filter. Never go back to hand-listing query keys.
- **`__NEXT_DATA__` shape varies by page:** result lists use `props.pageProps.searchResult`, but
  auto/landing pages use `props.pageProps.initialSearchResult`; detail pages use `advertDetails`.
  `scrapeSearchResults` already handles the first two.
- **Auto search URL needs the `/iad/` prefix:** `/iad/gebrauchtwagen/auto/gebrauchtwagenboerse`.
- **Verified willhaben query-param names** (tested live against result counts):
  - Price: `PRICE_FROM` / `PRICE_TO` (real estate, cars, marketplace)
  - Real estate: `NUMBER_OF_ROOMS`, `ESTATE_SIZE/LIVING_AREA_FROM` / `…_TO`
  - Cars: `CAR_MODEL/MAKE`, `CAR_MODEL/MODEL` (**numeric IDs only**), `YEAR_MODEL_FROM/TO`,
    `MILEAGE_FROM/TO`, `ENGINE/FUEL`, `TRANSMISSION`, `MOTOR_CONDITION`
  - Location: `areaId` (real estate, cars, marketplace — **not** jobs)
  - Marketplace condition: `treeAttributes` (neu=22, gebraucht=23, defekt=24)
- **Car make/model** are folded into the free-text `keyword` unless the value is numeric (then used
  as `CAR_MODEL/MAKE`/`MODEL`). Brand-name → ID mapping is intentionally not maintained.
- **Jobs ignore location.** `areaId`/`AREA` do nothing on the jobs API — keyword only.
- **Location resolution** (`geo.ts`): numeric passes through; 9 Austrian states resolve offline via
  `LOCATION_AREA_IDS` (Wien = 900); anything else hits `/webapi/autocomplete/area?term=…&source=desktop`
  (no auth) and prefers Gemeinde → PLZ → Ort.
- **Project / Bauträger ads** can appear above `price_to` in real estate — willhaben surfaces them as
  teasers. The count still reflects the filter. Don't "fix" this as a bug.
- **Detail field is `searchResult.searchTitle`**, not `.description` (the latter is per-ad).

## Invariants — keep these intact

- Rate limit **1 req/sec** (`RATE_LIMIT_PER_SEC`) and **5-min cache** (`CACHE_TTL_MS`). Don't raise to
  enable bulk fetching. Row count stays capped at 100 in `index.ts`.
- Keep the legal disclaimers (`DISCLAIMER.md`, README "Legal & Responsible Use", LICENSE notice) and the
  non-affiliation framing. Don't claim the tool is "authorized" or "fully legal."
- No new runtime deps without need; current deps (`@modelcontextprotocol/sdk`, `cheerio`, `zod`) are all MIT.
- MCP tool names are unprefixed here (`willhaben_search`, …); clients see them as `mcp__willhaben__*`.

## Adding a filter (checklist)

1. Add the field to the tool's zod schema in `index.ts` and pass it through to the search fn.
2. Map it to the **verified** willhaben query param in `search.ts` (confirm the param name against a
   live result-count change before trusting it).
3. It flows to the URL automatically via `buildQuery` — no `constants.ts` change needed.
4. Add an assertion in `test/filters.test.ts` that the filter narrows the result count.
