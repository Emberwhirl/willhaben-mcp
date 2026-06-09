// Willhaben Formatters - Response formatting helpers
import { SimplifiedListing, SimplifiedListingDetail } from "../api/types.js";

/**
 * Format a list of simplified listings as a human-readable text response
 */
export function formatListings(listings: SimplifiedListing[]): string {
  if (listings.length === 0) {
    return "No listings found.";
  }

  const lines = listings.map((listing, i) => {
    const parts = [`**${i + 1}. ${listing.title}**`];

    if (listing.price) {
      parts.push(`💰 ${listing.price}`);
    }

    if (listing.location) {
      parts.push(`📍 ${listing.location}`);
    }

    if (listing.published) {
      parts.push(`📅 ${listing.published}`);
    }

    if (listing.is_private !== undefined) {
      parts.push(listing.is_private ? "👤 Private" : "🏢 Dealer");
    }

    if (listing.advertiser_name) {
      parts.push(`🏷️ ${listing.advertiser_name}`);
    }

    // Add key vertical-specific attributes
    const attrMap = listing.attributes as Record<string, string | string[]>;
    if (attrMap) {
      // Real estate attributes
      if (attrMap["ESTATE_SIZE/LIVING_AREA"]) {
        parts.push(`📐 ${attrMap["ESTATE_SIZE/LIVING_AREA"]} m²`);
      }
      if (attrMap["NUMBER_OF_ROOMS"]) {
        parts.push(`🛏️ ${attrMap["NUMBER_OF_ROOMS"]} rooms`);
      }
      if (attrMap["PRICE/SQUARE_METER_FOR_DISPLAY"]) {
        // Value already includes the "/m²" suffix from willhaben.
        parts.push(`📊 ${attrMap["PRICE/SQUARE_METER_FOR_DISPLAY"]}`);
      }

      // Car attributes
      if (attrMap["YEAR_MODEL_FROM/TO"]) {
        parts.push(`🗓️ ${attrMap["YEAR_MODEL_FROM/TO"]}`);
      }
      if (attrMap["MILEAGE"]) {
        parts.push(`🛣️ ${attrMap["MILEAGE"]} km`);
      }
      if (attrMap["ENGINE/FUEL"]) {
        const fuel = attrMap["ENGINE/FUEL"] as string;
        const fuelName = fuel === "100001" ? "Petrol" : fuel === "100003" ? "Diesel" : fuel === "100004" ? "Electric" : fuel;
        parts.push(`⛽ ${fuelName}`);
      }
      if (attrMap["TRANSMISSION"]) {
        const trans = attrMap["TRANSMISSION"] as string;
        const transName = trans === "180001" ? "Manual" : trans === "180004" ? "Automatic" : trans;
        parts.push(`⚙️ ${transName}`);
      }

      // Job attributes (ORGNAME is already surfaced via advertiser_name above)
      if (attrMap["EMPLOYMENT_TYPE"]) {
        parts.push(`💼 ${attrMap["EMPLOYMENT_TYPE"]}`);
      }
    }

    parts.push(`🔗 ${listing.url}`);

    return parts.join(" | ");
  });

  return lines.join("\n\n");
}

/**
 * Format a single listing detail as a human-readable text response
 */
