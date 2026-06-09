// Willhaben Jobs API - Uses publicapi.willhaben.at (no scraping needed)
import { WillhabenJobsSearchResult, WillhabenJobAd, SimplifiedListing, VerticalId } from "./types.js";
import { fetchPublicApi, scrapeSearchResults } from "./scraper.js";
import { attributesToMap, simplifyAdSummary } from "./search.js";
import { SORT_CODES } from "../utils/constants.js";

/**
 * Simplify a job ad into a clean, readable format
 */
function simplifyJobAd(ad: WillhabenJobAd): SimplifiedListing {
  const attrs = attributesToMap(ad.attributes);

  const url = `https://www.willhaben.at/iad/job/${ad.id}`;
  const title = ad.description ?? "";
  const location = (attrs.LOCATION as string) ?? null;
  const orgName = (attrs.ORGNAME as string) ?? null;
  const published = (attrs.PUBLISHED_String as string) ?? (attrs.PUBLISHED as string) ?? null;
  const imageUrl = ad.advertImageList?.mainImageUrl ?? ad.advertImageList?.referenceImageUrl ?? null;

  return {
    id: ad.id,
    title,
    price: null,
    price_number: null,
    location,
    url,
    image_url: imageUrl,
    published,
    attributes: attrs,
    vertical: "Jobs",
    is_private: false,
    advertiser_name: orgName,
  };
}

/**
 * Search job listings using the public API
 */
export async function searchJobs(input: {
  keyword?: string;
  job_type?: string;
  sort?: string;
  rows?: number;
  page?: number;
}) {
  const { keyword, job_type, sort = "newest", rows = 30, page = 1 } = input;

  const params = new URLSearchParams();
  params.set("rows", String(rows));
  params.set("page", String(page));

  // Sort codes for jobs
  const sortMap: Record<string, string> = {
    newest: "1",
    nearby: "2",
  };
  const sortCode = sortMap[sort] ?? sortMap.newest;
  params.set("sort", sortCode);

  // Keyword search
  if (keyword) {
    params.set("keyword", keyword);
  }

  // Job type filter
  if (job_type) {
    params.set("JOB_TYPE", job_type);
  }

  const urlPath = `/jobs/v2/adverts?${params.toString()}`;

  try {
    const result = await fetchPublicApi<WillhabenJobsSearchResult>(urlPath);

    const listings = (result.advertSummaryList ?? []).map(simplifyJobAd);

    return {
      total: result.rowsFound,
      page: result.pageRequested ?? page,
      rows_per_page: result.rowsRequested ?? rows,
      listings,
      vertical: "jobs",
      description: result.searchTitle,
    };
  } catch (error) {
    // Fallback: try scraping the jobs page
    return searchJobsViaScraping(keyword, rows, page, sort);
  }
}

/**
 * Fallback: Search jobs via page scraping
 */
async function searchJobsViaScraping(keyword?: string, rows: number = 30, page: number = 1, sort?: string) {
  const params = new URLSearchParams();
  params.set("rows", String(rows));
  params.set("page", String(page));
  if (keyword) params.set("keyword", keyword);
  const sortCode = sort ? SORT_CODES[VerticalId.JOBS]?.[sort] : undefined;
  if (sortCode) params.set("sort", sortCode);

  const urlPath = `/iad/stellenmarkt?${params.toString()}`;
  const { result } = await scrapeSearchResults(urlPath);

  if (!result) {
    return { total: 0, page, rows_per_page: rows, listings: [], vertical: "jobs" };
  }

  const listings = (result.advertSummaryList?.advertSummary ?? []).map(simplifyAdSummary);

  return {
    total: result.rowsFound,
    page: result.pageRequested,
    rows_per_page: result.rowsRequested,
    listings,
    vertical: "jobs",
    description: result.searchTitle,
  };
}