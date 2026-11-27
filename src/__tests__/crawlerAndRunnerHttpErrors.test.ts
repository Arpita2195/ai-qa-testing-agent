import { describe, it, expect, vi } from "vitest";
import { isInfrastructureOrCdnPath, isErrorPageContent } from "../services/urlGuard";
import { discoverPageFunctionalities } from "../services/functionalityPlanner";
import { executePageStep } from "../services/runner";
import type { Page } from "@playwright/test";

describe("Infrastructure, CDN, and HTTP Error Guards", () => {
  describe("isInfrastructureOrCdnPath", () => {
    it("identifies Cloudflare CDN internal endpoints", () => {
      expect(isInfrastructureOrCdnPath("/cdn-cgi")).toBe(true);
      expect(isInfrastructureOrCdnPath("/cdn-cgi/content")).toBe(true);
      expect(isInfrastructureOrCdnPath("/cdn-cgi/rum")).toBe(true);
      expect(isInfrastructureOrCdnPath("/cdn-cgi/challenge-platform/h/b/scripts/alpha.js")).toBe(true);
      expect(isInfrastructureOrCdnPath("https://hyperstockcontrolroom-admin-stg.rishvi.app/cdn-cgi/content")).toBe(true);
      expect(isInfrastructureOrCdnPath("https://hyperstockcontrolroom-admin-stg.rishvi.app/cdn-cgi/content?query=1#hash")).toBe(true);
    });

    it("identifies .well-known and telemetry metadata", () => {
      expect(isInfrastructureOrCdnPath("/.well-known")).toBe(true);
      expect(isInfrastructureOrCdnPath("/.well-known/acme-challenge/xyz")).toBe(true);
      expect(isInfrastructureOrCdnPath("/.well-known/openid-configuration")).toBe(true);
      expect(isInfrastructureOrCdnPath("/__webpack_hmr")).toBe(true);
      expect(isInfrastructureOrCdnPath("/_next/webpack-hmr")).toBe(true);
      expect(isInfrastructureOrCdnPath("/hot-update.json")).toBe(true);
    });

    it("identifies static crawler/browser files", () => {
      expect(isInfrastructureOrCdnPath("/favicon.ico")).toBe(true);
      expect(isInfrastructureOrCdnPath("/robots.txt")).toBe(true);
      expect(isInfrastructureOrCdnPath("/sitemap.xml")).toBe(true);
      expect(isInfrastructureOrCdnPath("/manifest.json")).toBe(true);
      expect(isInfrastructureOrCdnPath("/service-worker.js")).toBe(true);
    });

    it("allows genuine application paths", () => {
      expect(isInfrastructureOrCdnPath("/")).toBe(false);
      expect(isInfrastructureOrCdnPath("/dashboard")).toBe(false);
      expect(isInfrastructureOrCdnPath("/inventory")).toBe(false);
      expect(isInfrastructureOrCdnPath("/products/item-123")).toBe(false);
      expect(isInfrastructureOrCdnPath("/users?role=admin")).toBe(false);
      expect(isInfrastructureOrCdnPath("https://app.example.com/checkout")).toBe(false);
    });
  });

  describe("isErrorPageContent", () => {
    it("detects 404, 500, and HTTP error titles and headings", () => {
      expect(isErrorPageContent("404 Not Found")).toBe(true);
      expect(isErrorPageContent("404 - Not Found")).toBe(true);
      expect(isErrorPageContent("Page Not Found", ["404 Error"])).toBe(true);
      expect(isErrorPageContent("Error 404", [])).toBe(true);
      expect(isErrorPageContent("500 Internal Server Error")).toBe(true);
      expect(isErrorPageContent("502 Bad Gateway")).toBe(true);
      expect(isErrorPageContent("504 Gateway Time-out")).toBe(true);
      expect(isErrorPageContent("403 Forbidden")).toBe(true);
      expect(isErrorPageContent("Access Denied")).toBe(true);
    });

    it("detects Cloudflare error page body and title combinations", () => {
      expect(isErrorPageContent("404", ["Not Found"], "cloudflare error")).toBe(true);
    });

    it("does not flag normal application pages", () => {
      expect(isErrorPageContent("StockFlow Inventory Manager", ["Products", "Suppliers"])).toBe(false);
      expect(isErrorPageContent("User Settings", ["Profile", "Security"])).toBe(false);
      expect(isErrorPageContent("Order #404 details", ["Item Summary"])).toBe(false);
    });
  });

  describe("discoverPageFunctionalities exclusion", () => {
    it("returns empty array for CDN infrastructure pages", () => {
      const funcs = discoverPageFunctionalities(
        {
          url: "https://hyperstockcontrolroom-admin-stg.rishvi.app/cdn-cgi/content",
          path: "/cdn-cgi/content",
          title: "Content",
          text: "Some cdn content",
          headings: [],
          elements: [],
        },
        "proj-123",
      );
      expect(funcs).toEqual([]);
    });

    it("returns empty array for 404/500 error pages", () => {
      const funcs = discoverPageFunctionalities(
        {
          url: "https://example.com/missing-route",
          path: "/missing-route",
          title: "404 Not Found",
          text: "The page you are looking for does not exist.",
          headings: ["404 Not Found"],
          elements: [],
        },
        "proj-123",
      );
      expect(funcs).toEqual([]);
    });

    it("discovers functionalities for legitimate pages", () => {
      const funcs = discoverPageFunctionalities(
        {
          url: "https://example.com/products",
          path: "/products",
          title: "Products Catalog",
          text: "Browse our products",
          headings: ["Products"],
          elements: [
            {
              tag: "button",
              text: "Add Product",
              selector: "#add-btn",
            },
          ],
        },
        "proj-123",
      );
      expect(funcs.length).toBeGreaterThan(0);
      expect(funcs[0].pagePath).toBe("/products");
    });
  });

  describe("executePageStep HTTP status validation", () => {
    it("blocks navigation to CDN/infrastructure route in runner", async () => {
      const mockPage = {
        locator: vi.fn().mockReturnValue({
          count: vi.fn().mockResolvedValue(0),
          first: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }),
        }),
        goto: vi.fn(),
      } as unknown as Page;

      await expect(
        executePageStep(mockPage, "https://hyperstockcontrolroom-admin-stg.rishvi.app", "goto /cdn-cgi/content"),
      ).rejects.toThrow(/Navigation to CDN or infrastructure path is not allowed/i);
    });

    it("throws an error when page.goto returns HTTP 404", async () => {
      const mockResponse = {
        status: vi.fn().mockReturnValue(404),
        statusText: vi.fn().mockReturnValue("Not Found"),
      };

      const mockPage = {
        locator: vi.fn().mockReturnValue({
          count: vi.fn().mockResolvedValue(0),
          first: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }),
        }),
        goto: vi.fn().mockResolvedValue(mockResponse),
      } as unknown as Page;

      await expect(
        executePageStep(mockPage, "https://example.com", "goto /non-existent-page"),
      ).rejects.toThrow(/Navigation to "https:\/\/example\.com\/non-existent-page" failed with HTTP 404/i);
    });

    it("throws an error when page.goto returns HTTP 500", async () => {
      const mockResponse = {
        status: vi.fn().mockReturnValue(500),
        statusText: vi.fn().mockReturnValue("Internal Server Error"),
      };

      const mockPage = {
        locator: vi.fn().mockReturnValue({
          count: vi.fn().mockResolvedValue(0),
          first: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }),
        }),
        goto: vi.fn().mockResolvedValue(mockResponse),
      } as unknown as Page;

      await expect(
        executePageStep(mockPage, "https://example.com", "goto /broken-endpoint"),
      ).rejects.toThrow(/Navigation to "https:\/\/example\.com\/broken-endpoint" failed with HTTP 500/i);
    });

    it("succeeds when page.goto returns HTTP 200", async () => {
      const mockResponse = {
        status: vi.fn().mockReturnValue(200),
        statusText: vi.fn().mockReturnValue("OK"),
      };

      const mockPage = {
        locator: vi.fn().mockReturnValue({
          count: vi.fn().mockResolvedValue(0),
          first: vi.fn().mockReturnValue({ isVisible: vi.fn().mockResolvedValue(false) }),
        }),
        goto: vi.fn().mockResolvedValue(mockResponse),
      } as unknown as Page;

      await expect(
        executePageStep(mockPage, "https://example.com", "goto /dashboard"),
      ).resolves.toBeUndefined();
    });
  });
});
