import { readFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";

const requiredKeys = [
  "STOCKFLOW_BASE_URL",
  "STOCKFLOW_TEST_EMAIL",
  "STOCKFLOW_TEST_PASSWORD",
  "PLATFORM_API_KEY",
] as const;

async function checkEnvironment(): Promise<void> {
  const envPath = path.resolve(process.cwd(), ".env");
  let parsed: Record<string, string> = {};
  try {
    parsed = dotenv.parse(await readFile(envPath));
  } catch {
    for (const key of requiredKeys) console.log(`${key}: missing`);
    process.exitCode = 1;
    return;
  }

  let missing = false;
  for (const key of requiredKeys) {
    const isSet = typeof parsed[key] === "string" && parsed[key].trim().length > 0;
    console.log(`${key}: ${isSet ? "set" : "missing"}`);
    if (!isSet) missing = true;
  }
  if (missing) process.exitCode = 1;
}

void checkEnvironment();
