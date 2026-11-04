import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Page } from "@playwright/test";
import { env } from "../config/env";
import { performGenericLogin } from "./appAuth";
import { getProjectAccess } from "./secretStore";
import { assertTargetUrlAllowed, attachUrlGuardToPage } from "./urlGuard";

export type WebResultStatus = "passed" | "failed" | "skipped" | "inconclusive";

export interface FailedRequestEvidence {
  method: string;
  url: string;
  failure: string;
}

export interface HttpErrorEvidence {
  method: string;
  url: string;
  status: number;
}

export interface WebEvidence {
  status: WebResultStatus;
  durationMs: number;
  failureStep: string | null;
  failureStepIndex: number | null;
  errorMessage: string | null;
  browserErrors: string[];
  failedRequests: FailedRequestEvidence[];
  httpErrors: HttpErrorEvidence[];
  finalUrl: string;
  finalTitle: string;
  screenshotPath: string | null;
  tracePath: string | null;
  traceNote: string | null;
  evidencePath: string | null;
}

export interface TestCaseRunResult {
  status: WebResultStatus;
  errorMessage?: string;
  durationMs: number;
  screenshotPath: string | null;
  tracePath?: string | null;
  evidence: WebEvidence;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AppCredentials {
  email?: string;
  password?: string;
  username?: string;
}

export type StockFlowCredentials = AppCredentials;

function getStockFlowCredentialsForTarget(baseUrl: string): AppCredentials | undefined {
  if (!env.STOCKFLOW_TEST_EMAIL || !env.STOCKFLOW_TEST_PASSWORD) {
    return undefined;
  }

  try {
    if (new URL(baseUrl).origin !== new URL(env.STOCKFLOW_BASE_URL).origin) {
      return undefined;
    }
  } catch {
    return undefined;
  }

  return {
    email: env.STOCKFLOW_TEST_EMAIL,
    username: env.STOCKFLOW_TEST_EMAIL,
    password: env.STOCKFLOW_TEST_PASSWORD,
  };
}

export function resolveStepPlaceholders(
  step: string,
  credentials?: AppCredentials,
): string {
  let stockflowEmail: string | undefined;
  let stockflowPassword: string | undefined;

  if (credentials !== undefined) {
    stockflowEmail = credentials.email;
    stockflowPassword = credentials.password;
  } else {
    stockflowEmail = env.STOCKFLOW_TEST_EMAIL;
    stockflowPassword = env.STOCKFLOW_TEST_PASSWORD;
  }

  if (!stockflowEmail && credentials?.username) {
    stockflowEmail = credentials.username;
  }

  const appUsername = credentials?.username || credentials?.email || env.STOCKFLOW_TEST_EMAIL;
  const appPassword = credentials?.password || env.STOCKFLOW_TEST_PASSWORD;

  const replacements: Array<[string, string | undefined, string]> = [
    ["{{STOCKFLOW_TEST_EMAIL}}", stockflowEmail, "Missing STOCKFLOW_TEST_EMAIL or STOCKFLOW_TEST_PASSWORD in .env"],
    ["{{STOCKFLOW_TEST_PASSWORD}}", stockflowPassword, "Missing STOCKFLOW_TEST_EMAIL or STOCKFLOW_TEST_PASSWORD in .env"],
    ["{{APP_USERNAME}}", appUsername, "Missing APP_USERNAME or APP_PASSWORD in project credentials"],
    ["{{APP_PASSWORD}}", appPassword, "Missing APP_USERNAME or APP_PASSWORD in project credentials"],
  ];
  let result = step;
  for (const [placeholder, value, errMsg] of replacements) {
    if (result.includes(placeholder)) {
      if (!value) {
        throw new Error(errMsg);
      }
      result = result.split(placeholder).join(value);
    }
  }
  return result;
}

export function redactSecrets(
  message: string,
  credentials: AppCredentials = {
    email: env.STOCKFLOW_TEST_EMAIL,
    password: env.STOCKFLOW_TEST_PASSWORD,
  },
): string {
  let safeMessage = message;
  const secrets = [
    credentials.email,
    credentials.password,
    credentials.username,
    env.STOCKFLOW_TEST_EMAIL,
    env.STOCKFLOW_TEST_PASSWORD,
    process.env.ENCRYPTION_KEY,
    env.PLATFORM_API_KEY,
    env.GEMINI_API_KEY,
  ].filter(Boolean) as string[];

  for (const value of secrets) {
    for (const candidate of [value, encodeURIComponent(value)]) {
      safeMessage = safeMessage.split(candidate).join("[hidden]");
    }
  }
  return safeMessage;
}

function safeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.search = "";
    url.username = "";
    url.password = "";
    return redactSecrets(url.toString());
  } catch {
    return redactSecrets(rawUrl.split("?")[0] ?? "");
  }
}

