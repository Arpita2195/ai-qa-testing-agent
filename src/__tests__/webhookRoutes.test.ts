import { createHmac } from "node:crypto";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import webhookRoutes from "../routes/webhooks";

vi.mock("../config/db", () => ({
  pool: {
    query: vi.fn().mockResolvedValue({
      rowCount: 1,
      rows: [{ id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" }],
    }),
  },
}));

vi.mock("../services/orchestrator/orchestrator", () => ({
  orchestrate: vi.fn().mockResolvedValue({
    correlation_id: "corr-1",
    status: "passed",
  }),
}));

describe("GitHub webhook routes", () => {
  let app: ReturnType<typeof Fastify> | undefined;
  const webhookSecret = "test-secret-webhook-key";

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GITHUB_WEBHOOK_SECRET = webhookSecret;
    app = Fastify();
    app.register(webhookRoutes);
  });

  function computeSignature(payload: string): string {
    const hmac = createHmac("sha256", webhookSecret);
    hmac.update(payload);
    return `sha256=${hmac.digest("hex")}`;
  }

  it("returns 400 when x-github-delivery header is missing", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/webhooks/github",
      payload: { action: "opened" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toHaveProperty("error", "Missing x-github-delivery header");
  });

  it("rejects invalid HMAC signatures when secret is configured", async () => {
    const payload = JSON.stringify({ action: "opened" });
    const res = await app!.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-invalid-sig-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbad",
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toHaveProperty("error", "Invalid webhook HMAC signature");
  });

  it("safely handles duplicate deliveries (idempotency)", async () => {
    const payload = JSON.stringify({
      action: "opened",
      pull_request: {
        number: 42,
        head: { sha: "abc123456789", ref: "feature-auth" },
        base: { ref: "main" },
      },
    });
    const sig = computeSignature(payload);

    // First delivery -> 202 Queued
    const res1 = await app!.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-dup-test-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sig,
      },
      payload,
    });
    expect(res1.statusCode).toBe(202);
    expect(res1.json()).toHaveProperty("status", "queued");

    // Duplicate delivery -> 200 duplicate_ignored
    const res2 = await app!.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-dup-test-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": sig,
      },
      payload,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json()).toHaveProperty("status", "duplicate_ignored");
  });

  it("acknowledges other GitHub events", async () => {
    const payload = JSON.stringify({ zen: "Keep it logically awesome." });
    const sig = computeSignature(payload);

    const res = await app!.inject({
      method: "POST",
      url: "/webhooks/github",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "delivery-ping-1",
        "x-github-event": "ping",
        "x-hub-signature-256": sig,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("status", "acknowledged");
  });
});
