import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, apiBase } from "../App";

export interface SystemHealthResponse {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: string;
  responseTimeMs: number;
  checks: {
    database: { status: "up" | "down"; latencyMs?: number; message?: string };
    storage: { status: "up" | "down" | "degraded"; latencyMs?: number; message?: string };
    worker: { status: "up" | "down" | "degraded"; message?: string };
  };
  system: {
    uptimeSeconds: number;
    heapUsedMb: number;
    heapTotalMb: number;
    rssMb: number;
  };
}

export interface SystemMetricsResponse {
  success: boolean;
  projectId: string | null;
  metrics: {
    tests: {
      total: number;
      passed: number;
      failed: number;
      skipped: number;
      inconclusive: number;
      flaky: number;
      passRatePercent: number;
      duration: {
        count: number;
        avgMs: number;
        p50Ms: number;
        p95Ms: number;
        minMs: number;
        maxMs: number;
      };
    };
    jobs: {
      pending: number;
      active: number;
      completed: number;
      failed: number;
      retrying: number;
      cancelled: number;
      total: number;
      queueDelay: {
        count: number;
        avgMs: number;
        p50Ms: number;
        p95Ms: number;
        minMs: number;
        maxMs: number;
      };
      worker: {
        retries: number;
        failures: number;
      };
    };
    ai: {
      totalRequests: number;
      totalTokens: number;
      promptTokens: number;
      completionTokens: number;
      estimatedCostUsd: number;
      breakdownByFeature: Record<string, { requests: number; tokens: number; costUsd: number }>;
    };
    api: {
      totalRequests: number;
      errors: Record<string, number>;
    };
    alerts: Array<{
      ruleId: string;
      ruleName: string;
      severity: "info" | "warning" | "critical";
      message: string;
      currentValue: number;
      threshold: number;
      triggeredAt: string;
    }>;
  };
  timestamp: string;
}

interface MonitoringProject {
  id: string;
  name: string;
}

