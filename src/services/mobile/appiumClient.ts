import { URL } from "node:url";
import {
  type IMobileDriver,
  type MobileCapabilities,
  type MobileDeviceInfo,
  type MobileLocator,
  type MobilePlatform,
} from "./types";

export class MobileDriverError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly isInfrastructure: boolean = false,
  ) {
    super(message);
    this.name = "MobileDriverError";
  }
}

/**
 * Validates that the Appium server URL is strictly local and safe.
 * Blocks any attempt to connect to remote untrusted hosts or metadata services.
 */
function assertSafeAppiumUrl(serverUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new MobileDriverError(`Invalid Appium server URL: ${serverUrl}`, 400, true);
  }

  const hostname = parsed.hostname.toLowerCase();
  const isLocal =
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1";

  if (!isLocal) {
    throw new MobileDriverError(
      `Appium server must run on a local loopback interface (127.0.0.1 / localhost). Remote host "${hostname}" is forbidden for security.`,
      403,
      true,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MobileDriverError(`Invalid protocol "${parsed.protocol}" for Appium server`, 400, true);
  }

  return parsed;
}

/**
 * Direct Appium W3C WebDriver client implementing the IMobileDriver interface.
 * Communicates with local Appium 2.x/3.x server via native fetch.
 */
export class AppiumClient implements IMobileDriver {
  public readonly platform: MobilePlatform = "android";
  private _sessionId: string | null = null;
  private readonly baseUrl: string;
  private currentCaps: MobileCapabilities | null = null;
  private windowSize: { width: number; height: number } | null = null;

  constructor(serverUrl: string = "http://127.0.0.1:4723") {
    const safeUrl = assertSafeAppiumUrl(serverUrl);
    // Strip trailing slash if present
    this.baseUrl = safeUrl.origin + (safeUrl.pathname.endsWith("/") ? safeUrl.pathname.slice(0, -1) : safeUrl.pathname);
  }

  public get isConnected(): boolean {
    return this._sessionId !== null;
  }

  public get sessionId(): string | null {
    return this._sessionId;
  }

  private async request<T = any>(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    timeoutMs: number = 30000,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      const text = await res.text();
      let data: any;
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new MobileDriverError(
          `Appium server returned non-JSON response (${res.status}): ${text.slice(0, 200)}`,
          res.status,
          true,
        );
      }

      if (!res.ok || data?.value?.error) {
        const errorName = data?.value?.error || `HTTP ${res.status}`;
        const errorMsg = data?.value?.message || data?.message || text;
        const isInfra =
          res.status >= 500 ||
          errorName === "unknown server-side error" ||
          /session not created|no such session/i.test(errorMsg);

        throw new MobileDriverError(
          `Appium error [${errorName}]: ${errorMsg}`,
          res.status,
          isInfra,
        );
      }

