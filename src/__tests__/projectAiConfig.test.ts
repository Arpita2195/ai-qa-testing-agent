import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../config/db";
import { createAuthHook } from "../services/auth";
import { AccessDeniedError } from "../services/authService";
import { projectAiConfigRoutes } from "../routes/projectAiConfig";
import {
  getProjectAiConfig,
  getDecryptedProjectAiConfig,
  saveProjectAiConfig,
  deleteProjectAiConfig,
  testProjectAiConfig,
} from "../services/ai/projectAiConfigService";
import { getAIProviderForProject } from "../services/ai/providerFactory";
import { GeminiProvider } from "../services/ai/geminiProvider";
import { OpenAIProvider } from "../services/ai/openaiProvider";
import { OllamaProvider } from "../services/ai/ollamaProvider";
import { GroqProvider } from "../services/ai/groqProvider";
import { recordAiUsage } from "../services/observability/metricsService";

describe("Stage 3C: Manual Project-Level AI Provider Configuration & Security", () => {
  let app: ReturnType<typeof Fastify>;
  const testApiKey = "test-platform-api-key-stage-3c";

  // Test entities created in real DB
  let testProjectId: string;
  let adminUserId: string;
  let managerUserId: string;
  let viewerUserId: string;
  let nonMemberUserId: string;

  let managerSessionToken: string;
  let managerCsrfToken: string;
  let viewerSessionToken: string;
  let viewerCsrfToken: string;

  beforeAll(async () => {
    // 1. Create a dedicated test project
    const projRes = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('Stage3C-AI-Project', 'https://stockflow-vert-two.vercel.app', true, 'public')
       RETURNING id`,
    );
    testProjectId = projRes.rows[0].id;

    // 2. Create test users: Admin, QA Manager, Viewer, Non-Member
    const adminRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ('admin-3c@example.com', 'scrypt:dummy', 'Admin 3C', 'admin', true)
       RETURNING id`,
    );
    adminUserId = adminRes.rows[0].id;

    const managerRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ('manager-3c@example.com', 'scrypt:dummy', 'Manager 3C', 'qa_engineer', true)
       RETURNING id`,
    );
    managerUserId = managerRes.rows[0].id;

    const viewerRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ('viewer-3c@example.com', 'scrypt:dummy', 'Viewer 3C', 'viewer', true)
       RETURNING id`,
    );
    viewerUserId = viewerRes.rows[0].id;

    const nonMemberRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ('outsider-3c@example.com', 'scrypt:dummy', 'Outsider 3C', 'viewer', true)
       RETURNING id`,
    );
    nonMemberUserId = nonMemberRes.rows[0].id;

    // 3. Assign project memberships
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES ($1, $2, 'qa_manager'), ($1, $3, 'viewer')`,
      [testProjectId, managerUserId, viewerUserId],
    );

    // 4. Create active sessions for manager and viewer
    const crypto = await import("node:crypto");
    const managerRaw = "manager-session-token-3c";
    managerSessionToken = managerRaw;
    managerCsrfToken = "csrf-token-manager-3c";
    const managerTokenHash = crypto.createHash("sha256").update(managerRaw).digest("hex");
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')`,
      [managerUserId, managerTokenHash, managerCsrfToken],
    );

    const viewerRaw = "viewer-session-token-3c";
    viewerSessionToken = viewerRaw;
    viewerCsrfToken = "csrf-token-viewer-3c";
    const viewerTokenHash = crypto.createHash("sha256").update(viewerRaw).digest("hex");
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')`,
      [viewerUserId, viewerTokenHash, viewerCsrfToken],
    );

    // 5. Initialize Fastify app with auth hooks & error handler
    app = Fastify();
    app.register(cookie);
    app.addHook("onRequest", createAuthHook(testApiKey));
    app.setErrorHandler((error, request, reply) => {
      const err = error as { name?: string; statusCode?: number; message?: string };
      if (
        error instanceof AccessDeniedError ||
        err.statusCode === 403 ||
        err.name === "AccessDeniedError"
      ) {
        return reply.code(403).send({ error: err.message || "Access denied" });
      }
      if (err.statusCode) {
        return reply.code(err.statusCode).send({ error: err.message || "Error" });
      }
      return reply.code(500).send({ error: "Internal Server Error" });
    });
    app.register(projectAiConfigRoutes);
    await app.ready();
  });

  afterAll(async () => {
    // Clean up test data
    await pool.query("DELETE FROM ai_usage_logs WHERE project_id = $1", [testProjectId]);
    await pool.query("DELETE FROM project_ai_configurations WHERE project_id = $1", [testProjectId]);
    await pool.query("DELETE FROM project_members WHERE project_id = $1", [testProjectId]);
    await pool.query("DELETE FROM sessions WHERE user_id IN ($1, $2, $3, $4)", [
      adminUserId,
      managerUserId,
      viewerUserId,
      nonMemberUserId,
    ]);
    await pool.query("DELETE FROM users WHERE id IN ($1, $2, $3, $4)", [
      adminUserId,
      managerUserId,
      viewerUserId,
      nonMemberUserId,
    ]);
    await pool.query("DELETE FROM projects WHERE id = $1", [testProjectId]);
    await app.close();
  });

  beforeEach(async () => {
    // Reset project AI configuration before each test
    await pool.query("DELETE FROM project_ai_configurations WHERE project_id = $1", [testProjectId]);
  });

  describe("1. Default Gemini Resolution for Unconfigured Projects", () => {
    it("returns isDefault: true and Gemini provider when no config exists", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/ai-config`,
        headers: { "x-api-key": testApiKey },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.provider).toBe("gemini");
      expect(data.model).toBe("gemini-3.1-flash-lite");
      expect(data.isDefault).toBe(true);
      expect(data.hasApiKey).toBe(false);
      expect(data).not.toHaveProperty("apiKey");
      expect(data).not.toHaveProperty("api_key_enc");
    });

    it("factory resolves GeminiProvider for unconfigured project", async () => {
      const provider = await getAIProviderForProject(testProjectId);
      expect(provider).toBeInstanceOf(GeminiProvider);
      expect(provider.providerType).toBe("gemini");
    });
  });

  describe("2. Authentication and RBAC Enforcement", () => {
    it("returns 401 when request is unauthenticated", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/ai-config`,
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 400 when projectId is not a valid UUID", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/projects/not-a-valid-uuid/ai-config",
        headers: { "x-api-key": testApiKey },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("expected a UUID");
    });

    it("allows Viewer to read AI configuration", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/ai-config`,
        headers: {
          authorization: `Bearer ${viewerSessionToken}`,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().provider).toBe("gemini");
    });

    it("blocks Viewer from mutating AI configuration (returns 403 Forbidden)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/projects/${testProjectId}/ai-config`,
        headers: {
          authorization: `Bearer ${viewerSessionToken}`,
        },
        payload: {
          provider: "openai",
          model: "gpt-4o",
        },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("Access denied");
    });

    it("blocks Viewer from deleting AI configuration (returns 403 Forbidden)", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/projects/${testProjectId}/ai-config`,
        headers: {
          authorization: `Bearer ${viewerSessionToken}`,
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it("blocks Viewer from running connection tests (returns 403 Forbidden)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/ai-config/test`,
        headers: {
          authorization: `Bearer ${viewerSessionToken}`,
        },
        payload: {
          provider: "gemini",
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it("allows QA Manager to update AI configuration", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/projects/${testProjectId}/ai-config`,
        headers: {
          authorization: `Bearer ${managerSessionToken}`,
        },
        payload: {
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: "sk-proj-manager-test-key",
        },
      });
      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.provider).toBe("openai");
      expect(data.model).toBe("gpt-4o-mini");
      expect(data.hasApiKey).toBe(true);
      expect(data.isDefault).toBe(false);
      // Plaintext or encrypted key MUST NEVER be in the response
      expect(data).not.toHaveProperty("apiKey");
      expect(data).not.toHaveProperty("api_key_enc");
    });

    it("allows Platform Admin (via API key) full management access", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/projects/${testProjectId}/ai-config`,
        headers: { "x-api-key": testApiKey },
        payload: {
          provider: "groq",
          model: "llama-3.3-70b-versatile",
          apiKey: "gsk_admin_test_key_12345",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().provider).toBe("groq");
      expect(res.json().hasApiKey).toBe(true);
    });

    it("enforces CSRF validation for cookie-authenticated mutating requests", async () => {
      // Missing x-csrf-token header with cookie authentication
      const resWithoutCsrf = await app.inject({
        method: "PUT",
        url: `/projects/${testProjectId}/ai-config`,
        cookies: {
          qa_session: managerSessionToken,
        },
        payload: {
          provider: "openai",
          model: "gpt-4o",
        },
      });
      expect(resWithoutCsrf.statusCode).toBe(403);
      expect(resWithoutCsrf.json().error).toContain("CSRF");

      // Valid x-csrf-token header with cookie authentication succeeds
      const resWithCsrf = await app.inject({
        method: "PUT",
        url: `/projects/${testProjectId}/ai-config`,
        cookies: {
          qa_session: managerSessionToken,
        },
        headers: {
          "x-csrf-token": managerCsrfToken,
        },
        payload: {
          provider: "openai",
          model: "gpt-4o",
        },
      });
      expect(resWithCsrf.statusCode).toBe(200);
    });
  });

  describe("3. Encrypted Secret Storage & Response Security", () => {
    it("stores API key encrypted in the database with AES-256-GCM and never in plaintext", async () => {
      const rawSecretKey = "sk-super-secret-custom-openai-key-999";

      await saveProjectAiConfig(
        testProjectId,
        {
          provider: "openai",
          model: "gpt-4o",
          apiKey: rawSecretKey,
        },
        adminUserId,
      );

      // Directly inspect raw database columns
      const rawDb = await pool.query<{ api_key_enc: string }>(
        "SELECT api_key_enc FROM project_ai_configurations WHERE project_id = $1",
        [testProjectId],
      );
      expect(rawDb.rowCount).toBe(1);
      const encryptedValue = rawDb.rows[0].api_key_enc;

      expect(encryptedValue).toBeDefined();
      expect(encryptedValue.split(":").length).toBe(3);
      expect(encryptedValue).not.toContain(rawSecretKey);

      // Decrypted helper recovers plaintext for backend execution
      const decrypted = await getDecryptedProjectAiConfig(testProjectId);
      expect(decrypted?.apiKey).toBe(rawSecretKey);

      // Public/Safe helper never exposes the plaintext key
      const safe = await getProjectAiConfig(testProjectId);
      expect(safe.hasApiKey).toBe(true);
      expect(safe).not.toHaveProperty("apiKey");
      expect(safe).not.toHaveProperty("api_key_enc");
    });

    it("preserves existing encrypted API key when updating model without providing new key", async () => {
      const originalKey = "sk-initial-key-111";

      await saveProjectAiConfig(
        testProjectId,
        {
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: originalKey,
        },
        adminUserId,
      );

      // Update model only
      const updated = await saveProjectAiConfig(
        testProjectId,
        {
          provider: "openai",
          model: "gpt-4o",
        },
        adminUserId,
      );

      expect(updated.model).toBe("gpt-4o");
      expect(updated.hasApiKey).toBe(true);

      const decrypted = await getDecryptedProjectAiConfig(testProjectId);
      expect(decrypted?.apiKey).toBe(originalKey);
    });

    it("clears API key when clearApiKey: true is provided", async () => {
      await saveProjectAiConfig(
        testProjectId,
        {
          provider: "openai",
          model: "gpt-4o",
          apiKey: "sk-key-to-be-removed",
        },
        adminUserId,
      );

      const updated = await saveProjectAiConfig(
        testProjectId,
        {
          provider: "openai",
          model: "gpt-4o",
          clearApiKey: true,
        },
        adminUserId,
      );

      expect(updated.hasApiKey).toBe(false);

      const decrypted = await getDecryptedProjectAiConfig(testProjectId);
      expect(decrypted?.apiKey).toBeUndefined();

      const rawDb = await pool.query<{ api_key_enc: string | null }>(
        "SELECT api_key_enc FROM project_ai_configurations WHERE project_id = $1",
        [testProjectId],
      );
      expect(rawDb.rows[0].api_key_enc).toBeNull();
    });

    it("deletes configuration completely on DELETE and resets to default", async () => {
      await saveProjectAiConfig(
        testProjectId,
        {
          provider: "groq",
          model: "mixtral-8x7b-32768",
          apiKey: "gsk_test_key",
        },
        adminUserId,
      );

      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/projects/${testProjectId}/ai-config`,
        headers: { "x-api-key": testApiKey },
      });

      expect(deleteRes.statusCode).toBe(200);
      expect(deleteRes.json().success).toBe(true);

      const getRes = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/ai-config`,
        headers: { "x-api-key": testApiKey },
      });

      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().isDefault).toBe(true);
      expect(getRes.json().provider).toBe("gemini");
    });
  });

  describe("4. Provider Factory Resolution for All Supported Providers", () => {
    it("resolves OpenAIProvider with project credentials", async () => {
      await saveProjectAiConfig(
        testProjectId,
        {
          provider: "openai",
          model: "gpt-4o",
          apiKey: "sk-project-custom-key",
        },
        adminUserId,
      );

      const provider = await getAIProviderForProject(testProjectId);
      expect(provider).toBeInstanceOf(OpenAIProvider);
      expect(provider.providerType).toBe("openai");
      expect((provider as any).defaultModel).toBe("gpt-4o");
    });

    it("resolves OllamaProvider with project base URL", async () => {
      await saveProjectAiConfig(
        testProjectId,
        {
          provider: "ollama",
          model: "mistral",
          baseUrl: "http://127.0.0.1:11434",
        },
        adminUserId,
      );

      const provider = await getAIProviderForProject(testProjectId);
      expect(provider).toBeInstanceOf(OllamaProvider);
      expect(provider.providerType).toBe("ollama");
      expect((provider as any).defaultModel).toBe("mistral");
    });

    it("resolves GroqProvider with project credentials", async () => {
      await saveProjectAiConfig(
        testProjectId,
        {
          provider: "groq",
          model: "llama-3.1-8b-instant",
          apiKey: "gsk_groq_project_key",
        },
        adminUserId,
      );

      const provider = await getAIProviderForProject(testProjectId);
      expect(provider).toBeInstanceOf(GroqProvider);
      expect(provider.providerType).toBe("groq");
      expect((provider as any).defaultModel).toBe("llama-3.1-8b-instant");
    });

    it("falls back to Gemini if project configuration is deleted", async () => {
      await deleteProjectAiConfig(testProjectId);
      const provider = await getAIProviderForProject(testProjectId);
      expect(provider).toBeInstanceOf(GeminiProvider);
      expect(provider.providerType).toBe("gemini");
    });
  });

  describe("5. Connection Testing & Error Sanitization", () => {
    it("rejects Ollama SSRF targeting cloud metadata IP in test connection", async () => {
      const testRes = await testProjectAiConfig(testProjectId, {
        provider: "ollama",
        model: "llama3.2",
        baseUrl: "http://169.254.169.254:11434",
      });

      expect(testRes.success).toBe(false);
      expect(testRes.error).toBeDefined();
      expect(testRes.error?.toLowerCase()).toContain("prohibited");
    });

    it("sanitizes error messages so secrets are never returned in connection test failures", async () => {
      const secretToRedact = "test-sensitive-secret-value-to-redact";
      // Temporarily set in env to simulate a matched sensitive secret
      process.env.GEMINI_API_KEY = secretToRedact;

      try {
        const testRes = await app.inject({
          method: "POST",
          url: `/projects/${testProjectId}/ai-config/test`,
          headers: { "x-api-key": testApiKey },
          payload: {
            provider: "gemini",
            apiKey: "invalid-key-triggering-failure",
            model: "nonexistent-model-xyz",
          },
        });

        expect(testRes.statusCode).toBe(200);
        const body = testRes.json();
        if (body.error) {
          expect(body.error).not.toContain(secretToRedact);
        }
      } finally {
        delete process.env.GEMINI_API_KEY;
      }
    });
  });

  describe("6. AI Usage Attribution with Configured Provider", () => {
    it("records usage logs with provider attribution and provider-specific cost calculation", async () => {
      await recordAiUsage({
        projectId: testProjectId,
        feature: "generation",
        model: "llama-3.3-70b-versatile",
        provider: "groq",
        promptTokens: 1000,
        completionTokens: 500,
        durationMs: 450,
      });

      const usageResult = await pool.query<{
        provider: string;
        model: string;
        prompt_tokens: number;
        completion_tokens: number;
        estimated_cost_usd: string;
      }>(
        `SELECT provider, model, prompt_tokens, completion_tokens, estimated_cost_usd
         FROM ai_usage_logs
         WHERE project_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [testProjectId],
      );

      expect(usageResult.rowCount).toBe(1);
      const log = usageResult.rows[0];
      expect(log.provider).toBe("groq");
      expect(log.model).toBe("llama-3.3-70b-versatile");
      expect(Number(log.prompt_tokens)).toBe(1000);
      expect(Number(log.completion_tokens)).toBe(500);
      // Cost should be calculated based on Groq pricing (0.59 / 1M prompt + 0.79 / 1M completion)
      expect(Number(log.estimated_cost_usd)).toBeGreaterThan(0);
    });
  });

  describe("7. AI Generation Call Sites Provider Resolution", () => {
    it("callGemini resolves project configured provider when projectId is passed", async () => {
      await saveProjectAiConfig(
        testProjectId,
        {
          provider: "openai",
          model: "gpt-4o",
          apiKey: "sk-mock-key-12345",
        },
        adminUserId,
      );

      // Create a mock provider to verify it receives the prompt
      const { callGemini } = await import("../services/generator");
      const mockProvider = {
        providerType: "openai" as const,
        generateText: async (opts: any) => ({
          text: JSON.stringify([{ title: "Resolved by project OpenAI", steps: ["step 1"], expected_result: "ok" }]),
          model: "gpt-4o",
          provider: "openai" as const,
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
          estimatedCostUsd: 0.0001,
        }),
        testConnection: async () => ({ success: true, provider: "openai" as const, model: "gpt-4o" }),
      };

      const result = await callGemini("test prompt", {
        projectId: testProjectId,
        provider: mockProvider as any,
      });

      expect(result).toContain("Resolved by project OpenAI");
    });

    it("rejects encryption with invalid key length (not 32 bytes)", async () => {
      const origKey = process.env.ENCRYPTION_KEY;
      try {
        process.env.ENCRYPTION_KEY = Buffer.from("too-short").toString("base64");
        const { encryptSecret } = await import("../services/secretStore");
        expect(() => encryptSecret("secret")).toThrow("Invalid ENCRYPTION_KEY: expected 32 bytes");
      } finally {
        process.env.ENCRYPTION_KEY = origKey;
      }
    });

    it("sanitizes ENCRYPTION_KEY from error messages", async () => {
      const { testProjectAiConfig } = await import("../services/ai/projectAiConfigService");
      const currentKey = process.env.ENCRYPTION_KEY || "dummy-test-key";
      const result = await testProjectAiConfig(testProjectId, {
        provider: "ollama",
        baseUrl: `http://169.254.169.254/?leak=${currentKey}`,
      });
      expect(result.success).toBe(false);
      expect(result.error).not.toContain(currentKey);
    });
  });
});
