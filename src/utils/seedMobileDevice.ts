import { pool } from "../config/db";
import { randomUUID } from "node:crypto";
import { env } from "../config/env";

async function seed() {
  const projectId = process.env.MOBILE_SEED_PROJECT_ID;
  const deviceUdid = env.ANDROID_DEVICE_UDID;
  if (!projectId) {
    throw new Error("Set MOBILE_SEED_PROJECT_ID to the project that should receive the sample Android test.");
  }
  if (!deviceUdid) {
    throw new Error("Set ANDROID_DEVICE_UDID to an Android device reported by adb devices -l.");
  }

  const project = await pool.query<{ id: string }>("SELECT id FROM projects WHERE id = $1", [projectId]);
  if (!project.rowCount) {
    throw new Error(`Project "${projectId}" was not found.`);
  }

  const sampleSteps = [
    "app launch com.android.settings",
    "wait 2000",
    "expect visible text:Network",
    "tap text:Network",
    "wait 2000",
    "expect visible text:Internet",
    "screenshot",
    "press back",
    "wait 2000",
    "expect visible text:Network",
    "screenshot",
  ];

  const existingDevice = await pool.query<{ id: string }>(
    "SELECT id FROM mobile_devices WHERE project_id = $1 AND udid = $2 ORDER BY created_at DESC LIMIT 1",
    [projectId, deviceUdid],
  );
  if (existingDevice.rows[0]) {
    await pool.query(
      `UPDATE mobile_devices
       SET name = $1, platform = 'android', os_version = 'Android',
           appium_url = $2, is_active = TRUE, updated_at = NOW()
       WHERE id = $3`,
      [`Android device ${deviceUdid}`, env.APPIUM_URL, existingDevice.rows[0].id],
    );
  } else {
    await pool.query(
      `INSERT INTO mobile_devices (project_id, name, platform, udid, os_version, appium_url, is_active)
       VALUES ($1, $2, 'android', $3, 'Android', $4, TRUE)`,
      [projectId, `Android device ${deviceUdid}`, deviceUdid, env.APPIUM_URL],
    );
  }

  const testCaseTitle = "Android Settings & Network Verification";
  const testCaseSteps = JSON.stringify([
    "Launch Android Settings",
    "Verify the Network settings entry is visible",
    "Open Network settings and verify Internet is visible",
    "Navigate back to Network settings",
  ]);
  const existingCase = await pool.query<{ id: string }>(
    "SELECT id FROM test_cases WHERE project_id = $1 AND title = $2 ORDER BY created_at DESC LIMIT 1",
    [projectId, testCaseTitle],
  );
  let testCaseId = existingCase.rows[0]?.id;
  if (testCaseId) {
    await pool.query(
      `UPDATE test_cases
       SET description = $1, steps = $2, expected_result = $3, review_status = 'approved'
       WHERE id = $4`,
      [
        "Verifies navigation in the Android Settings app on the selected emulator or device.",
        testCaseSteps,
        "Network settings open and the Settings screen can be restored.",
        testCaseId,
      ],
    );
  } else {
    const tcRes = await pool.query<{ id: string }>(
      `INSERT INTO test_cases
         (id, project_id, title, description, steps, expected_result, review_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'approved') RETURNING id`,
      [
        randomUUID(),
        projectId,
        testCaseTitle,
        "Verifies navigation in the Android Settings app on the selected emulator or device.",
        testCaseSteps,
        "Network settings open and the Settings screen can be restored.",
      ],
    );
    testCaseId = tcRes.rows[0]?.id;
  }
  if (!testCaseId) throw new Error("Failed to create the sample Android test case.");

  await pool.query(
    `INSERT INTO test_case_automations (
       id, project_id, test_case_id, target_type, status, mobile_steps,
       app_package, app_activity, device_udid, platform
     ) VALUES ($1, $2, $3, 'mobile', 'approved', $4,
       'com.android.settings', '.Settings', $5, 'android')
     ON CONFLICT (test_case_id) DO UPDATE SET
       target_type = 'mobile', status = 'approved', mobile_steps = EXCLUDED.mobile_steps,
       app_package = EXCLUDED.app_package, app_activity = EXCLUDED.app_activity,
       device_udid = EXCLUDED.device_udid, platform = 'android', updated_at = NOW()`,
    [randomUUID(), projectId, testCaseId, JSON.stringify(sampleSteps), deviceUdid],
  );

  console.log(`Seeded Android device and approved sample mobile test for project ${projectId}.`);
  await pool.end();
}

seed().catch((err) => {
  console.error("Seeding error:", err);
  process.exit(1);
});