export interface JobItem {
  id: string;
  projectId: string;
  queueName: string;
  jobType: string;
  status: "pending" | "active" | "completed" | "failed" | "retrying" | "cancelled";
  payload: any;
  result?: any;
  errorMessage?: string | null;
  retries: number;
  maxRetries: number;
  queueDelayMs?: number | null;
  durationMs?: number | null;
  enqueuedAt: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export function MonitoringDashboardPage() {
  const [health, setHealth] = useState<SystemHealthResponse | null>(null);
  const [metrics, setMetrics] = useState<SystemMetricsResponse | null>(null);
  const [projects, setProjects] = useState<MonitoringProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [loading, setLoading] = useState(true);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [error, setError] = useState("");
  const [projectsError, setProjectsError] = useState("");
  const [lastUpdated, setLastUpdated] = useState<Date>(new Date());
  const activeRequest = useRef(0);

  const selectedProject = projects.find((project) => project.id === selectedProjectId);

  const loadData = useCallback(async (projectId: string) => {
    const requestId = ++activeRequest.current;
    setError("");
    setLoading(true);
    try {
      const [healthRes, metricsRes] = await Promise.all([
        api<SystemHealthResponse>("/api/monitoring/health"),
        projectId
          ? api<SystemMetricsResponse>(
              `/api/monitoring/metrics?projectId=${encodeURIComponent(projectId)}`,
            )
          : Promise.resolve(null),
      ]);
      if (requestId !== activeRequest.current) return;
      setHealth(healthRes);
      setMetrics(metricsRes);
      setLastUpdated(new Date());
    } catch (err: any) {
      if (requestId === activeRequest.current) {
        setError(err.message || "Failed to load telemetry");
      }
    } finally {
      if (requestId === activeRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    api<MonitoringProject[]>("/projects")
      .then((projectRows) => {
        setProjects(projectRows);
        setSelectedProjectId(projectRows[0]?.id ?? "");
      })
      .catch((err: unknown) => {
        setProjectsError(err instanceof Error ? err.message : "Failed to load projects");
      })
      .finally(() => setProjectsLoading(false));
  }, []);

  useEffect(() => {
    void loadData(selectedProjectId);
    const interval = setInterval(() => void loadData(selectedProjectId), 10000);
    return () => clearInterval(interval);
  }, [loadData, selectedProjectId]);

  if (loading && !health) {
    return (
      <div style={{ padding: "20px" }}>
        <h2>System Monitoring & Observability</h2>
        <p className="notice">Loading telemetry data…</p>
      </div>
    );
  }

  const m = metrics?.metrics;
  const isHealthy = health?.status === "healthy";
  const isDegraded = health?.status === "degraded";

  return (
    <section style={{ maxWidth: "1200px", margin: "0 auto", padding: "10px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: "1.75rem" }}>Project Monitoring & Observability</h1>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Test executions, background jobs, and AI usage for one project at a time
          </p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
            Updated: {lastUpdated.toLocaleTimeString()}
          </span>
          <button className="secondary" onClick={() => void loadData(selectedProjectId)} style={{ padding: "6px 12px", fontSize: "0.85rem" }}>
            Refresh
          </button>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "18px", flexWrap: "wrap" }}>
        <label htmlFor="observability-project" style={{ fontWeight: 600 }}>Project</label>
        <select
          id="observability-project"
          value={selectedProjectId}
          disabled={projectsLoading || projects.length === 0}
          onChange={(event) => {
            setMetrics(null);
            setSelectedProjectId(event.target.value);
          }}
          style={{ minWidth: "260px", maxWidth: "100%" }}
        >
          {projectsLoading && <option value="">Loading projects…</option>}
          {!projectsLoading && projects.length === 0 && <option value="">No projects available</option>}
          {projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
        </select>
      </div>

      {error && <p className="notice error">{error}</p>}
      {projectsError && <p className="notice error">{projectsError}</p>}

      {/* 1. Subsystem Health Status Bar */}
      <h2 style={{ margin: "0 0 10px", fontSize: "1rem" }}>System-wide infrastructure health</h2>
      <div className="monitoring-health-grid">
        <div
          className="card"
          style={{
            padding: "14px",
            borderLeft: `3px solid ${isHealthy ? "var(--positive)" : isDegraded ? "var(--warning)" : "var(--negative)"}`,
          }}
        >
          <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 600 }}>OVERALL SYSTEM</div>
          <div style={{ fontSize: "1.4rem", fontWeight: 700, margin: "4px 0", textTransform: "capitalize" }}>
            {health?.status || "Unknown"}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
            Response: {health?.responseTimeMs ?? 0}ms · Uptime: {Math.floor((health?.system.uptimeSeconds ?? 0) / 60)}m
          </div>
        </div>

        <div className="card" style={{ padding: "14px" }}>
          <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 600 }}>POSTGRESQL DATABASE</div>
          <div style={{ fontSize: "1.2rem", fontWeight: 700, margin: "4px 0", color: health?.checks.database.status === "up" ? "var(--positive)" : "var(--negative)" }}>
            ● {health?.checks.database.status?.toUpperCase() || "UNKNOWN"}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
            Latency: {health?.checks.database.latencyMs ?? 0}ms (ACID Store)
          </div>
        </div>

        <div className="card" style={{ padding: "14px" }}>
          <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 600 }}>ARTIFACT STORAGE</div>
          <div style={{ fontSize: "1.2rem", fontWeight: 700, margin: "4px 0", color: health?.checks.storage.status === "up" ? "var(--positive)" : "var(--warning)" }}>
            ● {health?.checks.storage.status?.toUpperCase() || "UNKNOWN"}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
            {health?.checks.storage.message || "S3 / Local Storage"}
          </div>
        </div>

        <div className="card" style={{ padding: "14px" }}>
          <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 600 }}>BACKGROUND WORKER</div>
          <div style={{ fontSize: "1.2rem", fontWeight: 700, margin: "4px 0", color: health?.checks.worker.status === "up" ? "var(--positive)" : health?.checks.worker.status === "degraded" ? "var(--warning)" : "var(--negative)" }}>
            ● {health?.checks.worker.status?.toUpperCase() || "UNKNOWN"}
          </div>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
            {health?.checks.worker.message || "Queue Worker Loop"}
          </div>
        </div>

        <div className="card" style={{ padding: "14px" }}>
          <div style={{ fontSize: "0.8rem", color: "#64748b", fontWeight: 600 }}>MEMORY CONSUMPTION</div>
          <div style={{ fontSize: "1.2rem", fontWeight: 700, margin: "4px 0", color: "#334155" }}>
            {health?.system.heapUsedMb ?? 0} MB
          </div>
          <div style={{ fontSize: "0.75rem", color: "#64748b" }}>
            RSS: {health?.system.rssMb ?? 0} MB · Heap: {health?.system.heapTotalMb ?? 0} MB
          </div>
        </div>
      </div>

      {projectsLoading ? (
        <p className="notice" style={{ marginTop: "20px" }}>Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="notice" style={{ marginTop: "20px" }}>
          No projects are available to your account. Project telemetry will appear here after you are assigned to a project.
        </p>
      ) : !metrics ? (
        <p className="notice" style={{ marginTop: "20px" }}>
          {loading ? `Loading telemetry for ${selectedProject?.name ?? "the selected project"}…` : "Project telemetry is not available."}
        </p>
      ) : (
      <>
      {/* 2. Active Alerts Banner */}
      {m?.alerts && m.alerts.length > 0 && (
        <div style={{ marginBottom: "20px" }}>
          {m.alerts.map((alert) => (
            <div
              key={alert.ruleId}
              style={{
                padding: "12px 16px",
                borderRadius: "8px",
                marginBottom: "8px",
                background: alert.severity === "critical" ? "var(--negative-bg)" : "var(--warning-bg)",
                border: `1px solid ${alert.severity === "critical" ? "#edceca" : "var(--warning-border)"}`,
                display: "flex",
                alignItems: "center",
                gap: "12px",
              }}
            >
              <div style={{ flex: 1 }}>
                <strong style={{ color: alert.severity === "critical" ? "var(--negative)" : "var(--warning)" }}>
                  {alert.ruleName} ({alert.severity.toUpperCase()}):
                </strong>{" "}
                <span style={{ fontSize: "0.9rem", color: alert.severity === "critical" ? "var(--negative)" : "var(--warning)" }}>
                  {alert.message}
                </span>
              </div>
              <small style={{ color: "#64748b" }}>{new Date(alert.triggeredAt).toLocaleTimeString()}</small>
            </div>
          ))}
        </div>
      )}

      {/* 3. Primary Metrics Grid */}
      <div className="monitoring-metric-grid">
        {/* Test Execution Telemetry */}
        <div className="card" style={{ padding: "18px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: "1.1rem", display: "flex", justifyContent: "space-between" }}>
            <span>Test executions</span>
            <span style={{ color: "var(--positive)", fontWeight: 700 }}>{m?.tests.passRatePercent ?? 100}% Pass</span>
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "14px" }}>
            <div style={{ background: "#f7f8f7", padding: "10px", borderRadius: "6px" }}>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>TOTAL EXECUTIONS</div>
              <div style={{ fontSize: "1.3rem", fontWeight: 700 }}>{m?.tests.total ?? 0}</div>
            </div>
            <div style={{ background: "#f7f8f7", padding: "10px", borderRadius: "6px" }}>
              <div style={{ fontSize: "0.75rem", color: "#4b5c52" }}>Passed tests</div>
              <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--positive)" }}>{m?.tests.passed ?? 0}</div>
            </div>
            <div style={{ background: "#f7f8f7", padding: "10px", borderRadius: "6px" }}>
              <div style={{ fontSize: "0.75rem", color: "#4b5c52" }}>Failed tests</div>
              <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--negative)" }}>{m?.tests.failed ?? 0}</div>
            </div>
            <div style={{ background: "#f7f8f7", padding: "10px", borderRadius: "6px" }}>
              <div style={{ fontSize: "0.75rem", color: "#4b5c52" }}>Flaky tests</div>
              <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--warning)" }}>{m?.tests.flaky ?? 0}</div>
            </div>
          </div>
          <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "10px", fontSize: "0.85rem", color: "#475569" }}>
            <strong>Duration Latency:</strong> Avg: <code>{m?.tests.duration.avgMs ?? 0}ms</code> · P50: <code>{m?.tests.duration.p50Ms ?? 0}ms</code> · P95: <code>{m?.tests.duration.p95Ms ?? 0}ms</code>
          </div>
        </div>

        {/* Background Jobs Telemetry */}
        <div className="card" style={{ padding: "18px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: "1.1rem" }}>Background job queue</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", marginBottom: "14px" }}>
            <div style={{ background: "#f7f8f7", padding: "8px", borderRadius: "6px", textAlign: "center" }}>
              <div style={{ fontSize: "0.7rem", color: "#64748b" }}>PENDING</div>
              <div style={{ fontSize: "1.2rem", fontWeight: 700 }}>{m?.jobs.pending ?? 0}</div>
            </div>
            <div style={{ background: "#f7f8f7", padding: "8px", borderRadius: "6px", textAlign: "center" }}>
              <div style={{ fontSize: "0.7rem", color: "#4b5c52" }}>Active</div>
              <div style={{ fontSize: "1.2rem", fontWeight: 700, color: "var(--accent)" }}>{m?.jobs.active ?? 0}</div>
            </div>
            <div style={{ background: "#f7f8f7", padding: "8px", borderRadius: "6px", textAlign: "center" }}>
              <div style={{ fontSize: "0.7rem", color: "#4b5c52" }}>Completed</div>
              <div style={{ fontSize: "1.2rem", fontWeight: 700, color: "var(--positive)" }}>{m?.jobs.completed ?? 0}</div>
            </div>
            <div style={{ background: "#f7f8f7", padding: "8px", borderRadius: "6px", textAlign: "center" }}>
              <div style={{ fontSize: "0.7rem", color: "#4b5c52" }}>Failed</div>
              <div style={{ fontSize: "1.2rem", fontWeight: 700, color: "var(--negative)" }}>{m?.jobs.failed ?? 0}</div>
            </div>
            <div style={{ background: "#f7f8f7", padding: "8px", borderRadius: "6px", textAlign: "center" }}>
              <div style={{ fontSize: "0.7rem", color: "#c2410c" }}>RETRIED</div>
              <div style={{ fontSize: "1.2rem", fontWeight: 700, color: "#ea580c" }}>{m?.jobs.worker.retries ?? 0}</div>
            </div>
            <div style={{ background: "#f8fafc", padding: "8px", borderRadius: "6px", textAlign: "center" }}>
              <div style={{ fontSize: "0.7rem", color: "#64748b" }}>TOTAL JOBS</div>
              <div style={{ fontSize: "1.2rem", fontWeight: 700 }}>{m?.jobs.total ?? 0}</div>
            </div>
          </div>
          <div style={{ borderTop: "1px solid #e2e8f0", paddingTop: "10px", fontSize: "0.85rem", color: "#475569" }}>
            <strong>Queue Delay:</strong> Avg: <code>{m?.jobs.queueDelay.avgMs ?? 0}ms</code> · P95: <code>{m?.jobs.queueDelay.p95Ms ?? 0}ms</code>
          </div>
        </div>

        {/* AI Token Usage & Estimated Cost */}
        <div className="card" style={{ padding: "18px" }}>
          <h3 style={{ margin: "0 0 12px", fontSize: "1.1rem", display: "flex", justifyContent: "space-between" }}>
            <span>AI usage & costs</span>
            <span style={{ color: "var(--accent)", fontWeight: 700 }}>${m?.ai.estimatedCostUsd.toFixed(4) ?? "0.0000"} USD</span>
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px", marginBottom: "14px" }}>
            <div style={{ background: "#f7f8f7", padding: "10px", borderRadius: "6px" }}>
              <div style={{ fontSize: "0.75rem", color: "#64748b" }}>AI REQUESTS</div>
              <div style={{ fontSize: "1.3rem", fontWeight: 700 }}>{m?.ai.totalRequests ?? 0}</div>
            </div>
            <div style={{ background: "#f7f8f7", padding: "10px", borderRadius: "6px" }}>
              <div style={{ fontSize: "0.75rem", color: "#1e40af" }}>TOTAL TOKENS</div>
              <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--accent)" }}>
                {(m?.ai.totalTokens ?? 0).toLocaleString()}
              </div>
            </div>
          </div>
          <div style={{ fontSize: "0.82rem", color: "#64748b" }}>
            <strong>Token Breakdown:</strong> Prompt: <code>{(m?.ai.promptTokens ?? 0).toLocaleString()}</code> · Completion: <code>{(m?.ai.completionTokens ?? 0).toLocaleString()}</code>
          </div>
          {m?.ai.breakdownByFeature && Object.keys(m.ai.breakdownByFeature).length > 0 && (
            <div style={{ marginTop: "10px", paddingTop: "8px", borderTop: "1px solid #f1f5f9", fontSize: "0.8rem" }}>
              {Object.entries(m.ai.breakdownByFeature).map(([feature, data]) => (
                <div key={feature} style={{ display: "flex", justifyContent: "space-between", margin: "2px 0" }}>
                  <span style={{ textTransform: "capitalize" }}>{feature.replace("_", " ")}</span>
                  <span>{data.tokens.toLocaleString()} toks · ${data.costUsd.toFixed(4)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 4. External Integrations Card */}
      <div className="card" style={{ padding: "18px", background: "#f8fafc" }}>
        <h4 style={{ margin: "0 0 8px", fontSize: "1rem" }}>External telemetry & scraping endpoints</h4>
        <p className="muted" style={{ margin: "0 0 12px", fontSize: "0.85rem" }}>
          Project metrics above show <strong>{selectedProject?.name}</strong> only. Infrastructure health and Prometheus scraping remain system-wide.
        </p>
        <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
          <a
            href={`${apiBase}/metrics`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "6px 12px",
              background: "#334155",
              color: "#fff",
              borderRadius: "6px",
              textDecoration: "none",
              fontSize: "0.85rem",
            }}
          >
            Prometheus exposition format (/metrics)
          </a>
          <a
            href={`${apiBase}/api/monitoring/health`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "6px 12px",
              background: "#475569",
              color: "#fff",
              borderRadius: "6px",
              textDecoration: "none",
              fontSize: "0.85rem",
            }}
          >
            Detailed health check (/api/monitoring/health)
          </a>
          <a
            href={`${apiBase}/api/monitoring/metrics?projectId=${encodeURIComponent(selectedProjectId)}`}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              padding: "6px 12px",
              background: "#475569",
              color: "#fff",
              borderRadius: "6px",
              textDecoration: "none",
              fontSize: "0.85rem",
            }}
          >
            Selected project JSON metrics API
          </a>
        </div>
      </div>
      </>
      )}
    </section>
  );
}

