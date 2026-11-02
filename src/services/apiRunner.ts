import { classifyRunStatus } from "./runner";
import { assertTargetUrlAllowed, safeFetch, SecurityError, type SafeFetchResponse } from "./urlGuard";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ExpectedFieldType = "string" | "number" | "boolean" | "object" | "array";
export type ApiTestStatus = "passed" | "failed" | "skipped" | "inconclusive";

export { classifyRunStatus, classifyRunStatus as classifyApiRunStatus };

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
}

export interface ApiTestResult {
  status: ApiTestStatus;
  actualStatus: number | null;
  responseMs: number;
  errorMessage: string | null;
  responseSnippet: string;
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

