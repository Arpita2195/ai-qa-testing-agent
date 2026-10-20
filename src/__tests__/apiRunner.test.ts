import { afterEach, describe, expect, it, vi } from "vitest";
import { runApiTest, type ApiEndpoint } from "../services/apiRunner";

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