      return data.value as T;
    } catch (err) {
      if (err instanceof MobileDriverError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      const isInfra = /abort|econnrefused|etimedout|enotfound|fetch failed/i.test(msg);
      throw new MobileDriverError(`Appium connection error: ${msg}`, 503, isInfra);
    } finally {
      clearTimeout(timer);
    }
  }

  public async createSession(caps: MobileCapabilities): Promise<string> {
    this.currentCaps = caps;
    const body = {
      capabilities: {
        alwaysMatch: {
          platformName: caps.platformName || "Android",
          "appium:automationName": caps["appium:automationName"] || "UiAutomator2",
          "appium:deviceName": caps["appium:deviceName"] || "emulator-5554",
          "appium:udid": caps["appium:udid"] || "emulator-5554",
          "appium:noReset": caps["appium:noReset"] ?? true,
          "appium:newCommandTimeout": caps["appium:newCommandTimeout"] ?? 120,
          ...(caps["appium:appPackage"] ? { "appium:appPackage": caps["appium:appPackage"] } : {}),
          ...(caps["appium:appActivity"] ? { "appium:appActivity": caps["appium:appActivity"] } : {}),
          ...(caps["appium:app"] ? { "appium:app": caps["appium:app"] } : {}),
          ...(caps["appium:autoGrantPermissions"] !== undefined
            ? { "appium:autoGrantPermissions": caps["appium:autoGrantPermissions"] }
            : {}),
        },
      },
    };

    const res = await this.request<{ sessionId: string }>("POST", "/session", body, 60000);
    this._sessionId = res.sessionId;
    return this._sessionId;
  }

  public async deleteSession(): Promise<void> {
    if (!this._sessionId) return;
    const sId = this._sessionId;
    this._sessionId = null;
    try {
      await this.request("DELETE", `/session/${sId}`, undefined, 10000);
    } catch (e) {
      // Ignore cleanup error on delete
    }
  }

  private assertSession(): string {
    if (!this._sessionId) {
      throw new MobileDriverError("No active Appium session. Call createSession() first.", 400, true);
    }
    return this._sessionId;
  }

  public async findElement(locator: MobileLocator): Promise<string> {
    const sId = this.assertSession();
    const res = await this.request<{ "element-6066-11e4-a52e-4f735466cecf": string }>(
      "POST",
      `/session/${sId}/element`,
      {
        using: locator.using,
        value: locator.value,
      },
      15000,
    );

    const elemId =
      res?.["element-6066-11e4-a52e-4f735466cecf"] ||
      (res as any)?.ELEMENT ||
      (typeof res === "string" ? res : null);

    if (!elemId) {
      throw new MobileDriverError(`Element not found for selector: ${locator.using}="${locator.value}"`);
    }
    return elemId;
  }

  public async findElements(locator: MobileLocator): Promise<string[]> {
    const sId = this.assertSession();
    const res = await this.request<any[]>(
      "POST",
      `/session/${sId}/elements`,
      {
        using: locator.using,
        value: locator.value,
      },
      15000,
    );

    if (!Array.isArray(res)) return [];
    return res
      .map((item) => item?.["element-6066-11e4-a52e-4f735466cecf"] || item?.ELEMENT)
      .filter(Boolean);
  }

  public async click(elementId: string): Promise<void> {
    const sId = this.assertSession();
    await this.request("POST", `/session/${sId}/element/${elementId}/click`);
  }

  public async setValue(elementId: string, text: string): Promise<void> {
    const sId = this.assertSession();
    await this.request("POST", `/session/${sId}/element/${elementId}/value`, {
      text,
      value: Array.from(text),
    });
  }

  public async clear(elementId: string): Promise<void> {
    const sId = this.assertSession();
    await this.request("POST", `/session/${sId}/element/${elementId}/clear`);
  }

  public async getText(elementId: string): Promise<string> {
    const sId = this.assertSession();
    const text = await this.request<string>("GET", `/session/${sId}/element/${elementId}/text`);
    return typeof text === "string" ? text : "";
  }

  public async isDisplayed(elementId: string): Promise<boolean> {
    const sId = this.assertSession();
    try {
      const disp = await this.request<boolean>("GET", `/session/${sId}/element/${elementId}/displayed`);
      return Boolean(disp);
    } catch {
      return false;
    }
  }

  public async takeScreenshot(): Promise<Buffer> {
    const sId = this.assertSession();
    const base64Data = await this.request<string>("GET", `/session/${sId}/screenshot`);
    return Buffer.from(base64Data, "base64");
  }

  public async getWindowSize(): Promise<{ width: number; height: number }> {
    if (this.windowSize) return this.windowSize;
    const sId = this.assertSession();
    try {
      const size = await this.request<{ width: number; height: number }>(
        "GET",
        `/session/${sId}/window/rect`,
      );
      this.windowSize = { width: size.width || 1080, height: size.height || 2400 };
      return this.windowSize;
    } catch {
      this.windowSize = { width: 1080, height: 2400 };
      return this.windowSize;
    }
  }

  public async performSwipe(
    startX: number,
    startY: number,
    endX: number,
    endY: number,
    durationMs: number = 600,
  ): Promise<void> {
    const sId = this.assertSession();
    const actionsPayload = {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: Math.round(startX), y: Math.round(startY) },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 100 },
            { type: "pointerMove", duration: Math.max(durationMs, 100), x: Math.round(endX), y: Math.round(endY) },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    };

    await this.request("POST", `/session/${sId}/actions`, actionsPayload);
  }

  public async performScroll(direction: "up" | "down" | "left" | "right"): Promise<void> {
    const size = await this.getWindowSize();
    const centerX = Math.floor(size.width / 2);
    const centerY = Math.floor(size.height / 2);

    let startX = centerX;
    let startY = centerY;
    let endX = centerX;
    let endY = centerY;

    if (direction === "down") {
      // Swipe up to scroll down
      startY = Math.floor(size.height * 0.75);
      endY = Math.floor(size.height * 0.25);
    } else if (direction === "up") {
      // Swipe down to scroll up
      startY = Math.floor(size.height * 0.25);
      endY = Math.floor(size.height * 0.75);
    } else if (direction === "right") {
      startX = Math.floor(size.width * 0.8);
      endX = Math.floor(size.width * 0.2);
    } else if (direction === "left") {
      startX = Math.floor(size.width * 0.2);
      endX = Math.floor(size.width * 0.8);
    }

    await this.performSwipe(startX, startY, endX, endY, 600);
  }

  public async launchApp(appPackage: string, appActivity?: string): Promise<void> {
    const sId = this.assertSession();
    try {
      try {
        await this.request("POST", `/session/${sId}/appium/device/terminate_app`, {
          appId: appPackage,
        });
      } catch {
        // Best effort terminate
      }
      await this.request("POST", `/session/${sId}/appium/device/activate_app`, {
        appId: appPackage,
      });
    } catch {
      // Fallback for older server commands
      await this.request("POST", `/session/${sId}/appium/app/launch`);
    }
  }

  public async closeApp(appPackage?: string): Promise<void> {
    const sId = this.assertSession();
    const pkg = appPackage || this.currentCaps?.["appium:appPackage"];
    if (pkg) {
      try {
        await this.request("POST", `/session/${sId}/appium/device/terminate_app`, {
          appId: pkg,
        });
        return;
      } catch {
        // Fallback
      }
    }
    try {
      await this.request("POST", `/session/${sId}/appium/app/close`);
    } catch {
      // Best effort
    }
  }

  public async backgroundApp(seconds: number): Promise<void> {
    const sId = this.assertSession();
    await this.request("POST", `/session/${sId}/appium/device/background`, {
      seconds: Math.max(1, Math.min(seconds, 60)),
    });
  }

  public async pressKeyCode(keyCode: number): Promise<void> {
    const sId = this.assertSession();
    if (keyCode === 4) {
      try {
        await this.request("POST", `/session/${sId}/back`);
        return;
      } catch {
        // Fallback to press_keycode
      }
    }
    await this.request("POST", `/session/${sId}/appium/device/press_keycode`, {
      keycode: keyCode,
    });
  }

  public async grantPermission(packageName: string, permission: string): Promise<void> {
    const sId = this.assertSession();
    await this.request("POST", `/session/${sId}/appium/device/grant_permissions`, {
      appId: packageName,
      permissions: [permission],
    });
  }

  public async getLogs(logType: string = "logcat"): Promise<string[]> {
    if (!this._sessionId) return [];
    try {
      const logs = await this.request<any[]>("POST", `/session/${this._sessionId}/log`, {
        type: logType,
      }, 5000);
      if (!Array.isArray(logs)) return [];
      return logs.map((l) => (typeof l === "string" ? l : l?.message || JSON.stringify(l)));
    } catch {
      return [];
    }
  }

  public async getDeviceInfo(): Promise<MobileDeviceInfo> {
    const sId = this.assertSession();
    try {
      const caps = await this.request<Record<string, any>>("GET", `/session/${sId}`);
      const platformVersion = String(
        caps?.platformVersion || caps?.["appium:platformVersion"] || "17",
      );
      const deviceName = String(
        caps?.deviceName || caps?.["appium:deviceName"] || "emulator-5554",
      );
      const model = String(caps?.deviceModel || "Android Emulator");

      return {
        platform: "android",
        deviceName,
        osVersion: platformVersion,
        udid: String(this.currentCaps?.["appium:udid"] || "emulator-5554"),
        model,
      };
    } catch {
      return {
        platform: "android",
        deviceName: "emulator-5554",
        osVersion: "17",
        udid: "emulator-5554",
        model: "sdk_gphone64_x86_64",
      };
    }
  }
}

