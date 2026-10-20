import { env } from "../config/env";

const baseUrl = "http://localhost:3000";

interface Project {
  id: string;
  name: string;
  base_url: string;
}

interface TestCase {
  id: string;
  title: string;
}

interface TestResult {
  test_case_id: string;
  status: string;
  error_message?: string | null;
}

interface TestRun {
  id: string;
  status: string;
  results: TestResult[];
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "x-api-key": env.PLATFORM_API_KEY, ...init?.headers },
  });
  const body: unknown = await response.json();

  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} returned ${response.status}`);
  }

  return body as T;
}

async function runSmokeTest(): Promise<void> {
  const health = await requestJson<{ status: string; database: string }>("/health");
  console.log(`Health: ${health.status} (database ${health.database})`);

  if (health.status !== "ok" || health.database !== "connected") {
    throw new Error("Health check failed");
  }

  const projects = await requestJson<Project[]>("/projects");
  let project = projects.find((candidate) => candidate.name === "Demo");

  if (!project) {
    project = await requestJson<Project>("/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Demo", base_url: "https://example.com" }),
    });
    console.log(`Project: created Demo (${project.id})`);
  } else {
    console.log(`Project: found Demo (${project.id})`);
  }

  const casesPath = `/projects/${project.id}/test-cases`;
  const testCases = await requestJson<TestCase[]>(casesPath);
  let testCase = testCases.find((candidate) => candidate.title === "Homepage loads");

  if (!testCase) {
    testCase = await requestJson<TestCase>(casesPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Homepage loads",
        steps: ["goto /", "expect text This domain is for use in documentation examples"],
        expected_result: "Page shows the documentation examples notice",
      }),
    });
    console.log(`Test case: created Homepage loads (${testCase.id})`);
  } else {
    console.log(`Test case: found Homepage loads (${testCase.id})`);
  }

  const run = await requestJson<TestRun>(`/projects/${project.id}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  console.log(`Run: ${run.status}`);

  for (const result of run.results) {
    const errorDetail = result.error_message ? ` — errorMessage: ${result.error_message}` : "";
    console.log(`Test case ${result.test_case_id}: ${result.status}${errorDetail}`);
  }

  if (run.status !== "passed") {
    throw new Error(`Run did not pass (status: ${run.status})`);
  }
}

void runSmokeTest().catch((error: unknown) => {
  console.error(`Smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
