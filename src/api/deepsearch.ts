// Deep search: scan several result pages, rank everything client-side, then
// pull full details for the top matches — the core of the apartment-hunt /
// bargain-hunt workflow as a single tool call.
//
// Work is strictly bounded (≤ 3 pages + ≤ 8 details ≈ ≤ 11 polite requests at
// the built-in 1 req/s limit) so a call finishes well within client timeouts.
// Progress is reported through an optional callback which the MCP layer maps
// to `notifications/progress`, and the whole run honors an AbortSignal so a
// cancelled request stops hitting willhaben immediately.
//
// Note: this is deliberately a synchronous (blocking) tool. Once the MCP
// Tasks extension (io.modelcontextprotocol/tasks) lands in the TypeScript
// server SDK, this is the natural candidate to return a task handle instead.

import { searchCars, searchMarketplace, searchRealEstate } from "./search.js";
import { getListingDetail } from "./detail.js";
import type { SimplifiedListing, SimplifiedListingDetail } from "./types.js";
import { isAbortError, runWithAbortSignal, throwIfAborted, WillhabenBlockedError } from "./httpClient.js";

export interface DeepSearchInput {
  vertical: "real_estate" | "cars" | "marketplace";
  keyword?: string;
  category?: string;
  location?: string;
  area_id?: string;
  price_from?: number;
  price_to?: number;
  sort?: string;
  pages?: number;
  detail_limit?: number;
  rank_by?: "price_asc" | "price_desc" | "price_per_m2" | "none";
  // Real estate (same fields as willhaben_search_real_estate)
  property_type?: string;
  action?: "buy" | "rent";
  rooms?: number;
  area_from?: number;
  area_to?: number;
  // Cars (same fields as willhaben_search_cars)
  make?: string;
  model?: string;
  year_from?: number;
  year_to?: number;
  mileage_from?: number;
  mileage_to?: number;
  fuel_type?: string;
  transmission?: string;
  // Cars + marketplace
  condition?: string;
}

export interface DeepSearchResult {
  total: number;
  scanned_pages: number;
  scanned_listings: number;
  vertical: string;
  description?: string;
  ranked_by: string;
  listings: SimplifiedListing[];
  details: SimplifiedListingDetail[];
}

export type ProgressReporter = (progress: number, total: number, message: string) => void | Promise<void>;

export const DEEP_SEARCH_MAX_PAGES = 3;
export const DEEP_SEARCH_MAX_DETAILS = 8;
const DEEP_SEARCH_ROWS = 30;
/**
 * How many ranked listings the result carries. Everything scanned still feeds
 * the ranking (and `scanned_listings` reports the full count), but returning
 * all ~60-90 raw listings blew past per-tool-result token caps in MCP clients
 * at default parameters — the top of the ranking is the useful part.
 */
export const DEEP_SEARCH_LISTINGS_CAP = 20;

