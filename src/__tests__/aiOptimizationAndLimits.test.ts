import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../config/db";
import { createAuthHook } from "../services/auth";
import { AccessDeniedError } from "../services/authService";
import { projectAiConfigRoutes } from "../routes/projectAiConfig";
import {
  generateAiCacheKey,
  getAiResponseCache,
  setAiResponseCache,
  invalidateProjectAiCache,
  getProjectAiCacheStats,
} from "../services/ai/aiCacheService";
import {
  getProjectAiBudgetStatus,
  assertProjectAiBudgetAvailable,
  updateProjectAiBudgetLimits,
  reserveAiBudget,
  reconcileAiBudgetReservation,
  releaseAiBudgetReservation,
  cleanupExpiredReservations,
  renewAiBudgetReservation,
  startReservationHeartbeat,
  markReservationUncertain,
  isConfirmedProviderFailure,
} from "../services/ai/aiBudgetService";
import { analyzeFailure } from "../services/failureAnalyzer";
import { executeSingleFlight, renewDistributedLock } from "../services/ai/aiSingleFlight";
import { AIProviderError } from "../services/ai/types";
import {
  optimizePageElements,
  compactJson,
  compactRequirementText,
  compactPageDataForPrompt,
} from "../services/ai/promptOptimizer";
import { callGemini } from "../services/generator";
import { recordAiUsage } from "../services/observability/metricsService";
import type { PageElement } from "../services/pageReader";

