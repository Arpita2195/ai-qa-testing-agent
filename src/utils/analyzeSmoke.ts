export {};

import { env } from "../config/env";

const baseUrl = "http://localhost:3000";

interface Project {
  id: string;
  name: string;
}

interface TestRun {
  id: string;
  status: string;
}

interface BugReport {
  title: string;
  severity: string;
  classification: string;
  probable_cause: string;
}

interface AnalyzeRunResponse {
  reports: BugReport[];
  errors: Array<{ result_id: string; error: string }>;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "x-api-key": env.PLATFORM_API_KEY, ...init?.headers },
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body as T;
}

async function runSmoke(): Promise<void> {
  const projects = await requestJson<Project[]>("/projects");
  const project = projects.find((candidate) => candidate.name === "Demo");
  if (!project) {
    throw new Error('Project "Demo" does not exist');
  }

  const testCase = await requestJson<{ id: string }>(
    `/projects/${project.id}/test-cases`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Intentional failure",
        steps: ["goto /", "expect text This text does not exist anywhere"],
        expected_result: "The page shows the specified text.",
      }),
    },
  );
  console.log(`Created intentional failure test case: ${testCase.id}`);

  const run = await requestJson<TestRun>(`/projects/${project.id}/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  console.log(`Test run status (runner): ${run.status}`);
  if (run.status !== "failed") {
    throw new Error(`Expected runner status "failed", received "${run.status}"`);
  }

  const analysis = await requestJson<AnalyzeRunResponse>(`/runs/${run.id}/analyze`, {
    method: "POST",
  });

  for (const report of analysis.reports) {
    console.log(`Bug report: ${report.title}`);
    console.log(`Severity: ${report.severity}`);
    console.log(`Classification: ${report.classification}`);
    console.log(`Probable cause: ${report.probable_cause}`);
  }

  for (const error of analysis.errors) {
    console.error(`Analysis skipped for result ${error.result_id}: ${error.error}`);
  }

  if (analysis.reports.length === 0) {
    throw new Error("No bug report was created for the intentional failure");
  }
}

void runSmoke().catch((error: unknown) => {
  console.error(`Analysis smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
