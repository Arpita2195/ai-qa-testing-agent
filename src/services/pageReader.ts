import { chromium, type Page } from "@playwright/test";
import { env } from "../config/env";
import { pool } from "../config/db";
import { setupAuthenticatedBrowser } from "./appAuth";
import { assertTargetUrlAllowed, attachUrlGuardToPage, validateTargetUrl } from "./urlGuard";
import { executePageStep, resolveStepPlaceholders, saveRedactedScreenshot } from "./runner";

export interface PageElement {
  tag: string;
  text: string;
  selector: string;
  type?: string;
  href?: string;
  name?: string;
  placeholder?: string;
  value?: string;
  required?: boolean;
  options?: Array<{ text: string; value: string }>;
}

export interface PageData {
  title: string;
  url: string;
  text: string;
  elements: PageElement[];
}

export interface ScrapedPage {
  url: string;
  path: string;
  title: string;
  headings: string[];
  text: string;
  elements: PageElement[];
}

export interface SiteData {
  baseUrl: string;
  isLoggedIn: boolean;
  loginSteps: string[];
  pages: ScrapedPage[];
}

export interface ReadSiteOptions {
  path?: string;
  maxPages?: number;
}

export interface LoginElements {
  email: PageElement;
  password: PageElement;
  submit: PageElement;
}

export function isStockFlowUrl(url: string): boolean {
  if (!env.STOCKFLOW_BASE_URL) return false;
  try {
    return new URL(url).origin === new URL(env.STOCKFLOW_BASE_URL).origin;
  } catch {
    return url.trim().toLowerCase() === env.STOCKFLOW_BASE_URL.trim().toLowerCase();
  }
}

export function findLoginElements(elements: PageElement[]): LoginElements | null {
  const password = elements.find((el) => el.tag === "input" && el.type === "password");
  if (!password) return null;

  const email = elements.find(
    (el) =>
      el.tag === "input" &&
      el.type !== "password" &&
      /email|user|login/.test(`${el.type ?? ""} ${el.text} ${el.name ?? ""} ${el.placeholder ?? ""}`.toLowerCase()),
  );
  if (!email) return null;

  const submit = elements.find(
    (el) =>
      ["button", "input"].includes(el.tag) &&
      (el.type === "submit" || /sign in|log in|login|continue/i.test(`${el.text} ${el.name ?? ""} ${el.placeholder ?? ""}`)),
  );
  if (!submit) return null;

  return { email, password, submit };
}

async function waitForRealContent(page: Page, timeout = 30000): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout });
  try {
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 5000) });
  } catch {
    // networkidle may time out if background polling occurs; domcontentloaded is sufficient
  }
  await page.waitForFunction(
    () => (document.body?.innerText ?? "").trim().length > 0,
    { timeout: Math.min(timeout, 15000) },
  );
}

export async function extractScrapedPage(page: Page): Promise<ScrapedPage> {
  return await page.evaluate<ScrapedPage>(`(() => {
    function visible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function selectorFor(element) {
      if (element instanceof HTMLElement && element.id) {
        const idSelector = "#" + CSS.escape(element.id);
        if (document.querySelectorAll(idSelector).length === 1) {
          return idSelector;
        }
      }

      const parts = [];
      let current = element;
      while (current && current !== document.documentElement) {
        const tagName = current.tagName.toLowerCase();
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter(
              (sibling) => sibling.tagName === current.tagName,
            )
          : [];
        const index = siblings.indexOf(current) + 1;
        parts.unshift(tagName + ":nth-of-type(" + index + ")");
        current = current.parentElement;
      }

      return parts.join(" > ");
    }

    const headings = Array.from(
      document.querySelectorAll("h1, h2, h3, h4, h5, h6"),
    )
      .filter(visible)
      .map((h) => h.textContent?.trim() ?? "")
      .filter(Boolean);

    const elements = Array.from(
      document.querySelectorAll("a, button, input, form, select, textarea"),
    )
      .filter(visible)
      .slice(0, 40)
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        const text =
          element.textContent?.trim() ||
          element.getAttribute("placeholder") ||
          element.getAttribute("name") ||
          "";
        const options = element instanceof HTMLSelectElement
          ? Array.from(element.options).map((option) => ({
              text: option.textContent?.trim() ?? "",
              value: option.value,
            }))
          : undefined;
        return {
          tag,
          text,
          selector: selectorFor(element),
          type: element.getAttribute("type") ?? undefined,
          href: element instanceof HTMLAnchorElement ? element.href : undefined,
          name: element.getAttribute("name") ?? undefined,
          placeholder: element.getAttribute("placeholder") ?? undefined,
          value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
            ? element.value
            : undefined,
          required: element instanceof HTMLInputElement ||
            element instanceof HTMLSelectElement ||
            element instanceof HTMLTextAreaElement
            ? element.required
            : undefined,
          options,
        };
      });

    const parsed = new URL(window.location.href);

    return {
      url: window.location.href,
      path: parsed.pathname,
      title: document.title,
      headings,
      text: (document.body?.innerText ?? "").trim().slice(0, 4000),
      elements,
    };
  })()`);
}