describe("Stage 3D: AI Cost and Performance Optimization", () => {
  let app: ReturnType<typeof Fastify>;
  const testApiKey = "test-platform-api-key-stage-3d";

  let testProjectIdA: string;
  let testProjectIdB: string;
  let adminUserId: string;
  let managerUserId: string;
  let viewerUserId: string;

  let managerSessionToken: string;
  let managerCsrfToken: string;
  let viewerSessionToken: string;
  let viewerCsrfToken: string;

  beforeAll(async () => {
    // 1. Create two test projects for multi-tenant isolation testing
    const projARes = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('Stage3D-Project-A', 'https://app-a.example.com', true, 'public')
       RETURNING id`,
    );
    testProjectIdA = projARes.rows[0].id;

    const projBRes = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('Stage3D-Project-B', 'https://app-b.example.com', true, 'public')
       RETURNING id`,
    );
    testProjectIdB = projBRes.rows[0].id;

    // 2. Create test users: Admin, QA Manager, Viewer
    const adminRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ('admin-3d@example.com', 'scrypt:dummy', 'Admin 3D', 'admin', true)
       RETURNING id`,
    );
    adminUserId = adminRes.rows[0].id;

    const managerRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ('manager-3d@example.com', 'scrypt:dummy', 'Manager 3D', 'qa_engineer', true)
       RETURNING id`,
    );
    managerUserId = managerRes.rows[0].id;

    const viewerRes = await pool.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active)
       VALUES ('viewer-3d@example.com', 'scrypt:dummy', 'Viewer 3D', 'viewer', true)
       RETURNING id`,
    );
    viewerUserId = viewerRes.rows[0].id;

    // 3. Assign project memberships
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES ($1, $2, 'qa_manager'), ($1, $3, 'viewer'), ($4, $2, 'qa_manager')`,
      [testProjectIdA, managerUserId, viewerUserId, testProjectIdB],
    );

    // 4. Create active sessions for manager and viewer
    const crypto = await import("node:crypto");
    managerSessionToken = "manager-session-token-3d";
    managerCsrfToken = "csrf-token-manager-3d";
    const managerTokenHash = crypto.createHash("sha256").update(managerSessionToken).digest("hex");
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')`,
      [managerUserId, managerTokenHash, managerCsrfToken],
    );

    viewerSessionToken = "viewer-session-token-3d";
    viewerCsrfToken = "csrf-token-viewer-3d";
    const viewerTokenHash = crypto.createHash("sha256").update(viewerSessionToken).digest("hex");
    await pool.query(
      `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at)
       VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')`,
      [viewerUserId, viewerTokenHash, viewerCsrfToken],
    );

    // 5. Initialize Fastify app
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
      return reply.code(500).send({ error: error.message || "Internal server error" });
    });

    await app.register(projectAiConfigRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    // Clean up test data
    await pool.query("DELETE FROM ai_response_cache WHERE project_id IN ($1, $2)", [
      testProjectIdA,
      testProjectIdB,
    ]);
    await pool.query("DELETE FROM ai_cache_savings_logs WHERE project_id IN ($1, $2)", [
      testProjectIdA,
      testProjectIdB,
    ]);
    await pool.query("DELETE FROM ai_usage_logs WHERE project_id IN ($1, $2)", [
      testProjectIdA,
      testProjectIdB,
    ]);
    await pool.query("DELETE FROM project_ai_configurations WHERE project_id IN ($1, $2)", [
      testProjectIdA,
      testProjectIdB,
    ]);
    await pool.query("DELETE FROM project_members WHERE project_id IN ($1, $2)", [
      testProjectIdA,
      testProjectIdB,
    ]);
    await pool.query("DELETE FROM sessions WHERE user_id IN ($1, $2, $3)", [
      adminUserId,
      managerUserId,
      viewerUserId,
    ]);
    await pool.query("DELETE FROM users WHERE id IN ($1, $2, $3)", [
      adminUserId,
      managerUserId,
      viewerUserId,
    ]);
    await pool.query("DELETE FROM projects WHERE id IN ($1, $2)", [testProjectIdA, testProjectIdB]);
  });

  beforeEach(async () => {
    // Clear cache & limits between tests for project A
    await pool.query("DELETE FROM ai_response_cache WHERE project_id = $1", [testProjectIdA]);
    await pool.query("DELETE FROM ai_cache_savings_logs WHERE project_id = $1", [testProjectIdA]);
    await pool.query("DELETE FROM ai_usage_logs WHERE project_id = $1", [testProjectIdA]);
    await pool.query(
      `UPDATE project_ai_configurations
       SET max_cost_limit_usd = NULL, max_token_limit = NULL, warning_threshold_percent = 80,
           usage_limit_period = 'monthly', cache_enabled = true, cache_ttl_seconds = 86400
       WHERE project_id = $1`,
      [testProjectIdA],
    );
  });

  // =========================================================================
  // 1. Safe AI Response Caching & Project Isolation
  // =========================================================================
  describe("1. Safe AI Response Caching & Invalidation", () => {
    it("generates deterministic cache keys partitioned by project, provider, and model", () => {
      const key1 = generateAiCacheKey({
        projectId: testProjectIdA,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "test_generation",
        prompt: "Generate tests for login form",
      });

      const key2 = generateAiCacheKey({
        projectId: testProjectIdA,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "test_generation",
        prompt: "Generate  tests   for login form  ", // Normalized whitespace
      });

      const keyDiffProject = generateAiCacheKey({
        projectId: testProjectIdB,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "test_generation",
        prompt: "Generate tests for login form",
      });

      const keyDiffProvider = generateAiCacheKey({
        projectId: testProjectIdA,
        provider: "openai",
        model: "gpt-4o-mini",
        feature: "test_generation",
        prompt: "Generate tests for login form",
      });

      expect(key1).toBe(key2); // Whitespace invariance
      expect(key1).not.toBe(keyDiffProject); // Strict project isolation
      expect(key1).not.toBe(keyDiffProvider); // Provider partition
    });

    it("stores response in cache and retrieves on cache hit with savings tracked", async () => {
      const cacheKey = generateAiCacheKey({
        projectId: testProjectIdA,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "test_generation",
        prompt: "Verify checkout button",
      });

      // Initially empty
      const initial = await getAiResponseCache(testProjectIdA, cacheKey);
      expect(initial).toBeNull();

      // Store response
      const saved = await setAiResponseCache({
        projectId: testProjectIdA,
        cacheKey,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "test_generation",
        prompt: "Verify checkout button",
        responseText: '[{"title":"Checkout Flow"}]',
        promptTokens: 100,
        completionTokens: 50,
        estimatedCostUsd: 0.000045,
      });
      expect(saved).toBe(true);

      // Hit
      const cached = await getAiResponseCache(testProjectIdA, cacheKey);
      expect(cached).not.toBeNull();
      expect(cached?.text).toBe('[{"title":"Checkout Flow"}]');
      expect(cached?.hitCount).toBe(1);

      // Verify savings recorded in ai_cache_savings_logs
      const savingsRes = await pool.query<{ saved_tokens: string; saved_cost_usd: string }>(
        "SELECT saved_tokens, saved_cost_usd FROM ai_cache_savings_logs WHERE project_id = $1",
        [testProjectIdA],
      );
      expect(savingsRes.rows.length).toBe(1);
      expect(parseInt(savingsRes.rows[0].saved_tokens, 10)).toBe(150);
      expect(parseFloat(savingsRes.rows[0].saved_cost_usd)).toBeCloseTo(0.000045, 6);

      // Confirm cache hits do NOT insert into billable ai_usage_logs
      const billableRes = await pool.query("SELECT COUNT(*) FROM ai_usage_logs WHERE project_id = $1", [
        testProjectIdA,
      ]);
      expect(parseInt(billableRes.rows[0].count, 10)).toBe(0);
    });

    it("enforces strict project boundary isolation between Project A and Project B", async () => {
      const prompt = "Shared generic prompt";
      const keyA = generateAiCacheKey({
        projectId: testProjectIdA,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "test_generation",
        prompt,
      });
      const keyB = generateAiCacheKey({
        projectId: testProjectIdB,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "test_generation",
        prompt,
      });

      await setAiResponseCache({
        projectId: testProjectIdA,
        cacheKey: keyA,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "test_generation",
        prompt,
        responseText: "Project A Secret Response",
        promptTokens: 100,
        completionTokens: 50,
        estimatedCostUsd: 0.000045,
      });

      // Project B querying its key cannot see Project A response
      const cachedB = await getAiResponseCache(testProjectIdB, keyB);
      expect(cachedB).toBeNull();

      // Project B querying keyA with project B ID is rejected
      const maliciousCrossQuery = await getAiResponseCache(testProjectIdB, keyA);
      expect(maliciousCrossQuery).toBeNull();
    });

    it("strictly prevents caching when sensitive credentials or keys are detected in prompt or response", async () => {
      const sensitivePrompt = "Test login with bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz and sk-1234567890abcdef1234567890";
      const key = generateAiCacheKey({
        projectId: testProjectIdA,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "login_test",
        prompt: sensitivePrompt,
      });

      const saved = await setAiResponseCache({
        projectId: testProjectIdA,
        cacheKey: key,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "login_test",
        prompt: sensitivePrompt,
        responseText: '[{"title":"Test with leaked sk-secret"}]',
        promptTokens: 100,
        completionTokens: 50,
        estimatedCostUsd: 0.000045,
      });

      // Excluded from cache for security
      expect(saved).toBe(false);

      const check = await getAiResponseCache(testProjectIdA, key);
      expect(check).toBeNull();
    });

    it("invalidates all project cached responses on invalidateProjectAiCache", async () => {
      const key1 = generateAiCacheKey({
        projectId: testProjectIdA,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "f1",
        prompt: "Prompt 1",
      });
      const key2 = generateAiCacheKey({
        projectId: testProjectIdA,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "f2",
        prompt: "Prompt 2",
      });

      await setAiResponseCache({
        projectId: testProjectIdA,
        cacheKey: key1,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "f1",
        prompt: "Prompt 1",
        responseText: "Output 1",
        promptTokens: 50,
        completionTokens: 25,
        estimatedCostUsd: 0.00002,
      });

      await setAiResponseCache({
        projectId: testProjectIdA,
        cacheKey: key2,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "f2",
        prompt: "Prompt 2",
        responseText: "Output 2",
        promptTokens: 50,
        completionTokens: 25,
        estimatedCostUsd: 0.00002,
      });

      const deleted = await invalidateProjectAiCache(testProjectIdA);
      expect(deleted).toBe(2);

      const hit1 = await getAiResponseCache(testProjectIdA, key1);
      const hit2 = await getAiResponseCache(testProjectIdA, key2);
      expect(hit1).toBeNull();
      expect(hit2).toBeNull();
    });
  });

  // =========================================================================
  // 2. Token & Prompt Optimization
  // =========================================================================
  describe("2. Token & Prompt Optimization", () => {
    it("prunes non-semantic wrapper DOM nodes while strictly retaining interactive elements", () => {
      const noisyElements: PageElement[] = [
        { tag: "div", selector: "#wrapper1", text: "" }, // Noisy empty wrapper -> prune
        { tag: "span", selector: ".container > .spacer", text: "" }, // Noisy empty spacer -> prune
        { tag: "button", selector: "button#submit-btn", text: "Submit Order" }, // Interactive -> keep
        { tag: "input", selector: "input#email", type: "email", name: "email", placeholder: "you@example.com", text: "" }, // Form input -> keep
        { tag: "select", selector: "select#country", name: "country", text: "" }, // Select -> keep
        { tag: "h1", selector: "h1.page-title", text: "Shopping Cart Checkout" }, // Heading -> keep
      ];

      const optimized = optimizePageElements(noisyElements);
      expect(optimized.length).toBe(4);
      expect(optimized.some((el) => el.tag === "button" && el.text === "Submit Order")).toBe(true);
      expect(optimized.some((el) => el.tag === "input" && el.selector === "input#email")).toBe(true);
      expect(optimized.some((el) => el.tag === "div" && el.selector === "#wrapper1")).toBe(false);
    });

    it("compacts highly repetitive element clusters to a representative sample", () => {
      const repetitiveElements: PageElement[] = [];
      // 50 identical repetitive table cells
      for (let i = 0; i < 50; i++) {
        repetitiveElements.push({
          tag: "td",
          selector: `table.data-grid > tr > td.cell-item-${i}`,
          text: `Row item ${i}`,
        });
      }
      repetitiveElements.push({
        tag: "button",
        selector: "button.action-apply",
        text: "Apply Filter",
      });

      const optimized = optimizePageElements(repetitiveElements, 5);
      // Repetitive td elements should be capped to 5, plus the 1 button = 6 elements
      expect(optimized.length).toBe(6);
      expect(optimized.filter((el) => el.tag === "td").length).toBe(5);
      expect(optimized.some((el) => el.tag === "button")).toBe(true);
    });

    it("compactJson strips whitespace and indentation without altering data", () => {
      const sample = {
        title: "Test Login",
        steps: ["goto /login", "fill #email | user@test.com", "click #login-btn"],
      };

      const indented = JSON.stringify(sample, null, 2);
      const compacted = compactJson(sample);

      expect(compacted.length).toBeLessThan(indented.length);
      expect(JSON.parse(compacted)).toEqual(sample);
      expect(compacted).not.toContain("\n");
    });

    it("compactRequirementText normalizes irregular whitespace and noisy linebreaks", () => {
      const noisyText = `
        User should be able to    log in with valid credentials.

        Expected:
           Redirect to /dashboard
           Display welcome   banner.
      `;

      const compacted = compactRequirementText(noisyText);
      expect(compacted).not.toContain("   ");
      expect(compacted).toContain("User should be able to log in with valid credentials.");
      expect(compacted).toContain("Redirect to /dashboard");
    });
  });

  // =========================================================================
  // 3. Project-Level AI Usage Limits & Budget Controls
  // =========================================================================
  describe("3. Project-Level AI Usage Limits & Budget Controls", () => {
    it("reports allowed when usage is within limits and accurately aggregates consumed cost/tokens", async () => {
      // Configure $5.00 limit
      await updateProjectAiBudgetLimits(testProjectIdA, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 5.0,
        maxTokenLimit: 1000000,
        warningThresholdPercent: 80,
      });

      // Record some usage
      await recordAiUsage({
        projectId: testProjectIdA,
        feature: "test_gen",
        model: "gemini-2.5-flash",
        provider: "gemini",
        promptTokens: 10000,
        completionTokens: 2500,
        durationMs: 450,
      });

      const status = await getProjectAiBudgetStatus(testProjectIdA);
      expect(status.allowed).toBe(true);
      expect(status.isWarning).toBe(false);
      expect(status.currentTokens).toBe(12500);
      expect(status.currentCostUsd).toBeGreaterThan(0);
      expect(status.maxCostLimitUsd).toBe(5.0);
      expect(status.costPercentUsed).toBeLessThan(80);
    });

    it("triggers warning flag when usage crosses warning threshold", async () => {
      // Configure $0.001 limit with 80% threshold
      await updateProjectAiBudgetLimits(testProjectIdA, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 0.001,
        warningThresholdPercent: 80,
      });

      // Insert usage that reaches ~90% of $0.001 ($0.0009)
      await pool.query(
        `INSERT INTO ai_usage_logs (project_id, feature, model, provider, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd)
         VALUES ($1, 'test', 'gemini-2.5-flash', 'gemini', 5000, 1000, 6000, 0.0009)`,
        [testProjectIdA],
      );

      const status = await getProjectAiBudgetStatus(testProjectIdA);
      expect(status.allowed).toBe(true);
      expect(status.isWarning).toBe(true);
      expect(status.costPercentUsed).toBeGreaterThanOrEqual(80);
    });

    it("strictly blocks generation with 429 BUDGET_EXCEEDED when cost limit is exhausted", async () => {
      // Set cap to $0.0005
      await updateProjectAiBudgetLimits(testProjectIdA, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 0.0005,
        warningThresholdPercent: 80,
      });

      // Insert usage of $0.0006 (exceeding cap)
      await pool.query(
        `INSERT INTO ai_usage_logs (project_id, feature, model, provider, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd)
         VALUES ($1, 'test', 'gemini-2.5-flash', 'gemini', 5000, 2000, 7000, 0.0006)`,
        [testProjectIdA],
      );

      const status = await getProjectAiBudgetStatus(testProjectIdA);
      expect(status.allowed).toBe(false);

      // Calling assertProjectAiBudgetAvailable should throw 429 BUDGET_EXCEEDED
      await expect(assertProjectAiBudgetAvailable(testProjectIdA)).rejects.toMatchObject({
        code: "BUDGET_EXCEEDED",
        statusCode: 429,
        retryable: false,
      });
    });

    it("strictly blocks generation with 429 BUDGET_EXCEEDED when token limit is exhausted", async () => {
      // Set cap to 5,000 tokens
      await updateProjectAiBudgetLimits(testProjectIdA, {
        usageLimitPeriod: "monthly",
        maxTokenLimit: 5000,
        warningThresholdPercent: 80,
      });

      // Insert 6,000 tokens consumed
      await pool.query(
        `INSERT INTO ai_usage_logs (project_id, feature, model, provider, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd)
         VALUES ($1, 'test', 'gemini-2.5-flash', 'gemini', 4000, 2000, 6000, 0.0003)`,
        [testProjectIdA],
      );

      await expect(assertProjectAiBudgetAvailable(testProjectIdA)).rejects.toMatchObject({
        code: "BUDGET_EXCEEDED",
        statusCode: 429,
        retryable: false,
      });
    });
  });

  // =========================================================================
  // 4. Duplicate Request Protection & Single-Flight Execution
  // =========================================================================
  describe("4. Duplicate AI Request Protection & Single-Flight", () => {
    it("deduplicates concurrent identical in-flight requests into a single execution", async () => {
      let executionCount = 0;

      const slowProviderCall = async () => {
        executionCount++;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { answer: "42", tokens: 10 };
      };

      // Launch 3 simultaneous identical calls
      const [res1, res2, res3] = await Promise.all([
        executeSingleFlight("flight-test-key-1", slowProviderCall),
        executeSingleFlight("flight-test-key-1", slowProviderCall),
        executeSingleFlight("flight-test-key-1", slowProviderCall),
      ]);

      // Exactly ONE underlying execution occurred
      expect(executionCount).toBe(1);
      expect(res1.result).toEqual({ answer: "42", tokens: 10 });
      expect(res2.result).toEqual({ answer: "42", tokens: 10 });
      expect(res3.result).toEqual({ answer: "42", tokens: 10 });

      // Callers 2 and 3 should have wasShared: true
      const sharedCount = [res1.wasShared, res2.wasShared, res3.wasShared].filter(Boolean).length;
      expect(sharedCount).toBe(2);
    });
  });

  // =========================================================================
  // 5. REST APIs, RBAC, and Audit Logging
  // =========================================================================
  describe("5. REST APIs, RBAC & Audit Logging", () => {
    it("GET /projects/:id/ai-config/usage: allows Viewer to read budget and cache stats", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectIdA}/ai-config/usage`,
        cookies: { qa_session: viewerSessionToken },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.projectId).toBe(testProjectIdA);
      expect(data.budget).toBeDefined();
      expect(data.cache).toBeDefined();
      expect(typeof data.budget.allowed).toBe("boolean");
      expect(typeof data.cache.totalCachedEntries).toBe("number");
    });

    it("PUT /projects/:id/ai-config/limits: blocks Viewer with 403 Forbidden", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/projects/${testProjectIdA}/ai-config/limits`,
        cookies: { qa_session: viewerSessionToken },
        headers: { "x-csrf-token": viewerCsrfToken },
        payload: { maxCostLimitUsd: 100 },
      });

      expect(res.statusCode).toBe(403);
    });

    it("PUT /projects/:id/ai-config/limits: requires CSRF token for cookie authentication", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/projects/${testProjectIdA}/ai-config/limits`,
        cookies: { qa_session: managerSessionToken },
        // Missing x-csrf-token header
        payload: { maxCostLimitUsd: 50.0 },
      });

      expect(res.statusCode).toBe(403);
    });

    it("PUT /projects/:id/ai-config/limits: allows QA Manager with valid CSRF to update limits", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/projects/${testProjectIdA}/ai-config/limits`,
        cookies: { qa_session: managerSessionToken },
        headers: { "x-csrf-token": managerCsrfToken },
        payload: {
          usageLimitPeriod: "daily",
          maxCostLimitUsd: 25.5,
          maxTokenLimit: 200000,
          warningThresholdPercent: 75,
          cacheEnabled: true,
          cacheTtlSeconds: 43200,
        },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.success).toBe(true);
      expect(data.budget.period).toBe("daily");
      expect(data.budget.maxCostLimitUsd).toBe(25.5);
      expect(data.budget.maxTokenLimit).toBe(200000);
      expect(data.budget.warningThresholdPercent).toBe(75);

      // Verify audit log event
      const auditRes = await pool.query<{ action: string; outcome: string }>(
        "SELECT action, outcome FROM audit_logs WHERE project_id = $1 AND action = 'PROJECT_AI_BUDGET_LIMITS_UPDATED'",
        [testProjectIdA],
      );
      expect(auditRes.rows.length).toBeGreaterThanOrEqual(1);
      expect(auditRes.rows[0].outcome).toBe("success");
    });

    it("POST /projects/:id/ai-config/cache/clear: allows QA Manager to flush project cache", async () => {
      // Seed a cache entry
      const key = generateAiCacheKey({
        projectId: testProjectIdA,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "test_gen",
        prompt: "Flush test prompt",
      });
      await setAiResponseCache({
        projectId: testProjectIdA,
        cacheKey: key,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "test_gen",
        prompt: "Flush test prompt",
        responseText: "Flush me",
        promptTokens: 10,
        completionTokens: 5,
        estimatedCostUsd: 0.00001,
      });

      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectIdA}/ai-config/cache/clear`,
        cookies: { qa_session: managerSessionToken },
        headers: { "x-csrf-token": managerCsrfToken },
      });

      expect(res.statusCode).toBe(200);
      const data = res.json();
      expect(data.success).toBe(true);
      expect(data.clearedEntries).toBe(1);

      // Cache stats should now show 0 active entries
      const stats = await getProjectAiCacheStats(testProjectIdA);
      expect(stats.totalCachedEntries).toBe(0);

      // Verify audit log event
      const auditRes = await pool.query<{ action: string; outcome: string }>(
        "SELECT action, outcome FROM audit_logs WHERE project_id = $1 AND action = 'PROJECT_AI_CACHE_CLEARED'",
        [testProjectIdA],
      );
      expect(auditRes.rows.length).toBeGreaterThanOrEqual(1);
      expect(auditRes.rows[0].outcome).toBe("success");
    });
  });

  // =========================================================================
  // 6. End-to-End Optimization Pipeline in callGemini
  // =========================================================================
  describe("6. End-to-End AI Optimization Pipeline in Generator", () => {
    it("callGemini serves identical subsequent prompts from cache with zero duplicate provider calls", async () => {
      const prompt = `Return a JSON array of test cases: [{"title":"Cart item test","description":"desc","steps":["goto /cart"],"expected_result":"Cart loaded"}]`;

      const { getAIProviderForProject } = await import("../services/ai/providerFactory");
      const provider = await getAIProviderForProject(testProjectIdA);

      // Pre-seed cache entry matching the exact provider and model resolved for this project
      const cacheKey = generateAiCacheKey({
        projectId: testProjectIdA,
        provider: provider.providerType,
        model: provider.defaultModel,
        feature: "test_generation",
        prompt,
        responseFormat: "json",
      });

      await setAiResponseCache({
        projectId: testProjectIdA,
        cacheKey,
        provider: provider.providerType,
        model: provider.defaultModel,
        feature: "test_generation",
        prompt,
        responseText: '[{"title":"Cached Cart item test"}]',
        promptTokens: 100,
        completionTokens: 20,
        estimatedCostUsd: 0.000027,
      });

      // callGemini should serve the cached response without invoking GoogleGenAI
      const output = await callGemini(prompt, { projectId: testProjectIdA });
      expect(output).toBe('[{"title":"Cached Cart item test"}]');

      // Check cache stats incremented hit
      const stats = await getProjectAiCacheStats(testProjectIdA);
      expect(stats.totalHits).toBe(1);
    });

    it("callGemini is blocked before provider invocation when project budget is exceeded", async () => {
      // Set cap to $0.0001
      await updateProjectAiBudgetLimits(testProjectIdA, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 0.0001,
      });

      // Exceed budget
      await pool.query(
        `INSERT INTO ai_usage_logs (project_id, feature, model, provider, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd)
         VALUES ($1, 'test', 'gemini-2.5-flash', 'gemini', 5000, 2000, 7000, 0.0005)`,
        [testProjectIdA],
      );

      const prompt = "Fresh prompt that misses cache";
      await expect(callGemini(prompt, { projectId: testProjectIdA })).rejects.toMatchObject({
        code: "BUDGET_EXCEEDED",
        statusCode: 429,
        retryable: false,
      });
    });
  });

  // =========================================================================
  // 7. Stage 3D Audit - Concurrency, Cache Dimensions, and Distributed Single Flight
  // =========================================================================
  describe("7. Stage 3D Audit - Concurrency, Cache Dimensions, and Distributed Single Flight", () => {
    let testProjectIdC: string;

    beforeAll(async () => {
      const projCRes = await pool.query<{ id: string }>(
        `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
         VALUES ('Stage3D-Audit-Project', 'https://app-c.example.com', true, 'public')
         RETURNING id`,
      );
      testProjectIdC = projCRes.rows[0].id;
    });

    it("concurrent budget reservations serialize and reject requests exceeding hard cap", async () => {
      // Set cap to $0.001
      await updateProjectAiBudgetLimits(testProjectIdC, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 0.001,
      });

      // Clear any prior reservations or usage logs for project C
      await pool.query("DELETE FROM ai_budget_reservations WHERE project_id = $1", [testProjectIdC]);
      await pool.query("DELETE FROM ai_usage_logs WHERE project_id = $1", [testProjectIdC]);

      // Launch 4 concurrent reservation requests, each for $0.0004
      // Hard cap is $0.001. Exactly 2 requests ($0.0008) can fit.
      // The 3rd and 4th requests ($0.0012) must be blocked with BUDGET_EXCEEDED (status 429).
      const results = await Promise.allSettled([
        reserveAiBudget(testProjectIdC, { estimatedCostUsd: 0.0004, feature: "test1" }),
        reserveAiBudget(testProjectIdC, { estimatedCostUsd: 0.0004, feature: "test2" }),
        reserveAiBudget(testProjectIdC, { estimatedCostUsd: 0.0004, feature: "test3" }),
        reserveAiBudget(testProjectIdC, { estimatedCostUsd: 0.0004, feature: "test4" }),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
      const rejected = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];

      expect(fulfilled.length).toBe(2);
      expect(rejected.length).toBe(2);

      for (const rej of rejected) {
        expect(rej.reason).toMatchObject({
          code: "BUDGET_EXCEEDED",
          statusCode: 429,
        });
      }

      // Check budget status: active reservations total 0.0008
      const status = await getProjectAiBudgetStatus(testProjectIdC);
      expect(status.activeReservationsCostUsd).toBeCloseTo(0.0008, 4);

      // Clean up fulfilled reservations
      for (const res of fulfilled) {
        await releaseAiBudgetReservation(res.value.id);
      }
    });

    it("reconcileAiBudgetReservation commits actual usage and prevents double-reconciliation", async () => {
      // Reset limits and reservations for this test
      await updateProjectAiBudgetLimits(testProjectIdC, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 10.0,
      });
      await pool.query("DELETE FROM ai_budget_reservations WHERE project_id = $1", [testProjectIdC]);
      await pool.query("DELETE FROM ai_usage_logs WHERE project_id = $1", [testProjectIdC]);

      const res = await reserveAiBudget(testProjectIdC, {
        estimatedCostUsd: 0.0005,
        estimatedTokens: 1000,
        feature: "test_rec",
      });

      expect(res.status).toBe("active");

      // Reconcile with actual provider figures
      await reconcileAiBudgetReservation(res.id, {
        promptTokens: 120,
        completionTokens: 80,
        estimatedCostUsd: 0.0003,
        model: "gemini-2.5-flash",
        provider: "gemini",
        feature: "test_rec",
        durationMs: 45,
      });

      // Verify row in ai_budget_reservations is updated to reconciled
      const checkRes = await pool.query<{ status: string }>(
        "SELECT status FROM ai_budget_reservations WHERE id = $1",
        [res.id],
      );
      expect(checkRes.rows[0].status).toBe("reconciled");

      // Verify ai_usage_logs contains the reconciled usage
      const usageRes = await pool.query<{ total_tokens: number; estimated_cost_usd: string }>(
        "SELECT total_tokens, estimated_cost_usd FROM ai_usage_logs WHERE project_id = $1 AND feature = 'test_rec'",
        [testProjectIdC],
      );
      expect(usageRes.rows.length).toBe(1);
      expect(usageRes.rows[0].total_tokens).toBe(200);

      // Re-reconciling or releasing is idempotent (no double billing)
      await reconcileAiBudgetReservation(res.id, {
        promptTokens: 999,
        completionTokens: 999,
        estimatedCostUsd: 0.99,
        model: "gemini-2.5-flash",
        provider: "gemini",
        feature: "test_rec",
        durationMs: 50,
      });
      const checkDouble = await pool.query<{ total_tokens: number }>(
        "SELECT total_tokens FROM ai_usage_logs WHERE project_id = $1 AND feature = 'test_rec'",
        [testProjectIdC],
      );
      expect(checkDouble.rows.length).toBe(1);
      expect(checkDouble.rows[0].total_tokens).toBe(200);
    });

    it("releaseAiBudgetReservation frees active capacity immediately", async () => {
      // Set cap to $0.0005
      await updateProjectAiBudgetLimits(testProjectIdC, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 0.0005,
      });

      // Clear any prior reservations or usage logs for project C
      await pool.query("DELETE FROM ai_budget_reservations WHERE project_id = $1", [testProjectIdC]);
      await pool.query("DELETE FROM ai_usage_logs WHERE project_id = $1", [testProjectIdC]);

      // Reserve the entire remaining budget
      const res = await reserveAiBudget(testProjectIdC, {
        estimatedCostUsd: 0.0005,
        feature: "test_release",
      });

      // Another reservation should fail
      await expect(
        reserveAiBudget(testProjectIdC, { estimatedCostUsd: 0.0001 }),
      ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });

      // Release the reservation (e.g. simulated provider failure)
      await releaseAiBudgetReservation(res.id);

      // Verify status is released
      const checkRes = await pool.query<{ status: string }>(
        "SELECT status FROM ai_budget_reservations WHERE id = $1",
        [res.id],
      );
      expect(checkRes.rows[0].status).toBe("released");

      // Now reservation succeeds because capacity was restored
      const secondRes = await reserveAiBudget(testProjectIdC, {
        estimatedCostUsd: 0.0001,
        feature: "test_after_release",
      });
      expect(secondRes.id).toBeDefined();
      await releaseAiBudgetReservation(secondRes.id);
    });

    it("cleanupExpiredReservations expires stale reservations older than TTL", async () => {
      // Insert a reservation with expired expires_at
      const staleInsert = await pool.query<{ id: string }>(
        `INSERT INTO ai_budget_reservations (project_id, reserved_tokens, reserved_cost_usd, status, expires_at, feature)
         VALUES ($1, 500, 0.0002, 'active', NOW() - INTERVAL '10 minutes', 'stale_test')
         RETURNING id`,
        [testProjectIdC],
      );
      const staleId = staleInsert.rows[0].id;

      const expiredCount = await cleanupExpiredReservations();
      expect(expiredCount).toBeGreaterThanOrEqual(1);

      const check = await pool.query<{ status: string }>(
        "SELECT status FROM ai_budget_reservations WHERE id = $1",
        [staleId],
      );
      expect(check.rows[0].status).toBe("expired");
    });

    it("generateAiCacheKey differentiates on temperature, maxOutputTokens, topP, contextVersion, and canonical options", () => {
      const baseParams = {
        projectId: testProjectIdC,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "test_gen",
        prompt: "Generate tests for login",
      };

      const keyBase = generateAiCacheKey(baseParams);

      // Temperature differences
      const keyTempA = generateAiCacheKey({ ...baseParams, temperature: 0.2 });
      const keyTempB = generateAiCacheKey({ ...baseParams, temperature: 0.7 });
      expect(keyTempA).not.toBe(keyTempB);
      expect(keyTempA).not.toBe(keyBase);

      // maxOutputTokens differences
      const keyTokensA = generateAiCacheKey({ ...baseParams, maxOutputTokens: 1000 });
      const keyTokensB = generateAiCacheKey({ ...baseParams, maxOutputTokens: 2000 });
      expect(keyTokensA).not.toBe(keyTokensB);

      // topP differences
      const keyTopPA = generateAiCacheKey({ ...baseParams, topP: 0.9 });
      const keyTopPB = generateAiCacheKey({ ...baseParams, topP: 0.95 });
      expect(keyTopPA).not.toBe(keyTopPB);

      // contextVersion differences
      const keyVerA = generateAiCacheKey({ ...baseParams, contextVersion: "v1" });
      const keyVerB = generateAiCacheKey({ ...baseParams, contextVersion: "v2" });
      expect(keyVerA).not.toBe(keyVerB);

      // options object sorting canonical equality
      const keyOpts1 = generateAiCacheKey({ ...baseParams, options: { b: 2, a: 1 } });
      const keyOpts2 = generateAiCacheKey({ ...baseParams, options: { a: 1, b: 2 } });
      expect(keyOpts1).toBe(keyOpts2);

      // options value difference
      const keyOpts3 = generateAiCacheKey({ ...baseParams, options: { a: 1, b: 99 } });
      expect(keyOpts1).not.toBe(keyOpts3);
    });

    it("distributed single-flight coordinates leader and follower with cache pickup", async () => {
      const testFingerprint = `dist-sf-test-${Date.now()}`;
      let executionCount = 0;

      // Two workers request the same fingerprint concurrently
      const [worker1, worker2] = await Promise.all([
        executeSingleFlight(
          testFingerprint,
          async () => {
            executionCount++;
            await new Promise((resolve) => setTimeout(resolve, 80));
            // Simulate saving to cache upon completion
            await setAiResponseCache({
              projectId: testProjectIdC,
              cacheKey: testFingerprint,
              provider: "gemini",
              model: "gemini-2.5-flash",
              feature: "test_sf",
              prompt: "prompt",
              responseText: "Shared Result from Worker 1",
            });
            return "Shared Result from Worker 1";
          },
          {
            projectId: testProjectIdC,
            onCacheCheck: async () => {
              const cached = await getAiResponseCache(testProjectIdC, testFingerprint);
              return cached?.text;
            },
          },
        ),
        executeSingleFlight(
          testFingerprint,
          async () => {
            executionCount++;
            return "Worker 2 Result";
          },
          {
            projectId: testProjectIdC,
            onCacheCheck: async () => {
              const cached = await getAiResponseCache(testProjectIdC, testFingerprint);
              return cached?.text;
            },
          },
        ),
      ]);

      // Exactly one worker executed the underlying function
      expect(executionCount).toBe(1);
      expect(worker1.result).toBe("Shared Result from Worker 1");
      expect(worker2.result).toBe("Shared Result from Worker 1");
      expect(worker1.wasShared || worker2.wasShared).toBe(true);

      // In-flight lock in DB is released
      const lockRes = await pool.query(
        "SELECT * FROM ai_in_flight_locks WHERE fingerprint = $1",
        [testFingerprint],
      );
      expect(lockRes.rows.length).toBe(0);
    });

    it("distributed single-flight recovers gracefully from expired stale locks", async () => {
      const staleFingerprint = `stale-lock-test-${Date.now()}`;

      // Insert an already-expired lock
      await pool.query(
        `INSERT INTO ai_in_flight_locks (fingerprint, locked_by, created_at, expires_at)
         VALUES ($1, 'dead-worker-pid', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '10 seconds')`,
        [staleFingerprint],
      );

      // A new worker attempts to acquire the lock
      let executed = false;
      const res = await executeSingleFlight(
        staleFingerprint,
        async () => {
          executed = true;
          return "Recovered from stale lock";
        },
        { projectId: testProjectIdC },
      );

      expect(executed).toBe(true);
      expect(res.result).toBe("Recovered from stale lock");
      expect(res.wasShared).toBe(false);
    });

    it("context-sensitive failure analysis bypasses cache and enforces budget", async () => {
      // 1. Reset budget on testProjectIdC to a generous amount
      await updateProjectAiBudgetLimits(testProjectIdC, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 100.0,
      });

      // Pre-seed a cache entry for failure analysis prompt
      const failurePromptFragment = "Analyze this test failure";
      const failureCacheKey = generateAiCacheKey({
        projectId: testProjectIdC,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "failure_analysis",
        prompt: failurePromptFragment,
      });
      await setAiResponseCache({
        projectId: testProjectIdC,
        cacheKey: failureCacheKey,
        provider: "gemini",
        model: "gemini-2.5-flash",
        feature: "failure_analysis",
        prompt: failurePromptFragment,
        responseText: JSON.stringify({
          title: "Stale Cached Title",
          description: "Stale Cached Description",
          severity: "low",
          classification: "unknown",
          probable_cause: "Stale",
          reproduction_steps: ["Step 1"],
        }),
      });

      // 2. Exhaust budget for testProjectIdC to verify failure analysis enforces budget
      await updateProjectAiBudgetLimits(testProjectIdC, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 0.0001,
      });
      await pool.query(
        `INSERT INTO ai_usage_logs (project_id, feature, model, provider, prompt_tokens, completion_tokens, total_tokens, estimated_cost_usd)
         VALUES ($1, 'fill', 'gemini-2.5-flash', 'gemini', 1000, 1000, 2000, 0.001)`,
        [testProjectIdC],
      );

      // analyzeFailure must fail with BUDGET_EXCEEDED (429) rather than returning stale cached response
      await expect(
        analyzeFailure(
          {
            title: "Test login failed",
            steps: ["goto /login", "click #submit"],
            expected_result: "Dashboard displayed",
            errorMessage: "Element not found: #submit",
            pageUrl: "https://app-c.example.com/login",
          },
          { projectId: testProjectIdC },
        ),
      ).rejects.toMatchObject({
        code: "BUDGET_EXCEEDED",
        statusCode: 429,
      });
    });
  });

  // =========================================================================
  // 8. Stage 3D Final Targeted Audit: Expiry, Heartbeat, Uncertainty & Concurrency
  // =========================================================================
  describe("8. Stage 3D Final Targeted Audit: Expiry, Heartbeat, Uncertainty & Concurrency", () => {
    let testProjectIdD: string;

    beforeAll(async () => {
      const projDRes = await pool.query<{ id: string }>(
        `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
         VALUES ('Stage3D-Targeted-Audit-Project', 'https://app-d.example.com', true, 'public')
         RETURNING id`,
      );
      testProjectIdD = projDRes.rows[0].id;
    });

    beforeEach(async () => {
      await pool.query("DELETE FROM ai_budget_reservations WHERE project_id = $1", [testProjectIdD]);
      await pool.query("DELETE FROM ai_usage_logs WHERE project_id = $1", [testProjectIdD]);
      await pool.query("DELETE FROM ai_in_flight_locks WHERE project_id = $1", [testProjectIdD]);
    });

    it("1. AI generation exceeding five minutes maintains reservation through heartbeat renewal", async () => {
      await updateProjectAiBudgetLimits(testProjectIdD, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 1.0,
      });

      // 1. Create reservation
      const res = await reserveAiBudget(testProjectIdD, {
        estimatedCostUsd: 0.0006,
        estimatedTokens: 6000,
        feature: "long_generation",
      });
      expect(res.ownerToken).toBeDefined();

      // 2. Simulate time elapsing past the initial 5 minutes: set expires_at to past
      await pool.query(
        "UPDATE ai_budget_reservations SET expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1",
        [res.id],
      );

      // 3. Heartbeat renewal extends expires_at back into the future
      const renewed = await renewAiBudgetReservation(res.id, res.ownerToken!, 300);
      expect(renewed).toBe(true);

      // Verify expires_at is now safely in the future
      const checkRes = await pool.query<{ expires_at: Date; status: string }>(
        "SELECT expires_at, status FROM ai_budget_reservations WHERE id = $1",
        [res.id],
      );
      expect(checkRes.rows[0].status).toBe("active");
      expect(new Date(checkRes.rows[0].expires_at).getTime()).toBeGreaterThan(Date.now() + 200000);

      // 4. Verify cleanupExpiredReservations does NOT expire this actively renewed reservation
      const cleaned = await cleanupExpiredReservations();
      expect(cleaned).toBe(0);

      // 5. Active reservation is still counted in project budget
      const status = await getProjectAiBudgetStatus(testProjectIdD);
      expect(status.currentCostUsd).toBeCloseTo(0.0006, 4);

      // 6. Only the owner with valid ownerToken can reconcile
      const wrongOwnerReconcile = await reconcileAiBudgetReservation(
        res.id,
        {
          promptTokens: 100,
          completionTokens: 50,
          estimatedCostUsd: 0.0002,
          model: "gemini-2.5-flash",
          provider: "gemini",
          feature: "long_generation",
          durationMs: 310000, // > 5 minutes
        },
        "wrong-owner-token",
      );
      expect(wrongOwnerReconcile).toBe(false);

      // Reconcile with correct ownerToken succeeds
      const validOwnerReconcile = await reconcileAiBudgetReservation(
        res.id,
        {
          promptTokens: 100,
          completionTokens: 50,
          estimatedCostUsd: 0.0002,
          model: "gemini-2.5-flash",
          provider: "gemini",
          feature: "long_generation",
          durationMs: 310000,
        },
        res.ownerToken,
      );
      expect(validOwnerReconcile).toBe(true);
    });

    it("2. Single-flight execution exceeding 60 seconds prevents lock takeover via active heartbeat", async () => {
      const longFingerprint = `long-single-flight-${Date.now()}`;
      const workerIdA = "worker-pid-alpha";

      // 1. Worker A acquires the distributed lock
      await pool.query(
        `INSERT INTO ai_in_flight_locks (fingerprint, project_id, locked_by, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '60 seconds')`,
        [longFingerprint, testProjectIdD, workerIdA],
      );

      // 2. Simulate 65 seconds elapsed, but Worker A actively heartbeats
      await pool.query(
        "UPDATE ai_in_flight_locks SET expires_at = NOW() - INTERVAL '5 seconds' WHERE fingerprint = $1",
        [longFingerprint],
      );

      // Worker A's heartbeat renews the lock
      const lockRenewed = await renewDistributedLock(longFingerprint, workerIdA, 60);
      expect(lockRenewed).toBe(true);

      // 3. Worker B attempts to take over the lock while Worker A is still running
      const workerIdB = "worker-pid-beta";
      const takeoverAttempt = await pool.query(
        `INSERT INTO ai_in_flight_locks (fingerprint, project_id, locked_by, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '60 seconds')
         ON CONFLICT (fingerprint) DO UPDATE
         SET locked_by = EXCLUDED.locked_by,
             expires_at = EXCLUDED.expires_at
         WHERE ai_in_flight_locks.expires_at < NOW()
         RETURNING fingerprint`,
        [longFingerprint, testProjectIdD, workerIdB],
      );

      // Worker B must be rejected because Worker A's heartbeat extended expires_at
      expect(takeoverAttempt.rowCount).toBe(0);

      // Verify Worker A still owns the lock
      const lockCheck = await pool.query<{ locked_by: string }>(
        "SELECT locked_by FROM ai_in_flight_locks WHERE fingerprint = $1",
        [longFingerprint],
      );
      expect(lockCheck.rows[0].locked_by).toBe(workerIdA);

      // Cleanup
      await pool.query("DELETE FROM ai_in_flight_locks WHERE fingerprint = $1", [longFingerprint]);
    });

    it("3. Reservation heartbeat failure leads to safe expiry and prevents unauthorized renewal", async () => {
      await updateProjectAiBudgetLimits(testProjectIdD, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 1.0,
      });

      const res = await reserveAiBudget(testProjectIdD, {
        estimatedCostUsd: 0.0005,
        feature: "failing_heartbeat",
      });

      // 1. Attempt renewal with invalid owner token fails
      const invalidRenew = await renewAiBudgetReservation(res.id, "impostor-token", 300);
      expect(invalidRenew).toBe(false);

      // 2. Simulate worker crash where heartbeat stops and 5 minutes elapses
      await pool.query(
        "UPDATE ai_budget_reservations SET expires_at = NOW() - INTERVAL '10 seconds' WHERE id = $1",
        [res.id],
      );

      // 3. cleanupExpiredReservations safely reclaims the expired reservation
      const expiredCount = await cleanupExpiredReservations();
      expect(expiredCount).toBeGreaterThanOrEqual(1);

      const statusRes = await pool.query<{ status: string }>(
        "SELECT status FROM ai_budget_reservations WHERE id = $1",
        [res.id],
      );
      expect(statusRes.rows[0].status).toBe("expired");

      // 4. Renewal on expired reservation fails
      const postExpiryRenew = await renewAiBudgetReservation(res.id, res.ownerToken!, 300);
      expect(postExpiryRenew).toBe(false);
    });

    it("4. Worker crash and recovery: expired distributed lock is safely recovered by new worker", async () => {
      const crashFingerprint = `crash-recover-${Date.now()}`;

      // 1. Dead worker acquired lock and crashed (no heartbeat, expires_at in the past)
      await pool.query(
        `INSERT INTO ai_in_flight_locks (fingerprint, project_id, locked_by, expires_at)
         VALUES ($1, $2, 'crashed-worker-999', NOW() - INTERVAL '30 seconds')`,
        [crashFingerprint, testProjectIdD],
      );

      // 2. New worker attempts execution with executeSingleFlight
      let newWorkerExecuted = false;
      const res = await executeSingleFlight(
        crashFingerprint,
        async () => {
          newWorkerExecuted = true;
          return "Worker B Result";
        },
        { projectId: testProjectIdD },
      );

      // The new worker successfully took over the expired lock and executed
      expect(newWorkerExecuted).toBe(true);
      expect(res.result).toBe("Worker B Result");
      expect(res.wasShared).toBe(false);

      // Lock was cleaned up after completion
      const check = await pool.query(
        "SELECT * FROM ai_in_flight_locks WHERE fingerprint = $1",
        [crashFingerprint],
      );
      expect(check.rows.length).toBe(0);
    });

    it("5. Stale lock ownership: a stale worker cannot update or delete a newer worker's lock", async () => {
      const staleKey = `stale-worker-test-${Date.now()}`;
      const workerOld = "worker-pid-old";
      const workerNew = "worker-pid-new";

      // Newer worker owns the active lock
      await pool.query(
        `INSERT INTO ai_in_flight_locks (fingerprint, project_id, locked_by, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '60 seconds')`,
        [staleKey, testProjectIdD, workerNew],
      );

      // Stale worker attempts to renew
      const renewAttempt = await renewDistributedLock(staleKey, workerOld, 60);
      expect(renewAttempt).toBe(false);

      // Stale worker attempts conditional delete in finally block
      const deleteRes = await pool.query(
        "DELETE FROM ai_in_flight_locks WHERE fingerprint = $1 AND locked_by = $2",
        [staleKey, workerOld],
      );
      expect(deleteRes.rowCount).toBe(0);

      // Verify the newer worker's lock is completely intact
      const checkRes = await pool.query<{ locked_by: string }>(
        "SELECT locked_by FROM ai_in_flight_locks WHERE fingerprint = $1",
        [staleKey],
      );
      expect(checkRes.rows.length).toBe(1);
      expect(checkRes.rows[0].locked_by).toBe(workerNew);

      // Cleanup
      await pool.query("DELETE FROM ai_in_flight_locks WHERE fingerprint = $1", [staleKey]);
    });

    it("6. Provider timeout and cost accounting: distinguishes confirmed failures from ambiguous outcomes", async () => {
      await updateProjectAiBudgetLimits(testProjectIdD, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 0.0010,
      });

      // --- Confirmed Failure Case ---
      // Auth failure (401) is confirmed non-billing -> released completely
      const authErr = new AIProviderError({
        message: "API key invalid",
        code: "INVALID_CREDENTIALS",
        statusCode: 401,
        provider: "openai",
      });
      expect(isConfirmedProviderFailure(authErr)).toBe(true);

      const res1 = await reserveAiBudget(testProjectIdD, {
        estimatedCostUsd: 0.0004,
        feature: "auth_fail_test",
      });
      await releaseAiBudgetReservation(res1.id, res1.ownerToken);

      const checkRes1 = await pool.query<{ status: string }>(
        "SELECT status FROM ai_budget_reservations WHERE id = $1",
        [res1.id],
      );
      expect(checkRes1.rows[0].status).toBe("released");

      // --- Ambiguous Timeout Case ---
      // Gateway / request timeout (60s) could have been processed by upstream provider
      const timeoutErr = new AIProviderError({
        message: "Request timed out after 60000ms",
        code: "TIMEOUT",
        provider: "openai",
      });
      expect(isConfirmedProviderFailure(timeoutErr)).toBe(false);

      const res2 = await reserveAiBudget(testProjectIdD, {
        estimatedCostUsd: 0.0006,
        feature: "timeout_test",
      });

      // Mark reservation uncertain instead of releasing to $0
      const marked = await markReservationUncertain(res2.id, timeoutErr.message, res2.ownerToken);
      expect(marked).toBe(true);

      const checkRes2 = await pool.query<{ status: string; uncertainty_reason: string }>(
        "SELECT status, uncertainty_reason FROM ai_budget_reservations WHERE id = $1",
        [res2.id],
      );
      expect(checkRes2.rows[0].status).toBe("uncertain");
      expect(checkRes2.rows[0].uncertainty_reason).toContain("timed out");

      // Verify the uncertain reservation is still counted against the project budget cap!
      const budgetStatus = await getProjectAiBudgetStatus(testProjectIdD);
      expect(budgetStatus.currentCostUsd).toBeCloseTo(0.0006, 4);

      // A subsequent request for $0.0006 will exceed the $0.0010 cap (0.0006 + 0.0006 = 0.0012 > 0.0010)
      await expect(
        reserveAiBudget(testProjectIdD, { estimatedCostUsd: 0.0006 }),
      ).rejects.toMatchObject({
        code: "BUDGET_EXCEEDED",
        statusCode: 429,
      });

      // When final reconciliation occurs, uncertain reservation cleanly transitions to reconciled
      const reconciled = await reconcileAiBudgetReservation(
        res2.id,
        {
          promptTokens: 80,
          completionTokens: 20,
          estimatedCostUsd: 0.0002,
          model: "gpt-4o",
          provider: "openai",
          feature: "timeout_test",
          durationMs: 60100,
        },
        res2.ownerToken,
      );
      expect(reconciled).toBe(true);

      const checkReconciled = await pool.query<{ status: string }>(
        "SELECT status FROM ai_budget_reservations WHERE id = $1",
        [res2.id],
      );
      expect(checkReconciled.rows[0].status).toBe("reconciled");
    });

    it("7. Concurrent requests during reservation renewal cannot breach project hard cap", async () => {
      // Hard cap is $0.0010
      await updateProjectAiBudgetLimits(testProjectIdD, {
        usageLimitPeriod: "monthly",
        maxCostLimitUsd: 0.0010,
      });

      // 1. Active reservation for $0.0006
      const activeRes = await reserveAiBudget(testProjectIdD, {
        estimatedCostUsd: 0.0006,
        feature: "active_renewing",
      });

      // 2. Launch concurrent operations: renew existing reservation while 2 competing requests arrive
      const [renewResult, comp1Result, comp2Result] = await Promise.allSettled([
        renewAiBudgetReservation(activeRes.id, activeRes.ownerToken!, 300),
        reserveAiBudget(testProjectIdD, { estimatedCostUsd: 0.0003, feature: "comp1" }),
        reserveAiBudget(testProjectIdD, { estimatedCostUsd: 0.0003, feature: "comp2" }),
      ]);

      // Renewal must succeed
      expect(renewResult.status).toBe("fulfilled");
      expect((renewResult as PromiseFulfilledResult<boolean>).value).toBe(true);

      // Remaining budget was $0.0010 - $0.0006 = $0.0004
      // Competing requests are $0.0003 each.
      // Exactly ONE can fit ($0.0006 + $0.0003 = $0.0009 <= $0.0010).
      // The other ($0.0009 + $0.0003 = $0.0012 > $0.0010) must be rejected with 429.
      const compFulfilled = [comp1Result, comp2Result].filter((r) => r.status === "fulfilled");
      const compRejected = [comp1Result, comp2Result].filter((r) => r.status === "rejected");

      expect(compFulfilled.length).toBe(1);
      expect(compRejected.length).toBe(1);

      const rejectedError = (compRejected[0] as PromiseRejectedResult).reason;
      expect(rejectedError).toMatchObject({
        code: "BUDGET_EXCEEDED",
        statusCode: 429,
      });

      // Clean up
      await releaseAiBudgetReservation(activeRes.id, activeRes.ownerToken);
      for (const f of compFulfilled) {
        await releaseAiBudgetReservation((f as PromiseFulfilledResult<any>).value.id);
      }
    });
  });
});