export function classifyWebStatus(
  errorMessage: string | null,
  failedStep: string | null,
  failedStepIndex: number | null,
  browserLaunchFailed = false,
): WebResultStatus {
  if (!errorMessage) return "passed";
  if (browserLaunchFailed) return "inconclusive";
  const normalized = errorMessage.toLowerCase();
  if (normalized.includes("session expired or login needed")) {
    return "inconclusive";
  }
  const networkFailure =
    /net::err_|err_name_not_resolved|name or service not known|enotfound|econnrefused|econnreset|socket hang up|network is unreachable|failed to connect/.test(normalized);
  if (networkFailure) return "inconclusive";
  const firstNavigationTimeout =
    failedStepIndex === 0 &&
    failedStep?.startsWith("goto ") &&
    /timeout|timed out/.test(normalized);
  if (firstNavigationTimeout) return "inconclusive";
  return "failed";
}

export function classifyRunStatus(statuses: string[]): WebResultStatus {
  if (!statuses || statuses.length === 0) return "inconclusive";
  if (statuses.some((status) => status === "failed")) return "failed";
  if (statuses.some((status) => status === "inconclusive")) return "inconclusive";
  if (statuses.every((status) => status === "skipped")) return "skipped";
  if (
    statuses.some((status) => status === "passed") &&
    statuses.every((status) => status === "passed" || status === "skipped")
  ) {
    return "passed";
  }
  return "inconclusive";
}

function isCredentialTest(steps: string[], credentials?: AppCredentials): boolean {
  const secrets = [
    env.STOCKFLOW_TEST_EMAIL,
    env.STOCKFLOW_TEST_PASSWORD,
    credentials?.email,
    credentials?.password,
    credentials?.username,
  ].filter(Boolean) as string[];

  return steps.some((step) =>
    step.includes("{{STOCKFLOW_TEST_EMAIL}}") ||
    step.includes("{{STOCKFLOW_TEST_PASSWORD}}") ||
    step.includes("{{APP_USERNAME}}") ||
    step.includes("{{APP_PASSWORD}}") ||
    secrets.some((secret) => step.includes(secret)),
  );
}

export async function saveRedactedScreenshot(
  page: Page,
  destination = path.resolve(
    __dirname,
    "../../artifacts",
    `${Date.now()}-${crypto.randomUUID()}.png`,
  ),
): Promise<string> {
  await mkdir(path.dirname(destination), { recursive: true });
  const secrets = JSON.stringify(
    [env.STOCKFLOW_TEST_EMAIL, env.STOCKFLOW_TEST_PASSWORD]
      .filter(Boolean)
      .flatMap((secret) => [secret, encodeURIComponent(secret as string)]),
  );
  await page.evaluate(`(() => {
    const secrets = ${secrets};
    for (const input of document.querySelectorAll("input,textarea,[contenteditable='true']")) {
      for (const secret of secrets) {
        const value = input.value ?? input.textContent ?? "";
        if (secret && value.includes(secret)) {
          if ("value" in input) input.value = value.split(secret).join("[hidden]");
          else input.textContent = value.split(secret).join("[hidden]");
        }
      }
    }
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      for (const secret of secrets) {
        if (secret) node.textContent = node.textContent.split(secret).join("[hidden]");
      }
    }
    for (const element of document.querySelectorAll("*")) {
      for (const attribute of Array.from(element.attributes)) {
        for (const secret of secrets) {
          if (secret && attribute.value.includes(secret)) {
            element.setAttribute(attribute.name, attribute.value.split(secret).join("[hidden]"));
          }
        }
      }
    }
  })()`);
  await page.screenshot({ path: destination, fullPage: true });
  return path.relative(path.resolve(__dirname, "../.."), destination);
}

function relativeEvidencePath(runId: string, resultId: string, filename: string): string {
  return path.join("artifacts", "runs", runId, resultId, filename);
}

