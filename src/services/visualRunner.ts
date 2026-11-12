import { randomUUID } from "node:crypto";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { setupAuthenticatedBrowser } from "./appAuth";
import { assertTargetUrlAllowed, attachUrlGuardToPage } from "./urlGuard";
import { storageService } from "./storage/storageService";

export interface VisualCheck {
  id: string;
  name: string;
  path: string;
  viewport_width: number;
  viewport_height: number;
  threshold: number | string;
}

export interface VisualBaseline {
  id: string;
  image_path: string;
}

export interface VisualRunResult {
  status: "passed" | "failed" | "baseline_created";
  diffRatio: number | null;
  screenshotPath: string | null;
  diffPath: string | null;
  errorMessage: string | null;
  baselinePath: string | null;
  baselineStatus?: "pending";
}

export function createBaselineResult(screenshotPath: string): VisualRunResult {
  return {
    status: "baseline_created",
    diffRatio: null,
    screenshotPath,
    diffPath: null,
    errorMessage: null,
    baselinePath: screenshotPath,
    baselineStatus: "pending",
  };
}

export function comparePngBuffers(
  currentBuffer: Buffer,
  baselineBuffer: Buffer,
  threshold: number,
): { status: "passed" | "failed"; diffRatio: number; diffBuffer?: Buffer; errorMessage?: string } {
  const current = PNG.sync.read(currentBuffer);
  const baseline = PNG.sync.read(baselineBuffer);
  if (current.width !== baseline.width || current.height !== baseline.height) {
    return {
      status: "failed",
      diffRatio: 1,
      errorMessage: `Image size mismatch: current ${current.width}x${current.height}, baseline ${baseline.width}x${baseline.height}`,
    };
  }
  const diff = new PNG({ width: current.width, height: current.height });
  const differingPixels = pixelmatch(
    current.data,
    baseline.data,
    diff.data,
    current.width,
    current.height,
    { threshold: 0.1 },
  );
  const diffRatio = differingPixels / (current.width * current.height);
  return {
    status: diffRatio > threshold ? "failed" : "passed",
    diffRatio,
    diffBuffer: PNG.sync.write(diff),
  };
}

function resolveBaselineKey(imagePath: string): string {
  const filename = path.basename(imagePath);
  if (
    filename !== imagePath &&
    imagePath !== `visual/${filename}` &&
    imagePath !== path.join("artifacts", filename) &&
    imagePath !== `artifacts/${filename}`
  ) {
    throw new Error("Baseline image path must be a visual artifact filename");
  }
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new Error("Baseline image path must be a visual artifact filename");
  }
  return imagePath.startsWith("visual/") ? imagePath : filename;
}

function normalizePageName(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isLoginPageName(name: string): boolean {
  return /^(log in|login|sign in|signin|sign on|authentication)$/.test(normalizePageName(name));
}

interface PageEvidence {
  url: string;
  title: string;
  headings: string[];
  mainText: string;
}

async function readPageEvidence(page: Page): Promise<PageEvidence> {
  const headings = await page.locator("h1, h2, [role='heading']").evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => element.textContent?.trim() ?? "")
      .filter(Boolean),
  );
  const mainTexts = await page.locator("main, [role='main']").evaluateAll((elements) =>
    elements
      .filter((element) => element.getClientRects().length > 0)
      .map((element) => (element as HTMLElement).innerText.trim())
      .filter(Boolean),
  );
  const mainText = mainTexts[0] ?? (await page.locator("body").innerText());
  return { url: page.url(), title: await page.title(), headings, mainText };
}

async function waitForPageEvidence(
  page: Page,
  requestedName: string,
  allowAliases: boolean,
  attempts: number,
): Promise<PageEvidence | null> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const evidence = await readPageEvidence(page);
    if (evidenceMatchesPage(evidence, requestedName, allowAliases)) return evidence;
    if (attempt + 1 < attempts) await page.waitForTimeout(250);
  }
  return null;
}

