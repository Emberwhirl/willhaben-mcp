// Zod schemas for tool inputs and structured outputs (MCP outputSchema /
// structuredContent). The output schemas are the single source of truth for
// what `structuredContent` carries; the human-readable text blocks are
// rendered from the same data by utils/formatters.ts, and the bundled MCP App
// (ui/) renders the same payload as an interactive gallery.
import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

/** willhaben attribute map: attribute name → value or values. */
const attributesSchema = z
  .record(z.string(), z.union([z.string(), z.array(z.string())]))
  .describe("Raw willhaben attributes (name → value/values), e.g. ESTATE_SIZE/LIVING_AREA, MILEAGE");

export const listingSchema = z.object({
  id: z.string().describe("willhaben listing/ad ID"),
  title: z.string(),
  price: z.string().nullable().describe("Display price, e.g. '€ 185.000'"),
  price_number: z.number().nullable().describe("Numeric price in EUR"),
  location: z.string().nullable(),
  url: z.string().describe("Canonical willhaben.at URL"),
  image_url: z.string().nullable().describe("Main image URL"),
  published: z.string().nullable().describe("Publication date/time as displayed"),
  attributes: attributesSchema,
  vertical: z.string(),
  is_private: z.boolean().describe("true = private seller, false = dealer/company"),
  advertiser_name: z.string().nullable(),
});
export type Listing = z.infer<typeof listingSchema>;

const querySchema = z
  .object({
    tool: z.string().describe("Name of the tool that produced this result"),
    args: z.record(z.string(), z.unknown()).describe("Arguments as executed (location resolved). Re-call `tool` with these args and a different `page` to paginate."),
  })
  .describe("Echo of the executed query, for pagination and refinement");

export const searchResultSchema = z.object({
  query: querySchema,
  total: z.number().describe("Total listings matching the query"),
  page: z.number(),
  rows_per_page: z.number(),
  vertical: z.string(),
  description: z.string().optional().describe("willhaben's own title for this search"),
  location_note: z.string().optional().describe("Set when the location was disambiguated, skipped, or could not be resolved"),
  listings: z.array(listingSchema),
});
export type SearchResultPayload = z.infer<typeof searchResultSchema>;

export const listingDetailSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  price: z.string().nullable(),
  price_number: z.number().nullable(),
  location: z.string().nullable(),
  url: z.string(),
  images: z.array(z.string()),
  attributes: attributesSchema,
  vertical: z.string(),
  is_private: z.boolean(),
  advertiser: z.object({
    name: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
    logo_url: z.string().nullable(),
    active_ad_count: z.number().nullable(),
  }),
  address: z.object({
    street: z.string().nullable(),
    postcode: z.string().nullable(),
    city: z.string().nullable(),
    country: z.string().nullable(),
    coordinates: z.string().nullable(),
  }),
  contact_type: z.string().nullable(),
  chat_enabled: z.boolean(),
  published_date: z.string().nullable(),
  category_id: z.number().nullable(),
});

export const detailResultSchema = z.object({
  listing: listingDetailSchema,
});

export const categoriesResultSchema = z.object({
  vertical: z.string(),
  categories: z.array(
    z.object({
      key: z.string().describe("Short key"),
      path: z.string().describe("URL path / slug to pass as the `category` parameter"),
      name: z.string().describe("Human-readable name"),
    })
  ),
  note: z.string().optional(),
});

export const deepSearchResultSchema = z.object({
  query: querySchema,
  total: z.number().describe("Total listings matching the query on willhaben"),
  scanned_pages: z.number(),
  scanned_listings: z.number().describe("Distinct listings collected across the scanned pages"),
  vertical: z.string(),
  description: z.string().optional(),
  location_note: z.string().optional(),
  ranked_by: z.string(),
  listings: z.array(listingSchema).describe("Top-ranked listings (capped at 20; `scanned_listings` counts everything that fed the ranking)"),
  details: z.array(listingDetailSchema).describe("Full details for the top-ranked listings"),
});

// ---------------------------------------------------------------------------
// Tool input schemas
// ---------------------------------------------------------------------------

const rows = z.number().int().min(1).max(100).optional().describe("Results per page (default: 30, max: 100)");
const page = z.number().int().min(1).max(200).optional().describe("Page number (default: 1)");
const locationParam = z
  .string()
  .optional()
  .describe(
    "Location: Austrian state, city, place, or postal code (e.g. 'Wien', 'Graz', '6020'). Resolved to a willhaben area automatically; if several areas match you may be asked which one you meant."
  );
const priceFrom = z.number().optional().describe("Minimum price");
const priceTo = z.number().optional().describe("Maximum price");

export const searchInputSchema = z.object({
  vertical: z.enum(["marketplace", "real_estate", "cars", "jobs"]).describe("Which vertical to search"),
  keyword: z.string().optional().describe("Search term/keyword"),
  category: z.string().optional().describe("Category path (e.g., 'eigentumswohnung/eigentumswohnung-angebote' for real estate)"),
  location: locationParam,
  price_from: priceFrom,
  price_to: priceTo,
  sort: z.string().optional().describe("Sort order: 'newest', 'nearby', 'price_asc', 'price_desc', 'relevance'"),
  rows,
  page,
});

export const realEstateInputSchema = z.object({
  property_type: z.string().optional().describe("Property type: 'eigentumswohnung' (apartment), 'haus' (house), 'mietwohnung' (rental), 'grundstueck' (land)"),
  action: z.enum(["buy", "rent"]).optional().describe("Buy or rent (default: buy)"),
  location: locationParam,
  price_from: priceFrom,
  price_to: priceTo,
  rooms: z.number().optional().describe("Number of rooms"),
  area_from: z.number().optional().describe("Minimum living area in m²"),
  area_to: z.number().optional().describe("Maximum living area in m²"),
  sort: z.string().optional().describe("Sort: 'newest', 'nearby', 'price_asc', 'price_desc', 'area_asc', 'area_desc', 'relevance'"),
  rows,
  page,
});

