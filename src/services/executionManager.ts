import { runTestCase, type TestCaseRunResult, type WebResultStatus, redactSecrets } from "./runner";
import {
  createApiProjectAuthState,
  runApiTest,
  runApiTestWithProjectAuth,
  type ApiEndpoint,
  type ApiProjectAuthState,
  type ApiTestResult,
  isNetworkOrInfrastructureError,
} from "./apiRunner";
import { runMobileTestCase, type MobileRunnerOptions } from "./mobileRunner";
import { type MobileTestCaseRunResult } from "./mobile/types";

export interface ExecutionAttempt {
  attempt: number;
  status: "passed" | "failed" | "inconclusive" | "skipped";
  durationMs: number;
  errorMessage: string | null;
  errorType: "assertion" | "infrastructure" | "timeout" | "none";
  screenshotPath?: string | null;
}

export interface ExtendedWebExecutionResult extends TestCaseRunResult {
  flaky: boolean;
  retryCount: number;
  attempts: ExecutionAttempt[];
}

export interface ExtendedApiExecutionResult extends ApiTestResult {
  flaky: boolean;
  retryCount: number;
  attempts: ExecutionAttempt[];
}

export interface ExtendedMobileExecutionResult extends MobileTestCaseRunResult {
  flaky: boolean;
  retryCount: number;
  attempts: ExecutionAttempt[];
}

function shouldRetryApiFailure(result: ApiTestResult): boolean {
  if (result.status === "inconclusive" || result.actualStatus === null) return true;
  return [408, 425, 429].includes(result.actualStatus) || result.actualStatus >= 500;
}

function classifyErrorType(errorMessage: string | null, isInconclusive: boolean): ExecutionAttempt["errorType"] {
  if (!errorMessage) return "none";
  if (isInconclusive || isNetworkOrInfrastructureError(errorMessage)) return "infrastructure";
  if (/timeout|timed out/i.test(errorMessage)) return "timeout";
  return "assertion";
}

/**
 * Executes a Playwright Web UI test with automatic retries and flaky test detection.
 * If a test fails initially and then passes on a subsequent attempt, it is flagged as flaky.
 */
export async function runWebTestWithRetries(
  baseUrl: string,
  steps: string[],
  identifiers: { runId: string; resultId: string },
  options?: {
    projectId?: string;
    retries?: number;
    backoffMs?: number;
    runner?: typeof runTestCase;
  },
): Promise<ExtendedWebExecutionResult> {
  const runner = options?.runner ?? runTestCase;
  const maxRetries = Math.min(Math.max(options?.retries ?? 0, 0), 5);
  const backoffMs = options?.backoffMs ?? 250;
  const attempts: ExecutionAttempt[] = [];

  let lastResult: TestCaseRunResult | null = null;
  let hasPassed = false;
  let hasFailed = false;

  for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
    const result = await runner(baseUrl, steps, identifiers, { projectId: options?.projectId });
    lastResult = result;

    const errorType = classifyErrorType(result.errorMessage ?? null, result.status === "inconclusive");
    attempts.push({
      attempt,
      status: result.status,
      durationMs: result.durationMs,
      errorMessage: result.errorMessage ?? null,
      errorType,
      screenshotPath: result.screenshotPath ?? null,
    });

    if (result.status === "passed") {
      hasPassed = true;
      break;
    } else {
      hasFailed = true;
      if (attempt <= maxRetries && backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  const finalResult = lastResult!;
  const isFlaky = hasPassed && hasFailed;

  return {
    ...finalResult,
    flaky: isFlaky,
    retryCount: attempts.length - 1,
    attempts,
  };
}

/**
 * Executes a REST API test (single or multi-step) with automatic retries and flaky test detection.
 */
export async function runApiTestWithRetries(
  baseUrl: string,
  endpoint: ApiEndpoint,
  options?: {
    retries?: number;
    backoffMs?: number;
    runner?: typeof runApiTest;
    projectId?: string;
    authState?: ApiProjectAuthState;
  },
): Promise<ExtendedApiExecutionResult> {
  const runner = options?.runner ?? runApiTest;
  const authState = options?.projectId
    ? options.authState ?? createApiProjectAuthState()
    : null;
  const maxRetries = Math.min(Math.max(options?.retries ?? 0, 0), 5);
  const backoffMs = options?.backoffMs ?? 200;
  const attempts: ExecutionAttempt[] = [];

  let lastResult: ApiTestResult | null = null;
  let hasPassed = false;
  let hasFailed = false;

  for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
    const result = authState && options?.projectId
      ? await runApiTestWithProjectAuth(baseUrl, options.projectId, endpoint, authState)
      : await runner(baseUrl, endpoint);
    lastResult = result;

    const errorType = classifyErrorType(result.errorMessage, result.status === "inconclusive");
    attempts.push({
      attempt,
      status: result.status,
      durationMs: result.responseMs,
      errorMessage: result.errorMessage,
      errorType,
    });

    if (result.status === "passed") {
      hasPassed = true;
      break;
    } else {
      hasFailed = true;
      if (attempt <= maxRetries && shouldRetryApiFailure(result) && backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      } else {
        break;
      }
    }
  }

  const finalResult = lastResult!;
  const isFlaky = hasPassed && hasFailed;

  return {
    ...finalResult,
    flaky: isFlaky,
    retryCount: attempts.length - 1,
    attempts,
  };
}

/**
 * Executes an Appium Mobile Android test with automatic retries and flaky test detection.
 */
export async function runMobileTestWithRetries(
  steps: string[],
  identifiers: { runId: string; resultId: string },
  options?: MobileRunnerOptions & {
    retries?: number;
    backoffMs?: number;
    runner?: typeof runMobileTestCase;
  },
): Promise<ExtendedMobileExecutionResult> {
  const runner = options?.runner ?? runMobileTestCase;
  const maxRetries = Math.min(Math.max(options?.retries ?? 0, 0), 5);
  const backoffMs = options?.backoffMs ?? 500;
  const attempts: ExecutionAttempt[] = [];

  let lastResult: MobileTestCaseRunResult | null = null;
  let hasPassed = false;
  let hasFailed = false;

  for (let attempt = 1; attempt <= 1 + maxRetries; attempt++) {
    const result = await runner(steps, identifiers, options);
    lastResult = result;

    const errorType = classifyErrorType(result.errorMessage ?? null, result.status === "inconclusive");
    attempts.push({
      attempt,
      status: result.status,
      durationMs: result.durationMs,
      errorMessage: result.errorMessage ?? null,
      errorType,
      screenshotPath: result.screenshotPath ?? null,
    });

    if (result.status === "passed") {
      hasPassed = true;
      break;
    } else {
      hasFailed = true;
      if (attempt <= maxRetries && backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }

  const finalResult = lastResult!;
  const isFlaky = hasPassed && hasFailed;

  return {
    ...finalResult,
    flaky: isFlaky,
    retryCount: attempts.length - 1,
    attempts,
  };
}

/**
 * Runs items concurrently up to a specified concurrency limit.
 * Guaranteed to respect concurrency limits and isolate worker errors.
 */
export async function executeConcurrentPool<T, R>(
  items: T[],
  worker: (item: T, index: number) => Promise<R>,
  concurrencyLimit: number = 2,
): Promise<R[]> {
  const limit = Math.min(Math.max(concurrencyLimit, 1), 10);
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runner(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex++;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runner());
  await Promise.all(workers);
  return results;
}
