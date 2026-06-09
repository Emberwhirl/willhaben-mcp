// Willhaben Search API - Search listings via page scraping
import {
  WillhabenAdSummary,
  SimplifiedListing,
  SearchInput,
  RealEstateSearchInput,
  CarSearchInput,
  VerticalId,
} from "./types.js";
import { scrapeSearchResults } from "./scraper.js";
import { resolveLocationToAreaId } from "./geo.js";
import {
  SEARCH_URL_PATTERNS,
  SORT_CODES,
  CAR_FILTER_PARAMS,
  FUEL_TYPE_IDS,
  TRANSMISSION_IDS,
  CONDITION_IDS,
  VERTICAL_NAMES,
} from "../utils/constants.js";

/**
 * Simplify an ad summary into a clean, readable format
 */
export function simplifyAdSummary(ad: WillhabenAdSummary): SimplifiedListing {
  const attrs: Record<string, string | string[]> = {};
  if (ad.attributes?.attribute) {
    for (const attr of ad.attributes.attribute) {
      attrs[attr.name] = attr.values.length === 1 ? attr.values[0] : attr.values;
    }
  }

  const seoUrl = attrs.SEO_URL as string | undefined;
  const url = seoUrl
    ? `https://www.willhaben.at/iad/${seoUrl}`
    : `https://www.willhaben.at/iad/object?adId=${ad.id}`;

  const mainImage = ad.advertImageList?.advertImage?.[0];
  const imageUrl = mainImage?.mainImageUrl ?? mainImage?.referenceImageUrl ?? null;

  const priceForDisplay = attrs.PRICE_FOR_DISPLAY as string | undefined;
  const priceNumber = attrs.PRICE as string | undefined;
  const location = (attrs.LOCATION as string | undefined) ?? (attrs.ADDRESS as string | undefined) ?? null;
  const heading = attrs.HEADING as string | undefined;
  const orgName = attrs.ORGNAME as string | undefined;
  const isPrivate = attrs.ISPRIVATE as string | undefined;
  const published = attrs.PUBLISHED_String as string | undefined;

  return {
    id: ad.id,
    title: heading ?? ad.description ?? "",
    price: priceForDisplay ?? null,
    price_number: priceNumber ? parseFloat(priceNumber) : null,
    location,
    url,
    image_url: imageUrl,
    published: published ?? null,
    attributes: attrs,
    vertical: VERTICAL_NAMES[ad.verticalId] ?? String(ad.verticalId),
    is_private: isPrivate === "1",
    advertiser_name: orgName ?? null,
  };
}

/**
 * Universal search across all verticals
 */
export async function searchListings(input: SearchInput) {
  const { vertical: verticalName, keyword, category, rows = 30, page = 1, sort, price_from, price_to, location } = input;

  const verticalMap: Record<string, number> = {
    marketplace: VerticalId.MARKTPLATZ,
    real_estate: VerticalId.IMMOBILIEN,
    cars: VerticalId.AUTO_MOTOR,
    jobs: VerticalId.JOBS,
  };

  const verticalId = verticalMap[verticalName];
  if (!verticalId) {
    throw new Error(`Unknown vertical: ${verticalName}. Use: marketplace, real_estate, cars, or jobs`);
  }

  // Jobs uses the public API, not scraping
  if (verticalId === VerticalId.JOBS) {
    const { searchJobs } = await import("./jobs.js");
    return searchJobs({
      keyword,
      rows,
      page,
      sort: sort ?? "newest",
    });
  }

  // Build URL params
  const params: Record<string, string> = {
    rows: String(rows),
    page: String(page),
  };

  if (sort) {
    const sortCode = SORT_CODES[verticalId]?.[sort];
    if (sortCode) {
      params.sort = sortCode;
    }
  }

  if (keyword) {
    params.keyword = keyword;
  }

  // Price range filters (for real estate and marketplace)
  if (price_from !== undefined) {
    params.PRICE_FROM = String(price_from);
  }
  if (price_to !== undefined) {
    params.PRICE_TO = String(price_to);
  }

  // Location filter → areaId (Austrian state name/alias or numeric area ID)
  if (location) {
    const areaId = await resolveLocationToAreaId(location);
    if (areaId) params.areaId = areaId;
  }

  // Category for marketplace
  if (category && verticalId === VerticalId.MARKTPLATZ) {
    params.category = category;
  }

  const urlPath = SEARCH_URL_PATTERNS[verticalId](params);
  const { result } = await scrapeSearchResults(urlPath);

  if (!result) {
    return {
      total: 0,
      page,
      rows_per_page: rows,
      listings: [],
      vertical: verticalName,
    };
  }

  const listings = (result.advertSummaryList?.advertSummary ?? []).map(simplifyAdSummary);

  return {
    total: result.rowsFound,
    page: result.pageRequested,
    rows_per_page: result.rowsRequested,
    listings,
    vertical: verticalName,
    description: result.searchTitle,
  };
}

