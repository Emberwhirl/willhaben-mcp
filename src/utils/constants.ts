// Willhaben constants - Vertical IDs, URL patterns, sort codes, and category mappings

import { VerticalId } from "../api/types.js";

export const WILLHABEN_BASE_URL = "https://www.willhaben.at";
export const WILLHABEN_PUBLIC_API = "https://publicapi.willhaben.at";

/**
 * Build a query string from a params object, excluding reserved keys that are
 * handled elsewhere (e.g. `category`, which is part of the URL path). Every other
 * key is passed through verbatim so that willhaben filter params like PRICE_FROM,
 * NUMBER_OF_ROOMS, CAR_MODEL/MAKE, ENGINE/FUEL etc. actually reach the server.
 */
function buildQuery(params: Record<string, string>, exclude: string[] = ["category"]): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (exclude.includes(key)) continue;
    if (value === undefined || value === null || value === "") continue;
    query.set(key, value);
  }
  const qs = query.toString();
  return qs ? "?" + qs : "";
}

const CATEGORY_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Category is interpolated into the URL path. Only `[A-Za-z0-9_-]` segments
 * joined by a single `/` are allowed, so `?` / `..` / `//` cannot inject a
 * query string or escape the vertical prefix (and the 100-row cap).
 * Empty category is allowed (unfiltered marketplace).
 */
