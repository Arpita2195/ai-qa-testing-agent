import { describe, expect, it } from "vitest";
import { importOpenApi, skipExistingEndpoints } from "../services/openapiImporter";

const validSpec = {
  openapi: "3.0.3",
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    label: { type: "string" },
                    details: { $ref: "#/components/schemas/Details" },
                    skipped: { $ref: "https://example.invalid/Schema" },
                  },
                },
              },
            },
          },
        },
      },
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { label: { type: "string" }, count: { type: "integer" } },
              },
            },
          },
        },
        responses: { "201": { description: "Created" }, "200": { description: "OK" } },
      },
    },
  },
  components: {
    schemas: {
      Details: { type: "object" },
    },
  },
};

describe("OpenAPI importer", () => {
  it("creates endpoint drafts from an OpenAPI 3.x object", () => {
    const drafts = importOpenApi(validSpec);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      name: "listItems",
      method: "GET",
      expected_status: 200,
      expected_fields: { id: "number", label: "string", details: "object" },
      headers: {},
    });
    expect(drafts[0]?.expected_fields).not.toHaveProperty("skipped");
    expect(drafts[1]).toMatchObject({
      method: "POST",
      expected_status: 200,
      body: { label: "example", count: 1 },
    });
  });

  it("parses YAML and rejects non-3.x specifications clearly", () => {
    expect(importOpenApi("openapi: 3.1.0\npaths:\n  /ping:\n    get:\n      responses:\n        '200':\n          description: ok")).toHaveLength(1);
    expect(() => importOpenApi({ openapi: "2.0", paths: {} })).toThrow("Only OpenAPI 3.x");
  });

  it("skips duplicate method/path pairs both from storage and in a draft batch", () => {
    const drafts = importOpenApi(validSpec);
    const result = skipExistingEndpoints(drafts, [{ method: "GET", path: "/items" }]);
    expect(result.skipped).toBe(1);
    expect(result.created.map((draft) => draft.method)).toEqual(["POST"]);
    expect(skipExistingEndpoints(drafts, []).created).toHaveLength(2);
  });
});
