import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AppiumClient, MobileDriverError } from "./mobile/appiumClient";
import { XCUITestDriver } from "./mobile/iosDriver";
import {
  type IMobileDriver,
  type MobileCapabilities,
  type MobileCrashEvidence,
  type MobileDeviceInfo,
  type MobileEvidence,
  type MobilePlatform,
  type MobileResultStatus,
  type MobileStepResult,
  type MobileTestCaseRunResult,
} from "./mobile/types";
import {
  parseSelector,
  validateMobileDsl,
  type ParsedMobileStep,
} from "./mobile/mobileDsl";
import { getProjectAccess } from "./secretStore";
import { resolveStepPlaceholders, redactSecrets, type AppCredentials } from "./runner";
import { env } from "../config/env";
import { logger } from "./observability/logger";

export interface MobileRunnerOptions {
  appPackage?: string;
  appActivity?: string;
  appiumUrl?: string;
  deviceUdid?: string;
  platform?: MobilePlatform;
  projectId?: string;
  timeoutMs?: number;
  autoGrantPermissions?: boolean;
}

/**
 * Scans logcat logs for Android crash patterns (Fatal exceptions, ANRs, Sigsegv).
 */
export function detectCrashFromLogs(logs: string[], targetPackage?: string): MobileCrashEvidence {
  const crashPatterns = [
    /FATAL EXCEPTION/i,
    /AndroidRuntime.*Shutting down VM/i,
    /Beginning of crash dump/i,
    /ANR in\s+([a-zA-Z0-9_.]+)/i,
    /signal 11 \(SIGSEGV\)/i,
  ];

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];
    for (const pattern of crashPatterns) {
      if (pattern.test(log)) {
        const snippet = logs.slice(Math.max(0, i - 2), Math.min(logs.length, i + 8)).join("\n");
        if (
          targetPackage &&
          !snippet.toLowerCase().includes(targetPackage.toLowerCase()) &&
          !/FATAL EXCEPTION:\s+main/i.test(log)
        ) {
          continue;
        }
        return {
          crashed: true,
          exceptionType: pattern.source,
          logSnippet: snippet,
          stackTrace: snippet,
        };
      }
    }
  }

  return { crashed: false };
}

/**
 * Keycode mappings for Android hardware actions.
 */
const ANDROID_KEYCODES = {
  home: 3,
  back: 4,
  enter: 66,
};

/**
 * Dedicated Appium-based Mobile Test Runner.
 * Executes restricted Mobile DSL commands against Android emulator or device.
 */
