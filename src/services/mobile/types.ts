/**
 * Types and interfaces for the Mobile Execution Engine.
 * Supports Android (UiAutomator2) and prepares architecture for iOS (XCUITest).
 */

export type MobilePlatform = "android" | "ios";

export type MobileResultStatus = "passed" | "failed" | "skipped" | "inconclusive";

export type MobileLocatorStrategy =
  | "id"
  | "accessibility id"
  | "xpath"
  | "-android uiautomator"
  | "class name"
  | "css selector";

export interface MobileLocator {
  using: MobileLocatorStrategy;
  value: string;
}

export interface MobileCapabilities {
  platformName: "Android" | "iOS";
  "appium:automationName": "UiAutomator2" | "XCUITest";
  "appium:deviceName": string;
  "appium:udid": string;
  "appium:appPackage"?: string;
  "appium:appActivity"?: string;
  "appium:app"?: string;
  "appium:noReset"?: boolean;
  "appium:newCommandTimeout"?: number;
  "appium:autoGrantPermissions"?: boolean;
  [key: string]: unknown;
}

export interface MobileDeviceInfo {
  platform: MobilePlatform;
  deviceName: string;
  osVersion: string;
  udid: string;
  model?: string;
  apiLevel?: string;
}

export interface MobileStepResult {
  stepIndex: number;
  stepText: string;
  action: string;
  selector?: string;
  status: MobileResultStatus;
  durationMs: number;
  errorMessage?: string | null;
}

export interface MobileCrashEvidence {
  crashed: boolean;
  exceptionType?: string;
  stackTrace?: string;
  logSnippet?: string;
}

export interface MobileEvidence {
  status: MobileResultStatus;
  durationMs: number;
  failureStep: string | null;
  failureStepIndex: number | null;
  errorMessage: string | null;
  screenshotPath: string | null;
  deviceLogs: string[];
  crashEvidence: MobileCrashEvidence;
  stepResults: MobileStepResult[];
  deviceInfo: MobileDeviceInfo;
  evidencePath?: string | null;
}

export interface MobileTestCaseRunResult {
  status: MobileResultStatus;
  errorMessage?: string;
  durationMs: number;
  screenshotPath: string | null;
  deviceInfo: MobileDeviceInfo;
  evidence: MobileEvidence;
  stepResults: MobileStepResult[];
}

export interface IMobileDriver {
  readonly platform: MobilePlatform;
  readonly isConnected: boolean;
  readonly sessionId: string | null;

  createSession(caps: MobileCapabilities): Promise<string>;
  deleteSession(): Promise<void>;

  findElement(locator: MobileLocator): Promise<string>;
  findElements(locator: MobileLocator): Promise<string[]>;

  click(elementId: string): Promise<void>;
  setValue(elementId: string, text: string): Promise<void>;
  clear(elementId: string): Promise<void>;
  getText(elementId: string): Promise<string>;
  isDisplayed(elementId: string): Promise<boolean>;

  takeScreenshot(): Promise<Buffer>;
  performSwipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs?: number,
  ): Promise<void>;
  performScroll(direction: "up" | "down" | "left" | "right"): Promise<void>;

  launchApp(appPackage: string, appActivity?: string): Promise<void>;
  closeApp(appPackage?: string): Promise<void>;
  backgroundApp(seconds: number): Promise<void>;

  pressKeyCode(keyCode: number): Promise<void>;
  grantPermission(packageName: string, permission: string): Promise<void>;

  getLogs(logType?: string): Promise<string[]>;
  getDeviceInfo(): Promise<MobileDeviceInfo>;
}

