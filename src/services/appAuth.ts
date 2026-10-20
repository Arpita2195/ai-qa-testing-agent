import type { Browser, BrowserContext, Locator, Page } from "@playwright/test";
import { getProjectAccess } from "./secretStore";
import { assertTargetUrlAllowed, attachUrlGuardToPage } from "./urlGuard";
import { detectInteractiveAuthNeeds } from "./loginDetector";

async function getStableSelector(locator: Locator): Promise<string> {
  return await locator.evaluate((node: Element): string => {
    if (node instanceof HTMLElement && node.id) {
      const idSelector = "#" + CSS.escape(node.id);
      if (document.querySelectorAll(idSelector).length === 1) return idSelector;
    }
    const parts: string[] = [];
    let curr: Element | null = node;
    while (curr && curr !== document.documentElement) {
      const target: Element = curr;
      const tagName = target.tagName.toLowerCase();
      const parent = target.parentElement;
      const siblings = parent
        ? Array.from(parent.children).filter((s) => (s as Element).tagName === target.tagName)
        : [];
      const index = siblings.indexOf(target) + 1;
      parts.unshift(`${tagName}:nth-of-type(${index})`);
      curr = parent;
    }
    return parts.join(" > ");
  });
}

export interface AuthenticatedBrowserSetup {
  context: BrowserContext;
  page: Page;
  isLoggedIn: boolean;
  loginSteps: string[];
  usedSession: boolean;
  credentialsUsed?: { username: string; password?: string };
}

export interface AppLoginResult {
  loginSteps: string[];
  usernameSelector: string;
  passwordSelector: string;
}

/**
 * Discovers the login form inputs and performs login with username and password.
 * Supports one-step (username + password) and two-step (username then password) flows.
 */
export async function performGenericLogin(
  page: Page,
  baseUrl: string,
  credentials: { username: string; password: string },
  useStockflowPlaceholders = false,
): Promise<AppLoginResult> {
  const userPlaceholder = useStockflowPlaceholders ? "{{STOCKFLOW_TEST_EMAIL}}" : "{{APP_USERNAME}}";
  const passPlaceholder = useStockflowPlaceholders ? "{{STOCKFLOW_TEST_PASSWORD}}" : "{{APP_PASSWORD}}";

  // Check for CAPTCHA, MFA or SSO on initial load
  const initialAuthCheck = await detectInteractiveAuthNeeds(page);
  if (initialAuthCheck.needsManual) {
    throw new Error(
      "This login needs manual steps (CAPTCHA, MFA or SSO). Use 'Log in manually' on the project page.",
    );
  }

  const steps: string[] = [];

  // Find password locator
  let passwordLocator = page.locator('input[type="password"]');
  let hasVisiblePassword = (await passwordLocator.count()) > 0 && (await passwordLocator.first().isVisible());

  // Find username / email locator
  const userCandidates = [
    'input[type="email"]',
    'input[name*="user" i]',
    'input[name*="email" i]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[autocomplete*="username" i]',
    'input[autocomplete*="email" i]',
    'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"]):not([type="radio"])',
  ];

  let usernameLocator = page.locator(userCandidates.join(", ")).first();
  const hasVisibleUser = (await usernameLocator.count()) > 0 && (await usernameLocator.isVisible());

  if (!hasVisibleUser && !hasVisiblePassword) {
    throw new Error("Could not find login fields on page");
  }

  // Get stable selector for username
  const usernameSelector = await getStableSelector(usernameLocator);

  // Two-step login support: If username is visible but password is NOT visible
  if (hasVisibleUser && !hasVisiblePassword) {
    await usernameLocator.fill(credentials.username);
    steps.push(`fill ${usernameSelector} | ${userPlaceholder}`);

    // Click Next/Continue/Submit
    const nextBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Next"), button:has-text("Continue"), button').first();
    const nextSelector = await getStableSelector(nextBtn);

    await nextBtn.click();
    steps.push(`click ${nextSelector}`);

    // Wait for password field to appear
    passwordLocator = page.locator('input[type="password"]');
    await passwordLocator.first().waitFor({ state: "visible", timeout: 15000 });
    hasVisiblePassword = true;
  } else if (hasVisibleUser) {
    await usernameLocator.fill(credentials.username);
    steps.push(`fill ${usernameSelector} | ${userPlaceholder}`);
  }

  // Fill password
  const passwordSelector = await getStableSelector(passwordLocator.first());

  await passwordLocator.first().fill(credentials.password);
  steps.push(`fill ${passwordSelector} | ${passPlaceholder}`);

  // Find submit button
  const submitBtn = page.locator('button[type="submit"], input[type="submit"], form button, button').first();
  const submitSelector = await getStableSelector(submitBtn);

  await submitBtn.click();
  steps.push(`click ${submitSelector}`);

  // Wait for login to complete (password field hides)
  try {
    await passwordLocator.first().waitFor({ state: "hidden", timeout: 20000 });
  } catch {
    // If password didn't hide, verify if CAPTCHA or MFA was triggered
    const postCheck = await detectInteractiveAuthNeeds(page);
    if (postCheck.needsManual) {
      throw new Error(
        "This login needs manual steps (CAPTCHA, MFA or SSO). Use 'Log in manually' on the project page.",
      );
    }
    throw new Error("Login failed: password field did not hide after submission.");
  }

  steps.push(`expect not visible ${passwordSelector}`);

  // Check post-login auth prompts (CAPTCHA / MFA / SSO)
  const postAuthCheck = await detectInteractiveAuthNeeds(page);
  if (postAuthCheck.needsManual) {
    throw new Error(
      "This login needs manual steps (CAPTCHA, MFA or SSO). Use 'Log in manually' on the project page.",
    );
  }

  // Ensure DOM settled
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
  } catch {}

  return {
    loginSteps: steps,
    usernameSelector,
    passwordSelector,
  };
}