export function scrubEvidence<T>(
  value: T,
  credentials?: StockFlowCredentials,
): T {
  if (typeof value === "string") return redactSecrets(value, credentials) as T;
  if (Array.isArray(value)) return value.map((item) => scrubEvidence(item, credentials)) as T;
  if (typeof value === "object" && value !== null) {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (["authorization", "cookie", "x-api-key"].includes(key.toLowerCase())) continue;
      sanitized[key] = scrubEvidence(item, credentials);
    }
    return sanitized as T;
  }
  return value;
}

type WebStepAction = "click" | "fill" | "select" | "assert";

async function getStepLocator(
  page: Page,
  selector: string,
  action: WebStepAction = "assert",
): Promise<ReturnType<Page["locator"]>> {
  const original = page.locator(selector);
  if (await original.count() > 0) {
    return original;
  }

  try {
    await original.first().waitFor({ state: "attached", timeout: 2000 });
    return original;
  } catch {
    // Continue with conservative selector recovery after a brief render wait.
  }

  const parts = selector.split(/\s*>\s*/);
  if (parts.length >= 2 && selector.includes(":nth-of-type(")) {
    for (let start = 1; start < parts.length; start++) {
      const candidate = page.locator(parts.slice(start).join(" > "));
      if (await candidate.count() === 1 && await candidate.isVisible()) {
        return candidate;
      }
    }
  }

  const selectorParts = [
    ...selector.matchAll(/#([\w-]+)|\.([\w-]+)|(?:id|name|aria-label|placeholder|data-testid|data-test|data-qa)\s*=\s*["']([^"']+)["']/gi),
  ].flatMap((match) => [match[1], match[2], match[3]].filter((part): part is string => Boolean(part)));
  const genericWords = new Set([
    "button", "data", "field", "form", "id", "input", "name", "password",
    "qa", "select", "test", "text", "textarea", "type",
  ]);
  const hints = [...new Set(selectorParts.flatMap((part) =>
    part
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^a-z0-9]+/i)
      .map((word) => word.toLowerCase())
      .filter((word) => word.length > 2 && !genericWords.has(word)),
  ))];
  const elementTypes: Record<WebStepAction, string> = {
    click: "button, a, input[type='button'], input[type='submit'], [role='button']",
    fill: "input, textarea, [contenteditable='true']",
    select: "select",
    assert: "*",
  };
  for (const hint of hints) {
    const attributeSelectors = ["id", "name", "aria-label", "placeholder", "data-testid", "data-test", "data-qa"]
      .map((attribute) => `:is(${elementTypes[action]})[${attribute}*="${hint}" i]`)
      .join(", ");
    const candidate = page.locator(attributeSelectors);
    if (await candidate.count() === 1 && await candidate.isVisible()) {
      return candidate;
    }

    const labelCandidate = page.getByLabel(new RegExp(`\\b${hint}\\b`, "i"));
    if (
      await labelCandidate.count() === 1 &&
      await labelCandidate.isVisible() &&
      (action !== "select" || await labelCandidate.evaluate((element) => element.tagName === "SELECT"))
    ) {
      return labelCandidate;
    }
  }

  const recoveryHint = hints.join(", ");
  throw new Error(
    `No element matched selector "${selector}"` +
      (recoveryHint
        ? `, and no unique visible ${action === "assert" ? "element" : action} matched ${recoveryHint}`
        : "") +
      ". Confirm the current page and update the automation selector.",
  );
}

