import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { createApiKeyHook } from "../services/auth";

describe("platform API authentication", () => {
  let app: ReturnType<typeof Fastify> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns 401 when the API key is missing", async () => {
    app = Fastify();
    app.addHook("onRequest", createApiKeyHook("a-valid-test-api-key"));
    app.get("/private", async () => ({ ok: true }));
    const response = await app.inject({ method: "GET", url: "/private" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Unauthorized" });
  });

  it("allows a matching API key", async () => {
    app = Fastify();
    app.addHook("onRequest", createApiKeyHook("a-valid-test-api-key"));
    app.get("/private", async () => ({ ok: true }));
    const response = await app.inject({
      method: "GET",
      url: "/private",
      headers: { "x-api-key": "a-valid-test-api-key" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it("leaves GET /health open", async () => {
    app = Fastify();
    app.addHook("onRequest", createApiKeyHook("a-valid-test-api-key"));
    app.get("/health", async () => ({ status: "ok" }));
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
  });
});