export async function performStockFlowLogin(
  page: Page,
  baseUrl: string,
): Promise<{ loginSteps: string[]; authenticatedSteps: string[] }> {
  if (!isStockFlowUrl(baseUrl) || !env.STOCKFLOW_TEST_EMAIL || !env.STOCKFLOW_TEST_PASSWORD) {
    throw new Error(
      "Login required but test credentials are missing or login failed. Check the test credentials in .env",
    );
  }

  const initialData = await extractScrapedPage(page);
  const loginElements = findLoginElements(initialData.elements);
  if (!loginElements) {
    throw new Error(
      "Login required but test credentials are missing or login failed. Check the test credentials in .env",
    );
  }

  const { email, password, submit } = loginElements;
  const loginSteps = [
    `fill ${email.selector} | {{STOCKFLOW_TEST_EMAIL}}`,
    `fill ${password.selector} | {{STOCKFLOW_TEST_PASSWORD}}`,
    `click ${submit.selector}`,
  ];
  const authenticatedSteps = [...loginSteps, `expect not visible ${password.selector}`];

  try {
    await page.locator(email.selector).fill(env.STOCKFLOW_TEST_EMAIL);
    await page.locator(password.selector).fill(env.STOCKFLOW_TEST_PASSWORD);
    await page.locator(submit.selector).click();

    await page.locator(password.selector).waitFor({ state: "hidden", timeout: 30000 });

    const visiblePasswordCount = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input[type="password"]')).filter((el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      }).length;
    });
    if (visiblePasswordCount > 0) {
      throw new Error("Password input still visible");
    }

    await waitForRealContent(page, 15000);
  } catch {
    throw new Error(
      "Login required but test credentials are missing or login failed. Check the test credentials in .env",
    );
  }

  return { loginSteps, authenticatedSteps };
}

async function findNavigationLinks(page: Page, allowedOrigin: string): Promise<string[]> {
  return await page.evaluate((origin) => {
    const selectors = [
      "aside a[href]",
      "header a[href]",
      "nav a[href]",
      '[role="navigation"] a[href]',
      '[aria-label*="menu" i] a[href]',
      '[aria-label*="navigation" i] a[href]',
      ".sidebar a[href]",
      ".menu a[href]",
      ".nav a[href]",
      ".navbar a[href]",
    ];

    const found = new Set<HTMLAnchorElement>();
    for (const selector of selectors) {
      document.querySelectorAll<HTMLAnchorElement>(selector).forEach((el) => found.add(el));
    }

    if (found.size === 0) {
      document.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((el) => found.add(el));
    }

    const destructiveKeywords = [
      "delete",
      "remove",
      "pay",
      "purchase",
      "logout",
      "log-out",
      "signout",
      "sign-out",
      "confirm",
      "submit",
    ];

    const results: string[] = [];
    for (const a of found) {
      const href = a.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:")) {
        continue;
      }

      try {
        const resolved = new URL(href, window.location.href);
        if (resolved.origin !== origin) continue;

        const normalizedHref = resolved.origin + resolved.pathname;
        const text = (a.textContent ?? "").toLowerCase();
        const fullCheck = `${text} ${href.toLowerCase()}`;

        const isDestructive =
          destructiveKeywords.some((word) => fullCheck.includes(word)) ||
          /\b(?:place|make|confirm|submit)\s*order\b/i.test(text);
        if (isDestructive) continue;

        if (!results.includes(normalizedHref)) {
          results.push(normalizedHref);
        }
      } catch {
        // invalid URL
      }
    }
    return results;
  }, allowedOrigin);
}