export async function executePageStep(page: Page, baseUrl: string, step: string): Promise<void> {
  if (step.startsWith("goto ")) {
    const route = step.slice("goto ".length).trim();
    if (!route) {
      throw new Error('Invalid step: "goto" requires a path');
    }

    const passwordInput = page.locator('input[type="password"]');
    if ((await passwordInput.count()) > 0 && (await passwordInput.first().isVisible())) {
      try {
        await passwordInput.first().waitFor({ state: "hidden", timeout: 20000 });
      } catch {
        // Proceed with navigation if timeout expires
      }
    }

    const url = `${baseUrl.replace(/\/+$/, "")}/${route.replace(/^\/+/, "")}`;
    await assertTargetUrlAllowed(url);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return;
  }

  if (step.startsWith("click ")) {
    const selector = step.slice("click ".length).trim();
    if (!selector) {
      throw new Error('Invalid step: "click" requires a CSS selector');
    }

    await (await getStepLocator(page, selector, "click")).click();
    await page.waitForLoadState("domcontentloaded");
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

    await (await getStepLocator(page, selector, "fill")).fill(value);
    return;
  }

  if (step.startsWith("select ")) {
    const input = step.slice("select ".length);
    const separator = input.indexOf("|");
    if (separator === -1) {
      throw new Error('Invalid step: expected "select <css selector> | <option>"');
    }
    const selector = input.slice(0, separator).trim();
    const value = input.slice(separator + 1).trim();
    if (!selector || !value) {
      throw new Error('Invalid step: "select" requires a selector and option value');
    }
    await (await getStepLocator(page, selector, "select")).selectOption(value);
    return;
  }

  if (step.startsWith("expect invalid ")) {
    const selector = step.slice("expect invalid ".length).trim();
    if (!selector) {
      throw new Error('Invalid step: "expect invalid" requires a CSS selector');
    }
    const validity = await (await getStepLocator(page, selector)).evaluate(
      "(element) => element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement ? element.checkValidity() : true",
    );
    if (validity) {
      throw new Error(`Assertion failed: expected "${selector}" to be invalid, but it was valid`);
    }
    return;
  }

  if (step.startsWith("expect not visible ")) {
    const selector = step.slice("expect not visible ".length).trim();
    if (!selector) {
      throw new Error('Invalid step: "expect not visible" requires a CSS selector');
    }
    const locator = await getStepLocator(page, selector);
    try {
      await locator.first().waitFor({ state: "hidden", timeout: 30_000 });
    } catch {
      if (/password|form/i.test(selector)) {
        throw new Error("Login failed: check the test credentials in .env");
      }
      throw new Error(`Assertion failed: expected "${selector}" to be hidden, but it remained visible`);
    }
    return;
  }

  if (step.startsWith("expect visible ")) {
    const selector = step.slice("expect visible ".length).trim();
    if (!selector) {
      throw new Error('Invalid step: "expect visible" requires a CSS selector');
    }
    const locator = await getStepLocator(page, selector);
    try {
      await locator.first().waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      throw new Error(`Assertion failed: expected "${selector}" to be visible, but it remained hidden or absent`);
    }
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

  // Advanced DSL: wait <ms>
  if (/^wait\s+(\d+)$/i.test(step)) {
    const ms = parseInt(step.replace(/^wait\s+/i, "").trim(), 10);
    const safeMs = Math.min(Math.max(Number.isFinite(ms) ? ms : 1000, 0), 30_000);
    await page.waitForTimeout(safeMs);
    return;
  }

  // Advanced DSL: wait for selector <css selector>
  if (step.startsWith("wait for selector ")) {
    const selector = step.slice("wait for selector ".length).trim();
    if (!selector) {
      throw new Error('Invalid step: "wait for selector" requires a CSS selector');
    }
    await (await getStepLocator(page, selector)).first().waitFor({ state: "visible", timeout: 15_000 });
    return;
  }

  // Advanced DSL: wait for navigation
  if (step === "wait for navigation" || step.startsWith("wait for navigation")) {
    await page.waitForLoadState("domcontentloaded");
    return;
  }

  // Advanced DSL: check / uncheck (checkboxes & radio buttons)
  if (step.startsWith("check ")) {
    const selector = step.slice("check ".length).trim();
    if (!selector) {
      throw new Error('Invalid step: "check" requires a CSS selector');
    }
    await (await getStepLocator(page, selector)).check();
    return;
  }

  if (step.startsWith("uncheck ")) {
    const selector = step.slice("uncheck ".length).trim();
    if (!selector) {
      throw new Error('Invalid step: "uncheck" requires a CSS selector');
    }
    await (await getStepLocator(page, selector)).uncheck();
    return;
  }

  // Advanced DSL: screenshot [name]
  if (step === "screenshot" || step.startsWith("screenshot ")) {
    // Intermediate screenshot requested; can be captured without breaking workflow
    return;
  }

  // Advanced DSL: upload <selector> | <filename>
  if (step.startsWith("upload ")) {
    const input = step.slice("upload ".length);
    const separator = input.indexOf("|");
    const selector = separator !== -1 ? input.slice(0, separator).trim() : input.trim();
    const rawFilename = separator !== -1 ? input.slice(separator + 1).trim() : "test-fixture.txt";
    if (!selector) {
      throw new Error('Invalid step: "upload" requires a CSS selector');
    }
    const safeFilename = path.basename(rawFilename).replace(/[^a-zA-Z0-9._-]/g, "_") || "test-fixture.txt";
    const fixturesDir = path.resolve(__dirname, "../../artifacts/fixtures");
    await mkdir(fixturesDir, { recursive: true });
    const fixtureFilePath = path.join(fixturesDir, safeFilename);
    await writeFile(fixtureFilePath, "Automated test upload fixture file content.", "utf8");
    await (await getStepLocator(page, selector)).setInputFiles(fixtureFilePath);
    return;
  }

  // Advanced DSL: frame <frame_selector> | <action>
  if (step.startsWith("frame ")) {
    const input = step.slice("frame ".length);
    const separator = input.indexOf("|");
    if (separator === -1) {
      throw new Error('Invalid step: expected "frame <frame selector> | <action>"');
    }
    const frameSelector = input.slice(0, separator).trim();
    const action = input.slice(separator + 1).trim();
    if (!frameSelector || !action) {
      throw new Error('Invalid step: "frame" requires both frame selector and action');
    }
    const frame = page.frameLocator(frameSelector);
    if (action.startsWith("click ")) {
      const sel = action.slice("click ".length).trim();
      await frame.locator(sel).click();
      return;
    }
    if (action.startsWith("fill ")) {
      const fillInput = action.slice("fill ".length);
      const fillSep = fillInput.indexOf("|");
      const sel = fillSep !== -1 ? fillInput.slice(0, fillSep).trim() : fillInput.trim();
      const val = fillSep !== -1 ? fillInput.slice(fillSep + 1).trim() : "";
      await frame.locator(sel).fill(val);
      return;
    }
    if (action.startsWith("expect text ")) {
      const text = action.slice("expect text ".length).trim();
      await frame.getByText(text).first().waitFor({ state: "visible" });
      return;
    }
    if (action.startsWith("expect visible ")) {
      const sel = action.slice("expect visible ".length).trim();
      await frame.locator(sel).first().waitFor({ state: "visible" });
      return;
    }
    throw new Error(`Unsupported frame action: "${action}"`);
  }

  // Advanced DSL: dialog accept [prompt_text] / dialog dismiss
  if (step.startsWith("dialog accept") || step.startsWith("dialog dismiss")) {
    const isDismiss = step.startsWith("dialog dismiss");
    const promptText = step.includes("|") ? step.split("|")[1].trim() : undefined;
    page.once("dialog", async (dialog) => {
      try {
        if (isDismiss) {
          await dialog.dismiss();
        } else {
          await dialog.accept(promptText);
        }
      } catch {
        // Handled silently if dialog closed
      }
    });
    return;
  }

  throw new Error(`Unknown test step: "${step}"`);
}

export interface RunTestCaseOptions {
  projectId?: string;
  credentials?: AppCredentials;
  storageState?: any;
}

export async function runTestCase(
  baseUrl: string,
  steps: string[],
  identifiers: { runId: string; resultId: string },
  options?: RunTestCaseOptions,
): Promise<TestCaseRunResult> {
  const startedAt = Date.now();
  let activeCredentials = options?.credentials;
  let activeStorageState = options?.storageState;

  if (options?.projectId && !activeCredentials && !activeStorageState) {
    try {
      const access = await getProjectAccess(options.projectId);
      if (access?.session) {
        activeStorageState = access.session;
      }
      if (access?.username) {
        activeCredentials = {
          username: access.username,
          password: access.password,
          email: access.username,
        };
      }
    } catch {}
  }

  const stockFlowCredentials = getStockFlowCredentialsForTarget(baseUrl);
  if (
    stockFlowCredentials &&
    !options?.credentials &&
    (!activeCredentials?.password || !(activeCredentials.username || activeCredentials.email))
  ) {
    activeCredentials = { ...activeCredentials, ...stockFlowCredentials };
  }

  const safeSteps = scrubEvidence(steps, activeCredentials);
  const credentialTest = isCredentialTest(steps, activeCredentials);
  const isAuthenticated =
    credentialTest ||
    Boolean(activeStorageState) ||
    Boolean((activeCredentials?.username || activeCredentials?.email) && activeCredentials.password);

  const outputDirectory = path.resolve(
    __dirname,
    "../../artifacts/runs",
    identifiers.runId,
    identifiers.resultId,
  );
  const evidence: WebEvidence = {
    status: "inconclusive",
    durationMs: 0,
    failureStep: null,
    failureStepIndex: null,
    errorMessage: null,
    browserErrors: [],
    failedRequests: [],
    httpErrors: [],
    finalUrl: "",
    finalTitle: "",
    screenshotPath: null,
    tracePath: null,
    traceNote: isAuthenticated ? "trace skipped: authenticated test" : null,
    evidencePath: relativeEvidencePath(identifiers.runId, identifiers.resultId, "evidence.json"),
  };
  const persistEvidence = async (): Promise<void> => {
    evidence.durationMs = Date.now() - startedAt;
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(
      path.join(outputDirectory, "evidence.json"),
      JSON.stringify(scrubEvidence(evidence, activeCredentials), null, 2),
      "utf8",
    );
  };
  const result = (): TestCaseRunResult => ({
    status: evidence.status,
    ...(evidence.errorMessage ? { errorMessage: evidence.errorMessage } : {}),
    durationMs: evidence.durationMs,
    screenshotPath: evidence.screenshotPath,
    tracePath: evidence.tracePath,
    evidence: scrubEvidence(evidence, activeCredentials),
  });

  try {
    await assertTargetUrlAllowed(baseUrl);
  } catch (error) {
    evidence.errorMessage = redactSecrets(getErrorMessage(error), activeCredentials);
    evidence.status = "inconclusive";
    await persistEvidence();
    return result();
  }

  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  } catch (error) {
    evidence.errorMessage = redactSecrets(getErrorMessage(error), activeCredentials);
    evidence.status = classifyWebStatus(evidence.errorMessage, null, null, true);
    await persistEvidence();
    return result();
  }
  let context: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let page: Page | undefined;
  let traceStarted = false;
  let sensitiveHeaderSeen = false;

  try {
    context = activeStorageState
      ? await browser.newContext({ storageState: activeStorageState })
      : await browser.newContext();
    page = await context.newPage();
    attachUrlGuardToPage(page);

    page.on("pageerror", (error) => {
      evidence.browserErrors.push(redactSecrets(error.message, activeCredentials));
    });
    page.on("console", (message) => {
      if (message.type() === "error") evidence.browserErrors.push(redactSecrets(message.text(), activeCredentials));
    });
    page.on("requestfailed", (request) => {
      const headers = request.headers();
      if (Object.keys(headers).some((key) => ["authorization", "cookie", "x-api-key"].includes(key.toLowerCase()))) {
        sensitiveHeaderSeen = true;
      }
      evidence.failedRequests.push({
        method: request.method(),
        url: safeUrl(request.url()),
        failure: redactSecrets(request.failure()?.errorText ?? "Request failed", activeCredentials),
      });
    });
    page.on("request", (request) => {
      const headers = request.headers();
      if (Object.keys(headers).some((key) => ["authorization", "cookie", "x-api-key"].includes(key.toLowerCase()))) {
        sensitiveHeaderSeen = true;
      }
      if (new URL(request.url()).search) sensitiveHeaderSeen = true;
    });
    page.on("response", (response) => {
      const responseHeaders = response.headers();
      if (Object.keys(responseHeaders).some((key) => ["authorization", "cookie", "x-api-key", "set-cookie"].includes(key.toLowerCase()))) {
        sensitiveHeaderSeen = true;
      }
      if (response.status() < 400) return;
      const request = response.request();
      evidence.httpErrors.push({
        method: request.method(),
        url: safeUrl(response.url()),
        status: response.status(),
      });
    });
    if (!isAuthenticated) {
      await context.tracing.start({ screenshots: false, snapshots: false, sources: false });
      traceStarted = true;
    }

    if (!credentialTest) {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
      const passwordInput = page.locator('input[type="password"]');
      const hasVisiblePassword =
        (await passwordInput.count()) > 0 && (await passwordInput.first().isVisible());
      const pageText = (await page.locator("body").innerText()).toLowerCase();
      const submitText = (
        await page.locator('button[type="submit"], input[type="submit"]').allInnerTexts()
      ).join(" ").toLowerCase();
      const isLoginPage =
        hasVisiblePassword &&
        (/\b(sign in|log in|welcome back)\b/.test(`${pageText} ${submitText}`) ||
          /\b(login|sign-in|signin|auth)\b/i.test(new URL(page.url()).pathname));

      if (isLoginPage) {
        const username = activeCredentials?.username || activeCredentials?.email;
        const password = activeCredentials?.password;
        if (!username || !password) {
          throw new Error(
            "The target application requires sign-in. Save test credentials or a browser session in the project access settings.",
          );
        }

        await performGenericLogin(
          page,
          baseUrl,
          { username, password },
          Boolean(stockFlowCredentials),
        );
      }
    }

    if (page.url() === "about:blank" && !steps[0]?.startsWith("goto ")) {
      await page.goto(baseUrl);
      await page.waitForLoadState("domcontentloaded");
    }

    for (const [stepIndex, step] of steps.entries()) {
      try {
        const resolvedStep = resolveStepPlaceholders(step, activeCredentials);
        await executePageStep(page, baseUrl, resolvedStep);
      } catch (error) {
        evidence.errorMessage = redactSecrets(getErrorMessage(error), activeCredentials);
        evidence.failureStep = safeSteps[stepIndex] ?? "[hidden]";
        evidence.failureStepIndex = stepIndex;
        evidence.status = classifyWebStatus(
          evidence.errorMessage,
          step,
          stepIndex,
          false,
        );
        break;
      }
    }

    if (!evidence.errorMessage) evidence.status = "passed";
    try {
      evidence.finalUrl = safeUrl(page.url());
      evidence.finalTitle = redactSecrets(await page.title(), activeCredentials);
    } catch {
      evidence.finalUrl = "";
      evidence.finalTitle = "";
    }

    if (evidence.status === "passed" || evidence.status === "failed" || evidence.status === "inconclusive") {
      const screenshotPath = path.join(outputDirectory, "screenshot.png");
      try {
        await saveRedactedScreenshot(page, screenshotPath);
        evidence.screenshotPath = relativeEvidencePath(identifiers.runId, identifiers.resultId, "screenshot.png");
      } catch (error) {
        evidence.browserErrors.push(
          redactSecrets(`Screenshot capture failed: ${getErrorMessage(error)}`),
        );
        if (evidence.status === "passed") {
          evidence.status = "inconclusive";
          evidence.errorMessage = "Could not capture final screenshot";
        }
      }
    }

    if (traceStarted) {
      if (evidence.status === "failed" && !credentialTest && !sensitiveHeaderSeen) {
        const tracePath = path.join(outputDirectory, "trace.zip");
        try {
          await context.tracing.stop({ path: tracePath });
          evidence.tracePath = relativeEvidencePath(identifiers.runId, identifiers.resultId, "trace.zip");
        } catch (error) {
          evidence.traceNote = redactSecrets(`trace capture failed: ${getErrorMessage(error)}`);
        }
      } else {
        await context.tracing.stop();
        if (evidence.status === "failed" && sensitiveHeaderSeen) {
          evidence.traceNote = "trace skipped: sensitive request headers detected";
        }
      }
    }
    await persistEvidence();
    return result();
  } catch (error) {
    evidence.errorMessage = redactSecrets(getErrorMessage(error));
    evidence.status = classifyWebStatus(evidence.errorMessage, null, null);
    if (page) {
      try {
        evidence.finalUrl = safeUrl(page.url());
        evidence.finalTitle = redactSecrets(await page.title());
        if (evidence.status !== "passed") {
          await saveRedactedScreenshot(page, path.join(outputDirectory, "screenshot.png"));
          evidence.screenshotPath = relativeEvidencePath(identifiers.runId, identifiers.resultId, "screenshot.png");
        }
      } catch {
        // Evidence capture errors are represented by the primary execution error.
      }
    }
    if (traceStarted && context) {
      if (evidence.status === "failed" && !credentialTest && !sensitiveHeaderSeen) {
        const tracePath = path.join(outputDirectory, "trace.zip");
        try {
          await context.tracing.stop({ path: tracePath });
          evidence.tracePath = relativeEvidencePath(identifiers.runId, identifiers.resultId, "trace.zip");
        } catch {
          await context.tracing.stop().catch(() => undefined);
        }
      } else {
        await context.tracing.stop().catch(() => undefined);
      }
    }
    await persistEvidence();
    return result();
  } finally {
    await context?.close();
    await browser.close();
  }
}
