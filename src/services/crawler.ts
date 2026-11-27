import crypto from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { pool } from "../config/db";
import { env } from "../config/env";
import {
  assertTargetUrlAllowed,
  attachUrlGuardToPage,
  validateTargetUrl,
  isInfrastructureOrCdnPath,
  isErrorPageContent,
} from "./urlGuard";
import { setupAuthenticatedBrowser } from "./appAuth";
import {
  extractScrapedPage,
  waitForRealContent,
  type PageElement,
  type ScrapedPage,
  type SiteData,
} from "./pageReader";
import {
  discoverPageFunctionalities,
  planScenariosForFunctionality,
  persistFunctionalitiesAndScenarios,
} from "./functionalityPlanner";
import { redactSecrets } from "./runner";
import {
  recordNavigationTransition,
  explorePageInteractions,
} from "./crawlerStateTransitions";

export type PageType =
  | "auth"
  | "dashboard"
  | "list_table"
  | "form_editor"
  | "detail_view"
  | "settings"
  | "static"
  | "general";

export interface ElementCounts {
  forms: number;
  inputs: number;
  buttons: number;
  links: number;
  tables: number;
  filters: number;
  searchBars: number;
  pagination: number;
}

export const EMPTY_ELEMENT_COUNTS: ElementCounts = {
  forms: 0,
  inputs: 0,
  buttons: 0,
  links: 0,
  tables: 0,
  filters: 0,
  searchBars: 0,
  pagination: 0,
};

export interface CrawlPageResult {
  id?: string;
  url: string;
  path: string;
  depth: number;
  title: string;
  pageType: PageType;
  elementCounts: ElementCounts;
  domFingerprint: string;
  scrapedPage: ScrapedPage;
  discoveredLinks: string[];
  durationMs: number;
  status: "visited" | "failed" | "skipped";
  error?: string;
}

export interface EvidenceCaptureStats {
  attempted: number;
  persisted: number;
  failed: number;
  skipped: number;
  completenessRate: number;
}

export interface CrawlProgress {
  sessionId: string;
  projectId: string;
  currentUrl: string;
  currentDepth: number;
  pagesCrawled: number;
  pagesQueued: number;
  pagesFailed: number;
  latestPageType?: PageType;
  functionalitiesDiscovered: number;
  evidenceStats?: EvidenceCaptureStats;
}

export interface CrawlOptions {
  maxDepth?: number;
  maxPages?: number;
  timeoutMs?: number;
  resume?: boolean;
  sessionId?: string;
  startPath?: string;
  readOnly?: boolean;
  onProgress?: (progress: CrawlProgress) => void | Promise<void>;
  createdBy?: string;
}

export interface CrawlResult {
  sessionId: string;
  projectId: string;
  baseUrl: string;
  isLoggedIn: boolean;
  totalPagesCrawled: number;
  pages: CrawlPageResult[];
  functionalitiesDiscovered: number;
  durationMs: number;
  status: "completed" | "partial" | "failed";
  error?: string;
  evidenceStats?: EvidenceCaptureStats;
}

export interface CrawledPageRow {
  id: string;
  project_id: string;
  session_id: string | null;
  url: string;
  path: string;
  depth: number;
  status: string;
  title: string | null;
  page_type: PageType;
  element_counts: ElementCounts;
  dom_fingerprint: string | null;
  scraped_data: ScrapedPage | null;
  error_message: string | null;
  duration_ms: number;
  created_at: Date;
  updated_at: Date;
}

export interface CrawlSessionRow {
  id: string;
  project_id: string;
  status: string;
  start_url: string;
  max_depth: number;
  max_pages: number;
  pages_crawled: number;
  pages_failed: number;
  functionalities_discovered: number;
  duration_ms: number;
  error_message: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Normalizes a URL into canonical representation for crawling deduplication and anti-looping:
 * - Lowercases protocol & host
 * - Strips tracking/session parameters (utm_*, fbclid, ref, etc.)
 * - Sorts remaining query parameters alphabetically
 * - Normalizes trailing slashes (except root)
 * - Preserves SPA hash routes (e.g. #/dashboard) while stripping standard anchor hashes
 */
export function normalizeCanonicalUrl(rawUrl: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(rawUrl, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
      return null;
    }

    const trackingParams = new Set([
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
      "token",
      "timestamp",
      "_",
    ]);

    const cleanSearchParams = new URLSearchParams();
    const sortedKeys = Array.from(resolved.searchParams.keys()).sort();
    for (const key of sortedKeys) {
      if (!trackingParams.has(key.toLowerCase())) {
        const vals = resolved.searchParams.getAll(key);
        for (const val of vals) {
          cleanSearchParams.append(key, val);
        }
      }
    }

    let pathname = resolved.pathname;
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }

    let hash = "";
    if (resolved.hash && (resolved.hash.startsWith("#/") || resolved.hash.startsWith("#!/"))) {
      let hashPath = resolved.hash;
      if (hashPath.length > 3 && hashPath.endsWith("/")) {
        hashPath = hashPath.slice(0, -1);
      }
      hash = hashPath;
    }

    const search = cleanSearchParams.toString();
    const queryPart = search ? `?${search}` : "";
    return `${resolved.protocol}//${resolved.host.toLowerCase()}${pathname}${queryPart}${hash}`;
  } catch {
    return null;
  }
}

