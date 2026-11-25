import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool } from "../config/db";
import { crawlSite } from "../services/crawler";

// Mock DB interactions for clean test isolation
const mockDb = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
}));

const mockClient = vi.hoisted(() => ({
  query: vi.fn().mockResolvedValue({ rows: [{ locked: true }] }),
  release: vi.fn(),
}));

vi.mock("../config/db", () => ({
  pool: {
    query: mockDb.query,
    connect: mockDb.connect,
  },
}));

describe("Autonomous Website Exploration: End-to-End Fixture Integration", () => {
  let server: http.Server;
  let baseUrl: string;
  const oldAllowPrivate = process.env.ALLOW_PRIVATE_TARGETS;

  let formSubmissionCount = 0;
  let logoutCallCount = 0;
  const requestedPaths: string[] = [];

  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = "true";
    mockDb.connect.mockResolvedValue(mockClient);
    mockDb.query.mockResolvedValue({ rows: [{ id: "mock-id-1" }], rowCount: 1 });

    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const pathname = url.pathname;
      const search = url.search;
      requestedPaths.push(`${pathname}${search}`);

      // 1. Mutating Form Submit Tracker
      if (pathname === "/form-submit" && req.method === "POST") {
        formSubmissionCount++;
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<h1>Form submitted!</h1>");
      }

      // 2. Logout Session Destruction Tracker
      if (pathname === "/logout") {
        logoutCallCount++;
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end("<h1>You have been logged out</h1>");
      }

      // 3. Paginated list page 2
      if (pathname === "/inventory" && search === "?page=2") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Inventory Page 2</title></head>
            <body>
              <h1>Inventory - Page 2</h1>
              <table>
                <thead><tr><th>ID</th><th>Name</th></tr></thead>
                <tbody>
                  <tr><td>101</td><td>Gadget 101</td></tr>
                </tbody>
              </table>
              <a href="/dashboard">Back to Dashboard</a>
            </body>
          </html>
        `);
      }

      // 4. Paginated list page 1
      if (pathname === "/inventory") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Inventory Catalog</title></head>
            <body>
              <h1>Inventory - Page 1</h1>
              <table>
                <thead><tr><th>ID</th><th>Name</th><th>Action</th></tr></thead>
                <tbody>
                  <tr><td>42</td><td>Widget Alpha</td><td><a href="/items/42">View Details</a></td></tr>
                </tbody>
              </table>
              <div class="pagination">
                <a href="/inventory?page=2">Next Page &gt;</a>
              </div>
            </body>
          </html>
        `);
      }

      // 5. Item detail view
      if (pathname === "/items/42") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Item 42 Details</title></head>
            <body>
              <h1>Widget Alpha Specifications</h1>
              <p>SKU: WIDG-ALPHA-42 | Status: In Stock</p>
              <button class="btn-delete" style="color:red;">Delete Item</button>
              <a href="/inventory">Back to Inventory</a>
            </body>
          </html>
        `);
      }

      // 6. Form with a submit button
      if (pathname === "/form-page") {
        res.writeHead(200, { "Content-Type": "text/html" });
        return res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Create New Item</title></head>
            <body>
              <h1>Add Product Form</h1>
              <form action="/form-submit" method="POST">
                <label>Name: <input type="text" name="productName" value="Sample" /></label>
                <label>Category: <select name="cat"><option value="1">Electronics</option></select></label>
                <button type="submit" id="btn-submit">Submit Form</button>
              </form>
              <a href="/dashboard">Back</a>
            </body>
          </html>
        `);
      }

      // 7. Dashboard landing with navigation, logout, and external links
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`
        <!DOCTYPE html>
        <html>
          <head><title>App Dashboard</title></head>
          <body>
            <h1>Main App Dashboard</h1>
            <nav>
              <a href="/inventory">Inventory Catalog</a>
              <a href="/form-page">Create New Item</a>
              <a href="/logout">Logout</a>
              <a href="https://untrusted-external-site.com/track">External Tracker</a>
            </nav>
            <p>Welcome to the dashboard metrics summary.</p>
          </body>
        </html>
      `);
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = oldAllowPrivate;
    if (server) {
      if (typeof (server as any).closeAllConnections === "function") {
        (server as any).closeAllConnections();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("crawls the website recursively while strictly enforcing read-only safety guardrails", async () => {
    const project = {
      id: "33333333-3333-4333-a333-333333333333",
      base_url: baseUrl,
      name: "Test E2E App",
    };

    const result = await crawlSite(project, {
      maxDepth: 3,
      maxPages: 10,
      timeoutMs: 30000,
    });

    expect(result.status).toBe("completed");
    expect(result.totalPagesCrawled).toBeGreaterThanOrEqual(4);

    const crawledPaths = result.pages.map((p) => p.path);

    // 1. Discovered intended internal pages
    expect(crawledPaths).toContain("/");
    expect(crawledPaths).toContain("/inventory");
    expect(crawledPaths).toContain("/items/42");
    expect(crawledPaths).toContain("/form-page");

    // 2. Form safety: form was NEVER submitted!
    expect(formSubmissionCount).toBe(0);
    expect(crawledPaths).not.toContain("/form-submit");

    // 3. Session safety: logout endpoint was NEVER followed!
    expect(logoutCallCount).toBe(0);
    expect(crawledPaths).not.toContain("/logout");

    // 4. SSRF & Domain safety: external domain link was NEVER followed!
    expect(crawledPaths.some((p) => p.includes("untrusted-external-site"))).toBe(false);
    expect(requestedPaths.some((p) => p.includes("untrusted-external-site"))).toBe(false);

    // 5. Page types correctly classified
    const inventoryPage = result.pages.find((p) => p.path === "/inventory");
    expect(inventoryPage?.pageType).toBe("list_table");
    expect(inventoryPage?.elementCounts.tables).toBe(1);

    const formPage = result.pages.find((p) => p.path === "/form-page");
    expect(formPage?.pageType).toBe("form_editor");
    expect(formPage?.elementCounts.forms).toBe(1);

    const detailPage = result.pages.find((p) => p.path === "/items/42");
    expect(detailPage?.pageType).toBe("detail_view");
  }, 45000);
});