/**
 * Search real estate listings
 */
export async function searchRealEstate(input: RealEstateSearchInput) {
  const { property_type, action = "buy", location, price_from, price_to, rooms, area_from, area_to, sort, rows = 30, page = 1 } = input;

  // Determine the category path
  let categoryPath = "eigentumswohnung/eigentumswohnung-angebote"; // default

  if (property_type) {
    // Map common property types to their URL paths
    const typeMap: Record<string, string> = {
      eigentumswohnung: "eigentumswohnung",
      wohnung: "eigentumswohnung",
      apartment: "eigentumswohnung",
      haus: "haus",
      house: "haus",
      mietwohnung: "mietwohnung",
      rental: "mietwohnung",
      grundstueck: "grundstueck",
      buero: "buero-gewerbeimmobilie",
      gewerbe: "buero-gewerbeimmobilie",
    };

    const mapped = typeMap[property_type.toLowerCase()];
    if (mapped) {
      // Construct the full category path based on buy/rent
      if (action === "rent") {
        if (mapped === "eigentumswohnung") {
          categoryPath = "mietwohnung/mietwohnung-angebote";
        } else if (mapped === "haus") {
          categoryPath = "haus/haus-mieten";
        } else {
          categoryPath = `${mapped}/${mapped}-angebote`;
        }
      } else {
        categoryPath = `${mapped}/${mapped}-angebote`;
      }
    }
  } else if (action === "rent") {
    categoryPath = "mietwohnung/mietwohnung-angebote";
  }

  const params: Record<string, string> = {
    rows: String(rows),
    page: String(page),
  };

  if (sort) {
    const sortCode = SORT_CODES[VerticalId.IMMOBILIEN]?.[sort];
    if (sortCode) params.sort = sortCode;
  }

  if (price_from !== undefined) params.PRICE_FROM = String(price_from);
  if (price_to !== undefined) params.PRICE_TO = String(price_to);
  if (rooms) params.NUMBER_OF_ROOMS = String(rooms);
  if (area_from !== undefined) params["ESTATE_SIZE/LIVING_AREA_FROM"] = String(area_from);
  if (area_to !== undefined) params["ESTATE_SIZE/LIVING_AREA_TO"] = String(area_to);
  if (location) {
    const areaId = await resolveLocationToAreaId(location);
    if (areaId) params.areaId = areaId;
  }

  const urlPath = SEARCH_URL_PATTERNS[VerticalId.IMMOBILIEN]({ ...params, category: categoryPath });
  const { result } = await scrapeSearchResults(urlPath);

  if (!result) {
    return { total: 0, page, rows_per_page: rows, listings: [], vertical: "real_estate" };
  }

  const listings = (result.advertSummaryList?.advertSummary ?? []).map(simplifyAdSummary);

  return {
    total: result.rowsFound,
    page: result.pageRequested,
    rows_per_page: result.rowsRequested,
    listings,
    vertical: "real_estate",
    description: result.searchTitle,
  };
}

/**
 * Search car listings
 */
