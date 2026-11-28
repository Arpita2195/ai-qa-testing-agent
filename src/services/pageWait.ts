import type { Page } from "@playwright/test";

/**
 * Waits for modern SPAs (Angular, React, Vue, Next.js, Vite) to bootstrap,
 * fetch initial data, redirect to login/dashboard, and paint visible DOM content
 * before scraping, authentication checking, or screenshotting.
 */
export async function waitForRealContent(page: Page, timeout = 15000): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout });
  } catch {}

  try {
    // Wait for initial network settling (XHR/fetch calls for components/data)
    await page.waitForLoadState("networkidle", { timeout: Math.min(timeout, 5000) });
  } catch {}

  try {
    // Wait until text or interactive elements are rendered into the DOM
    await page.waitForFunction(
      () => {
        const body = document.body;
        if (!body) return false;
        const text = (body.innerText ?? "").trim();
        if (text.length > 0) return true;
        const elements = document.querySelectorAll(
          "input, button, a, img, svg, canvas, table, form, [role='button'], [role='link'], [role='main']",
        );
        return elements.length > 0;
      },
      { timeout: Math.min(timeout, 10000) },
    );
  } catch {}

  // Short pause to ensure paint/animations settle
  try {
    await page.waitForTimeout(400);
  } catch {}
}
