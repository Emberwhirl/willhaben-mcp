// Willhaben Geo / Location resolution
//
// Resolves a free-text location into a willhaben `areaId`. Resolution order:
//   1. Numeric input            → used directly as an area ID
//   2. Static Austrian state map → instant, no network (Wien, Steiermark, ...)
//   3. Dynamic autocomplete API  → covers any municipality / PLZ / place
//
// The dynamic lookup hits the same public endpoint the willhaben location
// search box uses: GET /webapi/autocomplete/area?term=<text>&source=desktop
// It needs no authentication and returns grouped matches:
//   [{ name: "Gemeinde", entries: [{ areaId, label, provinceAreaId }] },
//    { name: "PLZ",      entries: [...] },
//    { name: "Ort",      entries: [...] }]

import { WILLHABEN_BASE_URL, DEFAULT_USER_AGENT, resolveAreaId } from "../utils/constants.js";

interface AreaEntry {
  areaId: number;
  label: string;
  provinceAreaId: number;
}

interface AreaGroup {
  name: string;
  entries: AreaEntry[];
}

// Cache resolved lookups for the session to avoid repeat network calls.
const areaCache = new Map<string, string | null>();

/**
 * Query the willhaben area autocomplete and return its raw grouped results.
 */
export async function lookupAreaSuggestions(term: string): Promise<AreaGroup[]> {
  const url = `${WILLHABEN_BASE_URL}/webapi/autocomplete/area?term=${encodeURIComponent(term)}&source=desktop`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": DEFAULT_USER_AGENT,
      "Accept": "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Area autocomplete failed: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as AreaGroup[];
}

/**
 * Resolve a free-text location into a willhaben `areaId`, or null if it can't
 * be resolved. Tries numeric/state-name first (no network), then the dynamic
 * autocomplete endpoint. Prefers a municipality (Gemeinde) match, then PLZ,
 * then place (Ort), and within a group an exact case-insensitive label match.
 */
export async function resolveLocationToAreaId(location: string): Promise<string | null> {
  const trimmed = location.trim();
  if (!trimmed) return null;

  // 1 + 2: numeric ID or known state name (synchronous, no network).
  const direct = resolveAreaId(trimmed);
  if (direct) return direct;

  // Session cache.
  const cacheKey = trimmed.toLowerCase();
  if (areaCache.has(cacheKey)) return areaCache.get(cacheKey)!;

  // 3: dynamic autocomplete lookup.
  let groups: AreaGroup[];
  try {
    groups = await lookupAreaSuggestions(trimmed);
  } catch {
    areaCache.set(cacheKey, null);
    return null;
  }

  const groupOrder = ["Gemeinde", "PLZ", "Ort"];
  const orderedGroups = [
    ...groupOrder.map((n) => groups.find((g) => g.name === n)).filter((g): g is AreaGroup => !!g),
    ...groups.filter((g) => !groupOrder.includes(g.name)),
  ];

  let resolved: string | null = null;
  for (const group of orderedGroups) {
    if (!group.entries?.length) continue;
    // Prefer an exact label match within the group, else the first entry.
    const exact = group.entries.find(
      (e) => e.label.toLowerCase() === trimmed.toLowerCase()
    );
    const chosen = exact ?? group.entries[0];
    resolved = String(chosen.areaId);
    break;
  }

  areaCache.set(cacheKey, resolved);
  return resolved;
}