/**
 * Validates whether an action or URL is destructive or terminates sessions.
 * Strictly non-destructive exploration guards against deleting, purchasing, or logging out.
 */
export function isDestructiveActionOrUrl(url: string, text = "", href = ""): boolean {
  const combined = `${url} ${text} ${href}`.toLowerCase();

  // Session termination keywords and routes
  if (
    /\b(logout|signout|sign-out|log-out|auth\/logout|session\/destroy|api\/logout)\b/i.test(combined)
  ) {
    return true;
  }

  // Mutation and destruction keywords
  const destructiveKeywords = [
    "delete",
    "remove",
    "drop",
    "destroy",
    "purge",
    "erase",
    "truncate",
    "pay",
    "purchase",
    "buy",
    "checkout",
    "charge",
    "place order",
    "confirm order",
    "submit payment",
    "cancel subscription",
  ];

  return destructiveKeywords.some((kw) => combined.includes(kw));
}

/**
 * Computes a DOM structure fingerprint (SHA-256) to detect repetitive templates
 * (e.g. multiple product or item detail views with different IDs but identical structure).
 */
export function computeDomFingerprint(
  title: string,
  headings: string[],
  elements: PageElement[],
): string {
  const sortedHeadings = [...headings].sort().join("|");
  const inputsCount = elements.filter(
    (el) => el.tag === "input" || el.tag === "textarea" || el.tag === "select",
  ).length;
  const buttonsCount = elements.filter((el) => el.tag === "button").length;
  const linksCount = elements.filter((el) => el.tag === "a").length;
  const signature = `${title.trim().toLowerCase()}::${sortedHeadings}::in=${inputsCount}:btn=${buttonsCount}:link=${linksCount}`;
  return crypto.createHash("sha256").update(signature).digest("hex");
}

/**
 * Classifies the page type and counts interactive elements.
 */
export function classifyPageType(
  title: string,
  headings: string[],
  elements: PageElement[],
  text: string,
): { pageType: PageType; elementCounts: ElementCounts } {
  const forms = elements.filter((el) => el.tag === "form");
  const inputs = elements.filter(
    (el) => el.tag === "input" || el.tag === "textarea" || el.tag === "select",
  );
  const buttons = elements.filter((el) => el.tag === "button");
  const links = elements.filter((el) => el.tag === "a");
  const passwordInputs = inputs.filter((el) => el.type === "password");

  const lowerTitle = title.toLowerCase();
  const lowerHeadings = headings.map((h) => h.toLowerCase()).join(" ");
  const lowerText = text.slice(0, 2000).toLowerCase();

  const searchBars = inputs.filter(
    (el) =>
      el.type === "search" ||
      /search|query|find/i.test(`${el.name || ""} ${el.placeholder || ""}`),
  ).length;

  const filters = inputs.filter(
    (el) =>
      el.tag === "select" ||
      /filter|sort|category|status/i.test(`${el.name || ""} ${el.placeholder || ""}`),
  ).length;

  const tablesCount =
    elements.filter((el) => el.tag === "table").length ||
    (elements.some((el) => el.selector.includes("table") || el.selector.includes("tbody")) ? 1 : 0);

  const paginationCount = links.filter((el) =>
    /page|pagination|next|prev/i.test(`${el.text} ${el.selector}`),
  ).length;

  const elementCounts: ElementCounts = {
    forms: forms.length,
    inputs: inputs.length,
    buttons: buttons.length,
    links: links.length,
    tables: tablesCount,
    filters,
    searchBars,
    pagination: paginationCount,
  };

  // Auth page
  if (
    passwordInputs.length > 0 ||
    /\b(?:log\s*in|sign\s*in|register|signup|sign\s*up|reset\s*password)\b/i.test(`${lowerTitle} ${lowerHeadings}`)
  ) {
    return { pageType: "auth", elementCounts };
  }

  // Settings
  if (
    /\b(?:settings|preferences|account\s*settings|configuration)\b/i.test(`${lowerTitle} ${lowerHeadings}`)
  ) {
    return { pageType: "settings", elementCounts };
  }

  // Dashboard
  if (
    /\b(?:dashboard|overview|analytics|metrics)\b/i.test(`${lowerTitle} ${lowerHeadings}`) &&
    (buttons.length > 0 || links.length > 3)
  ) {
    return { pageType: "dashboard", elementCounts };
  }

  // List / Table
  if (
    tablesCount > 0 ||
    paginationCount > 0 ||
    /\b(?:list|inventory|users|products|orders|items|catalog|table)\b/i.test(`${lowerTitle} ${lowerHeadings}`)
  ) {
    return { pageType: "list_table", elementCounts };
  }

  // Form / Editor
  if (
    forms.length > 0 ||
    (inputs.length >= 2 && buttons.some((b) => /\b(?:save|submit|create|update|add)\b/i.test(b.text)))
  ) {
    return { pageType: "form_editor", elementCounts };
  }

  // Detail view
  if (
    /\b(?:details|view\s*item|view\s*order|profile)\b/i.test(`${lowerTitle} ${lowerHeadings}`) ||
    (inputs.length === 0 && buttons.some((b) => /\b(?:edit|back)\b/i.test(b.text)))
  ) {
    return { pageType: "detail_view", elementCounts };
  }

  // Static view
  if (inputs.length === 0 && buttons.length <= 1) {
    return { pageType: "static", elementCounts };
  }

  return { pageType: "general", elementCounts };
}

