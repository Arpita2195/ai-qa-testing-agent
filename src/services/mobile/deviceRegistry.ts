import { execFile } from "node:child_process";
import { pool } from "../../config/db";
import { env } from "../../config/env";
import { assertSafeAppiumUrl } from "./appiumClient";

export interface AndroidDevice {
  udid: string;
  state: string;
  isEmulator: boolean;
  model?: string;
}

export interface AndroidDeviceDiscovery {
  devices: AndroidDevice[];
  error?: string;
}

export interface MobileDeviceConfiguration {
  udid: string;
  appiumUrl: string;
}

export function parseAdbDevices(output: string): AndroidDevice[] {
  return output
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [udid, state, ...details] = line.split(/\s+/);
      const model = details.find((detail) => detail.startsWith("model:"))?.slice("model:".length);
      return {
        udid,
        state,
        isEmulator: udid.startsWith("emulator-"),
        ...(model ? { model: model.replace(/_/g, " ") } : {}),
      };
    });
}

export async function discoverAndroidDevices(): Promise<AndroidDeviceDiscovery> {
  try {
    const output = await new Promise<string>((resolve, reject) => {
      execFile(
        "adb",
        ["devices", "-l"],
        { timeout: 3000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });
    return { devices: parseAdbDevices(output) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      devices: [],
      error:
        code === "ENOENT"
          ? "Android Debug Bridge (adb) is not installed or is not available on the backend PATH."
          : `Unable to discover Android devices: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function resolveMobileDeviceConfiguration(
  projectId: string,
  requestedUdid?: string,
  allowMissing = false,
): Promise<MobileDeviceConfiguration | null> {
  const result = await pool.query<{ udid: string; appium_url: string }>(
    `SELECT udid, appium_url
     FROM mobile_devices
     WHERE project_id = $1 AND platform = 'android' AND is_active = TRUE
       AND ($2::text IS NULL OR udid = $2)
     ORDER BY created_at ASC
     LIMIT 2`,
    [projectId, requestedUdid ?? null],
  );

  if (result.rows.length > 1) {
    throw new Error("More than one active Android device is registered; select a device UDID.");
  }

  const registeredDevice = result.rows[0];
  if (registeredDevice) {
    const appiumUrl = assertSafeAppiumUrl(registeredDevice.appium_url).toString().replace(/\/$/, "");
    return { udid: registeredDevice.udid, appiumUrl };
  }

  if (requestedUdid) {
    if (env.ANDROID_DEVICE_UDID === requestedUdid) {
      const appiumUrl = assertSafeAppiumUrl(env.APPIUM_URL).toString().replace(/\/$/, "");
      return { udid: requestedUdid, appiumUrl };
    }
    throw new Error(`Android device "${requestedUdid}" is not registered as an active device for this project.`);
  }

  if (env.ANDROID_DEVICE_UDID) {
    const appiumUrl = assertSafeAppiumUrl(env.APPIUM_URL).toString().replace(/\/$/, "");
    return { udid: env.ANDROID_DEVICE_UDID, appiumUrl };
  }

  if (allowMissing) return null;
  throw new Error("No active Android device is registered for this project. Register and select a device first.");
}