/**
 * Prepares an authenticated or public browser context & page for discovery or test running.
 */
export async function setupAuthenticatedBrowser(
  browser: Browser,
  projectId: string,
  baseUrl: string,
): Promise<AuthenticatedBrowserSetup> {
  await assertTargetUrlAllowed(baseUrl);

  const access = await getProjectAccess(projectId);
  const isStockflow = baseUrl.includes("stockflow") || (process.env.STOCKFLOW_BASE_URL && baseUrl.includes(process.env.STOCKFLOW_BASE_URL));

  // Case 1: Try stored session first
  if (access?.session) {
    let context: BrowserContext;
    try {
      context = await browser.newContext({ storageState: access.session });
    } catch {
      context = await browser.newContext();
    }

    const page = await context.newPage();
    attachUrlGuardToPage(page);

    try {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

      // Verify session is still valid (password input is not visible and not on login page)
      const passwordLocator = page.locator('input[type="password"]');
      const hasPassword = (await passwordLocator.count()) > 0 && (await passwordLocator.first().isVisible());
      const onLoginPath = /\b(login|signin|sign-in|auth|sso)\b/i.test(new URL(page.url()).pathname);

      if (!hasPassword && !onLoginPath) {
        return {
          context,
          page,
          isLoggedIn: true,
          loginSteps: [], // Started logged in; generated steps start with goto
          usedSession: true,
        };
      }
    } catch (navErr) {
      // Navigation failed or session invalid; fall through to credentials
    }

    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }

  // Case 2: Stored credentials or StockFlow env credentials fallback
  const username = access?.username || (isStockflow ? process.env.STOCKFLOW_TEST_EMAIL : undefined);
  const password = access?.password || (isStockflow ? process.env.STOCKFLOW_TEST_PASSWORD : undefined);

  const context = await browser.newContext();
  const page = await context.newPage();
  attachUrlGuardToPage(page);

  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30000 });

  const passwordLocator = page.locator('input[type="password"]');
  const hasPasswordInput = (await passwordLocator.count()) > 0 && (await passwordLocator.first().isVisible());

  if (hasPasswordInput) {
    if (!username || !password) {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      throw new Error(
        "Session expired or login needed. Add test credentials or log in again on the project page.",
      );
    }

    const loginResult = await performGenericLogin(
      page,
      baseUrl,
      { username, password },
      Boolean(isStockflow),
    );

    return {
      context,
      page,
      isLoggedIn: true,
      loginSteps: loginResult.loginSteps,
      usedSession: false,
      credentialsUsed: { username, password },
    };
  }

  // Case 3: Public page (no login required)
  return {
    context,
    page,
    isLoggedIn: false,
    loginSteps: [],
    usedSession: false,
  };
}
