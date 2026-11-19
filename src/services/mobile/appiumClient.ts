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
 * Strictly validates an explicitly configured trusted remote Appium endpoint.
 * For AWS remote deployment, only the dedicated Docker bridge endpoint is permitted:
 * http://172.18.0.1:4724 (normalized path "/").
 * Arbitrary public IPs, external hostnames, other private network addresses, credentials,
 * query strings, fragments, and subpaths are strictly rejected.
 */
export function validateTrustedRemoteAppiumUrl(trustedUrl: string): URL {
  if (!trustedUrl || typeof trustedUrl !== "string") {
    throw new MobileDriverError("Trusted Appium server URL must be a non-empty string", 400, true);
  }

  let parsed: URL;
  try {
    parsed = new URL(trustedUrl);
  } catch {
    throw new MobileDriverError(`Invalid trusted Appium server URL: ${trustedUrl}`, 400, true);
  }

  if (parsed.protocol !== "http:") {
    throw new MobileDriverError(
      `Invalid protocol "${parsed.protocol}" for trusted remote Appium. Only "http:" is permitted for the Docker bridge.`,
      400,
      true,
    );
  }

  if (parsed.username || parsed.password) {
    throw new MobileDriverError("Trusted Appium server URL must not contain credentials", 400, true);
  }

  if (parsed.search || parsed.hash) {
    throw new MobileDriverError(
      "Trusted Appium server URL must not contain query parameters or a fragment",
      400,
      true,
    );
  }

  const normPath = parsed.pathname.replace(/\/$/, "") || "/";
  if (normPath !== "/") {
    throw new MobileDriverError("Trusted Appium server URL must not contain a subpath", 400, true);
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // For AWS remote execution, only the Docker bridge gateway interface 172.18.0.1 is permitted
  if (hostname !== "172.18.0.1") {
    throw new MobileDriverError(
      `Remote host "${hostname}" is forbidden. For AWS remote execution, only the Docker bridge endpoint http://172.18.0.1:4724 is permitted.`,
      403,
      true,
    );
  }

  // Only port 4724 (the socat bridge forwarding to the reverse tunnel) is permitted
  if (parsed.port !== "4724") {
    throw new MobileDriverError(
      `Port "${parsed.port}" is forbidden for remote Appium. Only port 4724 is permitted.`,
      403,
      true,
    );
  }

  return parsed;
}

/**
 * Validates that the Appium server URL is safe.
 * Permits local loopback interfaces (127.0.0.1, localhost, ::1),
 * or the explicitly configured trusted remote Appium URL.
 * Strictly blocks any attempt to connect to arbitrary hosts, public IPs, or metadata services.
 */
export function assertSafeAppiumUrl(serverUrl: string, trustedRemoteUrl?: string): URL {
  if (!serverUrl || typeof serverUrl !== "string") {
    throw new MobileDriverError("Appium server URL must be a non-empty string", 400, true);
  }

  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new MobileDriverError(`Invalid Appium server URL: ${serverUrl}`, 400, true);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MobileDriverError(`Invalid protocol "${parsed.protocol}" for Appium server`, 400, true);
  }

  if (parsed.username || parsed.password) {
    throw new MobileDriverError(
      "Appium server URL must not contain credentials",
      400,
      true,
    );
  }

  if (parsed.search || parsed.hash) {
    throw new MobileDriverError(
      "Appium server URL must not contain query parameters or a fragment",
      400,
      true,
    );
  }

  const normPath = parsed.pathname.replace(/\/$/, "") || "/";
  if (normPath !== "/") {
    throw new MobileDriverError(
      "Appium server URL must not contain a subpath",
      400,
      true,
    );
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLocal =
    hostname === "127.0.0.1" ||
    hostname === "localhost" ||
    hostname === "::1";

  if (isLocal) {
    return parsed;
  }

  const isDockerHost =
    hostname === "host.docker.internal" &&
    process.env.APPIUM_ALLOW_DOCKER_HOST === "true" &&
    (parsed.port === "" || parsed.port === "4723");

  if (isDockerHost) {
    return parsed;
  }

  const rawCandidate =
    trustedRemoteUrl ??
    process.env.APPIUM_TRUSTED_REMOTE_URL ??
    process.env.TRUSTED_REMOTE_APPIUM_URL;

  const rawTrusted =
    typeof rawCandidate === "string" && rawCandidate.trim() !== ""
      ? rawCandidate.trim()
      : undefined;

  if (rawTrusted) {
    // Validate the trusted remote endpoint independently.
    // A URL cannot authorize itself unless it strictly satisfies the permitted Docker bridge configuration.
    const trustedParsed = validateTrustedRemoteAppiumUrl(rawTrusted);
    const trustedHost = trustedParsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const normTrustedPath = trustedParsed.pathname.replace(/\/$/, "") || "/";

    const matchesExact =
      parsed.protocol === trustedParsed.protocol &&
      hostname === trustedHost &&
      parsed.port === trustedParsed.port &&
      normPath === normTrustedPath;

    if (matchesExact) {
      return parsed;
    }
  }

  throw new MobileDriverError(
    `Remote host "${hostname}" is forbidden for security. Appium server must run on a local loopback interface or the exact configured trusted remote URL.`,
    403,
    true,
  );
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
  private sessionCaps: Record<string, any> | null = null;
  private windowSize: { width: number; height: number } | null = null;

  constructor(serverUrl: string = "http://127.0.0.1:4723", trustedRemoteUrl?: string) {
    const safeUrl = assertSafeAppiumUrl(serverUrl, trustedRemoteUrl);
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
    const deviceUdid = caps["appium:udid"] || caps["appium:deviceName"];
    if (!deviceUdid) {
      throw new MobileDriverError("An Android device UDID is required to create an Appium session", 400, true);
    }

    this.currentCaps = caps;
    const body = {
      capabilities: {
        alwaysMatch: {
          platformName: caps.platformName || "Android",
          "appium:automationName": caps["appium:automationName"] || "UiAutomator2",
          "appium:deviceName": caps["appium:deviceName"] || deviceUdid,
          "appium:udid": deviceUdid,
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

    const res = await this.request<{ sessionId: string; capabilities?: Record<string, any> }>(
      "POST",
      "/session",
      body,
      60000,
    );
    this._sessionId = res.sessionId;
    this.sessionCaps = res.capabilities || null;

    // Set implicit wait timeout to allow elements to render during transitions
    try {
      await this.request("POST", `/session/${this._sessionId}/timeouts`, { implicit: 5000 });
    } catch {
      // Best effort if timeouts endpoint is not supported
    }

    return this._sessionId;
  }

  public async deleteSession(): Promise<void> {
    if (!this._sessionId) return;
    const sId = this._sessionId;
    this._sessionId = null;
    this.sessionCaps = null;
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
    if (appActivity) {
      try {
        await this.request("POST", `/session/${sId}/appium/device/start_activity`, {
          appPackage,
          appActivity,
          stopApp: true,
        });
        return;
      } catch {
        // Fallback to activate_app
      }
    }

    try {
      // First terminate if already running to ensure fresh start
      try {
        await this.request("POST", `/session/${sId}/appium/device/terminate_app`, {
          appId: appPackage,
        });
      } catch {}

      await this.request("POST", `/session/${sId}/appium/device/activate_app`, {
        appId: appPackage,
      });
    } catch {
      // Fallback for older server commands
      try {
        await this.request("POST", `/session/${sId}/appium/app/launch`);
      } catch {
        // Best effort
      }
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
      const rawRes = this.sessionCaps || (await this.request<Record<string, any>>("GET", `/session/${sId}`));
      const caps = (rawRes && typeof rawRes === "object" && "capabilities" in rawRes && rawRes.capabilities)
        ? rawRes.capabilities
        : (rawRes && typeof rawRes === "object" && "value" in rawRes && rawRes.value && typeof rawRes.value === "object" && !("error" in rawRes.value))
        ? rawRes.value
        : rawRes;

      const rawVersion =
        caps?.platformVersion ??
        caps?.["appium:platformVersion"] ??
        caps?.deviceApiLevel ??
        caps?.["appium:deviceApiLevel"];
      const osVersion = rawVersion !== undefined && rawVersion !== null && String(rawVersion).trim() !== ""
        ? String(rawVersion).trim()
        : "unknown";

      const rawUdid =
        caps?.deviceUDID ??
        caps?.["appium:deviceUDID"] ??
        caps?.["appium:udid"] ??
        caps?.udid ??
        this.currentCaps?.["appium:udid"];
      const udid = rawUdid !== undefined && rawUdid !== null && String(rawUdid).trim() !== ""
        ? String(rawUdid).trim()
        : "unknown";

      const rawDeviceName =
        caps?.deviceName ??
        caps?.["appium:deviceName"] ??
        (udid !== "unknown" ? udid : undefined) ??
        this.currentCaps?.["appium:deviceName"];
      const deviceName = rawDeviceName !== undefined && rawDeviceName !== null && String(rawDeviceName).trim() !== ""
        ? String(rawDeviceName).trim()
        : (udid !== "unknown" ? udid : "unknown");

      const rawModel = caps?.deviceModel ?? caps?.["appium:deviceModel"] ?? caps?.model;
      const model = rawModel !== undefined && rawModel !== null && String(rawModel).trim() !== ""
        ? String(rawModel).trim()
        : undefined;

      const rawApiLevel = caps?.deviceApiLevel ?? caps?.["appium:deviceApiLevel"];
      const apiLevel = rawApiLevel !== undefined && rawApiLevel !== null && String(rawApiLevel).trim() !== ""
        ? String(rawApiLevel).trim()
        : undefined;

      return {
        platform: "android",
        deviceName,
        osVersion,
        udid,
        ...(model ? { model } : {}),
        ...(apiLevel ? { apiLevel } : {}),
      };
    } catch {
      const fallbackUdid = String(this.currentCaps?.["appium:udid"] || "").trim() || "unknown";
      return {
        platform: "android",
        deviceName: fallbackUdid,
        osVersion: "unknown",
        udid: fallbackUdid,
      };
    }
  }
}
