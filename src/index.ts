// Willhaben MCP Server - Main Entry Point
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchListings, searchRealEstate, searchCars, searchMarketplace } from "./api/search.js";
import { searchJobs } from "./api/jobs.js";
import { getListingDetail } from "./api/detail.js";
import { REAL_ESTATE_CATEGORIES, MARKETPLACE_CATEGORIES } from "./utils/constants.js";
import { formatSearchResults, formatDetail, formatCategories } from "./utils/formatters.js";

const server = new McpServer({
  name: "willhaben",
  version: "1.0.0",
  description: "Search willhaben.at - Austria's largest classifieds marketplace. Search real estate, cars, jobs, and marketplace listings.",
});

// Tool 1: willhaben_search - Universal search
server.tool(
  "willhaben_search",
  "Search willhaben.at across all verticals (marketplace, real estate, cars, jobs). Returns listing summaries with prices, locations, and key attributes.",
  {
    vertical: z.enum(["marketplace", "real_estate", "cars", "jobs"]).describe("Which vertical to search"),
    keyword: z.string().optional().describe("Search term/keyword"),
    category: z.string().optional().describe("Category path (e.g., 'eigentumswohnung/eigentumswohnung-angebote' for real estate)"),
    location: z.string().optional().describe("Location: Austrian state, city, place, or postal code (e.g. 'Wien', 'Graz', 'Innsbruck', '6020'). Resolved to an area automatically. Not supported for jobs."),
    price_from: z.number().optional().describe("Minimum price"),
    price_to: z.number().optional().describe("Maximum price"),
    sort: z.string().optional().describe("Sort order: 'newest', 'nearby', 'price_asc', 'price_desc', 'relevance'"),
    rows: z.number().optional().describe("Results per page (default: 30, max: 100)"),
    page: z.number().optional().describe("Page number (default: 1)"),
  },
  async (params) => {
    try {
      const result = await searchListings({
        vertical: params.vertical,
        keyword: params.keyword,
        category: params.category,
        location: params.location,
        price_from: params.price_from,
        price_to: params.price_to,
        sort: params.sort,
        rows: Math.min(params.rows ?? 30, 100),
        page: params.page ?? 1,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: formatSearchResults(
              result.total,
              result.page,
              result.rows_per_page,
              result.listings,
              result.vertical,
              result.description
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error searching willhaben: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Tool 2: willhaben_search_real_estate - Real estate search
server.tool(
  "willhaben_search_real_estate",
  "Search willhaben.at real estate listings (apartments, houses for sale/rent). Filter by property type, price, rooms, area, and location.",
  {
    property_type: z.string().optional().describe("Property type: 'eigentumswohnung' (apartment), 'haus' (house), 'mietwohnung' (rental), 'grundstueck' (land)"),
    action: z.enum(["buy", "rent"]).optional().describe("Buy or rent (default: buy)"),
    location: z.string().optional().describe("Location: Austrian state, city, place, or postal code (e.g. 'Wien', 'Graz', '6020'). Resolved to an area automatically."),
    price_from: z.number().optional().describe("Minimum price"),
    price_to: z.number().optional().describe("Maximum price"),
    rooms: z.number().optional().describe("Number of rooms"),
    area_from: z.number().optional().describe("Minimum living area in m²"),
    area_to: z.number().optional().describe("Maximum living area in m²"),
    sort: z.string().optional().describe("Sort: 'newest', 'nearby', 'price_asc', 'price_desc', 'area_asc', 'area_desc', 'relevance'"),
    rows: z.number().optional().describe("Results per page (default: 30)"),
    page: z.number().optional().describe("Page number (default: 1)"),
  },
  async (params) => {
    try {
      const result = await searchRealEstate({
        property_type: params.property_type,
        action: params.action,
        location: params.location,
        price_from: params.price_from,
        price_to: params.price_to,
        rooms: params.rooms,
        area_from: params.area_from,
        area_to: params.area_to,
        sort: params.sort,
        rows: Math.min(params.rows ?? 30, 100),
        page: params.page ?? 1,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: formatSearchResults(
              result.total,
              result.page,
              result.rows_per_page,
              result.listings,
              "real_estate",
              result.description
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error searching real estate: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Tool 3: willhaben_search_cars - Car search
server.tool(
  "willhaben_search_cars",
  "Search willhaben.at car listings (used cars, new cars). Filter by make, model, price, year, mileage, fuel type, and transmission.",
  {
    make: z.string().optional().describe("Car brand (e.g., 'BMW', 'Audi', 'Volkswagen'). Matched as a keyword unless a numeric willhaben make ID is given."),
    model: z.string().optional().describe("Car model (matched as a keyword)"),
    location: z.string().optional().describe("Location: Austrian state, city, place, or postal code (e.g. 'Wien', 'Graz', '6020'). Resolved to an area automatically."),
    price_from: z.number().optional().describe("Minimum price"),
    price_to: z.number().optional().describe("Maximum price"),
    year_from: z.number().optional().describe("Minimum year of construction"),
    year_to: z.number().optional().describe("Maximum year of construction"),
    mileage_from: z.number().optional().describe("Minimum mileage in km"),
    mileage_to: z.number().optional().describe("Maximum mileage in km"),
    fuel_type: z.string().optional().describe("Fuel type: 'petrol', 'diesel', 'electric', 'hybrid_petrol', 'hybrid_diesel'"),
    transmission: z.string().optional().describe("Transmission: 'manual' or 'automatic'"),
    condition: z.string().optional().describe("Condition: 'used', 'new', 'year_old'"),
    sort: z.string().optional().describe("Sort: 'newest', 'nearby', 'price_asc', 'price_desc', 'mileage_asc', 'mileage_desc', 'year_desc', 'year_asc', 'relevance'"),
    rows: z.number().optional().describe("Results per page (default: 30)"),
    page: z.number().optional().describe("Page number (default: 1)"),
  },
  async (params) => {
    try {
      const result = await searchCars({
        make: params.make,
        model: params.model,
        location: params.location,
        price_from: params.price_from,
        price_to: params.price_to,
        year_from: params.year_from,
        year_to: params.year_to,
        mileage_from: params.mileage_from,
        mileage_to: params.mileage_to,
        fuel_type: params.fuel_type,
        transmission: params.transmission,
        condition: params.condition,
        sort: params.sort,
        rows: Math.min(params.rows ?? 30, 100),
        page: params.page ?? 1,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: formatSearchResults(
              result.total,
              result.page,
              result.rows_per_page,
              result.listings,
              "cars",
              result.description
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error searching cars: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Tool 4: willhaben_search_jobs - Job search
server.tool(
  "willhaben_search_jobs",
  "Search willhaben.at job listings. Filter by keyword and job type.",
  {
    keyword: z.string().optional().describe("Job title or keyword (also matches location names, e.g. 'Software Wien')"),
    job_type: z.string().optional().describe("Job type: 'Vollzeit', 'Teilzeit', etc."),
    sort: z.string().optional().describe("Sort: 'newest' or 'nearby'"),
    rows: z.number().optional().describe("Results per page (default: 30)"),
    page: z.number().optional().describe("Page number (default: 1)"),
  },
  async (params) => {
    try {
      const result = await searchJobs({
        keyword: params.keyword,
        job_type: params.job_type,
        sort: params.sort,
        rows: Math.min(params.rows ?? 30, 100),
        page: params.page ?? 1,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: formatSearchResults(
              result.total,
              result.page,
              result.rows_per_page,
              result.listings,
              "jobs",
              result.description
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error searching jobs: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Tool 5: willhaben_get_listing - Get listing detail
server.tool(
  "willhaben_get_listing",
  "Get full details for a specific willhaben.at listing by ID. Returns all attributes, images, seller info, contact details, and description.",
  {
    id: z.string().describe("The willhaben listing/ad ID (e.g., '1370327604')"),
  },
  async (params) => {
    try {
      const detail = await getListingDetail(params.id);

      if (!detail) {
        return {
          content: [{ type: "text" as const, text: `Listing ${params.id} not found. Make sure the ID is correct.` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: formatDetail(detail) }],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error getting listing detail: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Tool 6: willhaben_search_marketplace - Marketplace search
server.tool(
  "willhaben_search_marketplace",
  "Search willhaben.at marketplace (Marktplatz) for second-hand items. Filter by keyword, category, condition, price, and location.",
  {
    keyword: z.string().optional().describe("Search term/keyword"),
    category: z.string().optional().describe("Category slug (e.g., 'computer-tablets-5828', 'smartphones-handys-2722')"),
    condition: z.string().optional().describe("Item condition: 'neu'/'new', 'gebraucht'/'used', or 'defekt'/'defective'"),
    location: z.string().optional().describe("Location: Austrian state, city, place, or postal code (e.g. 'Wien', 'Graz', '6020')"),
    price_from: z.number().optional().describe("Minimum price"),
    price_to: z.number().optional().describe("Maximum price"),
    sort: z.string().optional().describe("Sort: 'newest', 'price_asc', 'price_desc', 'relevance'"),
    rows: z.number().optional().describe("Results per page (default: 30)"),
    page: z.number().optional().describe("Page number (default: 1)"),
  },
  async (params) => {
    try {
      const result = await searchMarketplace({
        keyword: params.keyword,
        category: params.category,
        condition: params.condition,
        location: params.location,
        price_from: params.price_from,
        price_to: params.price_to,
        sort: params.sort,
        rows: Math.min(params.rows ?? 30, 100),
        page: params.page ?? 1,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: formatSearchResults(
              result.total,
              result.page,
              result.rows_per_page,
              result.listings,
              "marketplace",
              result.description
            ),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error searching marketplace: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Tool 7: willhaben_get_categories - Get category tree
server.tool(
  "willhaben_get_categories",
  "Get available category paths for a willhaben.at vertical. Use these categories in search queries.",
  {
    vertical: z.enum(["marketplace", "real_estate", "cars", "jobs"]).describe("Which vertical to get categories for"),
  },
  async (params) => {
    try {
      if (params.vertical === "real_estate") {
        return {
          content: [{ type: "text" as const, text: formatCategories("Real Estate", REAL_ESTATE_CATEGORIES) }],
        };
      }

      if (params.vertical === "marketplace") {
        // Show top-level marketplace categories
        const topCategories: Record<string, { path: string; name: string }> = {};
        for (const [key, id] of Object.entries(MARKETPLACE_CATEGORIES)) {
          topCategories[key] = { path: String(id), name: key.replace(/_/g, " & ").replace(/^./, (s) => s.toUpperCase()) };
        }
        return {
          content: [{ type: "text" as const, text: formatCategories("Marketplace", topCategories) }],
        };
      }

      if (params.vertical === "cars") {
        return {
          content: [
            {
              type: "text" as const,
              text: `## Cars Categories\n\n- **gebrauchtwagenboerse** (Used cars): Main car search category\n\nUse "willhaben_search_cars" with make, model, and other filters for detailed car searches.`,
            },
          ],
        };
      }

      if (params.vertical === "jobs") {
        return {
          content: [
            {
              type: "text" as const,
              text: `## Jobs Categories\n\nJobs on willhaben.at can be searched with keyword and location filters.\nUse "willhaben_search_jobs" with keyword and job_type parameters.\n\nJob types: Vollzeit, Teilzeit, etc.`,
            },
          ],
        };
      }

      return {
        content: [{ type: "text" as const, text: `Unknown vertical: ${params.vertical}` }],
        isError: true,
      };
    } catch (error) {
      return {
        content: [{ type: "text" as const, text: `Error getting categories: ${error instanceof Error ? error.message : String(error)}` }],
        isError: true,
      };
    }
  }
);

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Willhaben MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});