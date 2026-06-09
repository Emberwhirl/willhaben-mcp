---
name: apartment-hunt
description: Multi-step willhaben.at real-estate search and comparison. Use when the user wants to find, compare, or shortlist apartments or houses (to buy or rent) on willhaben with preferences like budget, location, rooms, and size — e.g. "help me find a 2-bedroom flat in Vienna under 350k", "compare houses to rent near Graz". Orchestrates search → value scoring → dedupe → details on the top matches → a ranked summary.
---

# Apartment Hunt (willhaben)

Guide the user from a loose brief to a ranked shortlist of real-estate listings, using the
willhaben MCP tools. Be efficient and concrete; don't over-ask.

## Tools

- `willhaben_search_real_estate` — primary search (property_type, action, location, price_from/to, rooms, area_from/to, sort, rows, page)
- `willhaben_get_listing` — full detail for one ad by `id`
- `willhaben_get_categories` — real-estate category paths if needed

## Step 1 — Capture preferences (ask only what's missing)

Required to start: **action** (buy/rent), **location**, and a **budget** (`price_to`, optionally `price_from`).
Nice to have: **rooms**, **size** (`area_from`/`area_to` m²), **property_type**
(eigentumswohnung / haus / mietwohnung / grundstueck), and any must-haves (balcony, garden,
parking, Erstbezug, lift) — these aren't filter params, so treat them as scoring/notes signals.

If the user already gave enough, skip the questions and proceed. Convert "300k" → 300000.
Location accepts an Austrian state, city, place, or postal code (e.g. "Wien", "Graz", "6020").

## Step 2 — Search

Call `willhaben_search_real_estate` with the mapped filters. Use `sort: "price_asc"` when the
user is budget-driven, otherwise `newest`. Use `rows: 25`. Pull at most **2 pages** total
(`page: 1`, then `page: 2` only if needed to get ~30–40 candidates). Do **not** deep-paginate.

## Step 3 — Score & dedupe

For each candidate compute a simple value picture:
- **€/m²** (use the listing's value if present, else price ÷ living area).
- Compare each listing's €/m² to the median of the result set; flag clearly-below-median as "good value"
  and far-above as "premium".
- Note **private vs dealer**, and whether it's a **project / Bauträger** ad (these can appear even
  when above the price filter — call that out, don't silently include).
- **Dedupe**: drop near-duplicate titles/addresses and obvious re-posts; keep the freshest.
- Down-rank listings missing the user's must-haves; up-rank ones that mention them.

## Step 4 — Shortlist + details

Pick the **top 3–5**. For each, call `willhaben_get_listing` with its `id` and extract:
description highlights, image count, exact address/area, seller type, contact option, and the
attributes relevant to the user (size, rooms, floor, condition, energy class, monthly costs / fees).

## Step 5 — Present

Produce:
1. A **ranked comparison table**: `Rank · Title · Price · €/m² · Size · Rooms · Location · Value · Link`.
2. A short **per-pick rationale** (2–3 bullets each: why it's here, value verdict, watch-outs).
3. A **summary line**: total matches found, the median €/m², and your single top recommendation.
4. **Next steps** the user can ask for: "details on #N", "only private sellers", "raise budget to X",
   "different area", "show rentals instead".

## Style & guardrails

- Be decisive — give a clear top pick and say why.
- Always include the listing URL so the user can open it.
- Flag anything suspicious (price far below market, vague address, "Symbolbild" only).
- Personal, non-commercial use only: keep `rows` modest, cap at ~2 pages, never harvest in bulk
  or use listings to contact sellers at scale. (See the project DISCLAIMER.)
