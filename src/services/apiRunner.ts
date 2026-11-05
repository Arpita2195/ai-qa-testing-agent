import { classifyRunStatus } from "./runner";
import { assertTargetUrlAllowed, safeFetch, SecurityError, type SafeFetchResponse } from "./urlGuard";
import { getProjectAccess } from "./secretStore";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ExpectedFieldType = "string" | "number" | "boolean" | "object" | "array";
export type ApiTestStatus = "passed" | "failed" | "skipped" | "inconclusive";

export { classifyRunStatus, classifyRunStatus as classifyApiRunStatus };

export interface ApiWorkflowStep {
  name?: string;
  method: ApiMethod;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  expected_status?: number;
  expected_fields?: Record<string, ExpectedFieldType>;
  max_response_ms?: number | null;
  extract?: Record<string, string>;
}

export interface ApiStepExecutionResult {
  stepIndex: number;
  name: string;
  method: ApiMethod;
  path: string;
  status: ApiTestStatus;
  actualStatus: number | null;
  responseMs: number;
  errorMessage: string | null;
  responseSnippet: string;
  extracted?: Record<string, unknown>;
}

export interface ApiWorkflowResult {
  status: ApiTestStatus;
  actualStatus: number | null;
  responseMs: number;
  errorMessage: string | null;
  responseSnippet: string;
  stepResults: ApiStepExecutionResult[];
  extractedContext: Record<string, unknown>;
}

export interface ApiEndpoint {
  method: ApiMethod;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  expected_status: number;
  expected_fields: Record<string, ExpectedFieldType>;
  max_response_ms: number | null;
  enabled?: boolean;
  skip?: boolean;
  skip_reason?: string;
  timeout_ms?: number | null;
  steps?: ApiWorkflowStep[];
}

export interface ApiTestResult {
  status: ApiTestStatus;
  actualStatus: number | null;
  responseMs: number;
  errorMessage: string | null;
  responseSnippet: string;
  stepResults?: ApiStepExecutionResult[];
  extractedContext?: Record<string, unknown>;
}

export interface ApiProjectAuthState {
  authorizationHeader: string | null;
  authenticationAttempted: boolean;
  authenticationError: string | null;
}

export function createApiProjectAuthState(): ApiProjectAuthState {
  return {
    authorizationHeader: null,
    authenticationAttempted: false,
    authenticationError: null,
  };
}

