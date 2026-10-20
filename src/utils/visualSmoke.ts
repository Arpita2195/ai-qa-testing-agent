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

interface VisualCheck {
  id: string;
}

interface VisualResult {
  check_id: string;
  status: "passed" | "failed" | "baseline_created";
  baseline_id: string | null;
}

interface VisualRun {
  results: VisualResult[];
}

async function request<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${route}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  if (!response.ok) throw new Error(`Platform API request failed (${response.status})`);
  return response.json() as Promise<T>;
}

async function smoke(): Promise<void> {
  const projects = await request<Project[]>("/projects");
  const demo = projects.find((project) => project.name === "Demo");
  if (!demo) throw new Error("Demo project was not found.");

  const check = await request<VisualCheck>(`/projects/${demo.id}/visual-checks`, {
    method: "POST",
    body: JSON.stringify({ name: `Visual smoke ${Date.now()}`, path: "/" }),
  });
  const firstRun = await request<VisualRun>(`/projects/${demo.id}/visual-runs`, {
    method: "POST",
    body: "{}",
  });
  const firstResult = firstRun.results.find((result) => result.check_id === check.id);
  if (!firstResult || firstResult.status !== "baseline_created" || !firstResult.baseline_id) {
    throw new Error(`Expected a pending baseline, received ${firstResult?.status ?? "no result"}.`);
  }
  console.log(`First visual run: ${firstResult.status}`);

  await request(`/visual-baselines/${firstResult.baseline_id}/review`, {
    method: "PATCH",
    body: JSON.stringify({ review_status: "approved" }),
  });
  const secondRun = await request<VisualRun>(`/projects/${demo.id}/visual-runs`, {
    method: "POST",
    body: "{}",
  });
  const secondResult = secondRun.results.find((result) => result.check_id === check.id);
  if (!secondResult || secondResult.status !== "passed") {
    throw new Error(`Expected the approved baseline to pass, received ${secondResult?.status ?? "no result"}.`);
  }
  console.log(`Second visual run: ${secondResult.status}`);
}

void smoke().catch((error: unknown) => {
  console.error(`Visual smoke failed: ${error instanceof Error ? error.message : "Unexpected error"}`);
  process.exitCode = 1;
});