export const carsInputSchema = z.object({
  make: z.string().optional().describe("Car brand (e.g., 'BMW', 'Audi'). Matched as a keyword unless a numeric willhaben make ID is given."),
  model: z.string().optional().describe("Car model (matched as a keyword)"),
  location: locationParam,
  price_from: priceFrom,
  price_to: priceTo,
  year_from: z.number().optional().describe("Minimum year of construction"),
  year_to: z.number().optional().describe("Maximum year of construction"),
  mileage_from: z.number().optional().describe("Minimum mileage in km"),
  mileage_to: z.number().optional().describe("Maximum mileage in km"),
  fuel_type: z.string().optional().describe("Fuel type: 'petrol', 'diesel', 'electric', 'hybrid_petrol', 'hybrid_diesel'"),
  transmission: z.string().optional().describe("Transmission: 'manual' or 'automatic'"),
  condition: z.string().optional().describe("Condition: 'used', 'new', 'year_old'"),
  sort: z.string().optional().describe("Sort: 'newest', 'nearby', 'price_asc', 'price_desc', 'mileage_asc', 'mileage_desc', 'year_desc', 'year_asc', 'relevance'"),
  rows,
  page,
});

export const jobsInputSchema = z.object({
  keyword: z.string().optional().describe("Job title or keyword (also matches location names, e.g. 'Software Wien')"),
  job_type: z.string().optional().describe("Job type: 'Vollzeit', 'Teilzeit', etc."),
  sort: z.string().optional().describe("Sort: 'newest' or 'nearby'"),
  rows,
  page,
});

export const marketplaceInputSchema = z.object({
  keyword: z.string().optional().describe("Search term/keyword"),
  category: z.string().optional().describe("Category slug including the numeric ID (e.g., 'computer-software-5824'). Use willhaben_get_categories to list valid slugs."),
  condition: z.string().optional().describe("Item condition: 'neu'/'new', 'gebraucht'/'used', or 'defekt'/'defective'"),
  location: locationParam,
  price_from: priceFrom,
  price_to: priceTo,
  sort: z.string().optional().describe("Sort: 'newest', 'price_asc', 'price_desc', 'relevance'"),
  rows,
  page,
});

export const getListingInputSchema = z.object({
  id: z
    .string()
    .regex(/^\d{1,16}$/)
    .describe("The willhaben listing/ad ID (e.g., '1370327604')"),
});

export const getCategoriesInputSchema = z.object({
  vertical: z.enum(["marketplace", "real_estate", "cars", "jobs"]).describe("Which vertical to get categories for"),
});

export const deepSearchInputSchema = z.object({
  vertical: z.enum(["real_estate", "cars", "marketplace"]).describe("Vertical to deep-search (jobs not supported)"),
  keyword: z.string().optional().describe("Search term/keyword"),
  category: z.string().optional().describe("Category path/slug (see willhaben_get_categories)"),
  location: locationParam,
  price_from: priceFrom,
  price_to: priceTo,
  sort: z.string().optional().describe("willhaben sort to scan in: 'newest' (default), 'price_asc', ..."),
  pages: z.number().int().min(1).max(3).optional().describe("Result pages to scan, 1-3 (default 2). Each page is one polite request."),
  detail_limit: z.number().int().min(0).max(8).optional().describe("How many top-ranked listings to fetch full details for, 0-8 (default 5). Each detail is one polite request."),
  rank_by: z
    .enum(["price_asc", "price_desc", "price_per_m2", "none"])
    .optional()
    .describe("Client-side ranking across all scanned pages. 'price_per_m2' is best for real estate value hunting (default there); elsewhere defaults to 'price_asc'."),
  // Real estate — same fields / describes as willhaben_search_real_estate
  property_type: z.string().optional().describe("Property type: 'eigentumswohnung' (apartment), 'haus' (house), 'mietwohnung' (rental), 'grundstueck' (land)"),
  action: z.enum(["buy", "rent"]).optional().describe("Buy or rent (default: buy)"),
  rooms: z.number().optional().describe("Number of rooms"),
  area_from: z.number().optional().describe("Minimum living area in m²"),
  area_to: z.number().optional().describe("Maximum living area in m²"),
  // Cars — same fields / describes as willhaben_search_cars
  make: z.string().optional().describe("Car brand (e.g., 'BMW', 'Audi'). Matched as a keyword unless a numeric willhaben make ID is given."),
  model: z.string().optional().describe("Car model (matched as a keyword)"),
  year_from: z.number().optional().describe("Minimum year of construction"),
  year_to: z.number().optional().describe("Maximum year of construction"),
  mileage_from: z.number().optional().describe("Minimum mileage in km"),
  mileage_to: z.number().optional().describe("Maximum mileage in km"),
  fuel_type: z.string().optional().describe("Fuel type: 'petrol', 'diesel', 'electric', 'hybrid_petrol', 'hybrid_diesel'"),
  transmission: z.string().optional().describe("Transmission: 'manual' or 'automatic'"),
  // Cars + marketplace condition (vertical decides the encoding)
  condition: z.string().optional().describe("Cars: 'used', 'new', 'year_old'. Marketplace: 'neu'/'new', 'gebraucht'/'used', or 'defekt'/'defective'"),
});
