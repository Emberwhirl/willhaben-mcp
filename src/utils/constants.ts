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

// URL patterns for each vertical
export const SEARCH_URL_PATTERNS: Record<number, (params: Record<string, string>) => string> = {
  [VerticalId.IMMOBILIEN]: (params) => {
    const category = params.category || "eigentumswohnung/eigentumswohnung-angebote";
    return `/iad/immobilien/${category}${buildQuery(params)}`;
  },
  [VerticalId.AUTO_MOTOR]: (params) => {
    return `/iad/gebrauchtwagen/auto/gebrauchtwagenboerse${buildQuery(params)}`;
  },
  [VerticalId.MARKTPLATZ]: (params) => {
    const category = params.category || "";
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

// Real estate category paths
export const REAL_ESTATE_CATEGORIES: Record<string, { path: string; name: string }> = {
  eigentumswohnung_kaufen: { path: "eigentumswohnung/eigentumswohnung-angebote", name: "Eigentumswohnung kaufen" },
  haus_kaufen: { path: "haus/haus-angebote", name: "Haus kaufen" },
  mietwohnung: { path: "mietwohnung/mietwohnung-angebote", name: "Mietwohnung" },
  haus_mieten: { path: "haus/haus-mieten", name: "Haus mieten" },
  wohnung_mieten: { path: "wohnung-mieten", name: "Wohnung mieten" },
  grundstueck: { path: "grundstueck/grundstueck-angebote", name: "Grundstück" },
  buero_gewerbe: { path: "buero-gewerbeimmobilie/buero-gewerbeimmobilie-angebote", name: "Büro & Gewerbe" },
  bauprojekt: { path: "bauprojekt/bauprojekt-angebote", name: "Bauprojekt" },
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

// Marketplace category IDs (subset of most popular)
export const MARKETPLACE_CATEGORIES: Record<string, number> = {
  // Top-level
  all: 0,
  // Baby & Kind
  baby_kind: 3928,
  // Beauty & Gesundheit
  beauty_gesundheit: 3076,
  // Bücher & Medien
  buecher_medien: 387,
  // Computer & Software
  computer_tablets: 5828,
  // Dienstleistungen
  dienstleistungen: 537,
  // Fahrräder & Radsport
  fahrraeder: 4525,
  // Games & Konsolen
  games_konsolen: 2785,
  // Haus & Garten
  haus_garten: 3541,
  // Kameras & TV
  kameras_tv: 6808,
  // KFZ-Zubehör & Motorradteile
  kfz_zubehoer: 6142,
  // Mode & Accessoires
  mode_accessoires: 3275,
  // Smartphones & Telefonie
  smartphones: 2691,
  // Spielzeug
  spielzeug: 5136,
  // Sport & Sportgeräte
  sport: 4390,
  // Tiere & Tierbedarf
  tiere: 4915,
  // Uhren & Schmuck
  uhren_schmuck: 2409,
  // Wohnen & Haushalt
  wohnen_haushalt: 5387,
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