export function formatDetail(detail: SimplifiedListingDetail): string {
  const lines: string[] = [];

  lines.push(`# ${detail.title}`);
  lines.push("");

  if (detail.price) {
    lines.push(`💰 **Price:** ${detail.price}`);
  }

  if (detail.location) {
    lines.push(`📍 **Location:** ${detail.location}`);
  }

  if (detail.published_date) {
    lines.push(`📅 **Published:** ${detail.published_date}`);
  }

  lines.push(`🔗 **URL:** ${detail.url}`);
  lines.push(`🏷️ **Type:** ${detail.is_private ? "Private" : "Dealer"}`);

  if (detail.advertiser.name) {
    lines.push(`👤 **Seller:** ${detail.advertiser.name}`);
  }

  if (detail.address.street || detail.address.city) {
    const addr = [detail.address.street, detail.address.postcode, detail.address.city, detail.address.country]
      .filter(Boolean)
      .join(", ");
    lines.push(`🏠 **Address:** ${addr}`);
  }

  if (detail.address.coordinates) {
    lines.push(`📍 **Coordinates:** ${detail.address.coordinates}`);
  }

  if (detail.chat_enabled) {
    lines.push(`💬 **Chat:** Available`);
  }

  if (detail.contact_type) {
    lines.push(`📞 **Contact:** ${detail.contact_type}`);
  }

  // Key attributes
  if (detail.attributes) {
    lines.push("");
    lines.push("## Key Details");

    const attrMap = detail.attributes as Record<string, string | string[]>;

    // Real estate
    const reAttrs: Record<string, string> = {
      "ESTATE_SIZE/LIVING_AREA": "Living Area",
      "NUMBER_OF_ROOMS": "Rooms",
      "PRICE/SQUARE_METER_FOR_DISPLAY": "Price/m²",
      "PROPERTY_TYPE": "Property Type",
      "BUILDING_TYPE": "Building Type",
      "HEATING": "Heating",
      "OWNAGETYPE": "Ownership Type",
      "ENERGY_HWB_CLASS": "Energy Class (HWB)",
      "ENERGY_FGEE_CLASS": "Energy Class (FGEE)",
      "ESTATE_PRICE/PRICE_SUGGESTION_FOR_DISPLAY": "Price Suggestion",
      "ESTATE_PRICE/OTHERCOSTS_NET": "Additional Costs",
      "ESTATE_PRICE/MONTHCOSTS_GROSS": "Monthly Costs",
      "ADDITIONAL_COST/FEE": "Additional Fee",
    };

    for (const [key, label] of Object.entries(reAttrs)) {
      const val = attrMap[key];
      if (val) {
        lines.push(`- **${label}:** ${Array.isArray(val) ? val.join(", ") : val}`);
      }
    }

    // Car attributes
    const carAttrs: Record<string, string> = {
      "YEAR_MODEL_FROM/TO": "Year",
      "MILEAGE": "Mileage",
      "ENGINE/FUEL": "Fuel Type",
      "TRANSMISSION": "Transmission",
      "CAR_MODEL/MAKE": "Make",
      "CAR_MODEL/MODEL": "Model",
      "ENGINEEFFECT_FROM/TO": "Power (kW)",
      "NO_OF_DOORS_FROM/TO": "Doors",
      "WHEEL_DRIVE": "Drive Type",
    };

    for (const [key, label] of Object.entries(carAttrs)) {
      const val = attrMap[key];
      if (val) {
        lines.push(`- **${label}:** ${Array.isArray(val) ? val.join(", ") : val}`);
      }
    }

    // Description
    if (attrMap["BODY_DYN"]) {
      lines.push("");
      lines.push("## Description");
      lines.push(String(attrMap["BODY_DYN"]));
    }
  }

  // Images
  if (detail.images && detail.images.length > 0) {
    lines.push("");
    lines.push(`## Images (${detail.images.length})`);
    lines.push(detail.images.slice(0, 5).join("\n"));
    if (detail.images.length > 5) {
      lines.push(`... and ${detail.images.length - 5} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Format search results summary
 */
export function formatSearchResults(
  total: number,
  page: number,
  rowsPerPage: number,
  listings: SimplifiedListing[],
  vertical: string,
  description?: string
): string {
  const header = `## Search Results${description ? `: ${description}` : ""}`;
  const summary = `Found **${total.toLocaleString()}** listings (showing ${listings.length} of ${rowsPerPage} per page, page ${page})`;
  const verticalLabel = `Vertical: ${vertical}`;

  const formattedListings = formatListings(listings);

  return [header, "", summary, verticalLabel, "", formattedListings].join("\n");
}

/**
 * Format category tree
 */
export function formatCategories(vertical: string, categories: Record<string, { path: string; name: string }>): string {
  const lines = [`## ${vertical} Categories`, ""];

  for (const [key, cat] of Object.entries(categories)) {
    lines.push(`- **${cat.name}** (\`${key}\`): ${cat.path}`);
  }

  return lines.join("\n");
}