export async function searchCars(input: CarSearchInput) {
  const { make, model, location, price_from, price_to, year_from, year_to, mileage_from, mileage_to, fuel_type, transmission, condition, sort, rows = 30, page = 1 } = input;

  const params: Record<string, string> = {
    rows: String(rows),
    page: String(page),
  };

  if (sort) {
    const sortCode = SORT_CODES[VerticalId.AUTO_MOTOR]?.[sort];
    if (sortCode) params.sort = sortCode;
  }

  // Make/model: willhaben's CAR_MODEL/MAKE filter requires numeric brand IDs that
  // callers won't have. A numeric value is treated as an ID and passed through;
  // a name string (e.g. "BMW", "Golf") is folded into the free-text keyword search,
  // which willhaben supports on the car vertical.
  const keywordParts: string[] = [];
  if (make) {
    if (/^\d+$/.test(make)) params[CAR_FILTER_PARAMS.make] = make;
    else keywordParts.push(make);
  }
  if (model) {
    if (/^\d+$/.test(model)) params[CAR_FILTER_PARAMS.model] = model;
    else keywordParts.push(model);
  }
  if (keywordParts.length > 0) params.keyword = keywordParts.join(" ");

  if (location) {
    const areaId = await resolveLocationToAreaId(location);
    if (areaId) params.areaId = areaId;
  }

  if (price_from !== undefined) params[CAR_FILTER_PARAMS.price_from] = String(price_from);
  if (price_to !== undefined) params[CAR_FILTER_PARAMS.price_to] = String(price_to);
  if (year_from) params[CAR_FILTER_PARAMS.year_from] = String(year_from);
  if (year_to) params[CAR_FILTER_PARAMS.year_to] = String(year_to);
  if (mileage_from) params[CAR_FILTER_PARAMS.mileage_from] = String(mileage_from);
  if (mileage_to) params[CAR_FILTER_PARAMS.mileage_to] = String(mileage_to);
  if (fuel_type) {
    const fuelId = FUEL_TYPE_IDS[fuel_type.toLowerCase()];
    if (fuelId) params[CAR_FILTER_PARAMS.fuel_type] = fuelId;
  }
  if (transmission) {
    const transId = TRANSMISSION_IDS[transmission.toLowerCase()];
    if (transId) params[CAR_FILTER_PARAMS.transmission] = transId;
  }
  if (condition) {
    const condId = CONDITION_IDS[condition.toLowerCase()];
    if (condId) params[CAR_FILTER_PARAMS.condition] = condId;
  }

  const urlPath = SEARCH_URL_PATTERNS[VerticalId.AUTO_MOTOR](params);
  const { result } = await scrapeSearchResults(urlPath);

  if (!result) {
    return { total: 0, page, rows_per_page: rows, listings: [], vertical: "cars" };
  }

  const listings = (result.advertSummaryList?.advertSummary ?? []).map(simplifyAdSummary);

  return {
    total: result.rowsFound,
    page: result.pageRequested,
    rows_per_page: result.rowsRequested,
    listings,
    vertical: "cars",
    description: result.searchTitle,
  };
}

export interface MarketplaceSearchInput {
  keyword?: string;
  category?: string;
  condition?: string;
  location?: string;
  price_from?: number;
  price_to?: number;
  sort?: string;
  rows?: number;
  page?: number;
}

/**
 * Search marketplace listings
 */
export async function searchMarketplace(input: MarketplaceSearchInput = {}) {
  const { keyword, category, condition, location, price_from, price_to, sort, rows = 30, page = 1 } = input;

  const params: Record<string, string> = {
    rows: String(rows),
    page: String(page),
  };

  if (sort) {
    const sortCode = SORT_CODES[VerticalId.MARKTPLATZ]?.[sort];
    if (sortCode) params.sort = sortCode;
  }

  if (keyword) params.keyword = keyword;
  if (price_from !== undefined) params.PRICE_FROM = String(price_from);
  if (price_to !== undefined) params.PRICE_TO = String(price_to);

  if (location) {
    const areaId = await resolveLocationToAreaId(location);
    if (areaId) params.areaId = areaId;
  }

  // Condition filter for marketplace — willhaben encodes condition as a
  // `treeAttributes` value (neu=22, gebraucht=23, defekt=24).
  if (condition) {
    const conditionMap: Record<string, string> = {
      neu: "22",
      new: "22",
      gebraucht: "23",
      used: "23",
      defekt: "24",
      defective: "24",
    };
    const condId = conditionMap[condition.toLowerCase()];
    if (condId) params.treeAttributes = condId;
  }

  const urlPath = SEARCH_URL_PATTERNS[VerticalId.MARKTPLATZ]({ ...params, category: category ?? "" });
  const { result } = await scrapeSearchResults(urlPath);

  if (!result) {
    return { total: 0, page, rows_per_page: rows, listings: [], vertical: "marketplace" };
  }

  const listings = (result.advertSummaryList?.advertSummary ?? []).map(simplifyAdSummary);

  return {
    total: result.rowsFound,
    page: result.pageRequested,
    rows_per_page: result.rowsRequested,
    listings,
    vertical: "marketplace",
    description: result.searchTitle,
  };
}