async function authenticateProjectApi(
  baseUrl: string,
  projectId: string,
): Promise<{ authorizationHeader: string | null; error: string | null }> {
  const credentials = await getProjectAccess(projectId);
  if (!credentials?.username || !credentials.password) {
    return { authorizationHeader: null, error: "No saved project test credentials are available." };
  }

  try {
    const response = await safeFetch(new URL("/api/auth/login", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: credentials.username, password: credentials.password }),
      timeoutMs: 10_000,
    });
    if (response.status < 200 || response.status >= 300) {
      return {
        authorizationHeader: null,
        error: `The API login endpoint returned HTTP ${response.status}.`,
      };
    }

    let responseBody: unknown;
    try {
      responseBody = await response.json();
    } catch {
      return { authorizationHeader: null, error: "The API login endpoint did not return valid JSON." };
    }

    const token =
      typeof responseBody === "object" &&
      responseBody !== null &&
      "token" in responseBody &&
      typeof responseBody.token === "string"
        ? responseBody.token
        : "";
    if (!token) {
      return { authorizationHeader: null, error: "The API login response did not contain a bearer token." };
    }

    return { authorizationHeader: `Bearer ${token}`, error: null };
  } catch (error) {
    return {
      authorizationHeader: null,
      error: `API login request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function runApiTestWithProjectAuth(
  baseUrl: string,
  projectId: string,
  endpoint: ApiEndpoint,
  authState: ApiProjectAuthState,
): Promise<ApiTestResult> {
  const run = (authorizationHeader: string | null) =>
    runApiTest(baseUrl, {
      ...endpoint,
      headers: authorizationHeader
        ? { ...endpoint.headers, authorization: authorizationHeader }
        : endpoint.headers,
    });

  if (authState.authorizationHeader && endpoint.expected_status !== 401) {
    return run(authState.authorizationHeader);
  }

  const result = await runApiTest(baseUrl, endpoint);
  if (result.actualStatus !== 401 || endpoint.expected_status === 401) {
    return result;
  }

  if (!authState.authenticationAttempted) {
    authState.authenticationAttempted = true;
    const authentication = await authenticateProjectApi(baseUrl, projectId);
    authState.authorizationHeader = authentication.authorizationHeader;
    authState.authenticationError = authentication.error;
  }

  if (!authState.authorizationHeader) {
    return authState.authenticationError
      ? {
          ...result,
          errorMessage: `${result.errorMessage}. API authentication failed: ${authState.authenticationError}`,
        }
      : result;
  }

  return run(authState.authorizationHeader);
}

export function isNetworkOrInfrastructureError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof SecurityError) return true;
  const err = error as { name?: string; code?: string; message?: string; cause?: unknown };
  if (err.name === "AbortError" || err.name === "TimeoutError" || err.name === "SecurityError") return true;
  if (
    err.code &&
    /ENOTFOUND|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ETIMEDOUT|UND_ERR_/.test(
      err.code,
    )
  ) {
    return true;
  }
  const message = String(err.message || "").toLowerCase();
  if (
    /abort|timeout|timed out|enotfound|econnrefused|econnreset|socket hang up|failed to fetch|fetch failed|network error|getaddrinfo|ehostunreach|enetunreach|security guard|prohibited|blocked by security/.test(
      message,
    )
  ) {
    return true;
  }
  if (err.cause) {
    return isNetworkOrInfrastructureError(err.cause);
  }
  return false;
}

function redactSecretValues(text: string, headers: Record<string, string>): string {
  let redacted = text;
  for (const [name, value] of Object.entries(headers)) {
    if (["authorization", "cookie", "x-api-key"].includes(name.toLowerCase()) && value) {
      redacted = redacted.split(value).join("[REDACTED]");
    }
  }
  return redacted;
}

function matchesType(value: unknown, expected: ExpectedFieldType): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
  }
}

export function extractJsonValue(data: unknown, path: string): unknown {
  if (data === null || data === undefined) return undefined;
  if (!path || path.trim() === "") return data;
  const parts = path.split(".");
  let current: any = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object") {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function interpolateTemplate<T>(target: T, context: Record<string, unknown>): T {
  if (typeof target === "string") {
    let str: string = target as unknown as string;
    for (const [key, val] of Object.entries(context)) {
      if (val !== undefined && val !== null) {
        str = str.split(`{{${key}}}`).join(String(val));
      }
    }
    return str as unknown as T;
  }
  if (Array.isArray(target)) {
    return target.map((item) => interpolateTemplate(item, context)) as unknown as T;
  }
  if (typeof target === "object" && target !== null) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(target)) {
      result[k] = interpolateTemplate(v, context);
    }
    return result as unknown as T;
  }
  return target;
}

export async function runMultiStepApiTest(
  baseUrl: string,
  steps: ApiWorkflowStep[],
  options?: {
    timeoutMs?: number;
    runner?: (baseUrl: string, endpoint: ApiEndpoint) => Promise<ApiTestResult>;
  },
): Promise<ApiWorkflowResult> {
  const runner = options?.runner ?? runApiTest;
  const startedAt = Date.now();
  const stepResults: ApiStepExecutionResult[] = [];
  const extractionContext: Record<string, unknown> = {};
  let overallStatus: ApiTestStatus = "passed";
  let firstErrorMessage: string | null = null;
  let lastResponseSnippet = "";
  let lastStatus: number | null = null;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const interpolatedPath = interpolateTemplate(step.path, extractionContext);
    const interpolatedHeaders = interpolateTemplate(step.headers || {}, extractionContext) as Record<string, string>;
    const interpolatedBody = interpolateTemplate(step.body, extractionContext);

    const singleEndpoint: ApiEndpoint = {
      method: step.method,
      path: interpolatedPath,
      headers: interpolatedHeaders,
      body: interpolatedBody,
      expected_status: step.expected_status ?? 200,
      expected_fields: step.expected_fields ?? {},
      max_response_ms: step.max_response_ms ?? null,
      timeout_ms: options?.timeoutMs,
    };

    const result = await runner(baseUrl, singleEndpoint);
    lastStatus = result.actualStatus;
    lastResponseSnippet = result.responseSnippet;

    const extractedThisStep: Record<string, unknown> = {};
    if (result.status === "passed" && step.extract && Object.keys(step.extract).length > 0) {
      try {
        const parsedJson = JSON.parse(result.responseSnippet || "{}");
        for (const [contextKey, jsonPath] of Object.entries(step.extract)) {
          const val = extractJsonValue(parsedJson, jsonPath);
          if (val !== undefined) {
            extractionContext[contextKey] = val;
            extractedThisStep[contextKey] = val;
          }
        }
      } catch {
        // Snippet was not parseable or partial JSON
      }
    }

    stepResults.push({
      stepIndex: i + 1,
      name: step.name || `Step ${i + 1}: ${step.method} ${step.path}`,
      method: step.method,
      path: interpolatedPath,
      status: result.status,
      actualStatus: result.actualStatus,
      responseMs: result.responseMs,
      errorMessage: result.errorMessage,
      responseSnippet: result.responseSnippet,
      extracted: extractedThisStep,
    });

    if (result.status !== "passed") {
      overallStatus = result.status;
      firstErrorMessage = `Step ${i + 1} (${step.name || step.path}) failed: ${result.errorMessage}`;
      break;
    }
  }

  return {
    status: overallStatus,
    actualStatus: lastStatus,
    responseMs: Date.now() - startedAt,
    errorMessage: firstErrorMessage,
    responseSnippet: lastResponseSnippet,
    stepResults,
    extractedContext: extractionContext,
  };
}

export async function runApiTest(
  baseUrl: string,
  endpoint: ApiEndpoint,
): Promise<ApiTestResult> {
  // Check if test endpoint is explicitly disabled or skipped
  if (endpoint.skip || endpoint.enabled === false) {
    return {
      status: "skipped",
      actualStatus: null,
      responseMs: 0,
      errorMessage: endpoint.skip_reason ?? "API endpoint testing skipped",
      responseSnippet: "",
    };
  }

  if (endpoint.steps && endpoint.steps.length > 0) {
    const multiResult = await runMultiStepApiTest(baseUrl, endpoint.steps, { timeoutMs: endpoint.timeout_ms ?? undefined });
    return {
      status: multiResult.status,
      actualStatus: multiResult.actualStatus,
      responseMs: multiResult.responseMs,
      errorMessage: multiResult.errorMessage,
      responseSnippet: multiResult.responseSnippet,
      stepResults: multiResult.stepResults,
      extractedContext: multiResult.extractedContext,
    };
  }

  const startedAt = Date.now();
  const timeoutLimit = endpoint.timeout_ms && endpoint.timeout_ms > 0 ? endpoint.timeout_ms : 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutLimit);
  let response: SafeFetchResponse | Response | undefined;
  let responseText = "";

  try {
    const url = new URL(endpoint.path, baseUrl);
    try {
      await assertTargetUrlAllowed(url.toString());
    } catch (guardErr) {
      const responseMs = Date.now() - startedAt;
      const message = guardErr instanceof Error ? guardErr.message : String(guardErr);
      return {
        status: "inconclusive",
        actualStatus: null,
        responseMs,
        errorMessage: `Target URL blocked by security policy: ${message}`,
        responseSnippet: "",
      };
    }

    const bodyPayload =
      endpoint.body !== null && endpoint.body !== undefined
        ? typeof endpoint.body === "string"
          ? endpoint.body
          : JSON.stringify(endpoint.body)
        : null;

    response = await safeFetch(url.toString(), {
      method: endpoint.method,
      headers: endpoint.headers,
      body: bodyPayload,
      timeoutMs: timeoutLimit,
      signal: controller.signal,
    });
    responseText = await response.text();
    const responseMs = Date.now() - startedAt;
    const responseSnippet = redactSecretValues(responseText, endpoint.headers).slice(0, 500);

    if (response.status !== endpoint.expected_status) {
      return {
        status: "failed",
        actualStatus: response.status,
        responseMs,
        errorMessage: `Status assertion failed: expected ${endpoint.expected_status}, actual ${response.status}`,
        responseSnippet,
      };
    }

    if (endpoint.max_response_ms !== null && responseMs >= endpoint.max_response_ms) {
      return {
        status: "failed",
        actualStatus: response.status,
        responseMs,
        errorMessage: `Response time assertion failed: expected under ${endpoint.max_response_ms}ms, actual ${responseMs}ms`,
        responseSnippet,
      };
    }

    const expectedFields = Object.entries(endpoint.expected_fields || {});
    if (expectedFields.length > 0) {
      let responseBody: unknown;
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        return {
          status: "failed",
          actualStatus: response.status,
          responseMs,
          errorMessage: "JSON assertion failed: expected a JSON response body, actual body was not valid JSON",
          responseSnippet,
        };
      }

      for (const [field, expectedType] of expectedFields) {
        if (
          typeof responseBody !== "object" ||
          responseBody === null ||
          !(field in responseBody)
        ) {
          return {
            status: "failed",
            actualStatus: response.status,
            responseMs,
            errorMessage: `Field assertion failed for "${field}": expected present with type ${expectedType}, actual missing`,
            responseSnippet,
          };
        }
        const actualValue = (responseBody as Record<string, unknown>)[field];
        const actualType = Array.isArray(actualValue)
          ? "array"
          : actualValue === null
            ? "null"
            : typeof actualValue;
        if (!matchesType(actualValue, expectedType)) {
          return {
            status: "failed",
            actualStatus: response.status,
            responseMs,
            errorMessage: `Field assertion failed for "${field}": expected type ${expectedType}, actual ${actualType}`,
            responseSnippet,
          };
        }
      }
    }

    return {
      status: "passed",
      actualStatus: response.status,
      responseMs,
      errorMessage: null,
      responseSnippet,
    };
  } catch (error) {
    const responseMs = Date.now() - startedAt;
    const isTimeout =
      (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) ||
      controller.signal.aborted;
    const isSecurity =
      error instanceof SecurityError ||
      (error instanceof Error &&
        (error.message.includes("security guard") ||
          error.message.includes("prohibited") ||
          error.message.includes("SecurityError")));
    const isInconclusive = isTimeout || isSecurity || isNetworkOrInfrastructureError(error);

    let message: string;
    if (isSecurity) {
      message = `Target URL blocked by security policy: ${error instanceof Error ? error.message : String(error)}`;
    } else if (isTimeout) {
      message = `Request timeout: expected response within ${timeoutLimit}ms, actual timed out`;
    } else if (isInconclusive) {
      message = `Network/Infrastructure error: ${error instanceof Error ? error.message : String(error)}`;
    } else {
      message = `Request assertion failed: ${error instanceof Error ? error.message : String(error)}`;
    }

    return {
      status: isInconclusive ? "inconclusive" : "failed",
      actualStatus: response?.status ?? null,
      responseMs,
      errorMessage: redactSecretValues(message, endpoint.headers),
      responseSnippet: redactSecretValues(responseText, endpoint.headers).slice(0, 500),
    };
  } finally {
    clearTimeout(timeout);
  }
}
