import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";

export interface TestCaseRunResult {
  status: "passed" | "failed";
  errorMessage?: string;
  durationMs: number;
  screenshotPath: string | null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function executeStep(page: Page, baseUrl: string, step: string): Promise<void> {
  if (step.startsWith("goto ")) {
    const route = step.slice("goto ".length).trim();
    if (!route) {
      throw new Error('Invalid step: "goto" requires a path');
    }

    const url = `${baseUrl.replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
    await page.goto(url);
    return;
  }

  if (step.startsWith("click ")) {
    const selector = step.slice("click ".length).trim();
    if (!selector) {
      throw new Error('Invalid step: "click" requires a CSS selector');
    }

    await page.locator(selector).click();
    return;
  }

  if (step.startsWith("fill ")) {
    const input = step.slice("fill ".length);
    const separator = input.indexOf("|");
    if (separator === -1) {
      throw new Error('Invalid step: expected "fill <css selector> | <value>"');
    }

    const selector = input.slice(0, separator).trim();
    const value = input.slice(separator + 1).trim();
    if (!selector) {
      throw new Error('Invalid step: "fill" requires a CSS selector');
    }

    await page.locator(selector).fill(value);
    return;
  }

  if (step.startsWith("expect text ")) {
    const text = step.slice("expect text ".length).trim();
    if (!text) {
      throw new Error('Invalid step: "expect text" requires text to find');
    }

    await page.getByText(text).first().waitFor({ state: "visible" });
    return;
  }

  throw new Error(`Unknown test step: "${step}"`);
}

export async function runTestCase(
  baseUrl: string,
  steps: string[],
): Promise<TestCaseRunResult> {
  const startedAt = Date.now();
  const browser = await chromium.launch({ headless: true });
  let page: Page | undefined;

  try {
    page = await browser.newPage();

    for (const step of steps) {
      try {
        await executeStep(page, baseUrl, step);
      } catch (error) {
        const errorMessage = getErrorMessage(error);
        const timestamp = `${Date.now()}-${crypto.randomUUID()}`;
        const artifactsDirectory = path.resolve(__dirname, "../../artifacts");
        const screenshotPath = path.join(artifactsDirectory, `${timestamp}.png`);
        let savedScreenshotPath: string | null = null;

        try {
          await mkdir(artifactsDirectory, { recursive: true });
          await page.screenshot({ path: screenshotPath });
          savedScreenshotPath = path.join("artifacts", `${timestamp}.png`);
        } catch (screenshotError) {
          return {
            status: "failed",
            errorMessage: `${errorMessage}; screenshot could not be saved: ${getErrorMessage(screenshotError)}`,
            durationMs: Date.now() - startedAt,
            screenshotPath: null,
          };
        }

        return {
          status: "failed",
          errorMessage,
          durationMs: Date.now() - startedAt,
          screenshotPath: savedScreenshotPath,
        };
      }
    }

    return {
      status: "passed",
      durationMs: Date.now() - startedAt,
      screenshotPath: null,
    };
  } finally {
    await browser.close();
  }
}
