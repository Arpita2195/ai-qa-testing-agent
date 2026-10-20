import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectAccess, detectInteractiveAuthNeeds } from "../services/loginDetector";
import { chromium, type Browser } from "@playwright/test";

describe("loginDetector access detection", () => {
  let server: http.Server;
  let baseUrl: string;
  let browser: Browser;
  const oldAllowPrivate = process.env.ALLOW_PRIVATE_TARGETS;

  beforeAll(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = "true";
    browser = await chromium.launch({ headless: true });

    server = http.createServer((req, res) => {
      const path = req.url ?? "/";
      if (path === "/login") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Sign In</title></head>
            <body>
              <h1>Please Sign In</h1>
              <form>
                <input type="text" name="username" placeholder="Username" />
                <input type="password" name="password" placeholder="Password" />
                <button type="submit">Log in</button>
              </form>
            </body>
          </html>
        `);
      } else if (path === "/captcha") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Verify</title></head>
            <body>
              <div class="g-recaptcha" data-sitekey="abc"></div>
              <input type="password" />
            </body>
          </html>
        `);
      } else if (path === "/mfa") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Two-Factor Auth</title></head>
            <body>
              <label>Enter verification code</label>
              <input type="text" name="totp" placeholder="Enter OTP / MFA code" />
            </body>
          </html>
        `);
      } else {
        // Public landing page
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Public Documentation</title></head>
            <body>
              <h1>Welcome to the Public Site</h1>
              <p>This is a safe public site with no authentication required.</p>
              <nav><a href="/docs">Docs</a><a href="/about">About</a></nav>
            </body>
          </html>
        `);
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    process.env.ALLOW_PRIVATE_TARGETS = oldAllowPrivate;
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("marks a page with a password input as login_required", async () => {
    const status = await detectAccess(`${baseUrl}/login`);
    expect(status).toBe("login_required");
  }, 30000);

  it("marks a plain page with real content as public", async () => {
    const status = await detectAccess(`${baseUrl}/`);
    expect(status).toBe("public");
  }, 30000);

  it("detects CAPTCHA on a page requiring manual interaction", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/captcha`);
      const needs = await detectInteractiveAuthNeeds(page);
      expect(needs.needsManual).toBe(true);
      expect(needs.reason).toContain("CAPTCHA");
    } finally {
      await page.close();
    }
  });

  it("detects MFA / 2FA code prompt on a page", async () => {
    const page = await browser.newPage();
    try {
      await page.goto(`${baseUrl}/mfa`);
      const needs = await detectInteractiveAuthNeeds(page);
      expect(needs.needsManual).toBe(true);
      expect(needs.reason).toContain("MFA");
    } finally {
      await page.close();
    }
  });
});
