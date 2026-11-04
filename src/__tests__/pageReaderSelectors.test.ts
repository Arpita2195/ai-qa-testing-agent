import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "@playwright/test";

process.env.DATABASE_URL = "postgresql://localhost/test";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.AI_MODEL = "test-model";
process.env.PLATFORM_API_KEY = "test-platform-api-key-12345";

describe("page selectors", () => {
  let browser: Browser;
  let executePageStep: typeof import("../services/runner").executePageStep;
  let extractScrapedPage: typeof import("../services/pageReader").extractScrapedPage;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    ({ executePageStep } = await import("../services/runner"));
    ({ extractScrapedPage } = await import("../services/pageReader"));
  });

  afterAll(async () => {
    await browser.close();
  }, 30000);

  it("uses stable element attributes instead of positional paths when scraping", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <main>
        <form>
          <input type="email" name="email" placeholder="Email address">
          <input type="password" name="password" placeholder="Password">
          <button type="submit">Sign in</button>
        </form>
        <a href="/register">Create account</a>
      </main>
    `);

    const scraped = await extractScrapedPage(page);
    expect(scraped.elements.filter((element) => element.tag !== "form").map((element) => element.selector)).toEqual([
      'input[name="email"]',
      'input[name="password"]',
      'button[type="submit"]',
      'a[href="/register"]',
    ]);
    await page.close();
  });

  it("recovers a stale positional path only when its shortened path is unique", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <div id="app">
        <main>
          <form><input type="email" name="email"></form>
        </main>
      </div>
    `);

    await executePageStep(
      page,
      "https://example.test",
      "fill body:nth-of-type(1) > div:nth-of-type(1) > main:nth-of-type(1) > div:nth-of-type(1) > section:nth-of-type(1) > form:nth-of-type(1) > input:nth-of-type(1) | qa@example.test",
    );
    expect(await page.locator('input[name="email"]').inputValue()).toBe("qa@example.test");
    await page.close();
  });

  it("recovers a stale form selector only when one visible control matches its semantic hint", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <label for="customerId">Customer</label>
      <select id="customerId">
        <option value="">Choose customer</option>
        <option value="customer_id_001">QA customer</option>
      </select>
    `);

    await executePageStep(page, "https://example.test", "select #customer-select | customer_id_001");
    expect(await page.locator("#customerId").inputValue()).toBe("customer_id_001");
    await page.close();
  });

  it("does not guess when a stale form selector has multiple semantic matches", async () => {
    const page = await browser.newPage();
    await page.setContent(`
      <select id="customer-primary"><option value="one">One</option></select>
      <select id="customer-secondary"><option value="two">Two</option></select>
    `);

    await expect(
      executePageStep(page, "https://example.test", "select #customer-select | customer_id_001"),
    ).rejects.toThrow('No element matched selector "#customer-select"');
    await page.close();
  });
});
