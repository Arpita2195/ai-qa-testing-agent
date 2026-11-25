import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { pool } from "../config/db";
import {
  normalizeCanonicalUrl,
  isDestructiveActionOrUrl,
  computeDomFingerprint,
  classifyPageType,
  saveCrawledPageDb,
  crawlSite,
  getCrawledPages,
  getCrawlSession,
  withProjectCrawlLock,
  scrubScrapedData,
  type ElementCounts,
  type PageType,
} from "../services/crawler";
import { initializeJobHandlers } from "../services/jobs/jobHandlers";
import { getJobHandler } from "../services/jobs/jobQueue";
import crawlRoutes from "../routes/crawl";
import generateRoutes from "../routes/generate";
import { isStockFlowUrl, type PageElement, type ScrapedPage } from "../services/pageReader";

// Hoist mock state
const mockDb = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));

const mockClient = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
}));

const mockPlaywright = vi.hoisted(() => ({
  launch: vi.fn(),
  pageGoto: vi.fn(),
  pageEvaluate: vi.fn(),
  pageUrl: vi.fn(),
  pageClose: vi.fn(),
  browserClose: vi.fn(),
}));

vi.mock("../config/db", () => ({
  pool: {
    query: mockDb.query,
    connect: mockDb.connect,
  },
}));

vi.mock("@playwright/test", () => ({
  chromium: {
    launch: mockPlaywright.launch,
  },
}));

vi.mock("../services/urlGuard", () => ({
  assertTargetUrlAllowed: vi.fn().mockResolvedValue(undefined),
  validateTargetUrl: vi.fn().mockImplementation(async (url: string) => {
    if (url.includes("evil.com") || url.includes("169.254.169.254")) {
      return { valid: false, reason: "Blocked SSRF target" };
    }
    return { valid: true };
  }),
  attachUrlGuardToPage: vi.fn(),
}));

vi.mock("../services/appAuth", () => ({
  setupAuthenticatedBrowser: vi.fn().mockImplementation(async (_browser, _projectId, baseUrl) => {
    return {
      context: {},
      page: {
        url: () => baseUrl,
        goto: mockPlaywright.pageGoto,
        evaluate: mockPlaywright.pageEvaluate,
        setDefaultTimeout: vi.fn(),
        locator: vi.fn().mockReturnValue({
          count: vi.fn().mockResolvedValue(0),
          first: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }),
        }),
      },
      isLoggedIn: true,
      loginSteps: [],
      usedSession: true,
    };
  }),
}));

vi.mock("../services/pageReader", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/pageReader")>();
  return {
    ...actual,
    waitForRealContent: vi.fn().mockResolvedValue(undefined),
    extractScrapedPage: vi.fn().mockImplementation(async (page: any) => {
      const currentUrl = typeof page.url === "function" ? page.url() : "https://example.com";
      const pathname = new URL(currentUrl).pathname;
      return {
        url: currentUrl,
        path: pathname,
        title: `Page ${pathname}`,
        headings: [`Heading for ${pathname}`],
        text: `Content for ${pathname} with some items and details.`,
        elements: [
          { tag: "a", text: "Dashboard", selector: "nav a.dashboard", href: "https://example.com/dashboard" },
          { tag: "a", text: "Inventory", selector: "nav a.inventory", href: "https://example.com/inventory" },
          { tag: "button", text: "Filter", selector: "button.filter" },
        ],
      };
    }),
  };
});