/**
 * Extracts links from navigation, anchors, and dynamic SPA routes on the current page.
 */
async function extractPageLinks(page: Page, allowedOrigin: string): Promise<string[]> {
  try {
    const results = await page.evaluate((origin) => {
      const candidates = new Set<string>();

      // 1. Anchor links
      document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
        const href = a.getAttribute("href");
        if (href && !href.startsWith("javascript:") && !href.startsWith("mailto:") && !href.startsWith("tel:")) {
          candidates.add(href);
        }
      });

      // 2. SPA navigation attributes (e.g. data-nav, data-href, routerlink)
      document.querySelectorAll("[data-nav], [data-href], [routerlink]").forEach((el) => {
        const target =
          el.getAttribute("data-nav") ||
          el.getAttribute("data-href") ||
          el.getAttribute("routerlink");
        if (target) candidates.add(target);
      });

      // 3. Navigation menus & sidebars
      const navContainers = document.querySelectorAll(
        "nav a[href], aside a[href], header a[href], [role='navigation'] a[href], .sidebar a[href], .menu a[href], .navbar a[href]",
      );
      navContainers.forEach((el) => {
        const href = el.getAttribute("href");
        if (href) candidates.add(href);
      });

      // 4. Pagination links
      const paginationLinks = document.querySelectorAll(".pagination a[href], [aria-label*='page' i] a[href]");
      paginationLinks.forEach((el) => {
        const href = el.getAttribute("href");
        if (href) candidates.add(href);
      });

      const list: string[] = [];
      for (const href of candidates) {
        try {
          const resolved = new URL(href, window.location.href);
          if (resolved.origin === origin) {
            list.push(resolved.href);
          }
        } catch {}
      }
      return list;
    }, allowedOrigin);
    const validLinks = Array.isArray(results) ? results : [];
    return validLinks.filter((link) => !isInfrastructureOrCdnPath(link));
  } catch {
    return [];
  }
}

/**
 * Scrubs and redacts secrets from ScrapedPage structure before persistence.
 * Ensures password field values, tokens, and sensitive strings are redacted.
 */
export function scrubScrapedData(scraped?: ScrapedPage): ScrapedPage | null {
  if (!scraped) return null;
  return {
    ...scraped,
    title: redactSecrets(scraped.title),
    headings: scraped.headings.map((h) => redactSecrets(h)),
    text: redactSecrets(scraped.text),
    elements: (scraped.elements || []).map((el) => ({
      ...el,
      text: redactSecrets(el.text),
      name: el.name ? redactSecrets(el.name) : undefined,
      placeholder: el.placeholder ? redactSecrets(el.placeholder) : undefined,
      value:
        el.type === "password" || /password|secret|token|auth/i.test(`${el.name || ""} ${el.placeholder || ""}`)
          ? undefined
          : el.value
            ? redactSecrets(el.value)
            : undefined,
    })),
  };
}

/**
 * Executes a crawl operation with dedicated project-level advisory locking in PostgreSQL.
 * Uses a dedicated checked-out client with guaranteed release.
 * Lock key: 'crawl_project_' + projectId (distinct from AI generation lock 'generate_project_').
 */
