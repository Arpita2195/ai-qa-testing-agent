import { afterEach, describe, expect, it, vi } from "vitest";

const mockedProjectAccess = vi.hoisted(() => ({
  value: { username: "qa@example.test", password: "test-password" } as
    | { username: string; password: string }
    | null,
}));

vi.mock("../services/secretStore", () => ({
  getProjectAccess: vi.fn(async () => mockedProjectAccess.value),
}));

import {
  createApiProjectAuthState,
  runApiTest,
  runApiTestWithProjectAuth,
  classifyRunStatus,
  classifyApiRunStatus,
  isNetworkOrInfrastructureError,
  type ApiEndpoint,
} from "../services/apiRunner";
import { runApiTestWithRetries } from "../services/executionManager";

const endpoint: ApiEndpoint = {
  method: "GET",
  path: "/resource",
  headers: {},
  body: null,
  expected_status: 200,
  expected_fields: {},
  max_response_ms: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
  mockedProjectAccess.value = { username: "qa@example.test", password: "test-password" };
});

describe("runApiTest assertions", () => {
  it("fails when the status differs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("missing", { status: 404 })));
    const result = await runApiTest("https://example.test", endpoint);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("expected 200, actual 404");
  });

  it("fails when the response exceeds the maximum time", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response("{}", { status: 200 });
      }),
    );
    const result = await runApiTest("https://example.test", {
      ...endpoint,
      max_response_ms: 1,
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Response time assertion failed");
  });

  it("fails when an expected field is missing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ title: "Hello" })));
    const result = await runApiTest("https://example.test", {
      ...endpoint,
      expected_fields: { id: "number" },
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain('"id"');
    expect(result.errorMessage).toContain("actual missing");
  });

  it("fails when an expected field has the wrong type", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "one" })));
    const result = await runApiTest("https://example.test", {
      ...endpoint,
      expected_fields: { id: "number" },
    });
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("expected type number, actual string");
  });

  it("passes when status and field type assertions hold", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: 1 })));
    const result = await runApiTest("https://example.test", {
      ...endpoint,
      expected_fields: { id: "number" },
    });
    expect(result.status).toBe("passed");
    expect(result.actualStatus).toBe(200);
    expect(result.responseSnippet).toContain('"id":1');
  });
});

describe("runApiTest infrastructure and network error handling", () => {
  it("classifies request timeout as inconclusive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      }),
    );
    const result = await runApiTest("https://example.test", {
      ...endpoint,
      timeout_ms: 50,
    });
    expect(result.status).toBe("inconclusive");
    expect(result.errorMessage).toContain("Request timeout");
  });

  it("classifies DNS failure (ENOTFOUND) as inconclusive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new TypeError("fetch failed");
        (error as any).cause = { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND example.invalid" };
        throw error;
      }),
    );
    const result = await runApiTest("https://example.test", endpoint);
    expect(result.status).toBe("inconclusive");
    expect(result.errorMessage).toContain("Network/Infrastructure error");
  });

  it("classifies connection refused (ECONNREFUSED) as inconclusive", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const error = new TypeError("fetch failed");
        (error as any).cause = { code: "ECONNREFUSED", message: "connect ECONNREFUSED 127.0.0.1:8080" };
        throw error;
      }),
    );
    const result = await runApiTest("https://example.test", endpoint);
    expect(result.status).toBe("inconclusive");
    expect(result.errorMessage).toContain("Network/Infrastructure error");
  });

  it("classifies skipped endpoint as skipped", async () => {
    const result = await runApiTest("https://example.test", {
      ...endpoint,
      skip: true,
      skip_reason: "Feature flag disabled",
    });
    expect(result.status).toBe("skipped");
    expect(result.errorMessage).toBe("Feature flag disabled");
    expect(result.actualStatus).toBeNull();
  });

  it("classifies disabled endpoint as skipped", async () => {
    const result = await runApiTest("https://example.test", {
      ...endpoint,
      enabled: false,
    });
    expect(result.status).toBe("skipped");
    expect(result.errorMessage).toContain("skipped");
  });

  it("detects network or infrastructure error via helper", () => {
    expect(isNetworkOrInfrastructureError(new Error("socket hang up"))).toBe(true);
    expect(isNetworkOrInfrastructureError({ code: "ECONNRESET" })).toBe(true);
    expect(isNetworkOrInfrastructureError({ cause: { code: "EHOSTUNREACH" } })).toBe(true);
    expect(isNetworkOrInfrastructureError(new Error("Status assertion failed"))).toBe(false);
  });
});

