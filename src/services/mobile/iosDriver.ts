import {
  type IMobileDriver,
  type MobileCapabilities,
  type MobileDeviceInfo,
  type MobileLocator,
  type MobilePlatform,
} from "./types";
import { MobileDriverError } from "./appiumClient";

/**
 * XCUITest Driver Architecture Stub for iOS.
 *
 * Implements IMobileDriver to ensure complete interface compatibility.
 * Accurately informs callers that iOS execution requires a macOS host machine
 * configured with Xcode, CocoaPods, Carthage/idb, and Appium XCUITest driver.
 */
export class XCUITestDriver implements IMobileDriver {
  public readonly platform: MobilePlatform = "ios";
  public readonly isConnected: boolean = false;
  public readonly sessionId: string | null = null;

  private checkEnvironment(): never {
    throw new MobileDriverError(
      "iOS test execution is not supported on Windows/Linux environments. " +
        "Future iOS execution requires a macOS runner with Xcode, Command Line Tools, " +
        "and the Appium XCUITest driver ('appium driver install xcuitest') configured.",
      501,
      true,
    );
  }

  public async createSession(caps: MobileCapabilities): Promise<string> {
    this.checkEnvironment();
  }

  public async deleteSession(): Promise<void> {
    // No-op
  }

  public async findElement(_locator: MobileLocator): Promise<string> {
    this.checkEnvironment();
  }

  public async findElements(_locator: MobileLocator): Promise<string[]> {
    this.checkEnvironment();
  }

  public async click(_elementId: string): Promise<void> {
    this.checkEnvironment();
  }

  public async setValue(_elementId: string, _text: string): Promise<void> {
    this.checkEnvironment();
  }

  public async clear(_elementId: string): Promise<void> {
    this.checkEnvironment();
  }

  public async getText(_elementId: string): Promise<string> {
    this.checkEnvironment();
  }

  public async isDisplayed(_elementId: string): Promise<boolean> {
    this.checkEnvironment();
  }

  public async takeScreenshot(): Promise<Buffer> {
    this.checkEnvironment();
  }

  public async performSwipe(
    _startX: number,
    _startY: number,
    _endX: number,
    _endY: number,
    _durationMs?: number,
  ): Promise<void> {
    this.checkEnvironment();
  }

  public async performScroll(_direction: "up" | "down" | "left" | "right"): Promise<void> {
    this.checkEnvironment();
  }

  public async launchApp(_appPackage: string, _appActivity?: string): Promise<void> {
    this.checkEnvironment();
  }

  public async closeApp(_appPackage?: string): Promise<void> {
    this.checkEnvironment();
  }

  public async backgroundApp(_seconds: number): Promise<void> {
    this.checkEnvironment();
  }

  public async pressKeyCode(_keyCode: number): Promise<void> {
    this.checkEnvironment();
  }

  public async grantPermission(_packageName: string, _permission: string): Promise<void> {
    this.checkEnvironment();
  }

  public async getLogs(_logType?: string): Promise<string[]> {
    return [];
  }

  public async getDeviceInfo(): Promise<MobileDeviceInfo> {
    return {
      platform: "ios",
      deviceName: "iOS Simulator",
      osVersion: "18.0",
      udid: "unavailable-on-windows",
      model: "iPhone 16",
    };
  }
}