export async function withProjectCrawlLock<T>(
  projectId: string,
  operation: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const client = await pool.connect();
  let lockAcquired = false;
  let releaseError: Error | undefined;

  try {
    const lockRes = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('crawl_project_' || $1)) AS locked",
      [projectId],
    );
    lockAcquired = Boolean(lockRes.rows[0]?.locked);

    if (!lockAcquired) {
      return { acquired: false };
    }

    const result = await operation();
    return { acquired: true, result };
  } finally {
    if (lockAcquired) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext('crawl_project_' || $1))",
          [projectId],
        );
      } catch (unlockErr) {
        console.error(`[CrawlLock] Failed to release advisory lock for project ${projectId}:`, unlockErr);
        releaseError = unlockErr instanceof Error ? unlockErr : new Error(String(unlockErr));
      }
    }
    client.release(releaseError);
  }
}

/**
 * Persists or updates a crawled page record incrementally in PostgreSQL.
 */
export async function saveCrawledPageDb(
  projectId: string,
  pageData: {
    sessionId?: string;
    url: string;
    path: string;
    depth: number;
    status: "visited" | "failed" | "skipped";
    title?: string;
    pageType: PageType;
    elementCounts: ElementCounts;
    domFingerprint?: string;
    scrapedData?: ScrapedPage;
    errorMessage?: string;
    durationMs?: number;
  },
): Promise<string> {
  const res = await pool.query<{ id: string }>(
    `INSERT INTO crawled_pages
       (project_id, session_id, url, path, depth, status, title, page_type, element_counts, dom_fingerprint, scraped_data, error_message, duration_ms, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
     ON CONFLICT (project_id, url) DO UPDATE
     SET status = EXCLUDED.status,
         depth = EXCLUDED.depth,
         title = EXCLUDED.title,
         page_type = EXCLUDED.page_type,
         element_counts = EXCLUDED.element_counts,
         dom_fingerprint = EXCLUDED.dom_fingerprint,
         scraped_data = EXCLUDED.scraped_data,
         error_message = EXCLUDED.error_message,
         duration_ms = EXCLUDED.duration_ms,
         updated_at = NOW()
     RETURNING id`,
    [
      projectId,
      pageData.sessionId ?? null,
      pageData.url,
      pageData.path,
      pageData.depth,
      pageData.status,
      pageData.title ? redactSecrets(pageData.title) : null,
      pageData.pageType,
      JSON.stringify(pageData.elementCounts),
      pageData.domFingerprint ?? null,
      pageData.scrapedData ? JSON.stringify(scrubScrapedData(pageData.scrapedData)) : null,
      pageData.errorMessage ? redactSecrets(pageData.errorMessage) : null,
      pageData.durationMs ?? 0,
    ],
  );
  return res.rows[0]?.id || "";
}

/**
 * Autonomous Recursive Website Crawler
 * Explores internal pages up to maxDepth and maxPages, classifies page types,
 * prevents crawling loops, saves pages incrementally, and integrates with Stage 1 functionality planning.
 */