export async function runMobileTestCase(
  steps: string[],
  identifiers: { runId: string; resultId: string },
  options: MobileRunnerOptions = {},
): Promise<MobileTestCaseRunResult> {
  const startTime = Date.now();
  const { runId, resultId } = identifiers;
  const platform = options.platform || "android";
  const appiumUrl = options.appiumUrl || process.env.APPIUM_URL || "http://127.0.0.1:4723";
  const deviceUdid = options.deviceUdid || process.env.ANDROID_DEVICE_UDID || "emulator-5554";
  const appPackage = options.appPackage || "com.android.settings";
  const appActivity =
    options.appActivity ||
    (appPackage === "com.android.settings" ? "com.android.settings.Settings" : undefined);

  const defaultDeviceInfo: MobileDeviceInfo = {
    platform,
    deviceName: deviceUdid,
    osVersion: "Android 17",
    udid: deviceUdid,
    model: "sdk_gphone64_x86_64",
  };

  // 1. Validate DSL steps against security whitelist
  const dslValidation = validateMobileDsl(steps);
  if (!dslValidation.valid || !dslValidation.parsedSteps) {
    const errorMsg = `Mobile DSL Validation Failed: ${dslValidation.errors.join("; ")}`;
    return {
      status: "failed",
      errorMessage: errorMsg,
      durationMs: Date.now() - startTime,
      screenshotPath: null,
      deviceInfo: defaultDeviceInfo,
      stepResults: [],
      evidence: {
        status: "failed",
        durationMs: Date.now() - startTime,
        failureStep: null,
        failureStepIndex: null,
        errorMessage: errorMsg,
        screenshotPath: null,
        deviceLogs: [],
        crashEvidence: { crashed: false },
        stepResults: [],
        deviceInfo: defaultDeviceInfo,
      },
    };
  }

  // 2. Fetch project credentials for placeholder replacement if available
  let credentials: AppCredentials | undefined;
  if (options.projectId) {
    try {
      const access = await getProjectAccess(options.projectId);
      if (access && (access.username || access.password)) {
        credentials = {
          username: access.username,
          password: access.password,
          email: access.username,
        };
      }
    } catch {
      // Best-effort
    }
  }

  // 3. Check platform - prepare iOS diagnostic or Android driver
  if (platform === "ios") {
    const iosDriver = new XCUITestDriver();
    try {
      await iosDriver.createSession({
        platformName: "iOS",
        "appium:automationName": "XCUITest",
        "appium:deviceName": "iPhone Simulator",
        "appium:udid": "ios-simulator",
      });
    } catch (iosErr) {
      const msg = iosErr instanceof Error ? iosErr.message : String(iosErr);
      return {
        status: "inconclusive",
        errorMessage: msg,
        durationMs: Date.now() - startTime,
        screenshotPath: null,
        deviceInfo: {
          platform: "ios",
          deviceName: "iOS Simulator (XCUITest Architecture)",
          osVersion: "18.0",
          udid: "unavailable-on-windows",
        },
        stepResults: [],
        evidence: {
          status: "inconclusive",
          durationMs: Date.now() - startTime,
          failureStep: null,
          failureStepIndex: null,
          errorMessage: msg,
          screenshotPath: null,
          deviceLogs: [],
          crashEvidence: { crashed: false },
          stepResults: [],
          deviceInfo: {
            platform: "ios",
            deviceName: "iOS Simulator",
            osVersion: "18.0",
            udid: "unavailable-on-windows",
          },
        },
      };
    }
  }

  const driver: IMobileDriver = new AppiumClient(appiumUrl);
  let sessionCreated = false;
  let screenshotPath: string | null = null;
  let failureStep: string | null = null;
  let failureStepIndex: number | null = null;
  let errorMessage: string | null = null;
  let status: MobileResultStatus = "passed";
  const stepResults: MobileStepResult[] = [];
  let capturedLogs: string[] = [];
  let crashEvidence: MobileCrashEvidence = { crashed: false };
  let deviceInfo: MobileDeviceInfo = defaultDeviceInfo;

  const artifactDir = path.resolve(__dirname, "../../artifacts/runs", runId, resultId);
  const screenshotFileName = "screenshot.png";
  const fullScreenshotPath = path.join(artifactDir, screenshotFileName);
  const relativeScreenshotPath = path.join("artifacts", "runs", runId, resultId, screenshotFileName);

  try {
    // 4. Initialize session with Appium & UiAutomator2
    const caps: MobileCapabilities = {
      platformName: "Android",
      "appium:automationName": "UiAutomator2",
      "appium:deviceName": deviceUdid,
      "appium:udid": deviceUdid,
      "appium:appPackage": appPackage,
      ...(appActivity ? { "appium:appActivity": appActivity } : {}),
      "appium:noReset": true,
      "appium:newCommandTimeout": 120,
      "appium:autoGrantPermissions": options.autoGrantPermissions ?? true,
    };

    try {
      await driver.createSession(caps);
      sessionCreated = true;
      deviceInfo = await driver.getDeviceInfo();
      // Drain pre-existing log buffer so only logs generated during this run are evaluated for crashes
      try {
        await driver.getLogs("logcat");
      } catch {}
    } catch (sessionErr) {
      const isInfra =
        sessionErr instanceof MobileDriverError
          ? sessionErr.isInfrastructure
          : true;
      const msg = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
      return {
        status: isInfra ? "inconclusive" : "failed",
        errorMessage: `Failed to create Appium UiAutomator2 session: ${msg}`,
        durationMs: Date.now() - startTime,
        screenshotPath: null,
        deviceInfo: defaultDeviceInfo,
        stepResults: [],
        evidence: {
          status: isInfra ? "inconclusive" : "failed",
          durationMs: Date.now() - startTime,
          failureStep: null,
          failureStepIndex: null,
          errorMessage: msg,
          screenshotPath: null,
          deviceLogs: [],
          crashEvidence: { crashed: false },
          stepResults: [],
          deviceInfo: defaultDeviceInfo,
        },
      };
    }

    // 5. Execute steps sequentially
    const parsedSteps = dslValidation.parsedSteps;

    for (let i = 0; i < parsedSteps.length; i++) {
      const step = parsedSteps[i];
      const stepStart = Date.now();
      let stepErr: string | null = null;
      let stepStatus: MobileResultStatus = "passed";

      try {
        switch (step.action) {
          case "app launch": {
            const pkg = step.appPackage || appPackage;
            await driver.launchApp(pkg, step.appActivity);
            break;
          }

          case "app close": {
            await driver.closeApp(step.appPackage || appPackage);
            break;
          }

          case "tap":
          case "click": {
            if (!step.locator) throw new Error("Missing selector locator for tap");
            const elemId = await driver.findElement(step.locator);
            await driver.click(elemId);
            break;
          }

          case "type":
          case "fill": {
            if (!step.locator) throw new Error("Missing selector locator for type");
            const elemId = await driver.findElement(step.locator);
            const resolvedValue = resolveStepPlaceholders(step.value || "", credentials);
            await driver.setValue(elemId, resolvedValue);
            break;
          }

          case "clear": {
            if (!step.locator) throw new Error("Missing selector locator for clear");
            const elemId = await driver.findElement(step.locator);
            await driver.clear(elemId);
            break;
          }

          case "scroll": {
            await driver.performScroll(step.scrollDirection || "down");
            break;
          }

          case "swipe": {
            if (!step.swipeCoords) throw new Error("Missing coordinates for swipe");
            await driver.performSwipe(
              step.swipeCoords.startX,
              step.swipeCoords.startY,
              step.swipeCoords.endX,
              step.swipeCoords.endY,
              step.swipeCoords.durationMs,
            );
            break;
          }

          case "expect visible": {
            if (!step.locator) throw new Error("Missing selector locator for expect visible");
            const elemId = await driver.findElement(step.locator);
            const visible = await driver.isDisplayed(elemId);
            if (!visible) {
              throw new Error(`Element "${step.selector}" is not visible on screen`);
            }
            break;
          }

          case "expect not visible": {
            if (!step.locator) throw new Error("Missing selector locator for expect not visible");
            try {
              const elements = await driver.findElements(step.locator);
              if (elements.length > 0) {
                const visible = await driver.isDisplayed(elements[0]);
                if (visible) {
                  throw new Error(`Element "${step.selector}" is unexpectedly visible`);
                }
              }
            } catch (elemErr) {
              // Element not found is considered not visible, which passes
            }
            break;
          }

          case "expect text": {
            if (!step.locator) throw new Error("Missing selector locator for expect text");
            const expected = step.value || "";
            const elemId = await driver.findElement(step.locator);
            const actual = await driver.getText(elemId);
            if (!actual.toLowerCase().includes(expected.toLowerCase())) {
              throw new Error(
                `Assertion failed: Expected element text to include "${expected}", but got "${actual}"`,
              );
            }
            break;
          }

          case "wait": {
            const delay = step.waitMs || 1000;
            await new Promise((resolve) => setTimeout(resolve, delay));
            break;
          }

          case "press": {
            const keyCode = ANDROID_KEYCODES[step.pressKey || "back"] || 4;
            await driver.pressKeyCode(keyCode);
            break;
          }

          case "background": {
            await driver.backgroundApp(step.backgroundSec || 5);
            break;
          }

          case "permission grant": {
            if (step.value) {
              await driver.grantPermission(appPackage, step.value);
            }
            break;
          }

          case "screenshot": {
            await mkdir(artifactDir, { recursive: true });
            const shotBuffer = await driver.takeScreenshot();
            await writeFile(fullScreenshotPath, shotBuffer);
            screenshotPath = relativeScreenshotPath;
            break;
          }
        }
      } catch (actionErr) {
        stepStatus = "failed";
        stepErr = actionErr instanceof Error ? actionErr.message : String(actionErr);
        status = "failed";
        failureStep = step.originalText;
        failureStepIndex = i;
        errorMessage = stepErr;

        // Capture failure evidence immediately
        try {
          await mkdir(artifactDir, { recursive: true });
          const shotBuffer = await driver.takeScreenshot();
          await writeFile(fullScreenshotPath, shotBuffer);
          screenshotPath = relativeScreenshotPath;
        } catch {
          // Best effort screenshot
        }

        stepResults.push({
          stepIndex: i,
          stepText: redactSecrets(step.originalText),
          action: step.action,
          selector: step.selector,
          status: stepStatus,
          durationMs: Date.now() - stepStart,
          errorMessage: redactSecrets(stepErr),
        });

        break; // Stop further steps on failure
      }

      stepResults.push({
        stepIndex: i,
        stepText: redactSecrets(step.originalText),
        action: step.action,
        selector: step.selector,
        status: stepStatus,
        durationMs: Date.now() - stepStart,
      });
    }

    // Capture logs and check for crashes
    try {
      capturedLogs = await driver.getLogs("logcat");
      crashEvidence = detectCrashFromLogs(capturedLogs, appPackage);
      if (crashEvidence.crashed && status === "passed") {
        status = "failed";
        errorMessage = `Application crashed during execution: ${crashEvidence.exceptionType || "Fatal exception"}`;
      }
    } catch {
      // Best-effort logs
    }

    // If passed and no screenshot taken yet, take final screenshot
    if (status === "passed" && !screenshotPath) {
      try {
        await mkdir(artifactDir, { recursive: true });
        const shotBuffer = await driver.takeScreenshot();
        await writeFile(fullScreenshotPath, shotBuffer);
        screenshotPath = relativeScreenshotPath;
      } catch {
        // Best effort
      }
    }
  } catch (err) {
    status = "inconclusive";
    errorMessage = err instanceof Error ? err.message : String(err);
  } finally {
    // 6. Graceful cleanup - always release Appium session
    if (sessionCreated) {
      try {
        await driver.deleteSession();
      } catch {
        // Ignore session delete error
      }
    }
  }

  const durationMs = Date.now() - startTime;

  // 7. Write evidence.json to disk
  const evidence: MobileEvidence = {
    status,
    durationMs,
    failureStep: failureStep ? redactSecrets(failureStep) : null,
    failureStepIndex,
    errorMessage: errorMessage ? redactSecrets(errorMessage) : null,
    screenshotPath,
    deviceLogs: capturedLogs.slice(-100), // preserve last 100 log lines
    crashEvidence,
    stepResults,
    deviceInfo,
    evidencePath: path.join("artifacts", "runs", runId, resultId, "evidence.json"),
  };

  try {
    await mkdir(artifactDir, { recursive: true });
    await writeFile(
      path.join(artifactDir, "evidence.json"),
      JSON.stringify(evidence, null, 2),
      "utf8",
    );
  } catch {
    // Best effort evidence write
  }

  return {
    status,
    errorMessage: errorMessage ? redactSecrets(errorMessage) : undefined,
    durationMs,
    screenshotPath,
    deviceInfo,
    evidence,
    stepResults,
  };
}
