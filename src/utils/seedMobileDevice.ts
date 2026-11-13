import { pool } from "../config/db";
import { randomUUID } from "node:crypto";

async function seed() {
  const projects = await pool.query<{ id: string }>("SELECT id FROM projects");

  const sampleSteps = [
    "app launch com.android.settings",
    "wait 2000",
    "expect visible text:Network & internet",
    "tap text:Network & internet",
    "wait 2000",
    "expect visible text:Internet",
    "screenshot",
    "press back",
    "wait 2000",
    "expect visible text:Search Settings",
    "screenshot",
  ];

  for (const p of projects.rows) {
    // 1. Device registration
    const existingDevice = await pool.query(
      "SELECT id FROM mobile_devices WHERE project_id = $1 AND udid = $2",
      [p.id, "emulator-5554"],
    );
    if (existingDevice.rowCount === 0) {
      await pool.query(
        `INSERT INTO mobile_devices (project_id, name, platform, udid, os_version, appium_url, is_active)
         VALUES ($1, 'Pixel 7 Emulator', 'android', 'emulator-5554', '17 (API 35)', 'http://127.0.0.1:4723', true)`,
        [p.id],
      );
    }

    // 2. Sample approved test case & automation
    const existingCase = await pool.query(
      "SELECT id FROM test_cases WHERE project_id = $1 AND title = $2",
      [p.id, "Android Settings & Network Verification"],
    );

    let testCaseId: string;
    if (existingCase.rowCount === 0) {
      const tcRes = await pool.query<{ id: string }>(
        `INSERT INTO test_cases (id, project_id, title, description, steps, expected_result)
         VALUES ($1, $2, 'Android Settings & Network Verification', 'Validates settings navigation, network status, and back navigation on Android emulator.', $3, 'Settings opens and network status displays successfully.')
         RETURNING id`,
        [
          randomUUID(),
          p.id,
          JSON.stringify([
            "Launch Settings app",
            "Verify Network & internet is visible",
            "Tap Network & internet",
            "Verify Internet setting is visible",
            "Navigate back to main settings",
          ]),
        ],
      );
      testCaseId = tcRes.rows[0].id;
    } else {
      testCaseId = existingCase.rows[0].id;
    }

    const existingAuto = await pool.query(
      "SELECT id FROM test_case_automations WHERE test_case_id = $1",
      [testCaseId],
    );
    if (existingAuto.rowCount === 0) {
      await pool.query(
        `INSERT INTO test_case_automations (
           id, project_id, test_case_id, target_type, status,
           mobile_steps, app_package, app_activity, device_udid, platform
         ) VALUES (
           $1, $2, $3, 'mobile', 'approved',
           $4, 'com.android.settings', '.Settings', 'emulator-5554', 'android'
         )`,
        [randomUUID(), p.id, testCaseId, JSON.stringify(sampleSteps)],
      );
    }
  }

  console.log("Successfully seeded device and approved mobile test case for all projects!");
  await pool.end();
}

seed().catch((err) => {
  console.error("Seeding error:", err);
  process.exit(1);
});