export async function crawlSite(
  projectOrUrl: string | { id: string; base_url: string; name?: string },
  options: CrawlOptions = {},
): Promise<CrawlResult> {
  let baseUrl: string;
  let projectId: string;

  if (typeof projectOrUrl === "string") {
    baseUrl = projectOrUrl;
    const found = await pool.query<{ id: string }>(
      "SELECT id FROM projects WHERE base_url = $1 OR base_url = $2 LIMIT 1",
      [baseUrl, baseUrl.replace(/\/+$/, "")],
    );
    if (!found.rowCount || !found.rows[0]) {
      throw new Error(`No project found with base_url: ${baseUrl}`);
    }
    projectId = found.rows[0].id;
  } else {
    baseUrl = projectOrUrl.base_url;
    projectId = projectOrUrl.id;
  }

  // Acquire project-level crawl advisory lock
  const lockResult = await withProjectCrawlLock(projectId, async () => {
    const startTime = Date.now();
    const maxDepth = Math.max(1, Math.min(options.maxDepth ?? 3, 5));
    const maxPages = Math.max(1, Math.min(options.maxPages ?? 25, 50));
    const timeoutMs = options.timeoutMs ?? 120000;
    const MAX_DUPLICATE_TEMPLATES = 2;

    // SSRF guard on root URL
    await assertTargetUrlAllowed(baseUrl);
    const allowedOrigin = new URL(baseUrl).origin;

    // Initialize or retrieve crawl session in database
    const sessionId = options.sessionId || crypto.randomUUID();
    await pool.query(
      `INSERT INTO crawl_sessions
         (id, project_id, status, start_url, max_depth, max_pages, created_by)
       VALUES ($1, $2, 'active', $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
       SET status = 'active', updated_at = NOW()`,
      [sessionId, projectId, baseUrl, maxDepth, maxPages, options.createdBy ?? null],
    );

    const visitedUrls = new Set<string>();
    const fingerprintCounts = new Map<string, number>();
    const crawledPages: CrawlPageResult[] = [];
    let totalFunctionalitiesDiscovered = 0;
    let pagesFailed = 0;

    // Queue for BFS recursive crawling
    interface QueueItem {
      url: string;
      depth: number;
      parentUrl?: string;
      parentPageId?: string;
      attemptId?: string;
    }
    const queue: QueueItem[] = [];
    const attemptMap = new Map<string, string>();

    // If resume is enabled, load already-visited pages and seed queue with unvisited/failed links
    if (options.resume) {
      const existing = await pool.query<CrawledPageRow>(
        "SELECT url, depth, status, dom_fingerprint, scraped_data FROM crawled_pages WHERE project_id = $1",
        [projectId],
      );
      for (const row of existing.rows) {
        const canonical = normalizeCanonicalUrl(row.url, baseUrl);
        if (!canonical) continue;

        if (row.status === "visited") {
          visitedUrls.add(canonical);
          if (row.dom_fingerprint) {
            const count = fingerprintCounts.get(row.dom_fingerprint) || 0;
            fingerprintCounts.set(row.dom_fingerprint, count + 1);
          }

          // Extract discovered child links from previously scraped elements to continue crawl
          if (row.scraped_data && Array.isArray(row.scraped_data.elements)) {
            for (const el of row.scraped_data.elements) {
              if (el.tag === "a" && el.href) {
                const childCanonical = normalizeCanonicalUrl(el.href, baseUrl);
                if (
                  childCanonical &&
                  !isDestructiveActionOrUrl(childCanonical) &&
                  !isInfrastructureOrCdnPath(childCanonical)
                ) {
                  try {
                    if (new URL(childCanonical).origin === allowedOrigin && (row.depth || 0) + 1 <= maxDepth) {
                      if (!queue.some((q) => q.url === childCanonical)) {
                        queue.push({ url: childCanonical, depth: (row.depth || 0) + 1, parentUrl: canonical });
                      }
                    }
                  } catch {}
                }
              }
            }
          }
        } else if (row.status === "failed") {
          // Failed page: do NOT add to visitedUrls, but re-enqueue to retry if not an infrastructure path!
          if (!isInfrastructureOrCdnPath(canonical) && !queue.some((q) => q.url === canonical)) {
            queue.push({ url: canonical, depth: row.depth || 0 });
          }
        }
      }
    }

    const startUrl = options.startPath
      ? new URL(options.startPath, baseUrl).toString()
      : baseUrl;
    const initialCanonical = normalizeCanonicalUrl(startUrl, baseUrl);
    if (!initialCanonical) {
      throw new Error(`Invalid start URL: ${startUrl}`);
    }

    // If starting URL was not yet visited, seed it at the front of the queue
    if (!visitedUrls.has(initialCanonical) && !queue.some((q) => q.url === initialCanonical)) {
      queue.unshift({ url: initialCanonical, depth: 0 });
    }

    const browser: Browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    let isLoggedIn = false;
    let crawlStatus: "completed" | "partial" | "failed" = "completed";
    let crawlError: string | undefined;

    const evidenceStats: EvidenceCaptureStats = {
      attempted: 0,
      persisted: 0,
      failed: 0,
      skipped: 0,
      completenessRate: 1.0,
    };

    try {
      // Prepare authenticated browser session
      const setupResult = await setupAuthenticatedBrowser(browser, projectId, baseUrl);
      const { page } = setupResult;
      isLoggedIn = setupResult.isLoggedIn;
      page.setDefaultTimeout(20000);

      while (queue.length > 0 && crawledPages.length < maxPages) {
        if (Date.now() - startTime >= timeoutMs) {
          crawlStatus = "partial";
          break;
        }

        const current = queue.shift()!;
        const canonicalCurrent = normalizeCanonicalUrl(current.url, baseUrl);
        if (!canonicalCurrent || visitedUrls.has(canonicalCurrent)) {
          continue;
        }

        // Check SSRF and origin boundaries
        const guard = await validateTargetUrl(canonicalCurrent);
        if (!guard.valid) {
          continue;
        }

        // Global Infrastructure & CDN Guard: Never crawl CDN internals (e.g. /cdn-cgi/*)
        if (isInfrastructureOrCdnPath(canonicalCurrent)) {
          continue;
        }

        let parsedCurrent: URL;
        try {
          parsedCurrent = new URL(canonicalCurrent);
          if (parsedCurrent.origin !== allowedOrigin) {
            continue;
          }
        } catch {
          continue;
        }

        // Read-only safety guard: Skip destructive URLs and session exit
        if (isDestructiveActionOrUrl(canonicalCurrent)) {
          continue;
        }

        visitedUrls.add(canonicalCurrent);
        const pageStartTime = Date.now();

        try {
          // Navigate to current URL and capture HTTP response status
          let navResponse: import("@playwright/test").Response | null = null;
          if (page.url() !== canonicalCurrent) {
            navResponse = await page.goto(canonicalCurrent, { waitUntil: "domcontentloaded", timeout: 20000 });
            await waitForRealContent(page, 15000);
          }

          // Check if response returned an HTTP error status (4xx/5xx)
          if (navResponse && typeof navResponse.status === "function" && navResponse.status() >= 400) {
            const statusText = typeof navResponse.statusText === "function" ? navResponse.statusText() : "";
            const httpErrorMsg = `HTTP ${navResponse.status()}${statusText ? ` ${statusText}` : ""}`.trim();
            const pageDurationMs = Date.now() - pageStartTime;

            await saveCrawledPageDb(projectId, {
              sessionId,
              url: canonicalCurrent,
              path: new URL(canonicalCurrent).pathname,
              depth: current.depth,
              status: "failed",
              pageType: "static",
              elementCounts: EMPTY_ELEMENT_COUNTS,
              errorMessage: httpErrorMsg,
              durationMs: pageDurationMs,
            });
            crawledPages.push({
              url: canonicalCurrent,
              path: new URL(canonicalCurrent).pathname,
              depth: current.depth,
              title: "",
              pageType: "static",
              elementCounts: EMPTY_ELEMENT_COUNTS,
              domFingerprint: "",
              scrapedPage: {
                url: canonicalCurrent,
                path: new URL(canonicalCurrent).pathname,
                title: "",
                headings: [],
                text: "",
                elements: [],
              },
              discoveredLinks: [],
              durationMs: pageDurationMs,
              status: "failed",
              error: httpErrorMsg,
            });
            continue;
          }

          // Handle client-side SPA redirects or URL changes
          const finalUrl = page.url();
          const canonicalFinal = normalizeCanonicalUrl(finalUrl, baseUrl) || canonicalCurrent;

          if (isInfrastructureOrCdnPath(canonicalFinal)) {
            continue;
          }

          // Extract scraped data
          const scraped = await extractScrapedPage(page);

          // Check if page content represents an HTTP error page (404/500/Cloudflare error)
          if (
            isErrorPageContent(scraped.title, scraped.headings, scraped.text) ||
            isInfrastructureOrCdnPath(scraped.path)
          ) {
            const errorMsg = isInfrastructureOrCdnPath(scraped.path)
              ? `Skipped infrastructure or CDN path: ${scraped.path}`
              : `Error page detected: ${scraped.title || scraped.path}`;
            const pageDurationMs = Date.now() - pageStartTime;

            await saveCrawledPageDb(projectId, {
              sessionId,
              url: canonicalFinal,
              path: scraped.path,
              depth: current.depth,
              status: "failed",
              title: scraped.title,
              pageType: "static",
              elementCounts: EMPTY_ELEMENT_COUNTS,
              scrapedData: scraped,
              errorMessage: errorMsg,
              durationMs: pageDurationMs,
            });
            crawledPages.push({
              url: canonicalFinal,
              path: scraped.path,
              depth: current.depth,
              title: scraped.title,
              pageType: "static",
              elementCounts: EMPTY_ELEMENT_COUNTS,
              domFingerprint: "",
              scrapedPage: scraped,
              discoveredLinks: [],
              durationMs: pageDurationMs,
              status: "failed",
              error: errorMsg,
            });
            continue;
          }

          // Classify page type and element counts
          const { pageType, elementCounts } = classifyPageType(
            scraped.title,
            scraped.headings,
            scraped.elements,
            scraped.text,
          );

          // Compute DOM fingerprint for anti-looping & template deduplication
          const domFingerprint = computeDomFingerprint(
            scraped.title,
            scraped.headings,
            scraped.elements,
          );

          const currentFingerprintCount = fingerprintCounts.get(domFingerprint) || 0;
          fingerprintCounts.set(domFingerprint, currentFingerprintCount + 1);

          const pageDurationMs = Date.now() - pageStartTime;

          // Save page record incrementally to database
          const pageRowId = await saveCrawledPageDb(projectId, {
            sessionId,
            url: canonicalFinal,
            path: scraped.path,
            depth: current.depth,
            status: "visited",
            title: scraped.title,
            pageType,
            elementCounts,
            domFingerprint,
            scrapedData: scraped,
            durationMs: pageDurationMs,
          });

          // Discover and enqueue child links if within maxDepth and template is not saturated
          const discoveredLinks: string[] = [];
          if (current.depth < maxDepth && currentFingerprintCount < MAX_DUPLICATE_TEMPLATES) {
            const rawLinks = await extractPageLinks(page, allowedOrigin);
            for (const rawLink of rawLinks) {
              const canonicalLink = normalizeCanonicalUrl(rawLink, baseUrl);
              if (!canonicalLink || isInfrastructureOrCdnPath(canonicalLink)) continue;

              try {
                const linkObj = new URL(canonicalLink);
                if (linkObj.origin !== allowedOrigin) continue;
              } catch {
                continue;
              }

              if (isDestructiveActionOrUrl(canonicalLink)) continue;
              if (visitedUrls.has(canonicalLink)) continue;

              discoveredLinks.push(canonicalLink);
              // Enqueue if not already queued
              if (!queue.some((item) => item.url === canonicalLink)) {
                const navAttemptId = attemptMap.get(canonicalLink) || crypto.randomUUID();
                attemptMap.set(canonicalLink, navAttemptId);
                queue.push({
                  url: canonicalLink,
                  depth: current.depth + 1,
                  parentUrl: canonicalCurrent,
                  parentPageId: pageRowId,
                  attemptId: navAttemptId,
                });
              }
            }
          }

          // Automatically feed discovered page into Stage 1 Functionality Inventory
          const pageFunctionalities = discoverPageFunctionalities(scraped, projectId);
          if (pageFunctionalities.length > 0) {
            const plannedScenarios = pageFunctionalities.flatMap((f) =>
              planScenariosForFunctionality(f),
            );
            const saved = await persistFunctionalitiesAndScenarios(
              projectId,
              pageFunctionalities,
              plannedScenarios,
            );
            totalFunctionalitiesDiscovered += saved.savedFunctionalities;
          }

          // If this page was reached via link from parent page, record cross-page navigation transition
          if (current.parentPageId) {
            try {
              const parentPath = current.parentUrl ? new URL(current.parentUrl).pathname : "/";
              evidenceStats.attempted++;
              const navResult = await recordNavigationTransition({
                pool,
                projectId,
                sessionId,
                sourcePageId: current.parentPageId,
                destinationPageId: pageRowId,
                sourcePath: parentPath,
                destinationPath: scraped.path,
                domFingerprint,
                isLoggedIn,
                attemptId: current.attemptId || crypto.randomUUID(),
              });
              if (navResult && navResult.transitionId) {
                evidenceStats.persisted++;
              } else {
                evidenceStats.failed++;
              }
            } catch (navErr) {
              evidenceStats.failed++;
              console.warn(`[CrawlerEvidence] Failed recording navigation transition for ${canonicalFinal}:`, navErr);
            }
          }

          // Explore safe on-page interactions (tabs, dropdowns, modals, safe search) and record structured state transitions
          try {
            const expStats = await explorePageInteractions({
              pool,
              page,
              projectId,
              sessionId,
              sourcePageId: pageRowId,
              sourcePath: scraped.path,
              pageType,
              isLoggedIn,
              functionalities: pageFunctionalities,
              attemptMap,
            });
            evidenceStats.attempted += expStats.attempted;
            evidenceStats.persisted += expStats.persisted;
            evidenceStats.failed += expStats.failed;
            evidenceStats.skipped += expStats.skipped;
          } catch (exploreErr) {
            console.warn(`[CrawlerEvidence] Failed exploring page interactions for ${canonicalFinal}:`, exploreErr);
          }

          const pageResult: CrawlPageResult = {
            id: pageRowId,
            url: canonicalFinal,
            path: scraped.path,
            depth: current.depth,
            title: scraped.title,
            pageType,
            elementCounts,
            domFingerprint,
            scrapedPage: scraped,
            discoveredLinks,
            durationMs: pageDurationMs,
            status: "visited",
          };
          crawledPages.push(pageResult);

          // Update crawl session metrics in database
          await pool.query(
            `UPDATE crawl_sessions
             SET pages_crawled = $1,
                 functionalities_discovered = $2,
                 duration_ms = $3,
                 updated_at = NOW()
             WHERE id = $4`,
            [crawledPages.length, totalFunctionalitiesDiscovered, Date.now() - startTime, sessionId],
          );

          // Report real-time progress
          if (options.onProgress) {
            await options.onProgress({
              sessionId,
              projectId,
              currentUrl: canonicalFinal,
              currentDepth: current.depth,
              pagesCrawled: crawledPages.length,
              pagesQueued: queue.length,
              pagesFailed,
              latestPageType: pageType,
              functionalitiesDiscovered: totalFunctionalitiesDiscovered,
              evidenceStats: { ...evidenceStats },
            });
          }
        } catch (pageErr) {
          pagesFailed++;
          const errorMessage = pageErr instanceof Error ? pageErr.message : String(pageErr);
          console.warn(`[AutonomousCrawler] Failed crawling ${canonicalCurrent}:`, errorMessage);

          await saveCrawledPageDb(projectId, {
            sessionId,
            url: canonicalCurrent,
            path: new URL(canonicalCurrent).pathname,
            depth: current.depth,
            status: "failed",
            pageType: "general",
            elementCounts: {
              forms: 0,
              inputs: 0,
              buttons: 0,
              links: 0,
              tables: 0,
              filters: 0,
              searchBars: 0,
              pagination: 0,
            },
            errorMessage,
            durationMs: Date.now() - pageStartTime,
          });

          crawledPages.push({
            url: canonicalCurrent,
            path: new URL(canonicalCurrent).pathname,
            depth: current.depth,
            title: "",
            pageType: "general",
            elementCounts: {
              forms: 0,
              inputs: 0,
              buttons: 0,
              links: 0,
              tables: 0,
              filters: 0,
              searchBars: 0,
              pagination: 0,
            },
            domFingerprint: "",
            scrapedPage: {
              url: canonicalCurrent,
              path: new URL(canonicalCurrent).pathname,
              title: "",
              headings: [],
              text: "",
              elements: [],
            },
            discoveredLinks: [],
            durationMs: Date.now() - pageStartTime,
            status: "failed",
            error: errorMessage,
          });
        }
      }

      if (queue.length > 0 && crawledPages.length >= maxPages) {
        crawlStatus = "partial";
      }
    } catch (fatalErr) {
      crawlStatus = "failed";
      crawlError = fatalErr instanceof Error ? fatalErr.message : String(fatalErr);
      console.error("[AutonomousCrawler] Fatal error during crawl:", fatalErr);
    } finally {
      await browser.close().catch(() => {});
    }

    const totalDurationMs = Date.now() - startTime;
    const dbStatus = crawlStatus === "partial" ? "completed" : crawlStatus;

    // Finalize session in database
    await pool.query(
      `UPDATE crawl_sessions
       SET status = $1,
           pages_crawled = $2,
           pages_failed = $3,
           functionalities_discovered = $4,
           duration_ms = $5,
           error_message = $6,
           updated_at = NOW()
       WHERE id = $7`,
      [
        dbStatus,
        crawledPages.filter((p) => p.status === "visited").length,
        pagesFailed,
        totalFunctionalitiesDiscovered,
        totalDurationMs,
        crawlError ?? null,
        sessionId,
      ],
    );

    evidenceStats.completenessRate =
      evidenceStats.attempted > 0
        ? Math.round((evidenceStats.persisted / evidenceStats.attempted) * 1000) / 1000
        : 1.0;

    return {
      sessionId,
      projectId,
      baseUrl,
      isLoggedIn,
      totalPagesCrawled: crawledPages.filter((p) => p.status === "visited").length,
      pages: crawledPages,
      functionalitiesDiscovered: totalFunctionalitiesDiscovered,
      durationMs: totalDurationMs,
      status: crawlStatus,
      error: crawlError,
      evidenceStats,
    };
  });

  if (!lockResult.acquired) {
    throw new Error(`A crawl is already in progress for project ${projectId}`);
  }

  return lockResult.result;
}

/**
 * Retrieves crawled pages for a given project from PostgreSQL.
 */
export async function getCrawledPages(projectId: string): Promise<CrawledPageRow[]> {
  const res = await pool.query<CrawledPageRow>(
    `SELECT id, project_id, session_id, url, path, depth, status, title,
            page_type, element_counts, dom_fingerprint, scraped_data, error_message,
            duration_ms, created_at, updated_at
     FROM crawled_pages
     WHERE project_id = $1
     ORDER BY depth ASC, created_at ASC`,
    [projectId],
  );
  return res.rows;
}

/**
 * Retrieves a crawl session by ID.
 */
export async function getCrawlSession(sessionId: string): Promise<CrawlSessionRow | null> {
  const res = await pool.query<CrawlSessionRow>(
    "SELECT * FROM crawl_sessions WHERE id = $1",
    [sessionId],
  );
  return res.rows[0] ?? null;
}
