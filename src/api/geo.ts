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
//
// `resolveLocationDetailed` distinguishes a confident match from an
// ambiguous one, so tool handlers can ask the user which area they meant
// (multi-round-trip elicitation, protocol revision 2026-07-28) instead of
// silently guessing.

import { WILLHABEN_BASE_URL, resolveAreaId } from "../utils/constants.js";
import { httpJson, isAbortError, WillhabenBlockedError } from "./httpClient.js";

export interface AreaEntry {
  areaId: number;
  label: string;
  provinceAreaId: number;
}

export interface AreaGroup {
  name: string;
  entries: AreaEntry[];
}

export interface AreaCandidate {
  areaId: string;
  label: string;
  /** The autocomplete group this candidate came from (Gemeinde / PLZ / Ort / ...). */
  group: string;
}

export type LocationResolution =
  | { kind: "resolved"; areaId: string; label?: string }
  | { kind: "ambiguous"; candidates: AreaCandidate[] }
  | { kind: "unresolved" };

// Resolved / missed lookups. Bounded + TTL so a long session cannot grow
// without limit, and a transient autocomplete failure is not remembered forever.
const AREA_CACHE_MAX = 50;
const AREA_CACHE_TTL_MS = 10 * 60 * 1000;
const AREA_NEGATIVE_TTL_MS = 60 * 1000;
const areaCache = new Map<string, { value: string | null; timestamp: number }>();

function areaCacheGet(key: string): string | null | undefined {
  const hit = areaCache.get(key);
  if (!hit) return undefined;
  const ttl = hit.value === null ? AREA_NEGATIVE_TTL_MS : AREA_CACHE_TTL_MS;
  if (Date.now() - hit.timestamp >= ttl) {
    areaCache.delete(key);
    return undefined;
  }
  return hit.value;
}

function areaCacheSet(key: string, value: string | null): void {
  if (areaCache.size >= AREA_CACHE_MAX && !areaCache.has(key)) {
    const oldest = areaCache.keys().next().value;
    if (oldest !== undefined) areaCache.delete(oldest);
  }
  areaCache.set(key, { value, timestamp: Date.now() });
}

// Cache raw suggestion groups so that a multi-round-trip retry (the client
// re-issuing the same search after the user picked an area) does not pay a
// second autocomplete request. Bounded and time-limited.
const SUGGESTION_CACHE_MAX = 50;
const SUGGESTION_CACHE_TTL_MS = 10 * 60 * 1000;
const suggestionCache = new Map<string, { groups: AreaGroup[]; timestamp: number }>();

/**
 * Query the willhaben area autocomplete and return its raw grouped results.
 * Results are cached for a few minutes (see above).
 */
export async function lookupAreaSuggestions(term: string): Promise<AreaGroup[]> {
  const cacheKey = term.toLowerCase();
  const cached = suggestionCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SUGGESTION_CACHE_TTL_MS) {
    return cached.groups;
  }

  const url = `${WILLHABEN_BASE_URL}/webapi/autocomplete/area?term=${encodeURIComponent(term)}&source=desktop`;
  const response = await httpJson<AreaGroup[]>(url);
  if (!response.ok) {
    throw new Error(`Area autocomplete failed: ${response.status} ${response.statusText}`);
  }
  const groups = response.json();

  if (suggestionCache.size >= SUGGESTION_CACHE_MAX && !suggestionCache.has(cacheKey)) {
    const oldest = suggestionCache.keys().next().value;
    if (oldest !== undefined) suggestionCache.delete(oldest);
  }
  suggestionCache.set(cacheKey, { groups, timestamp: Date.now() });
  return groups;
}

const GROUP_ORDER = ["Gemeinde", "PLZ", "Ort"];

function orderedGroups(groups: AreaGroup[]): AreaGroup[] {
  return [
    ...GROUP_ORDER.map((n) => groups.find((g) => g.name === n)).filter((g): g is AreaGroup => !!g),
    ...groups.filter((g) => !GROUP_ORDER.includes(g.name)),
  ];
}

/**
 * Resolve a location with ambiguity detection.
 *
 * - Numeric IDs and Austrian state names resolve instantly (no network).
 * - An exact (case-insensitive) label match in the best group resolves.
 * - A single distinct candidate resolves.
 * - Multiple distinct candidates and no exact match → `ambiguous`, with up to
 *   `maxCandidates` deduplicated candidates in group preference order, so the
 *   caller can ask the user.
 */
export async function resolveLocationDetailed(location: string, maxCandidates = 5): Promise<LocationResolution> {
  const trimmed = location.trim();
  if (!trimmed) return { kind: "unresolved" };

  // 1 + 2: numeric ID or known state name (synchronous, no network).
  const direct = resolveAreaId(trimmed);
  if (direct) return { kind: "resolved", areaId: direct, label: trimmed };

  // Previously disambiguated or resolved this session.
  const cacheKey = trimmed.toLowerCase();
  const cached = areaCacheGet(cacheKey);
  if (cached !== undefined) {
    return cached ? { kind: "resolved", areaId: cached } : { kind: "unresolved" };
  }

  // 3: dynamic autocomplete lookup.
  let groups: AreaGroup[];
  try {
    groups = await lookupAreaSuggestions(trimmed);
  } catch (error) {
    if (isAbortError(error) || error instanceof WillhabenBlockedError) throw error;
    // Remember the miss so a handler that still passes `location` without
    // `area_id` (search.ts) does not hit autocomplete a second time.
    areaCacheSet(cacheKey, null);
    return { kind: "unresolved" };
  }

  const candidates: AreaCandidate[] = [];
  const seen = new Set<string>();
  for (const group of orderedGroups(groups)) {
    for (const entry of group.entries ?? []) {
      const id = String(entry.areaId);
      if (seen.has(id)) continue;
      seen.add(id);
      candidates.push({ areaId: id, label: entry.label, group: group.name });
    }
  }

  if (candidates.length === 0) {
    areaCacheSet(cacheKey, null);
    return { kind: "unresolved" };
  }

  // Exact label match in the highest-priority group wins outright.
  const exact = candidates.find((c) => c.label.toLowerCase() === cacheKey);
  if (exact) {
    areaCacheSet(cacheKey, exact.areaId);
    return { kind: "resolved", areaId: exact.areaId, label: exact.label };
  }

  if (candidates.length === 1) {
    areaCacheSet(cacheKey, candidates[0].areaId);
    return { kind: "resolved", areaId: candidates[0].areaId, label: candidates[0].label };
  }

  return { kind: "ambiguous", candidates: candidates.slice(0, maxCandidates) };
}

/**
 * Record the user's disambiguation choice so later searches for the same term
 * resolve instantly without asking again.
 */
export function rememberLocationChoice(location: string, areaId: string): void {
  areaCacheSet(location.trim().toLowerCase(), areaId);
}

/** Test-only: drop session location/suggestion caches. */
export function clearLocationCaches(): void {
  areaCache.clear();
  suggestionCache.clear();
}

/**
 * Resolve a free-text location into a willhaben `areaId`, or null if it can't
 * be resolved. Non-interactive: an ambiguous result falls back to the first
 * (best-group) candidate, preserving the previous behavior for library callers
 * and clients without elicitation support.
 */
export async function resolveLocationToAreaId(location: string): Promise<string | null> {
  const resolution = await resolveLocationDetailed(location);
  if (resolution.kind === "resolved") return resolution.areaId;
  if (resolution.kind === "ambiguous") {
    const first = resolution.candidates[0];
    areaCacheSet(location.trim().toLowerCase(), first.areaId);
    return first.areaId;
  }
  return null;
}
