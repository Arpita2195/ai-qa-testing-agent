/**
 * URL and Page Identity Matcher
 * Provides safe, deterministic normalization and comparison of page identities,
 * query parameters, pathnames, and origins for crawling, scenario planning, and step validation.
 */

export interface PageIdentity {
  origin: string | null;
  pathname: string;
  search: string;
  fullNormalizedPath: string;
}

/**
 * Strips common tracking/analytics parameters while preserving functional application state parameters.
 */
const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
  "msclkid",
  "mc_eid",
  "_ga",
  "_gl",
  "ref",
  "source",
  "session_id",
  "timestamp",
  "_",
]);

/**
 * Safely parses and normalizes a URL or path into a structured PageIdentity.
 * Normalizes:
 * - Redundant slashes
 * - Trailing slashes (except root "/")
 * - Query parameter sorting and tracking parameter exclusion
 */
export function normalizePageIdentity(
  inputUrlOrPath: string,
  baseUrl: string = "http://localhost",
): PageIdentity {
  const trimmed = (inputUrlOrPath || "/").trim();
  let parsed: URL;
  let hasExplicitOrigin = false;

  try {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
      parsed = new URL(trimmed);
      hasExplicitOrigin = true;
    } else {
      parsed = new URL(trimmed.startsWith("/") ? trimmed : `/${trimmed}`, baseUrl);
    }
  } catch {
    parsed = new URL("/", "http://localhost");
  }

  // Normalize pathname
  let pathname = parsed.pathname.replace(/\/+/g, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  if (!pathname.startsWith("/")) {
    pathname = `/${pathname}`;
  }

  // Filter and sort query parameters alphabetically to ensure deterministic representation
  const cleanParams = new URLSearchParams();
  const sortedKeys = Array.from(parsed.searchParams.keys()).sort();
  for (const key of sortedKeys) {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) {
      const vals = parsed.searchParams.getAll(key);
      for (const val of vals) {
        cleanParams.append(key, val);
      }
    }
  }

  const search = cleanParams.toString() ? `?${cleanParams.toString()}` : "";
  const fullNormalizedPath = `${pathname}${search}`;

  return {
    origin: hasExplicitOrigin ? parsed.origin.toLowerCase() : null,
    pathname,
    search,
    fullNormalizedPath,
  };
}

/**
 * Compares two URLs or paths to determine whether they represent the identical page and state.
 * Strictly checks:
 * 1. Origin match (if target has an explicit origin, candidate must match origin).
 * 2. Pathname match.
 * 3. Query parameter match (distinct query params like ?page=1 vs ?page=2 represent distinct states).
 */
export function isPageIdentityMatch(
  targetPathOrUrl: string,
  candidatePage: { url?: string; path?: string },
  baseUrl?: string,
): boolean {
  if (!targetPathOrUrl || !candidatePage) return false;

  const targetIdentity = normalizePageIdentity(targetPathOrUrl, baseUrl);

  // Derive candidate identity preferentially from url (which retains full query params), then path
  const candidateRaw = candidatePage.url || candidatePage.path || "/";
  const candidateIdentity = normalizePageIdentity(candidateRaw, baseUrl);

  // If candidate has url and path separate, also inspect path if url had no search but path did
  if (!candidateIdentity.search && candidatePage.path && candidatePage.path.includes("?")) {
    const fromPath = normalizePageIdentity(candidatePage.path, baseUrl);
    candidateIdentity.search = fromPath.search;
    candidateIdentity.fullNormalizedPath = fromPath.fullNormalizedPath;
  }

  // 1. Same-origin protection: external origins cannot match internal pages
  if (targetIdentity.origin && candidateIdentity.origin) {
    if (targetIdentity.origin !== candidateIdentity.origin) {
      return false;
    }
  }

  // 2. Pathname match
  if (targetIdentity.pathname !== candidateIdentity.pathname) {
    return false;
  }

  // 3. Query parameters must match
  if (targetIdentity.search !== candidateIdentity.search) {
    return false;
  }

  return true;
}

/**
 * Searches a list of scraped pages for the exact matching page evidence corresponding to a target functionality path.
 * Deterministic matching rules:
 * 1. Exact match on pathname AND query parameters.
 * 2. If target has no query parameters, matches the candidate that also has no query parameters.
 * 3. Never silently falls back to the homepage ("/") when no match is found.
 */
export function findMatchingPageForPath<T extends { url?: string; path?: string }>(
  pages: T[],
  functionalityPath: string,
  baseUrl?: string,
): { page: T | null; error?: string } {
  if (!pages || pages.length === 0) {
    return {
      page: null,
      error: `Page evidence missing: No scraped pages available to match "${functionalityPath}"`,
    };
  }

  for (const p of pages) {
    if (isPageIdentityMatch(functionalityPath, p, baseUrl)) {
      return { page: p };
    }
  }

  return {
    page: null,
    error: `Page evidence missing: No crawled page matched functionality path "${functionalityPath}"`,
  };
}
