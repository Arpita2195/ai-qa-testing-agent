import { randomUUID } from "node:crypto";
import { runMobileTestCase } from "../services/mobileRunner";

async function main() {
  console.log("==================================================");
  console.log("  TASK 15: REAL ANDROID INTERACTION & ASSERTION   ");
  console.log("  Target: emulator-5554 | Appium: 127.0.0.1:4723  ");
  console.log("==================================================\n");

  const runId = randomUUID();
  const resultId = randomUUID();

  // Test with real element tap, assertion, back navigation
  const testSteps = [
    "app launch com.android.settings",
    "wait 2000",
    "expect visible text:Apps",
    "tap text:Apps",
    "wait 2000",
    "expect visible accessibility id:Navigate up",
    "screenshot",
    "tap accessibility id:Navigate up",
    "wait 2000",
    "expect visible text:Search Settings",
    "screenshot",
  ];

  console.log("Running Mobile DSL Steps:");
  testSteps.forEach((s, idx) => console.log(`  ${idx + 1}. ${s}`));
  console.log("\nStarting test execution on emulator-5554...");

  const result = await runMobileTestCase(
    testSteps,
    { runId, resultId },
    {
      appPackage: "com.android.settings",
      deviceUdid: "emulator-5554",
      appiumUrl: "http://127.0.0.1:4723",
      platform: "android",
    },
  );

  console.log("\nExecution completed!");
  console.log(`Status:         ${result.status.toUpperCase()}`);
  console.log(`Duration:       ${result.durationMs}ms`);
  console.log(`Device:         ${result.deviceInfo.deviceName} (${result.deviceInfo.osVersion})`);
  console.log(`Model:          ${result.deviceInfo.model}`);
  console.log(`Screenshot:     ${result.screenshotPath ?? "None"}`);
  console.log(`Crash detected: ${result.evidence.crashEvidence.crashed ? "YES" : "NO"}`);

  if (result.errorMessage) {
    console.error(`Error:          ${result.errorMessage}`);
  }

  console.log("\nStep-by-step results:");
  result.stepResults.forEach((sr) => {
    console.log(
      `  Step ${sr.stepIndex + 1} [${sr.status.toUpperCase()}] (${sr.durationMs}ms): ${sr.stepText}${
        sr.errorMessage ? " -> " + sr.errorMessage : ""
      }`,
    );
  });

  if (result.status !== "passed") {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal test failure:", err);
  process.exit(1);
});