async function collectNavigationItems(page: Page, selector: string) {
  return page.locator(selector).evaluateAll((elements) =>
    elements.flatMap((element, index) => {
      if (!(element instanceof HTMLElement) || element.getClientRects().length === 0) return [];
      const label = [
        element.innerText,
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
      ]
        .filter(Boolean)
        .join(" ");
      return label.trim()
        ? [{ index, label: label.trim() }]
        : [];
    }),
  );
}

function evidenceMatchesPage(
  evidence: PageEvidence,
  requestedName: string,
  allowAliases = false,
): boolean {
  const target = normalizePageName(requestedName);
  const candidates = [evidence.title, ...evidence.headings, evidence.mainText]
    .map(normalizePageName)
    .filter(Boolean);
  const aliases: Record<string, string[]> = {
    "ai chat": ["chat"],
    dashboard: ["home", "overview"],
    products: ["product", "catalog"],
    "user management": ["users", "user"],
    "bug reports": ["bugs", "bug report"],
    observability: ["monitoring"],
    settings: ["preferences"],
  };
  const acceptedNames = [target, ...(allowAliases ? aliases[target] ?? [] : [])];

  if (candidates.some((candidate) => acceptedNames.some((name) => candidate.includes(name)))) return true;
  if (isLoginPageName(requestedName)) {
    return candidates.some((candidate) => /\b(log in|login|sign in|signin)\b/.test(candidate));
  }
  return false;
}

function urlsMatchTarget(actualUrl: string, targetUrl: URL): boolean {
  const actual = new URL(actualUrl);
  const normalizePath = (pathname: string) => decodeURIComponent(pathname).replace(/\/+$/, "") || "/";
  return actual.host.toLowerCase() === targetUrl.host.toLowerCase() &&
    normalizePath(actual.pathname) === normalizePath(targetUrl.pathname);
}

const navigationSelector =
  "nav a, nav button, aside a, aside button, [role='navigation'] a, [role='navigation'] button, [role='menuitem']";