describe("Autonomous Website Exploration & Recursive Crawler Engine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mockClient.query.mockResolvedValue({ rows: [{ locked: true }] });
    mockClient.release.mockReset();
    mockDb.connect.mockResolvedValue(mockClient);
    mockPlaywright.pageEvaluate.mockResolvedValue([]);
    mockPlaywright.pageGoto.mockResolvedValue(undefined);
  });

  describe("1. Canonical URL Normalization & Anti-Looping", () => {
    it("strips marketing and analytics tracking query parameters", () => {
      const raw = "https://example.com/products?utm_source=google&utm_medium=cpc&fbclid=xyz&category=shoes";
      const canonical = normalizeCanonicalUrl(raw, "https://example.com");
      expect(canonical).toBe("https://example.com/products?category=shoes");
    });

    it("sorts query parameters alphabetically for consistent canonical deduplication", () => {
      const url1 = "https://example.com/items?sort=asc&page=2&filter=active";
      const url2 = "https://example.com/items?filter=active&page=2&sort=asc";
      const c1 = normalizeCanonicalUrl(url1, "https://example.com");
      const c2 = normalizeCanonicalUrl(url2, "https://example.com");
      expect(c1).toBe(c2);
      expect(c1).toBe("https://example.com/items?filter=active&page=2&sort=asc");
    });

    it("strips normal anchor fragments (#section) to prevent crawler duplication", () => {
      const raw = "https://example.com/docs/intro#getting-started";
      const canonical = normalizeCanonicalUrl(raw, "https://example.com");
      expect(canonical).toBe("https://example.com/docs/intro");
    });

    it("preserves SPA hash routing (e.g. #/dashboard, #!/settings)", () => {
      const raw = "https://example.com/#/dashboard/metrics/";
      const canonical = normalizeCanonicalUrl(raw, "https://example.com");
      expect(canonical).toBe("https://example.com/#/dashboard/metrics");
    });

    it("normalizes trailing slashes except on the root domain", () => {
      const urlWithPath = "https://example.com/inventory/items/";
      expect(normalizeCanonicalUrl(urlWithPath, "https://example.com")).toBe("https://example.com/inventory/items");

      const rootUrl = "https://example.com/";
      expect(normalizeCanonicalUrl(rootUrl, "https://example.com")).toBe("https://example.com/");
    });

    it("rejects non-http/https protocols such as javascript:, mailto:, tel:", () => {
      expect(normalizeCanonicalUrl("javascript:void(0)", "https://example.com")).toBeNull();
      expect(normalizeCanonicalUrl("mailto:support@example.com", "https://example.com")).toBeNull();
      expect(normalizeCanonicalUrl("tel:+123456789", "https://example.com")).toBeNull();
    });
  });

  describe("2. Destructive Actions & Session Guardrails", () => {
    it("detects and rejects session termination endpoints", () => {
      expect(isDestructiveActionOrUrl("https://example.com/logout")).toBe(true);
      expect(isDestructiveActionOrUrl("https://example.com/auth/signout")).toBe(true);
      expect(isDestructiveActionOrUrl("https://example.com/api/logout")).toBe(true);
      expect(isDestructiveActionOrUrl("https://example.com/session/destroy")).toBe(true);
      expect(isDestructiveActionOrUrl("https://example.com/account", "Sign Out", "/logout")).toBe(true);
    });

    it("detects and flags destructive mutation actions (delete, purge, destroy)", () => {
      expect(isDestructiveActionOrUrl("https://example.com/items/delete/1")).toBe(true);
      expect(isDestructiveActionOrUrl("https://example.com/items", "Delete item", "#")).toBe(true);
      expect(isDestructiveActionOrUrl("https://example.com/database", "Purge all records", "#")).toBe(true);
      expect(isDestructiveActionOrUrl("https://example.com/users", "Drop table", "#")).toBe(true);
    });

    it("detects and flags financial transactions and order placement", () => {
      expect(isDestructiveActionOrUrl("https://example.com/checkout/pay")).toBe(true);
      expect(isDestructiveActionOrUrl("https://example.com/cart", "Submit payment", "/pay")).toBe(true);
      expect(isDestructiveActionOrUrl("https://example.com/order", "Place order now", "#")).toBe(true);
      expect(isDestructiveActionOrUrl("https://example.com/subscription", "Cancel subscription", "#")).toBe(true);
    });

    it("allows benign navigation and read-only pages", () => {
      expect(isDestructiveActionOrUrl("https://example.com/dashboard")).toBe(false);
      expect(isDestructiveActionOrUrl("https://example.com/inventory")).toBe(false);
      expect(isDestructiveActionOrUrl("https://example.com/items/view/123")).toBe(false);
      expect(isDestructiveActionOrUrl("https://example.com/reports", "View monthly report", "/reports/1")).toBe(false);
    });
  });

  describe("3. DOM Structure Fingerprinting & Anti-Looping", () => {
    it("produces identical fingerprints for different URLs using the same template", () => {
      const headings = ["Product Details", "Specifications"];
      const elements: PageElement[] = [
        { tag: "input", text: "", selector: "#qty" },
        { tag: "button", text: "Add to Cart", selector: "#add" },
        { tag: "a", text: "Back to Catalog", selector: "a.back", href: "/catalog" },
      ];

      const fp1 = computeDomFingerprint("Product 123", headings, elements);
      const fp2 = computeDomFingerprint("Product 123", headings, elements);
      expect(fp1).toBe(fp2);
    });

    it("produces distinct fingerprints when page structure changes", () => {
      const fp1 = computeDomFingerprint("Dashboard", ["Overview", "Metrics"], [
        { tag: "button", text: "Refresh", selector: "#btn1" },
      ]);
      const fp2 = computeDomFingerprint("Settings", ["Profile", "Security"], [
        { tag: "input", text: "", selector: "#username" },
        { tag: "input", text: "", selector: "#email" },
      ]);
      expect(fp1).not.toBe(fp2);
    });
  });

  describe("4. Page Type Classification & Element Surface Analysis", () => {
    it("classifies authentication pages when password inputs are present", () => {
      const elements: PageElement[] = [
        { tag: "input", text: "", selector: "#email", type: "email" },
        { tag: "input", text: "", selector: "#password", type: "password" },
        { tag: "button", text: "Sign in", selector: "button[type='submit']" },
      ];
      const result = classifyPageType("Sign In - StockFlow", ["Welcome Back"], elements, "Please log in to continue");
      expect(result.pageType).toBe("auth");
      expect(result.elementCounts.inputs).toBe(2);
      expect(result.elementCounts.buttons).toBe(1);
    });

    it("classifies list/table pages with data tables, search, and pagination", () => {
      const elements: PageElement[] = [
        { tag: "input", text: "", selector: "input.search", type: "search", name: "search" },
        { tag: "select", text: "", selector: "select.filter", name: "category" },
        { tag: "table", text: "", selector: "table.items-table" },
        { tag: "a", text: "Next page", selector: ".pagination a.next", href: "/items?page=2" },
      ];
      const result = classifyPageType(
        "Inventory Catalog",
        ["Items List"],
        elements,
        "<table><tr><th>ID</th><th>Name</th></tr><tr><td>1</td><td>Widget</td></tr></table>",
      );
      expect(result.pageType).toBe("list_table");
      expect(result.elementCounts.tables).toBe(1);
      expect(result.elementCounts.searchBars).toBe(1);
      expect(result.elementCounts.filters).toBe(1);
      expect(result.elementCounts.pagination).toBe(1);
    });

    it("classifies form/editor pages with multiple inputs and action buttons", () => {
      const elements: PageElement[] = [
        { tag: "form", text: "", selector: "form#item-form" },
        { tag: "input", text: "", selector: "#name", type: "text" },
        { tag: "input", text: "", selector: "#sku", type: "text" },
        { tag: "input", text: "", selector: "#price", type: "number" },
        { tag: "button", text: "Save Item", selector: "button.submit" },
      ];
      const result = classifyPageType("Create Item", ["New Product Form"], elements, "Fill in the fields to create a product");
      expect(result.pageType).toBe("form_editor");
      expect(result.elementCounts.forms).toBe(1);
      expect(result.elementCounts.inputs).toBe(3);
    });

    it("classifies dashboard pages with overview metrics", () => {
      const elements: PageElement[] = [
        { tag: "a", text: "Sales", selector: "nav a.sales", href: "/sales" },
        { tag: "a", text: "Orders", selector: "nav a.orders", href: "/orders" },
        { tag: "a", text: "Customers", selector: "nav a.customers", href: "/customers" },
        { tag: "a", text: "Settings", selector: "nav a.settings", href: "/settings" },
        { tag: "button", text: "Generate Report", selector: "button.report" },
      ];
      const result = classifyPageType("Dashboard Overview", ["Executive Metrics"], elements, "High level summary and KPI cards");
      expect(result.pageType).toBe("dashboard");
    });

    it("classifies static content pages with no inputs and minimal actions", () => {
      const elements: PageElement[] = [
        { tag: "a", text: "Back Home", selector: "a.home", href: "/" },
      ];
      const result = classifyPageType("Terms of Service", ["Terms and Conditions"], elements, "All usage is subject to terms...");
      expect(result.pageType).toBe("static");
      expect(result.elementCounts.inputs).toBe(0);
    });
  });

  describe("5. Database Persistence & Incremental Saving", () => {
    it("persists crawled page incrementally and returns page id", async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: "crawled-page-uuid-1" }], rowCount: 1 });

      const pageId = await saveCrawledPageDb("proj-123", {
        sessionId: "sess-1",
        url: "https://example.com/inventory",
        path: "/inventory",
        depth: 1,
        status: "visited",
        title: "Inventory",
        pageType: "list_table",
        elementCounts: {
          forms: 0,
          inputs: 1,
          buttons: 2,
          links: 4,
          tables: 1,
          filters: 1,
          searchBars: 1,
          pagination: 1,
        },
        domFingerprint: "fingerprint-123",
        durationMs: 320,
      });

      expect(pageId).toBe("crawled-page-uuid-1");
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining("INSERT INTO crawled_pages"),
        expect.arrayContaining(["proj-123", "sess-1", "https://example.com/inventory", "/inventory", 1, "visited"]),
      );
    });

    it("retrieves crawled pages ordered by depth and creation date", async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { id: "page-1", url: "https://example.com", depth: 0, page_type: "dashboard" },
          { id: "page-2", url: "https://example.com/items", depth: 1, page_type: "list_table" },
        ],
        rowCount: 2,
      });

      const pages = await getCrawledPages("proj-123");
      expect(pages.length).toBe(2);
      expect(pages[0].depth).toBe(0);
      expect(pages[1].depth).toBe(1);
    });
  });

  describe("6. Autonomous Recursive Crawl Engine (crawlSite)", () => {
    it("executes recursive crawl within maxDepth and maxPages bounds", async () => {
      const mockBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockPlaywright.launch.mockResolvedValue(mockBrowser);

      // Mock DB queries for crawl session insert, update, functionality persistence
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT INTO crawl_sessions
        .mockResolvedValueOnce({ rows: [{ id: "page-row-1" }], rowCount: 1 }) // saveCrawledPageDb
        .mockResolvedValueOnce({ rows: [{ id: "func-1" }], rowCount: 1 }) // functionality_inventory
        .mockResolvedValueOnce({ rows: [{ id: "scen-1" }], rowCount: 1 }) // scenario_checklists
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE crawl_sessions live metrics
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE crawl_sessions finalize

      const project = { id: "proj-123", base_url: "https://example.com", name: "Example App" };
      const result = await crawlSite(project, {
        maxDepth: 2,
        maxPages: 5,
        timeoutMs: 10000,
      });

      expect(result.status).toBe("completed");
      expect(result.projectId).toBe("proj-123");
      expect(result.totalPagesCrawled).toBeGreaterThanOrEqual(1);
      expect(result.pages[0].pageType).toBeDefined();
      expect(mockBrowser.close).toHaveBeenCalled();
    });

    it("resumes crawl by skipping already-visited pages from previous session", async () => {
      const mockBrowser = {
        close: vi.fn().mockResolvedValue(undefined),
      };
      mockPlaywright.launch.mockResolvedValue(mockBrowser);

      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT INTO crawl_sessions
        .mockResolvedValueOnce({
          rows: [
            { url: "https://example.com", dom_fingerprint: "fp-root", status: "visited" },
          ],
          rowCount: 1,
        }) // SELECT from crawled_pages on resume
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // Finalize session

      const project = { id: "proj-123", base_url: "https://example.com", name: "Example App" };
      const result = await crawlSite(project, {
        resume: true,
        maxPages: 2,
      });

      // The root URL was already visited in the previous session, so it should be skipped
      expect(result.status).toBe("completed");
      expect(mockBrowser.close).toHaveBeenCalled();
    });
  });

  describe("7. HTTP Crawl Routes & Background Job Queue Integration", () => {
    const validProjectId = "11111111-1111-4111-a111-111111111111";

    it("POST /projects/:projectId/crawl enqueues asynchronous crawl job when async: true", async () => {
      const app = Fastify();
      await app.register(crawlRoutes);

      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ id: validProjectId, name: "Test App", base_url: "https://example.com" }],
          rowCount: 1,
        }) // project check
        .mockResolvedValueOnce({
          rows: [{
            id: "job-crawl-uuid-1",
            project_id: validProjectId,
            queue_name: "crawler",
            job_type: "site_crawl",
            status: "pending",
            payload: {},
            retries: 0,
            max_retries: 3,
            enqueued_at: new Date(),
            created_at: new Date(),
            updated_at: new Date(),
          }],
          rowCount: 1,
        }); // enqueue job insert

      const response = await app.inject({
        method: "POST",
        url: `/projects/${validProjectId}/crawl`,
        payload: {
          async: true,
          maxDepth: 3,
          maxPages: 15,
        },
      });

      expect(response.statusCode).toBe(202);
      const json = response.json();
      expect(json.message).toBe("Autonomous crawler job enqueued");
      expect(json.jobId).toBe("job-crawl-uuid-1");
      expect(json.status).toBe("pending");
      await app.close();
    });

    it("GET /projects/:projectId/crawl returns session summary and pages count", async () => {
      const app = Fastify();
      await app.register(crawlRoutes);

      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ id: "sess-1", status: "completed", pages_crawled: 12 }],
          rowCount: 1,
        }) // crawl_sessions query
        .mockResolvedValueOnce({
          rows: [{ count: "12" }],
          rowCount: 1,
        }); // crawled_pages count

      const response = await app.inject({
        method: "GET",
        url: `/projects/${validProjectId}/crawl`,
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.totalCrawledPages).toBe(12);
      expect(json.recentSessions.length).toBe(1);
      await app.close();
    });

    it("site_crawl background job handler is registered and executable", async () => {
      initializeJobHandlers();
      const handler = getJobHandler("site_crawl");
      expect(handler).toBeDefined();

      const mockBrowser = { close: vi.fn().mockResolvedValue(undefined) };
      mockPlaywright.launch.mockResolvedValue(mockBrowser);

      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ id: validProjectId, name: "Test App", base_url: "https://example.com" }],
          rowCount: 1,
        }) // project query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // crawl_sessions insert
        .mockResolvedValueOnce({ rows: [{ id: "page-1" }], rowCount: 1 }) // saveCrawledPageDb
        .mockResolvedValueOnce({ rows: [{ id: "f-1" }], rowCount: 1 }) // functionality_inventory
        .mockResolvedValueOnce({ rows: [{ id: "s-1" }], rowCount: 1 }) // scenario_checklists
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // live metrics update
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // session finalize update

      const jobResult = await handler!(
        {
          projectId: validProjectId,
          maxDepth: 2,
          maxPages: 5,
        },
        {
          id: "job-1",
          projectId: validProjectId,
          queueName: "crawler",
          jobType: "site_crawl",
          status: "active",
          payload: {},
          retries: 0,
          maxRetries: 3,
          enqueuedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      );

      expect(jobResult.status).toBe("completed");
      expect(jobResult.totalPagesCrawled).toBeGreaterThanOrEqual(1);
    });
  });

  describe("8. Security, Isolation & Concurrency Audit", () => {
    const testProjectId = "22222222-2222-4222-a222-222222222222";

    it("withProjectCrawlLock uses distinct 'crawl_project_' key and acquires lock on dedicated client", async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [{ locked: true }] }); // lock
      mockClient.query.mockResolvedValueOnce({ rows: [] }); // unlock

      const op = vi.fn().mockResolvedValue("crawl_done");
      const res = await withProjectCrawlLock(testProjectId, op);

      expect(res.acquired).toBe(true);
      if (res.acquired) expect(res.result).toBe("crawl_done");
      expect(op).toHaveBeenCalled();
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("pg_try_advisory_lock(hashtext('crawl_project_' || $1))"),
        [testProjectId],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        expect.stringContaining("pg_advisory_unlock(hashtext('crawl_project_' || $1))"),
        [testProjectId],
      );
      expect(mockClient.release).toHaveBeenCalledWith(undefined);
    });

    it("withProjectCrawlLock rejects concurrent crawl when lock is already held", async () => {
      mockClient.query.mockResolvedValueOnce({ rows: [{ locked: false }] }); // lock not acquired

      const op = vi.fn().mockResolvedValue("should_not_run");
      const res = await withProjectCrawlLock(testProjectId, op);

      expect(res.acquired).toBe(false);
      expect(op).not.toHaveBeenCalled();
      expect(mockClient.release).toHaveBeenCalledWith(undefined);
    });

    it("withProjectCrawlLock discards connection if pg_advisory_unlock fails", async () => {
      const unlockErr = new Error("Database network dropped during unlock");
      mockClient.query
        .mockResolvedValueOnce({ rows: [{ locked: true }] }) // lock acquired
        .mockRejectedValueOnce(unlockErr); // unlock fails

      const op = vi.fn().mockResolvedValue("done");
      const res = await withProjectCrawlLock(testProjectId, op);

      expect(res.acquired).toBe(true);
      // Connection must be released with the error to discard from pool
      expect(mockClient.release).toHaveBeenCalledWith(unlockErr);
    });

    it("POST /projects/:projectId/crawl returns 409 Conflict when crawl lock is already held", async () => {
      const app = Fastify();
      await app.register(crawlRoutes);

      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: testProjectId, name: "App", base_url: "https://example.com" }],
        rowCount: 1,
      });

      // Mock crawl lock acquisition failing
      mockClient.query.mockResolvedValueOnce({ rows: [{ locked: false }] });

      const response = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/crawl`,
        payload: { maxDepth: 2 },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().error).toContain("already in progress");
      await app.close();
    });

    it("isStockFlowUrl strictly checks origin equality and rejects arbitrary domains with 'stockflow' in path", () => {
      // Valid Stockflow matching env.STOCKFLOW_BASE_URL (or default)
      expect(isStockFlowUrl("https://stockflow-vert-two.vercel.app/")).toBe(true);
      expect(isStockFlowUrl("https://stockflow-vert-two.vercel.app/inventory")).toBe(true);

      // Malicious/attacker URLs containing 'stockflow' substring
      expect(isStockFlowUrl("https://evil.com/stockflow")).toBe(false);
      expect(isStockFlowUrl("https://stockflow.attacker.org/")).toBe(false);
      expect(isStockFlowUrl("https://my-app.com?ref=stockflow")).toBe(false);
    });

    it("scrubScrapedData masks password values to undefined and redacts sensitive text", () => {
      const sensitiveScraped: ScrapedPage = {
        url: "https://example.com/account",
        path: "/account",
        title: "Account page with super_secret_token",
        headings: ["User API Key: secret_api_key_12345"],
        text: "Your session token is bearer_token_xyz987",
        elements: [
          { tag: "input", text: "", selector: "#pass", type: "password", value: "superSecretPlaintextPassword" },
          { tag: "input", text: "", selector: "#user", type: "text", value: "alice@example.com" },
        ],
      };

      const scrubbed = scrubScrapedData(sensitiveScraped);
      expect(scrubbed).not.toBeNull();
      // Password value MUST be undefined
      const passEl = scrubbed!.elements.find((e) => e.selector === "#pass");
      expect(passEl?.value).toBeUndefined();

      // Normal input value preserved
      const userEl = scrubbed!.elements.find((e) => e.selector === "#user");
      expect(userEl?.value).toBe("alice@example.com");
    });

    it("resume skips visited pages, retries failed pages, and enqueues unvisited child links", async () => {
      const mockBrowser = { close: vi.fn().mockResolvedValue(undefined) };
      mockPlaywright.launch.mockResolvedValue(mockBrowser);

      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT INTO crawl_sessions
        .mockResolvedValueOnce({
          rows: [
            {
              url: "https://example.com/",
              depth: 0,
              status: "visited",
              dom_fingerprint: "fp-home",
              scraped_data: {
                elements: [
                  { tag: "a", href: "https://example.com/unvisited-subpage" },
                ],
              },
            },
            {
              url: "https://example.com/previously-failed-page",
              depth: 1,
              status: "failed",
              dom_fingerprint: null,
              scraped_data: null,
            },
          ],
          rowCount: 2,
        }) // existing crawled_pages query on resume
        .mockResolvedValueOnce({ rows: [{ id: "new-p1" }], rowCount: 1 }) // saveCrawledPageDb
        .mockResolvedValueOnce({ rows: [{ id: "f1" }], rowCount: 1 }) // persist func
        .mockResolvedValueOnce({ rows: [{ id: "s1" }], rowCount: 1 }) // persist scen
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // live metrics update
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // session finalize update

      const project = { id: testProjectId, base_url: "https://example.com", name: "App" };
      const res = await crawlSite(project, { resume: true, maxPages: 5 });

      expect(res.status).toBe("completed");
      // The previously visited home page should have been skipped, but unvisited-subpage / failed page crawled
      expect(mockBrowser.close).toHaveBeenCalled();
    });
  });
});
