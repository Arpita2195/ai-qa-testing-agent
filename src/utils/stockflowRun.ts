import { env } from "../config/env";

const apiUrl = "http://localhost:3000";
const headers = {
  "content-type": "application/json",
  "x-api-key": env.PLATFORM_API_KEY,
};

interface Project {
  id: string;
  name: string;
}

interface TestCase {
  id: string;
  title: string;
}

interface RunResult {
  test_case_id: string;
  status: string;
  error_message: string | null;
}

interface Run {
  status: string;
  results: RunResult[];
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${route}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  if (!response.ok) throw new Error(`Platform API request failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function runStockFlow(): Promise<void> {
  const projects = await request<Project[]>("/projects");
  const project = projects.find((candidate) => candidate.name === "StockFlow");
  if (!project) throw new Error("StockFlow project was not found; run npm run setup:stockflow first.");

  const cases = await request<TestCase[]>(`/projects/${project.id}/test-cases`);
  const run = await request<Run>(`/projects/${project.id}/runs`, {
    method: "POST",
    body: "{}",
  });
  for (const result of run.results) {
    const title = cases.find((testCase) => testCase.id === result.test_case_id)?.title ?? "Test case";
    const safeError = result.error_message ? ` | ${result.error_message}` : "";
    console.log(`${title} | ${result.status}${safeError}`);
  }
}

void runStockFlow().catch((error: unknown) => {
  console.error(`StockFlow run failed: ${error instanceof Error ? error.message : "Unexpected error"}`);
  process.exitCode = 1;
});