export async function readSite(
  projectOrUrl: string | { id: string; base_url: string; name?: string },
  options: ReadSiteOptions = {},
): Promise<SiteData> {
  const browser = await chromium.launch({ headless: true });
  const startTime = Date.now();
  const TOTAL_TIMEOUT_MS = 120000;

  try {
    let baseUrl: string;
    let projectId: string | undefined;

    if (typeof projectOrUrl === "string") {
      baseUrl = projectOrUrl;
      try {
        const found = await pool.query<{ id: string }>(
          "SELECT id FROM projects WHERE base_url = $1 OR base_url = $2 LIMIT 1",
          [baseUrl, baseUrl.replace(/\/+$/, "")],
        );
        if (found.rowCount && found.rows[0]) {
          projectId = found.rows[0].id;
        }
      } catch {}
    } else {
      baseUrl = projectOrUrl.base_url;
      projectId = projectOrUrl.id;
    }

    await assertTargetUrlAllowed(baseUrl);

    let setupResult;
    if (projectId) {
      setupResult = await setupAuthenticatedBrowser(browser, projectId, baseUrl);
    } else {
      const context = await browser.newContext();
      const page = await context.newPage();
      attachUrlGuardToPage(page);
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
      await waitForRealContent(page, 30000);

      const passwordLocator = page.locator('input[type="password"]');
      const hasPasswordInput =
        (await passwordLocator.count()) > 0 && (await passwordLocator.first().isVisible());

      let isLoggedIn = false;
      let loginSteps: string[] = [];

      if (hasPasswordInput) {
        const credentialsAvailable =
          isStockFlowUrl(baseUrl) &&
          Boolean(env.STOCKFLOW_TEST_EMAIL) &&
          Boolean(env.STOCKFLOW_TEST_PASSWORD);

        if (!credentialsAvailable) {
          throw new Error(
            "This app needs a login. Add test credentials or log in manually on the project page.",
          );
        }

        const loginResult = await performStockFlowLogin(page, baseUrl);
        isLoggedIn = true;
        loginSteps = loginResult.authenticatedSteps;
      }

      setupResult = { context, page, isLoggedIn, loginSteps, usedSession: false };
    }

    const { page, isLoggedIn, loginSteps } = setupResult;
    page.setDefaultTimeout(30000);

    if (options.path && options.path.trim()) {
      const targetUrl = new URL(options.path, baseUrl).toString();
      await assertTargetUrlAllowed(targetUrl);
      if (page.url() !== targetUrl) {
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await waitForRealContent(page, 30000);
      }
      const scraped = await extractScrapedPage(page);
      return {
        baseUrl,
        isLoggedIn,
        loginSteps,
        pages: [scraped],
      };
    }

    const pages: ScrapedPage[] = [];
    const visitedUrls = new Set<string>();

    const landingPage = await extractScrapedPage(page);
    pages.push(landingPage);
    const normalizedLanding = landingPage.url.split("#")[0].split("?")[0];
    visitedUrls.add(normalizedLanding);

    const origin = new URL(page.url()).origin;
    const navLinks = await findNavigationLinks(page, origin);

    for (const linkUrl of navLinks) {
      if (pages.length >= 8) break;
      if (Date.now() - startTime >= TOTAL_TIMEOUT_MS) break;

      const normalized = linkUrl.split("#")[0].split("?")[0];
      if (visitedUrls.has(normalized)) continue;
      visitedUrls.add(normalized);

      const guard = await validateTargetUrl(linkUrl);
      if (!guard.valid) continue;

      try {
        await page.goto(linkUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await waitForRealContent(page, 30000);
        const subPage = await extractScrapedPage(page);
        pages.push(subPage);
      } catch (err) {
        console.warn(`Failed to read link page ${linkUrl}:`, err instanceof Error ? err.message : String(err));
      }
    }

    return {
      baseUrl,
      isLoggedIn,
      loginSteps,
      pages,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function readPage(url: string, steps: string[] = []): Promise<PageData> {
  await assertTargetUrlAllowed(url);
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    attachUrlGuardToPage(page);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    for (const step of steps) {
      await executePageStep(page, url, resolveStepPlaceholders(step));
    }

    return await page.evaluate<PageData>(`(() => {
      function visible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      }

      function selectorFor(element) {
        if (element instanceof HTMLElement && element.id) {
          const idSelector = "#" + CSS.escape(element.id);
          if (document.querySelectorAll(idSelector).length === 1) {
            return idSelector;
          }
        }

        const parts = [];
        let current = element;
        while (current && current !== document.documentElement) {
          const tagName = current.tagName.toLowerCase();
          const siblings = current.parentElement
            ? Array.from(current.parentElement.children).filter(
                (sibling) => sibling.tagName === current.tagName,
              )
            : [];
          const index = siblings.indexOf(current) + 1;
          parts.unshift(tagName + ":nth-of-type(" + index + ")");
          current = current.parentElement;
        }

        return parts.join(" > ");
      }

      const elements = Array.from(
        document.querySelectorAll("a, button, input, form, select, textarea"),
      )
        .filter(visible)
        .slice(0, 40)
        .map((element) => {
          const tag = element.tagName.toLowerCase();
          const text =
            element.textContent?.trim() ||
            element.getAttribute("placeholder") ||
            element.getAttribute("name") ||
            "";
          const options = element instanceof HTMLSelectElement
            ? Array.from(element.options).map((option) => ({
                text: option.textContent?.trim() ?? "",
                value: option.value,
              }))
            : undefined;
          return {
            tag,
            text,
            selector: selectorFor(element),
            type: element.getAttribute("type") ?? undefined,
            href: element instanceof HTMLAnchorElement ? element.href : undefined,
            name: element.getAttribute("name") ?? undefined,
            placeholder: element.getAttribute("placeholder") ?? undefined,
            value: element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
              ? element.value
              : undefined,
            required: element instanceof HTMLInputElement ||
              element instanceof HTMLSelectElement ||
              element instanceof HTMLTextAreaElement
              ? element.required
              : undefined,
            options,
          };
        });

      return {
        title: document.title,
        url: window.location.href,
        text: (document.body?.innerText ?? "").trim().slice(0, 4000),
        elements,
      };
    })()`);
  } finally {
    await browser.close().catch(() => {});
  }
}

export async function savePageScreenshot(url: string): Promise<string> {
  await assertTargetUrlAllowed(url);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    attachUrlGuardToPage(page);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return await saveRedactedScreenshot(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

