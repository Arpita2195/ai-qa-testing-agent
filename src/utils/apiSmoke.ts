import { env } from "../config/env";

const apiBase = "http://localhost:3000";
const headers = {
  "Content-Type": "application/json",
  "x-api-key": env.PLATFORM_API_KEY,
};

interface Project {
  id: string;
  name: string;
}

interface Endpoint {
  id: string;
  name: string;
  method: string;
  path: string;
}

interface ApiRun {
  id: string;
  status: string;
  results: Array<{
    endpoint_id: string;
    name?: string;
    status: string;
    error_message: string | null;
  }>;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  const body: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw new Error(`${init?.method ?? "GET"} ${path} failed (${response.status})`);
  }
  return body as T;
}

async function runSmoke(): Promise<void> {
  const projects = await requestJson<Project[]>("/projects");
  let project = projects.find((candidate) => candidate.name === "API Demo");
  if (!project) {
    project = await requestJson<Project>("/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "API Demo",
        base_url: "https://jsonplaceholder.typicode.com",
      }),
    });
  }

  const endpointPath = `/projects/${project.id}/api-endpoints`;
  const endpoints = await requestJson<Endpoint[]>(endpointPath);
  const desired: Array<{
    name: string;
    method: "GET";
    path: string;
    expected_status: number;
    expected_fields?: Record<string, string>;
  }> = [
    { name: "Get post", method: "GET", path: "/posts/1", expected_status: 200, expected_fields: { id: "number", title: "string" } },
    { name: "List posts", method: "GET", path: "/posts", expected_status: 200 },
    { name: "Intentional failure", method: "GET", path: "/posts/999999", expected_status: 200 },
  ];

  for (const endpoint of desired) {
    if (!endpoints.some((existing) => existing.name === endpoint.name)) {
      await requestJson<Endpoint>(endpointPath, {
        method: "POST",
        body: JSON.stringify(endpoint),
      });
    }
  }

  const run = await requestJson<ApiRun>(`/projects/${project.id}/api-runs`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  for (const result of run.results) {
    const endpoint = endpoints.find((item) => item.id === result.endpoint_id);
    console.log(`${endpoint?.name ?? result.name ?? result.endpoint_id}: ${result.status}${result.error_message ? ` — ${result.error_message}` : ""}`);
  }
  console.log(`API run: ${run.status}`);
}

void runSmoke().catch((error: unknown) => {
  console.error(`API smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