function livingAreaOf(listing: SimplifiedListing): number | null {
  const raw = listing.attributes["ESTATE_SIZE/LIVING_AREA"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const parsed = parseFloat(String(value).replace(",", "."));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** €/m² if both price and living area are known (real estate). */
export function pricePerM2(listing: SimplifiedListing): number | null {
  if (listing.price_number == null) return null;
  const area = livingAreaOf(listing);
  if (area == null) return null;
  return listing.price_number / area;
}

function rank(listings: SimplifiedListing[], rankBy: string): SimplifiedListing[] {
  const byMetric = (metric: (l: SimplifiedListing) => number | null, ascending: boolean) =>
    [...listings].sort((a, b) => {
      const ma = metric(a);
      const mb = metric(b);
      if (ma == null && mb == null) return 0;
      if (ma == null) return 1; // unknowns last
      if (mb == null) return -1;
      return ascending ? ma - mb : mb - ma;
    });

  switch (rankBy) {
    case "price_asc":
      return byMetric((l) => l.price_number, true);
    case "price_desc":
      return byMetric((l) => l.price_number, false);
    case "price_per_m2":
      return byMetric(pricePerM2, true);
    default:
      return listings;
  }
}

function checkAborted(signal: AbortSignal | undefined): void {
  throwIfAborted(signal);
}

function searchDeepPage(input: DeepSearchInput, page: number) {
  const sort = input.sort ?? "newest";
  const shared = {
    location: input.location,
    area_id: input.area_id,
    price_from: input.price_from,
    price_to: input.price_to,
    sort,
    rows: DEEP_SEARCH_ROWS,
    page,
  };

  switch (input.vertical) {
    case "real_estate":
      return searchRealEstate({
        ...shared,
        keyword: input.keyword,
        category: input.category,
        property_type: input.property_type,
        action: input.action,
        rooms: input.rooms,
        area_from: input.area_from,
        area_to: input.area_to,
      });
    case "cars":
      return searchCars({
        ...shared,
        keyword: input.keyword,
        make: input.make,
        model: input.model,
        year_from: input.year_from,
        year_to: input.year_to,
        mileage_from: input.mileage_from,
        mileage_to: input.mileage_to,
        fuel_type: input.fuel_type,
        transmission: input.transmission,
        condition: input.condition,
      });
    case "marketplace":
      return searchMarketplace({
        ...shared,
        keyword: input.keyword,
        category: input.category,
        condition: input.condition,
      });
  }
}

export async function deepSearch(
  input: DeepSearchInput,
  options: { signal?: AbortSignal; onProgress?: ProgressReporter } = {}
): Promise<DeepSearchResult> {
  return runWithAbortSignal(options.signal, () => deepSearchBody(input, options));
}

async function deepSearchBody(
  input: DeepSearchInput,
  options: { signal?: AbortSignal; onProgress?: ProgressReporter }
): Promise<DeepSearchResult> {
  const { signal, onProgress } = options;
  const pages = Math.min(Math.max(input.pages ?? 2, 1), DEEP_SEARCH_MAX_PAGES);
  const detailLimit = Math.min(Math.max(input.detail_limit ?? 5, 0), DEEP_SEARCH_MAX_DETAILS);
  const rankBy = input.rank_by ?? (input.vertical === "real_estate" ? "price_per_m2" : "price_asc");

  // MCP progress `total` must stay stable for the whole run (do not shrink
  // after an early page break or fewer-than-limit details).
  const totalSteps = pages + detailLimit;
  let step = 0;
  const report = async (message: string) => {
    step += 1;
    await onProgress?.(step, totalSteps, message);
  };

  // Phase 1: scan result pages.
  const collected = new Map<string, SimplifiedListing>();
  let total = 0;
  let description: string | undefined;
  let scannedPages = 0;

  for (let pageNo = 1; pageNo <= pages; pageNo++) {
    checkAborted(signal);
    const result = await searchDeepPage(input, pageNo);
    scannedPages = pageNo;
    total = result.total;
    description = description ?? result.description;
    for (const listing of result.listings) {
      if (!collected.has(listing.id)) collected.set(listing.id, listing);
    }
    await report(`Scanned page ${pageNo}/${pages} — ${collected.size} distinct listings so far`);
    // Stop early when the site has no further pages.
    if (result.listings.length < DEEP_SEARCH_ROWS) break;
  }

  const ranked = rank([...collected.values()], rankBy);

  // Phase 2: pull details for the top-ranked listings.
  const detailTargets = ranked.slice(0, detailLimit);
  const details: SimplifiedListingDetail[] = [];
  for (const listing of detailTargets) {
    checkAborted(signal);
    try {
      const detail = await getListingDetail(listing.id);
      if (detail) {
        details.push(detail);
        await report(`Fetched details ${details.length}/${detailTargets.length}: ${listing.title.slice(0, 60)}`);
      } else {
        await report(`Skipped listing ${listing.id} (no longer available)`);
      }
    } catch (error) {
      if (isAbortError(error) || error instanceof WillhabenBlockedError) throw error;
      await report(`Skipped listing ${listing.id} (detail fetch failed)`);
    }
  }

  return {
    total,
    scanned_pages: scannedPages,
    scanned_listings: ranked.length,
    vertical: input.vertical,
    description,
    ranked_by: rankBy,
    listings: ranked.slice(0, DEEP_SEARCH_LISTINGS_CAP),
    details,
  };
}