export function ProjectJobsTab({ projectId }: { projectId: string }) {
  const [jobs, setJobs] = useState<JobItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [enqueueing, setEnqueueing] = useState(false);
  const [message, setMessage] = useState("");

  async function loadJobs() {
    try {
      const res = await api<{ jobs: JobItem[]; total: number }>(`/projects/${projectId}/jobs?limit=25`);
      setJobs(res.jobs);
      setTotal(res.total);
    } catch (err: any) {
      setError(err.message || "Failed to load jobs");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadJobs();
    const timer = setInterval(loadJobs, 3000); // 3s polling for active jobs
    return () => clearInterval(timer);
  }, [projectId]);

  async function handleEnqueueWebRun() {
    setEnqueueing(true);
    setMessage("");
    try {
      const res = await api<{ success: boolean; jobId: string; runId: string }>(
        `/projects/${projectId}/jobs/web-execution`,
        { method: "POST", body: JSON.stringify({ concurrency: 2, retries: 1 }) },
      );
      setMessage(`Enqueued web execution job #${res.jobId.slice(0, 8)} (Run ID: ${res.runId.slice(0, 8)})`);
      loadJobs();
    } catch (err: any) {
      setError(err.message || "Failed to enqueue web execution job");
    } finally {
      setEnqueueing(false);
    }
  }

  async function handleEnqueueApiRun() {
    setEnqueueing(true);
    setMessage("");
    try {
      const res = await api<{ success: boolean; jobId: string; runId: string }>(
        `/projects/${projectId}/jobs/api-execution`,
        { method: "POST", body: JSON.stringify({ retries: 1 }) },
      );
      setMessage(`Enqueued API execution job #${res.jobId.slice(0, 8)} (Run ID: ${res.runId.slice(0, 8)})`);
      loadJobs();
    } catch (err: any) {
      setError(err.message || "Failed to enqueue API execution job");
    } finally {
      setEnqueueing(false);
    }
  }

  async function handleCancelJob(jobId: string) {
    try {
      await api(`/jobs/${jobId}/cancel`, { method: "POST" });
      loadJobs();
    } catch (err: any) {
      alert(err.message || "Failed to cancel job");
    }
  }

  return (
    <div style={{ marginTop: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px", flexWrap: "wrap", gap: "10px" }}>
        <div>
          <h2 style={{ margin: 0 }}>Background Jobs & Async Executions</h2>
          <p className="muted" style={{ margin: "2px 0 0", fontSize: "0.85rem" }}>
            Showing {jobs.length} of {total} jobs processed by background workers
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button onClick={handleEnqueueWebRun} disabled={enqueueing} style={{ fontSize: "0.85rem" }}>
            Run web tests asynchronously
          </button>
          <button onClick={handleEnqueueApiRun} disabled={enqueueing} className="secondary" style={{ fontSize: "0.85rem" }}>
            Run API tests asynchronously
          </button>
        </div>
      </div>

      {message && <p className="notice" style={{ background: "#ecfdf5", borderColor: "#a7f3d0", color: "#065f46" }}>{message}</p>}
      {error && <p className="notice error">{error}</p>}

      {loading && jobs.length === 0 ? (
        <p className="notice">Loading background jobs…</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Job ID</th>
              <th>Type / Queue</th>
              <th>Status</th>
              <th>Retries</th>
              <th>Queue Delay</th>
              <th>Duration</th>
              <th>Enqueued At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((job) => {
              const statusTone =
                job.status === "completed"
                  ? "positive"
                  : job.status === "active"
                  ? "active"
                  : job.status === "failed"
                  ? "negative"
                  : job.status === "retrying"
                  ? "warning"
                  : "neutral";

              return (
                <tr key={job.id}>
                  <td>
                    <code>{job.id.slice(0, 8)}…</code>
                  </td>
                  <td>
                    <strong>{job.jobType}</strong>
                    <div style={{ fontSize: "0.75rem", color: "#64748b" }}>queue: {job.queueName}</div>
                  </td>
                  <td>
                    <span className={`job-status job-status-${statusTone}`}>
                      {job.status}
                    </span>
                    {job.errorMessage && (
                      <div style={{ fontSize: "0.75rem", color: "var(--negative)", maxWidth: "240px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {job.errorMessage}
                      </div>
                    )}
                  </td>
                  <td>
                    {job.retries} / {job.maxRetries}
                  </td>
                  <td>
                    {job.queueDelayMs !== null && job.queueDelayMs !== undefined ? `${job.queueDelayMs}ms` : "-"}
                  </td>
                  <td>
                    {job.durationMs !== null && job.durationMs !== undefined ? `${job.durationMs}ms` : "-"}
                  </td>
                  <td>
                    <small>{new Date(job.enqueuedAt).toLocaleTimeString()}</small>
                  </td>
                  <td>
                    {(job.status === "pending" || job.status === "retrying") && (
                      <button
                        className="secondary"
                        style={{ padding: "3px 8px", fontSize: "0.75rem", color: "var(--negative)" }}
                        onClick={() => handleCancelJob(job.id)}
                      >
                        Cancel
                      </button>
                    )}
                    {job.status === "completed" && job.payload?.runId && (
                      <Link
                        to={`/runs/${job.payload.runId}`}
                        style={{ fontSize: "0.8rem", textDecoration: "none", color: "var(--accent)" }}
                      >
                        View Run →
                      </Link>
                    )}
                  </td>
                </tr>
              );
            })}
            {jobs.length === 0 && (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", color: "#64748b", padding: "24px" }}>
                  No background jobs enqueued yet for this project.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