describe("runApiTestWithProjectAuth", () => {
  it("uses project authentication and retries transient failures consistently", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/api/auth/login")) {
        return Response.json({ token: "test-bearer-token" });
      }
      if (!new Headers(init?.headers).has("authorization")) {
        return Response.json({ message: "Unauthorized" }, { status: 401 });
      }
      if (fetchMock.mock.calls.filter(([url]) => !String(url).endsWith("/api/auth/login")).length === 2) {
        return Response.json({ message: "Temporary failure" }, { status: 500 });
      }
      return Response.json([{ id: 1 }]);
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await runApiTestWithRetries(
      "https://example.test",
      endpoint,
      { retries: 1, backoffMs: 1, projectId: "project-id" },
    );

    expect(result.status).toBe("passed");
    expect(result.flaky).toBe(true);
    expect(result.retryCount).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not waste retries on deterministic 4xx failures", async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: "Not found" }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runApiTestWithRetries(
      "https://example.test",
      endpoint,
      { retries: 3, backoffMs: 1 },
    );

    expect(result.status).toBe("failed");
    expect(result.retryCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs in with saved project credentials and retries an unauthorized endpoint", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const requestUrl = String(input);
      if (requestUrl.endsWith("/api/auth/login")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          email: "qa@example.test",
          password: "test-password",
        });
        return Response.json({ token: "test-bearer-token" });
      }

      if (new Headers(init?.headers).has("authorization")) {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-bearer-token");
        return Response.json([{ id: 1 }]);
      }

      return Response.json({ message: "Not authorized, no token" }, { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const authState = createApiProjectAuthState();

    const result = await runApiTestWithProjectAuth(
      "https://example.test",
      "project-id",
      endpoint,
      authState,
    );

    expect(result.status).toBe("passed");
    expect(result.actualStatus).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(authState.authorizationHeader).toBe("Bearer test-bearer-token");
    expect(authState.authenticationAttempted).toBe(true);
  });

  it("does not authenticate endpoints explicitly expecting an unauthorized response", async () => {
    const fetchMock = vi.fn(async () => Response.json({ message: "Unauthorized" }, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await runApiTestWithProjectAuth(
      "https://example.test",
      "project-id",
      { ...endpoint, expected_status: 401 },
      createApiProjectAuthState(),
    );

    expect(result.status).toBe("passed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("overall API and run status calculation", () => {
  it("never classifies empty results as passed", () => {
    expect(classifyRunStatus([])).toBe("inconclusive");
    expect(classifyApiRunStatus([])).toBe("inconclusive");
  });

  it("classifies all passed results as passed", () => {
    expect(classifyRunStatus(["passed", "passed"])).toBe("passed");
  });

  it("classifies passed with skipped results as passed", () => {
    expect(classifyRunStatus(["passed", "skipped"])).toBe("passed");
  });

  it("classifies all skipped results as skipped", () => {
    expect(classifyRunStatus(["skipped", "skipped"])).toBe("skipped");
  });

  it("prioritizes failed when any test fails", () => {
    expect(classifyRunStatus(["passed", "failed"])).toBe("failed");
    expect(classifyRunStatus(["skipped", "failed"])).toBe("failed");
    expect(classifyRunStatus(["inconclusive", "failed"])).toBe("failed");
  });

  it("classifies inconclusive when infrastructure errors exist without failure", () => {
    expect(classifyRunStatus(["passed", "inconclusive"])).toBe("inconclusive");
    expect(classifyRunStatus(["skipped", "inconclusive"])).toBe("inconclusive");
    expect(classifyRunStatus(["inconclusive"])).toBe("inconclusive");
  });
});
