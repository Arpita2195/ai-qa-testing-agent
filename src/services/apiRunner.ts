import { assertTargetUrlAllowed } from "./urlGuard";

export type ApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ExpectedFieldType = "string" | "number" | "boolean" | "object" | "array";

export interface ApiEndpoint {
  method: ApiMethod;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  expected_status: number;
  expected_fields: Record<string, ExpectedFieldType>;
  max_response_ms: number | null;
}

export interface ApiTestResult {
  status: "passed" | "failed";
  actualStatus: number | null;
  responseMs: number;
  errorMessage: string | null;
  responseSnippet: string;
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
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let response: Response | undefined;
  let responseText = "";

  try {
    const url = new URL(endpoint.path, baseUrl);
    await assertTargetUrlAllowed(url.toString());
    const init: RequestInit = {
      method: endpoint.method,
      headers: endpoint.headers,
      signal: controller.signal,
    };
    if (endpoint.body !== null && endpoint.body !== undefined) {
      init.body = JSON.stringify(endpoint.body);
    }

    response = await fetch(url, init);
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

    const expectedFields = Object.entries(endpoint.expected_fields);
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
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "Request timeout assertion failed: expected response within 30000ms, actual timed out"
        : `Request assertion failed: ${error instanceof Error ? error.message : String(error)}`;
    return {
      status: "failed",
      actualStatus: response?.status ?? null,
      responseMs,
      errorMessage: redactSecretValues(message, endpoint.headers),
      responseSnippet: redactSecretValues(responseText, endpoint.headers).slice(0, 500),
    };
  } finally {
    clearTimeout(timeout);
  }
}