async function navigateToRequestedPage(
  page: Page,
  baseUrl: string,
  check: VisualCheck,
): Promise<void> {
  await page.locator("body").waitFor({ state: "visible", timeout: 10000 });

  const directPath = check.path !== "/";
  if (directPath) {
    const targetUrl = new URL(check.path, baseUrl);
    await assertTargetUrlAllowed(targetUrl.toString());
    await page.goto(targetUrl.toString(), { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.locator("body").waitFor({ state: "visible", timeout: 10000 });
    const evidence = await waitForPageEvidence(page, check.name, true, 40);
    if (!evidence || !urlsMatchTarget(evidence.url, targetUrl)) {
      throw new Error(
        `Requested page "${check.name}" did not match the requested URL and visible page content after navigating to ${targetUrl.pathname}.`,
      );
    }
    return;
  }

  const target = normalizePageName(check.name);
  let initialEvidence = await readPageEvidence(page);
  if (evidenceMatchesPage(initialEvidence, check.name)) return;

  let items = await collectNavigationItems(page, navigationSelector);
  let candidates = items.filter((item) => normalizePageName(item.label) === target);
  for (let attempt = 0; candidates.length === 0 && attempt < 20; attempt++) {
    await page.waitForTimeout(250);
    initialEvidence = await readPageEvidence(page);
    if (evidenceMatchesPage(initialEvidence, check.name)) return;
    items = await collectNavigationItems(page, navigationSelector);
    candidates = items.filter((item) => normalizePageName(item.label) === target);
  }

  let clickedNavigationItem = false;

  if (candidates.length === 0) {
    const fallbackSelector = "a, button, [role='link'], [role='menuitem']";
    let fallbackItems = await collectNavigationItems(page, fallbackSelector);
    candidates = fallbackItems.filter((item) => normalizePageName(item.label) === target);
    for (let attempt = 0; candidates.length === 0 && attempt < 20; attempt++) {
      await page.waitForTimeout(250);
      initialEvidence = await readPageEvidence(page);
      if (evidenceMatchesPage(initialEvidence, check.name)) return;
      fallbackItems = await collectNavigationItems(page, fallbackSelector);
      candidates = fallbackItems.filter((item) => normalizePageName(item.label) === target);
    }
    if (candidates.length === 1) {
      await page.locator(fallbackSelector)
        .nth(candidates[0].index)
        .click({ timeout: 10000 });
      clickedNavigationItem = true;
    }
  } else if (candidates.length === 1) {
    await page.locator(navigationSelector).nth(candidates[0].index).click({ timeout: 10000 });
    clickedNavigationItem = true;
  }

  if (clickedNavigationItem) {
    if (await waitForPageEvidence(page, check.name, true, 40)) return;
    throw new Error(
      `Navigation completed, but the visible heading or page content did not match "${check.name}".`,
    );
  }

  if (candidates.length > 1) {
    throw new Error(`More than one navigation item matches requested page "${check.name}".`);
  }

  if (isLoginPageName(check.name)) {
    const passwordFields = page.locator("input[type='password']");
    if (await passwordFields.count() > 0 && await passwordFields.first().isVisible()) return;
  }

  if (evidenceMatchesPage(await readPageEvidence(page), check.name, true)) return;

  const availableItems = [...new Set(items.map((item) => item.label))].slice(0, 20);
  const fallbackMessage =
    items.length === 0
      ? "No matching navigation item or matching page content was available."
      : `No navigation item matched. Available navigation items: ${availableItems.join(", ")}.`;
  throw new Error(
    `Requested page "${check.name}" was not found on the current page. ${fallbackMessage}`,
  );
}

export async function runVisualCheck(
  baseUrl: string,
  projectId: string,
  check: VisualCheck,
  baseline: VisualBaseline | null,
): Promise<VisualRunResult> {
  const screenshotName = `visual-${check.id}-${randomUUID()}.png`;
  const screenshotKey = `visual/${screenshotName}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    let page: Page;
    if (isLoginPageName(check.name)) {
      const context = await browser.newContext();
      page = await context.newPage();
      attachUrlGuardToPage(page);
      const loginUrl = check.path === "/" ? baseUrl : new URL(check.path, baseUrl).toString();
      await assertTargetUrlAllowed(loginUrl);
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
    } else {
      ({ page } = await setupAuthenticatedBrowser(browser, projectId, baseUrl));
    }
    await page.setViewportSize({ width: check.viewport_width, height: check.viewport_height });
    await navigateToRequestedPage(page, baseUrl, check);
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
    const mainContent = page.locator("main, [role='main']");
    if (await mainContent.count() > 0) {
      await mainContent.first().waitFor({ state: "visible", timeout: 10000 });
    } else {
      await page.locator("body").waitFor({ state: "visible", timeout: 10000 });
    }
    await page.waitForTimeout(500);
    const screenshotBuffer = await page.screenshot({ fullPage: true, timeout: 15000, animations: "disabled" });
    await storageService.upload(screenshotKey, screenshotBuffer, "image/png");

    if (!baseline) {
      return createBaselineResult(screenshotKey);
    }

    let comparison: ReturnType<typeof comparePngBuffers>;
    try {
      const baselineBuffer = (await storageService.download(resolveBaselineKey(baseline.image_path))).buffer;
      comparison = comparePngBuffers(
        screenshotBuffer,
        baselineBuffer,
        Number(check.threshold),
      );
    } catch (error) {
      return {
        status: "failed",
        diffRatio: null,
        screenshotPath: screenshotKey,
        diffPath: null,
        errorMessage: `Visual comparison failed: ${error instanceof Error ? error.message : String(error)}`,
        baselinePath: null,
      };
    }

    let diffPath: string | null = null;
    if (comparison.diffBuffer) {
      const diffKey = `visual/visual-diff-${check.id}-${randomUUID()}.png`;
      await storageService.upload(diffKey, comparison.diffBuffer, "image/png");
      diffPath = diffKey;
    }

    return {
      status: comparison.status,
      diffRatio: comparison.diffRatio,
      screenshotPath: screenshotKey,
      diffPath,
      errorMessage: comparison.errorMessage ?? null,
      baselinePath: null,
    };
  } catch (error) {
    return {
      status: "failed",
      diffRatio: null,
      screenshotPath: null,
      diffPath: null,
      errorMessage: error instanceof Error ? error.message : String(error),
      baselinePath: null,
    };
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