export function sanitizeCategoryPath(category: string | undefined): string {
  if (category == null || category === "") return "";
  if (
    category.includes("..") ||
    category.includes("//") ||
    /[?#\\]/.test(category) ||
    /[a-zA-Z][a-zA-Z0-9+.-]*:/.test(category)
  ) {
    throw new Error("Invalid category path");
  }
  const segments = category.split("/");
  if (segments.some((seg) => !CATEGORY_SEGMENT_RE.test(seg))) {
    throw new Error("Invalid category path");
  }
  return segments.join("/");
}

/** Cap rows at 100 and page at 200 so callers cannot bypass the server-layer clamp. */
export function clampSearchPaging(rows?: number, page?: number): { rows: number; page: number } {
  return {
    rows: Math.min(Math.max(Math.trunc(rows ?? 30), 1), 100),
    page: Math.min(Math.max(Math.trunc(page ?? 1), 1), 200),
  };
}

// URL patterns for each vertical
export const SEARCH_URL_PATTERNS: Record<number, (params: Record<string, string>) => string> = {
  [VerticalId.IMMOBILIEN]: (params) => {
    const category = sanitizeCategoryPath(params.category) || "eigentumswohnung/eigentumswohnung-angebote";
    return `/iad/immobilien/${category}${buildQuery(params)}`;
  },
  [VerticalId.AUTO_MOTOR]: (params) => {
    return `/iad/gebrauchtwagen/auto/gebrauchtwagenboerse${buildQuery(params)}`;
  },
  [VerticalId.MARKTPLATZ]: (params) => {
    const category = sanitizeCategoryPath(params.category);
    const base = category
      ? `/iad/kaufen-und-verkaufen/marktplatz/${category}`
      : `/iad/kaufen-und-verkaufen/marktplatz`;
    return `${base}${buildQuery(params)}`;
  },
  [VerticalId.JOBS]: (_params) => {
    // Jobs use the public API, not scraping
    return "";
  },
};

// Sort codes for each vertical
export const SORT_CODES: Record<number, Record<string, string>> = {
  [VerticalId.IMMOBILIEN]: {
    newest: "1",        // Aktualität (published descending)
    nearby: "2",        // In der Nähe (distance ascending)
    price_asc: "3",     // Preis aufsteigend
    price_desc: "4",    // Preis absteigend
    area_asc: "5",      // Wohnfläche aufsteigend
    area_desc: "6",     // Wohnfläche absteigend
    relevance: "7",     // Relevanz
  },
  [VerticalId.AUTO_MOTOR]: {
    newest: "1",        // Aktualität
    nearby: "2",        // In der Nähe
    price_asc: "3",     // Preis aufsteigend
    price_desc: "4",    // Preis absteigend
    mileage_asc: "5",   // km aufsteigend
    mileage_desc: "6",  // km absteigend
    relevance: "7",     // Relevanz
    year_desc: "8",     // EZ absteigend
    year_asc: "9",      // EZ aufsteigend
    model_asc: "10",    // Modell
  },
  [VerticalId.MARKTPLATZ]: {
    newest: "1",
    nearby: "2",
    price_asc: "3",
    price_desc: "4",
    relevance: "7",
  },
  [VerticalId.JOBS]: {
    newest: "1",
    nearby: "2",
    relevance: "7",
  },
};

// Real estate category landing paths. willhaben splits buy vs rent across
// *different* URL slugs (e.g. houses for sale live under `haus-kaufen/...`,
// rentals under `haus-mieten/...`). Every path below is verified live against a
// 200 + non-zero result count — see REAL_ESTATE_PATHS in search.ts for the
// property-type/action resolver that produces these.
export const REAL_ESTATE_CATEGORIES: Record<string, { path: string; name: string }> = {
  eigentumswohnung_kaufen: { path: "eigentumswohnung/eigentumswohnung-angebote", name: "Eigentumswohnung kaufen" },
  haus_kaufen: { path: "haus-kaufen/haus-angebote", name: "Haus kaufen" },
  grundstueck_kaufen: { path: "grundstuecke/grundstueck-angebote", name: "Grundstück kaufen" },
  gewerbe_kaufen: { path: "gewerbeimmobilien-kaufen/gewerbeimmobilien-angebote", name: "Gewerbeimmobilie kaufen" },
  ferienimmobilie_kaufen: { path: "ferienimmobilien-kaufen/ferienimmobilien-angebote", name: "Ferienimmobilie kaufen" },
  mietwohnung: { path: "mietwohnungen/mietwohnung-angebote", name: "Mietwohnung (Wohnung mieten)" },
  haus_mieten: { path: "haus-mieten/haus-angebote", name: "Haus mieten" },
  gewerbe_mieten: { path: "gewerbeimmobilien-mieten/gewerbeimmobilien-angebote", name: "Gewerbeimmobilie mieten" },
  ferienimmobilie_mieten: { path: "ferienimmobilien-mieten/ferienimmobilien-angebote", name: "Ferienimmobilie mieten" },
  neubauprojekt: { path: "neubauprojekte/angebote", name: "Neubauprojekt" },
};

// Car filter parameter names (for URL query params)
export const CAR_FILTER_PARAMS: Record<string, string> = {
  make: "CAR_MODEL/MAKE",
  model: "CAR_MODEL/MODEL",
  fuel_type: "ENGINE/FUEL",
  transmission: "TRANSMISSION",
  condition: "MOTOR_CONDITION",
  price_from: "PRICE_FROM",
  price_to: "PRICE_TO",
  year_from: "YEAR_MODEL_FROM",
  year_to: "YEAR_MODEL_TO",
  mileage_from: "MILEAGE_FROM",
  mileage_to: "MILEAGE_TO",
  doors_from: "NO_OF_DOORS_FROM",
  doors_to: "NO_OF_DOORS_TO",
  seats_from: "NO_OF_SEATS_FROM",
  seats_to: "NO_OF_SEATS_TO",
  power_from: "ENGINEEFFECT_FROM",
  power_to: "ENGINEEFFECT_TO",
  wheel_drive: "WHEEL_DRIVE",
};

// Fuel type IDs
export const FUEL_TYPE_IDS: Record<string, string> = {
  petrol: "100001",
  diesel: "100003",
  electric: "100004",
  hybrid_petrol: "100002",
  hybrid_diesel: "100005",
  gas: "100006",
  other: "100007",
};

// Transmission IDs
export const TRANSMISSION_IDS: Record<string, string> = {
  manual: "180001",
  automatic: "180004",
};

// Condition IDs
export const CONDITION_IDS: Record<string, string> = {
  used: "20",
  new: "10",
  year_old: "50",
};

// Marketplace top-level categories. The `path` is the URL slug segment under
// /iad/kaufen-und-verkaufen/marktplatz/ — it must be the full slug (name + ID);
// a bare numeric ID returns 200 but silently ignores the filter (whole-market
// rowsFound). All slugs taken from the live marketplace landing-page nav.
export const MARKETPLACE_CATEGORIES: Record<string, { path: string; name: string }> = {
  antiquitaeten_kunst: { path: "antiquitaeten-kunst-6941", name: "Antiquitäten & Kunst" },
  baby_kind: { path: "baby-kind-3928", name: "Baby & Kind" },
  beauty_gesundheit: { path: "beauty-gesundheit-wellness-3076", name: "Beauty, Gesundheit & Wellness" },
  boote: { path: "boote-yachten-jetskis-5007823", name: "Boote, Yachten & Jetskis" },
  buecher_filme_musik: { path: "buecher-filme-musik-387", name: "Bücher, Filme & Musik" },
  computer_software: { path: "computer-software-5824", name: "Computer & Software" },
  dienstleistungen: { path: "dienstleistungen-537", name: "Dienstleistungen" },
  fahrraeder: { path: "fahrraeder-radsport-4525", name: "Fahrräder & Radsport" },
  freizeit: { path: "freizeit-instrumente-kulinarik-6462", name: "Freizeit, Instrumente & Kulinarik" },
  games_konsolen: { path: "games-konsolen-2785", name: "Games & Konsolen" },
  haus_garten: { path: "haus-garten-werkstatt-3541", name: "Haus, Garten & Werkstatt" },
  kameras_tv: { path: "kameras-tv-multimedia-6808", name: "Kameras, TV & Multimedia" },
  kfz_zubehoer: { path: "kfz-zubehoer-motorradteile-6142", name: "KFZ-Zubehör & Motorradteile" },
  mode_accessoires: { path: "mode-accessoires-3275", name: "Mode & Accessoires" },
  smartphones: { path: "smartphones-telefonie-2691", name: "Smartphones & Telefonie" },
  spielzeug: { path: "spielen-spielzeug-5136", name: "Spielen & Spielzeug" },
  sport: { path: "sport-sportgeraete-4390", name: "Sport & Sportgeräte" },
  tiere: { path: "tiere-tierbedarf-4915", name: "Tiere & Tierbedarf" },
  uhren_schmuck: { path: "uhren-schmuck-2409", name: "Uhren & Schmuck" },
  wohnen_haushalt: { path: "wohnen-haushalt-gastronomie-5387", name: "Wohnen, Haushalt & Gastronomie" },
};

// Vertical display names
export const VERTICAL_NAMES: Record<number, string> = {
  [VerticalId.JOBS]: "Jobs",
  [VerticalId.IMMOBILIEN]: "Immobilien",
  [VerticalId.AUTO_MOTOR]: "Auto & Motor",
  [VerticalId.MARKTPLATZ]: "Marktplatz",
};

// Location → willhaben `areaId` mapping for the 9 Austrian states (Bundesländer),
// plus common English aliases. Location filtering uses the `areaId` query param
// (verified working for real estate, cars, and marketplace). Finer-grained
// districts/municipalities have their own area IDs not covered here.
export const LOCATION_AREA_IDS: Record<string, string> = {
  burgenland: "1",
  kaernten: "2",
  "kärnten": "2",
  carinthia: "2",
  niederoesterreich: "3",
  "niederösterreich": "3",
  "lower austria": "3",
  oberoesterreich: "4",
  "oberösterreich": "4",
  "upper austria": "4",
  salzburg: "5",
  steiermark: "6",
  styria: "6",
  tirol: "7",
  tyrol: "7",
  vorarlberg: "8",
  wien: "900",
  vienna: "900",
};

/**
 * Resolve a free-text location into a willhaben `areaId`. Accepts a numeric ID
 * directly, or a (case-insensitive) Austrian state name / English alias.
 * Returns null if it can't be resolved, so callers can decide how to handle it.
 */
export function resolveAreaId(location: string): string | null {
  const trimmed = location.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  return LOCATION_AREA_IDS[trimmed.toLowerCase()] ?? null;
}

// Default user agent for HTTP requests
export const DEFAULT_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";

// Cache TTL in milliseconds (5 minutes)
export const CACHE_TTL_MS = 5 * 60 * 1000;

// Rate limit: max requests per second
export const RATE_LIMIT_PER_SEC = 1;