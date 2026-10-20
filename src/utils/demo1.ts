import { env } from "../config/env";
import { redactSecrets } from "../services/runner";
import { setupStockFlow } from "./stockflowSetup";

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
  steps: string[];
  review_status: string;
}

interface Run {
  id: string;
  status: string;
  results: Array<{ id: string; test_case_id: string; title: string; status: string }>;
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${route}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  if (!response.ok) {
    throw new Error(`Platform request failed (${response.status})`);
  }
  return response.status === 204 ? null as T : response.json() as Promise<T>;
}

function readOnly(testCase: TestCase): boolean {
  if (/add\s+(?:a\s+new\s+)?product|creates?\s+data|edit|delete|update/i.test(testCase.title)) {
    return false;
  }
  for (const step of testCase.steps) {
    if (step.startsWith("fill ")) {
      const [rawSelector = "", rawValue = ""] = step.slice("fill ".length).split("|", 2);
      const selector = rawSelector.toLowerCase();
      if (/product|order|quantity|price|sku|warehouse|supplier/.test(selector)) return false;
      const credentialFill = /{{STOCKFLOW_TEST_(?:EMAIL|PASSWORD)}}/.test(rawValue);
      const searchFill = /inventory|search|filter/i.test(testCase.title);
      if (!credentialFill && !searchFill) return false;
    }
    if (/^(?:click|select)\s+/.test(step) && /(?:delete|remove|edit|update|create|save|add)[-_]/i.test(step)) {
      return false;
    }
  }
  return true;
}

async function runDemo(): Promise<void> {
  const healthResponse = await fetch(`${apiUrl}/health`);
  if (!healthResponse.ok) throw new Error("Backend health check failed");
  const health = await healthResponse.json() as { status?: string };
  if (health.status !== "ok") throw new Error("Backend health check failed");

  let projects = await request<Project[]>("/projects");
  let project = projects.find((item) => item.name === "StockFlow");
  if (!project) {
    await setupStockFlow();
    projects = await request<Project[]>("/projects");
    project = projects.find((item) => item.name === "StockFlow");
  }
  if (!project) throw new Error("StockFlow project was not found");

  let cases = await request<TestCase[]>(`/projects/${project.id}/test-cases`);
  if (cases.length === 0) {
    await setupStockFlow();
    cases = await request<TestCase[]>(`/projects/${project.id}/test-cases`);
  }

  for (const testCase of cases) {
    let decision = "left pending (not approved)";
    const isReadOnly = readOnly(testCase);
    if (isReadOnly && testCase.review_status !== "approved") {
      await request(`/test-cases/${testCase.id}/review`, {
        method: "PATCH",
        body: JSON.stringify({ review_status: "approved" }),
      });
      decision = "approved (read-only)";
    } else if (isReadOnly && testCase.review_status === "approved") {
      decision = "already approved";
    } else if (!isReadOnly && testCase.review_status === "approved") {
      await request(`/test-cases/${testCase.id}/review`, {
        method: "PATCH",
        body: JSON.stringify({ review_status: "pending" }),
      });
      decision = "left pending (may modify data)";
    } else {
      decision = "left pending (may modify data)";
    }
    console.log(`${redactSecrets(testCase.title)} | ${decision}`);
  }

  cases = await request<TestCase[]>(`/projects/${project.id}/test-cases`);
  let intentionalFailure = cases.find((item) => item.title === "Intentional failure: missing text");
  if (!intentionalFailure) {
    intentionalFailure = await request<TestCase>(`/projects/${project.id}/test-cases`, {
      method: "POST",
      body: JSON.stringify({
        title: "Intentional failure: missing text",
        description: "Confirms that a missing page string is reported as a test failure.",
        steps: ["goto /", "expect text This text should never appear on the page"],
        expected_result: "The intentionally absent text appears on the page.",
      }),
    });
  }
  if (intentionalFailure.review_status !== "approved") {
    await request(`/test-cases/${intentionalFailure.id}/review`, {
      method: "PATCH",
      body: JSON.stringify({ review_status: "approved" }),
    });
  }

  const run = await request<Run>(`/projects/${project.id}/runs`, {
    method: "POST",
    body: "{}",
  });
  for (const result of run.results) {
    console.log(`${redactSecrets(result.title)} | ${result.status}`);
  }
  console.log(`Run status: ${run.status}`);
  console.log(`Report: artifacts/runs/${run.id}/report.html`);
}

void runDemo().catch((error: unknown) => {
  console.error(`Demo 1 failed: ${error instanceof Error ? error.message : "Unexpected error"}`);
  process.exitCode = 1;
});
