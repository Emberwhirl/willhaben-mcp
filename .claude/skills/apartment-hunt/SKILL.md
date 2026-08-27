---
name: apartment-hunt
description: Multi-step willhaben.at real-estate search and comparison. Use when the user wants to find, compare, or shortlist apartments or houses (to buy or rent) on willhaben with preferences like budget, location, rooms, and size — e.g. "help me find a 2-bedroom flat in Vienna under 350k", "compare houses to rent near Graz". Orchestrates search → value scoring → dedupe → details on the top matches → a ranked summary.
---

# Apartment Hunt (willhaben)

Guide the user from a loose brief to a ranked shortlist of real-estate listings, using the
willhaben MCP tools. Be efficient and concrete; don't over-ask.

## Tools

- `willhaben_deep_search` — **the primary tool for this workflow**. One call scans several result
  pages, dedupes, ranks everything by value, and returns full details for the top matches.
  Params: `vertical` (use `"real_estate"`), `property_type`, `action`, `location`, `price_from`/`price_to`,
  `rooms`, `area_from`/`area_to`, `keyword`, `category`, `sort`, `pages`, `detail_limit`, `rank_by`.
- `willhaben_search_real_estate` — plain single-page search (same filters plus `rows`/`page`).
  Use for a quick count, a follow-up variation, or if deep search is unavailable.
- `willhaben_get_listing` — full detail for one ad by `id`, for anything deep search didn't already detail
- `willhaben_get_categories` — real-estate category paths if needed

## Step 1 — Capture preferences (ask only what's missing)

Required to start: **action** (buy/rent), **location**, and a **budget** (`price_to`, optionally `price_from`).
Nice to have: **rooms**, **size** (`area_from`/`area_to` m²), **property_type**
(eigentumswohnung / haus / mietwohnung / grundstueck), and any must-haves (balcony, garden,
parking, Erstbezug, lift) — these aren't filter params, so treat them as scoring/notes signals.

If the user already gave enough, skip the questions and proceed. Convert "300k" → 300000.
Location accepts an Austrian state, city, place, or postal code (e.g. "Wien", "Graz", "6020").
If the place is ambiguous the server asks which area you meant — pass the user's answer straight back.

## Step 2 — One deep search

Call `willhaben_deep_search` **once**, with `vertical: "real_estate"` and every mapped filter —
`property_type`, `action`, `location`, `price_from`/`price_to`, `rooms`, `area_from`/`area_to`.
Don't fall back to keyword-only; the specialized params are what narrow the search.

Tuning (defaults are already right for most hunts):

- `rank_by` — defaults to `price_per_m2` for real estate, which is what a value hunt wants.
  Use `price_asc` only when the user is purely budget-driven and size doesn't matter.
- `pages` — 1–3, default **2**. Each page is 30 listings and one request. Use 3 only for a broad
  brief in a big market; use 1 for a tight filter that obviously returns few matches.
- `detail_limit` — 0–8, default **5**. This is how many top-ranked listings come back fully detailed,
  so it *is* your shortlist size. 5 is right for the usual "top 3–5" ask.
- `sort` — the willhaben-side sort to scan in (default `newest`). Ranking happens client-side across
  everything scanned, so leave it alone unless the user wants the freshest ads specifically.

**Call it once.** Defaults (2 pages + 5 details) are 7 polite requests (~7 seconds). The maximum is
3 pages + 8 details = 11 requests (~11 seconds) at the built-in 1 req/sec limit; progress is reported
while it works. Details use each listing's canonical URL (one hop). Do not loop it, do not re-run it
per page, and do not re-run it with slightly different params to "get more" — change filters only when
the user asks for a different search.

What comes back:

- `total` — every listing on willhaben matching the filters.
- `scanned_listings` — distinct listings actually collected and ranked (~30–90).
- `listings` — the **top 20** of that ranking only (a deliberate cap, so `scanned_listings` is
  normally larger; don't report it as "20 results found").
- `details` — full attributes, images, seller, address and contact option for the top `detail_limit`.
- `ranked_by`, `description` — what the ranking used and willhaben's own title for the search.

## Step 3 — Score & dedupe

The tool already deduped by ad ID across pages and ranked by €/m². Add the judgment it can't:

- **€/m²** is in the ranking, but sanity-check it (price ÷ living area) where either is odd or missing.
- Compare listings **within the returned set** — and be honest that the set is the *top* of the
  ranking, not a random sample. A "median" over the top 20 cheapest €/m² is a median of the best,
  so phrase value verdicts relative to the shortlist, not the whole market.
- Note **private vs dealer**, and whether it's a **project / Bauträger** ad (these can appear even
  when above the price filter — call that out, don't silently include).
- **Dedupe again by content**: near-duplicate titles/addresses and obvious re-posts survive the ID
  dedupe; keep the freshest.
- Down-rank listings missing the user's must-haves; up-rank ones that mention them.

## Step 4 — Shortlist + details

Your top 3–5 usually come pre-detailed in `details` — use those, don't re-fetch them. Read out
description highlights, image count, exact address/area, seller type, contact option, and the
attributes relevant to the user (size, rooms, floor, condition, energy class, monthly costs / fees).

Call `willhaben_get_listing` only for the gaps: a listing your Step 3 re-scoring promoted from
`listings` into the shortlist but that `details` didn't cover, or one the user asks about by name.
Keep that to a couple of calls.

## Step 5 — Present

Produce:
1. A **ranked comparison table**: `Rank · Title · Price · €/m² · Size · Rooms · Location · Value · Link`.
2. A short **per-pick rationale** (2–3 bullets each: why it's here, value verdict, watch-outs).
3. A **summary line**: `total` matches on willhaben, how many were actually scanned and ranked
   (`scanned_listings`), the €/m² range across the shortlist, and your single top recommendation.
4. **Next steps** the user can ask for: "details on #N", "only private sellers", "raise budget to X",
   "different area", "show rentals instead".

## Style & guardrails

- Be decisive — give a clear top pick and say why.
- Always include the listing URL so the user can open it.
- Flag anything suspicious (price far below market, vague address, "Symbolbild" only).
- Personal, non-commercial use only: one deep search per hunt, keep `pages`/`detail_limit` at the
  defaults unless there's a reason, never harvest in bulk or use listings to contact sellers at
  scale. (See the project DISCLAIMER.)
