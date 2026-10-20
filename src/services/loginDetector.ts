import { chromium } from "@playwright/test";
import { pool } from "../config/db";
import { assertTargetUrlAllowed, attachUrlGuardToPage } from "./urlGuard";

export type AccessStatus = "unknown" | "public" | "login_required" | "ready" | "failed";

const SSO_HOST_PATTERNS = [
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.live.com",
  "okta.com",
  "auth0.com",
  "onelogin.com",
  "pingidentity.com",
  "cognito",
  "keycloak",
];

const LOGIN_PATH_REGEX = /\b(login|signin|sign-in|log-in|auth|sso|session)\b/i;

/**
 * Checks if a given URL host represents an SSO provider.
 */
export function isSsoHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return SSO_HOST_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Checks if the page indicates CAPTCHA, MFA, or external SSO requiring manual intervention.
 */
export async function detectInteractiveAuthNeeds(page: { url: () => string; locator: any; evaluate: any }): Promise<{
  needsManual: boolean;
  reason?: string;
}> {
  try {
    const currentUrl = new URL(page.url());
    if (isSsoHost(currentUrl.hostname)) {
      return { needsManual: true, reason: `SSO authentication provider detected (${currentUrl.hostname})` };
    }
  } catch {}

  const hasCaptcha = await page.evaluate(`(() => {
    const selectors = [
      "iframe[src*='recaptcha']",
      "iframe[src*='hcaptcha']",
      "iframe[src*='turnstile']",
      "iframe[src*='challenges.cloudflare.com']",
      ".g-recaptcha",
      ".h-captcha",
      ".cf-turnstile",
      "[id*='captcha']",
      "[class*='captcha']",
    ];
    return selectors.some((sel) => document.querySelector(sel) !== null);
  })()`);

  if (hasCaptcha) {
    return { needsManual: true, reason: "CAPTCHA challenge detected on the page" };
  }

  const hasMfa = await page.evaluate(`(() => {
    const mfaRegex = /mfa|otp|2fa|authenticator|verification\s*code|security\s*code/i;
    const inputs = Array.from(document.querySelectorAll("input"));
    for (const input of inputs) {
      const matchTarget = (input.name || "") + " " + (input.placeholder || "") + " " + (input.id || "") + " " + (input.getAttribute("autocomplete") || "");
      if (mfaRegex.test(matchTarget)) return true;
    }
    const text = document.body ? document.body.innerText : "";
    return /enter (the )?(verification|security|authenticator|mfa|2fa|one-time) code/i.test(text);
  })()`);

  if (hasMfa) {
    return { needsManual: true, reason: "Multi-factor authentication (MFA/OTP) prompt detected" };
  }

  return { needsManual: false };
}

/**
 * Opens the URL in headless Chromium and checks if login is required.
 */
export async function detectAccess(
  url: string,
  projectId?: string,
): Promise<"public" | "login_required"> {
  await assertTargetUrlAllowed(url);

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    attachUrlGuardToPage(page);

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // Wait for network to settle or fallback
    try {
      await page.waitForLoadState("load", { timeout: 10000 });
      await page.waitForLoadState("networkidle", { timeout: 2000 });
    } catch {
      // networkidle may timeout on polling pages; domcontentloaded/load is fine
    }

    // Wait for non-empty body text without fixed sleep
    try {
      await page.waitForFunction(
        () => document.body && document.body.innerText.trim().length > 0,
        { timeout: 15000 },
      );
    } catch {
      // Proceed with inspection even if page has little text
    }

    const currentUrl = page.url();
    let isLoginRequired = false;

    // 1. Check for password input
    const passwordLocator = page.locator('input[type="password"]');
    const hasPassword = (await passwordLocator.count()) > 0;
    if (hasPassword) {
      for (let i = 0; i < (await passwordLocator.count()); i++) {
        if (await passwordLocator.nth(i).isVisible()) {
          isLoginRequired = true;
          break;
        }
      }
    }

    // 2. Check for redirect to login or SSO
    if (!isLoginRequired) {
      try {
        const parsedCurrent = new URL(currentUrl);
        if (isSsoHost(parsedCurrent.hostname)) {
          isLoginRequired = true;
        } else if (LOGIN_PATH_REGEX.test(parsedCurrent.pathname)) {
          isLoginRequired = true;
        }
      } catch {}
    }

    // 3. Check for login form or sign-in buttons in main content
    if (!isLoginRequired) {
      const hasLoginForm = await page.evaluate(`(() => {
        const forms = Array.from(document.querySelectorAll("form"));
        for (const form of forms) {
          const text = (form.innerText || "").toLowerCase();
          const action = (form.getAttribute("action") || "").toLowerCase();
          if (/login|signin|sign-in|log-in/.test(action)) return true;
          const hasPasswordInput = form.querySelector("input[type='password']") !== null;
          if (hasPasswordInput) return true;
          const hasSubmit = form.querySelector("button[type='submit'], input[type='submit'], button");
          const submitText = hasSubmit ? (hasSubmit.innerText || hasSubmit.value || "").toLowerCase() : "";
          if (hasSubmit && /sign in|log in|login/.test(submitText)) {
            const hasInput = form.querySelector("input") !== null;
            if (hasInput) return true;
          }
        }
        return false;
      })()`);

      if (hasLoginForm) {
        isLoginRequired = true;
      }
    }

    const status: "public" | "login_required" = isLoginRequired ? "login_required" : "public";

    if (projectId) {
      await pool.query(
        `UPDATE projects
         SET access_status = CASE
           WHEN access_status = 'ready' THEN 'ready'
           ELSE $1
         END
         WHERE id = $2`,
        [status, projectId],
      );
    }

    return status;
  } finally {
    await browser.close().catch(() => {});
  }
}
