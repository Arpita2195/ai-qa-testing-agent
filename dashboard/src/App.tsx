import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import "./App.css";

const apiBase = import.meta.env.VITE_API_URL || "http://localhost:3000";
const apiKey = import.meta.env.VITE_API_KEY || "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      ...init?.headers,
    },
  });
  const payload: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const message =
      typeof payload === "object" && payload !== null && "error" in payload
        ? String(payload.error)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

interface Project {
  id: string;
  name: string;
  base_url: string;
  owner_confirmed?: boolean;
  access_status?: "unknown" | "public" | "login_required" | "ready" | "failed";
  has_credentials?: boolean;
  has_session?: boolean;
  session_saved_at?: string | null;
}

interface TestCase {
  id: string;
  title: string;
  description: string | null;
  steps: string[];
  review_status: string;
}

interface ApiEndpoint {
  id: string;
  name: string;
  method: string;
  path: string;
  review_status: string;
}

interface VisualBaseline {
  id: string;
  image_path: string;
  status: string;
}

interface VisualCheck {
  id: string;
  name: string;
  path: string;
  baselines: VisualBaseline[];
}

interface Suite {
  id: string;
  name: string;
}

interface Run {
  id: string;
  status: string;
  run_type: string;
  created_at: string;
  passed_count?: number;
  failed_count?: number;
  pass_rate?: number;
}

interface BugReport {
  id: string;
  title: string;
  severity: string;
  classification: string;
  probable_cause: string;
  status: string;
}

interface EvidenceSummary {
  browserErrors?: string[];
  failedRequests?: Array<{ method: string; url: string; failure: string }>;
  httpErrors?: Array<{ method: string; url: string; status: number }>;
  tracePath?: string | null;
  screenshotPath?: string | null;
}

function useResource<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    api<T>(path)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [path, reloadKey]);

  return { data, loading, error, reload };
}

function State({ loading, error, children }: { loading: boolean; error: string; children: ReactNode }) {
  if (loading) return <p className="notice">Loading…</p>;
  if (error) return <p className="notice error">{error}</p>;
  return <>{children}</>;
}

function Layout() {
  return (
    <>
      <header className="topbar">
        <Link to="/projects" className="brand">QA Control</Link>
        <nav>
          <NavLink to="/projects">Projects</NavLink>
          <NavLink to="/bug-reports">Bug reports</NavLink>
        </nav>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<ProjectsPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:id" element={<ProjectPage />} />
          <Route path="/suites/:id" element={<SuiteDetailPage />} />
          <Route path="/runs/:id" element={<RunDetailPage />} />
          <Route path="/bug-reports" element={<BugReportsPage />} />
          <Route path="*" element={<p className="notice">Page not found.</p>} />
        </Routes>
      </main>
    </>
  );
}

function TestNewAppBox({ onProjectCreated }: { onProjectCreated: () => void }) {
  const [url, setUrl] = useState("");
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [detectedStatus, setDetectedStatus] = useState<string | null>(null);

  // Access options state
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [accessSaving, setAccessSaving] = useState(false);
  const [manualSessionStarted, setManualSessionStarted] = useState(false);

  // Test cases state
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [runningApproved, setRunningApproved] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const navigate = useNavigate();

  async function triggerDiscoveryAndGenerate(projectId: string) {
    setLoading(true);
    setProgress("Discovering pages and generating pending test cases (this may take up to 2 minutes)…");
    try {
      const result = await api<GenerateResponse>(`/projects/${projectId}/generate`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setProgress(
        `Generated ${result.created} pending test cases (${result.skipped_invalid} skipped, ${result.skipped_duplicate} duplicate).`,
      );
      const cases = await api<TestCase[]>(`/projects/${projectId}/test-cases`);
      setTestCases(cases);
      onProjectCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress("");
    } finally {
      setLoading(false);
    }
  }

  async function handleStart(e: FormEvent) {
    e.preventDefault();
    if (!ownerConfirmed) {
      setError("This is a test environment I own or have permission to test must be confirmed.");
      return;
    }
    setError("");
    setLoading(true);
    setProgress("Checking URL safety and detecting login requirements…");
    setActiveProject(null);
    setDetectedStatus(null);
    setTestCases([]);

    try {
      const project = await api<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({ base_url: url.trim(), owner_confirmed: true }),
      });
      setActiveProject(project);
      setDetectedStatus(project.access_status || "unknown");
      onProjectCreated();

      if (project.access_status === "public") {
        await triggerDiscoveryAndGenerate(project.id);
      } else if (project.access_status === "login_required") {
        setProgress("Login required. Choose an access method below to continue test generation.");
      } else {
        await triggerDiscoveryAndGenerate(project.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress("");
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveCredentials(e: FormEvent) {
    e.preventDefault();
    if (!activeProject) return;
    setAccessSaving(true);
    setError("");
    setProgress("Saving credentials…");
    try {
      await api(`/projects/${activeProject.id}/credentials`, {
        method: "PUT",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      setPassword("");
      setUsername("");
      onProjectCreated();
      await triggerDiscoveryAndGenerate(activeProject.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress("");
    } finally {
      setAccessSaving(false);
    }
  }

  async function handleStartManualLogin() {
    if (!activeProject) return;
    setError("");
    setAccessSaving(true);
    setProgress("Opening headed browser window on the machine. Please log in there.");
    try {
      await api(`/projects/${activeProject.id}/session/start`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setManualSessionStarted(true);
      setProgress("Browser window opened. Log in manually in that window, then click 'Done'.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress("");
    } finally {
      setAccessSaving(false);
    }
  }

  async function handleFinishManualLogin() {
    if (!activeProject) return;
    setError("");
    setAccessSaving(true);
    setProgress("Saving session state…");
    try {
      await api(`/projects/${activeProject.id}/session/finish`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setManualSessionStarted(false);
      onProjectCreated();
      await triggerDiscoveryAndGenerate(activeProject.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setProgress("");
    } finally {
      setAccessSaving(false);
    }
  }

  async function handleReview(id: string, review_status: "approved" | "rejected") {
    try {
      await api(`/test-cases/${id}/review`, {
        method: "PATCH",
        body: JSON.stringify({ review_status }),
      });
      if (activeProject) {
        const cases = await api<TestCase[]>(`/projects/${activeProject.id}/test-cases`);
        setTestCases(cases);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const isReadOnly = (tc: TestCase) =>
    !tc.steps.some(
      (s) =>
        s.startsWith("fill ") ||
        s.startsWith("select ") ||
        /\b(delete|remove|pay|purchase|order|confirm|submit)\b/i.test(s),
    );

  const approvedCount = testCases.filter((tc) => tc.review_status === "approved").length;
  const readOnlyPendingCount = testCases.filter(
    (tc) => tc.review_status === "pending" && isReadOnly(tc),
  ).length;

  async function handleApproveReadOnly() {
    if (!activeProject) return;
    const readOnlyPending = testCases.filter(
      (tc) => tc.review_status === "pending" && isReadOnly(tc),
    );
    if (readOnlyPending.length === 0) return;

    try {
      await Promise.all(
        readOnlyPending.map((tc) =>
          api(`/test-cases/${tc.id}/review`, {
            method: "PATCH",
            body: JSON.stringify({ review_status: "approved" }),
          }),
        ),
      );
      const cases = await api<TestCase[]>(`/projects/${activeProject.id}/test-cases`);
      setTestCases(cases);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRunApproved() {
    if (!activeProject) return;
    const approved = testCases.filter((tc) => tc.review_status === "approved");
    if (approved.length === 0) {
      setError("No approved test cases found. Click Approve on one or more tests first.");
      return;
    }
    setRunningApproved(true);
    try {
      const run = await api<Run>(`/projects/${activeProject.id}/runs`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningApproved(false);
    }
  }

  async function handleRunSingle(testCaseId: string) {
    if (!activeProject) return;
    setRunningId(testCaseId);
    try {
      const run = await api<Run>(`/projects/${activeProject.id}/runs`, {
        method: "POST",
        body: JSON.stringify({ test_case_id: testCaseId }),
      });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningId(null);
    }
  }

  return (
    <div className="test-app-box">
      <h2>Test a new app</h2>
      <form onSubmit={handleStart} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          <input
            style={{ flex: 1, minWidth: "280px" }}
            required
            type="url"
            aria-label="App URL"
            placeholder="https://example.com"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            disabled={loading || accessSaving}
          />
          <button disabled={loading || accessSaving || !url.trim() || !ownerConfirmed}>
            {loading ? "Starting…" : "Start"}
          </button>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            required
            checked={ownerConfirmed}
            onChange={(e) => setOwnerConfirmed(e.target.checked)}
            disabled={loading || accessSaving}
          />
          <span>This is a test environment I own or have permission to test</span>
        </label>
      </form>

      {progress && <p className="notice" style={{ marginTop: "12px" }}>{progress}</p>}
      {error && <p className="notice error" style={{ marginTop: "12px" }}>{error}</p>}

      {detectedStatus === "login_required" && testCases.length === 0 && (
        <div
          className="access-panel"
          style={{
            marginTop: "16px",
            padding: "16px",
            background: "#f8fafc",
            border: "1px solid #dbe2ea",
            borderRadius: "8px",
          }}
        >
          <h3 style={{ margin: "0 0 4px" }}>Access options</h3>
          <p className="muted" style={{ margin: "0 0 12px" }}>
            This application requires authentication. Choose an access method:
          </p>
          <div className="access-options">
            <div className="card" style={{ padding: "14px" }}>
              <strong>Enter test username and password</strong>
              <form
                onSubmit={handleSaveCredentials}
                style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}
              >
                <input
                  type="text"
                  required
                  placeholder="Username or email"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={accessSaving}
                  aria-label="Test username"
                />
                <input
                  type="password"
                  required
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={accessSaving}
                  aria-label="Test password"
                />
                <button disabled={accessSaving || !username.trim() || !password}>
                  {accessSaving ? "Saving…" : "Save credentials & continue"}
                </button>
              </form>
            </div>
            <div className="card" style={{ padding: "14px" }}>
              <strong>Log in manually in a browser window</strong>
              <p className="muted" style={{ fontSize: "0.85rem", margin: "8px 0" }}>
                Opens a visible browser window on this machine for you to log in, handle MFA/SSO, and save the session.
              </p>
              <div style={{ display: "flex", gap: "8px", marginTop: "10px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={handleStartManualLogin}
                  disabled={accessSaving || manualSessionStarted}
                >
                  Start login
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={handleFinishManualLogin}
                  disabled={accessSaving || !manualSessionStarted}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {testCases.length > 0 && activeProject && (
        <div style={{ marginTop: "20px" }}>
          <div className="section-heading">
            <div>
              <h3>Pending test cases for {activeProject.name}</h3>
              <p className="muted" style={{ margin: "2px 0 8px" }}>
                Review and approve test cases before running:
              </p>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
              <button
                type="button"
                className="secondary"
                onClick={handleApproveReadOnly}
                disabled={readOnlyPendingCount === 0 || loading || runningApproved}
              >
                Approve all read-only tests ({readOnlyPendingCount})
              </button>
              <button
                type="button"
                onClick={handleRunApproved}
                disabled={approvedCount === 0 || loading || runningApproved}
              >
                {runningApproved ? "Running…" : `Run approved (${approvedCount})`}
              </button>
              <Link
                to={`/projects/${activeProject.id}`}
                className="button secondary"
                style={{
                  textDecoration: "none",
                  padding: "10px 14px",
                  borderRadius: "6px",
                  background: "#e8edf2",
                  color: "#34465a",
                  display: "inline-block",
                }}
              >
                Open project →
              </Link>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "12px" }}>
            {testCases.map((tc) => (
              <article className="row-card" key={tc.id}>
                <div>
                  <strong>{tc.title}</strong>
                  <p>{tc.description}</p>
                  <span className={`badge ${tc.review_status}`}>{tc.review_status}</span>
                </div>
                <div className="actions">
                  {tc.review_status === "pending" && (
                    <>
                      <button onClick={() => handleReview(tc.id, "approved")}>Approve</button>
                      <button className="secondary" onClick={() => handleReview(tc.id, "rejected")}>
                        Reject
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => handleRunSingle(tc.id)}
                    disabled={runningId === tc.id || runningApproved}
                  >
                    {runningId === tc.id ? "Running…" : "Run now"}
                  </button>
                </div>
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectsPage() {
  const { data, loading, error, reload } = useResource<Project[]>("/projects");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setFormError("");
    try {
      await api<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({ name, base_url: baseUrl, owner_confirmed: true }),
      });
      setName("");
      setBaseUrl("");
      reload();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h1>Projects</h1>
      <TestNewAppBox onProjectCreated={reload} />

      <h2 style={{ marginTop: "32px" }}>All Projects</h2>
      <form className="inline-form" onSubmit={createProject}>
        <input
          required
          aria-label="Project name"
          placeholder="Project name"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          required
          type="url"
          aria-label="Base URL"
          placeholder="https://example.com"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
        <button disabled={saving}>Create project</button>
      </form>
      {formError && <p className="error">{formError}</p>}
      <State loading={loading} error={error}>
        <div className="cards">
          {(data ?? []).map((project) => (
            <Link className="card" key={project.id} to={`/projects/${project.id}`}>
              <strong>{project.name}</strong>
              <span>{project.base_url}</span>
              <span style={{ fontSize: "0.8rem", color: project.has_credentials || project.has_session ? "#1c6b42" : "#80621b" }}>
                {project.has_session
                  ? "Session saved"
                  : project.has_credentials
                    ? "Credentials saved"
                    : project.access_status === "login_required"
                      ? "Login required"
                      : "Public"}
              </span>
            </Link>
          ))}
          {data?.length === 0 && <p className="notice">No projects yet.</p>}
        </div>
      </State>
    </section>
  );
}

function ProjectAccessBar({ project, onUpdate }: { project: Project; onUpdate: () => void }) {
  const [showAddAccess, setShowAddAccess] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [manualStarted, setManualStarted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function removeCredentials() {
    setBusy(true);
    setMessage("");
    try {
      await api(`/projects/${project.id}/credentials`, { method: "DELETE" });
      onUpdate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeSession() {
    setBusy(true);
    setMessage("");
    try {
      await api(`/projects/${project.id}/session`, { method: "DELETE" });
      onUpdate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function saveCredentials(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      await api(`/projects/${project.id}/credentials`, {
        method: "PUT",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      setPassword("");
      setUsername("");
      setShowAddAccess(false);
      onUpdate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function startManual() {
    setBusy(true);
    setMessage("Opening browser window on server…");
    try {
      await api(`/projects/${project.id}/session/start`, { method: "POST", body: "{}" });
      setManualStarted(true);
      setMessage("Browser window opened. Log in in that window, then click Done.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function finishManual() {
    setBusy(true);
    setMessage("Saving session…");
    try {
      await api(`/projects/${project.id}/session/finish`, { method: "POST", body: "{}" });
      setManualStarted(false);
      setShowAddAccess(false);
      setMessage("");
      onUpdate();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const sessionSavedDate = project.session_saved_at
    ? new Date(project.session_saved_at).toLocaleDateString()
    : "";

  return (
    <div className="card" style={{ margin: "14px 0", padding: "14px" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "10px",
        }}
      >
        <div>
          <strong>Access status: </strong>
          {project.has_session ? (
            <span style={{ color: "#1c6b42" }}>Session saved on {sessionSavedDate}</span>
          ) : project.has_credentials ? (
            <span style={{ color: "#1c6b42" }}>Credentials saved</span>
          ) : (
            <span style={{ color: "#80621b" }}>No access saved</span>
          )}
        </div>
        <div className="actions">
          {project.has_session && (
            <button className="secondary" onClick={removeSession} disabled={busy}>
              Remove session
            </button>
          )}
          {project.has_credentials && (
            <button className="secondary" onClick={removeCredentials} disabled={busy}>
              Remove credentials
            </button>
          )}
          <button
            className="secondary"
            onClick={() => setShowAddAccess(!showAddAccess)}
            disabled={busy}
          >
            {showAddAccess
              ? "Cancel"
              : project.has_session || project.has_credentials
                ? "Change access"
                : "Add access"}
          </button>
        </div>
      </div>

      {message && <p className="notice" style={{ marginTop: "10px" }}>{message}</p>}

      {showAddAccess && (
        <div style={{ marginTop: "14px", borderTop: "1px solid #dbe2ea", paddingTop: "14px" }}>
          <div className="access-options">
            <div className="card" style={{ padding: "12px", background: "#f8fafc" }}>
              <strong>Enter test username and password</strong>
              <form
                onSubmit={saveCredentials}
                style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "8px" }}
              >
                <input
                  type="text"
                  required
                  placeholder="Username / Email"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  disabled={busy}
                  aria-label="Username"
                />
                <input
                  type="password"
                  required
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  aria-label="Password"
                />
                <button disabled={busy || !username.trim() || !password}>Save credentials</button>
              </form>
            </div>
            <div className="card" style={{ padding: "12px", background: "#f8fafc" }}>
              <strong>Log in manually in a browser window</strong>
              <p className="muted" style={{ fontSize: "0.85rem", margin: "8px 0" }}>
                Opens headed browser for interactive login / MFA / SSO.
              </p>
              <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
                <button type="button" onClick={startManual} disabled={busy || manualStarted}>
                  Start login
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={finishManual}
                  disabled={busy || !manualStarted}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const tabs = ["Test Cases", "API Endpoints", "Suites", "Runs", "Visual"] as const;
type ProjectTab = (typeof tabs)[number];

function ProjectPage() {
  const { id = "" } = useParams();
  const { data: project, loading, error, reload } = useResource<Project>(`/projects/${id}`);
  const [search, setSearch] = useSearchParams();
  const activeTab = (tabs.find((tab) => tab.toLowerCase().replace(" ", "-") === search.get("tab")) ??
    tabs[0]) as ProjectTab;

  return (
    <section>
      <Link to="/projects" className="back-link">
        ← Projects
      </Link>
      <State loading={loading} error={error}>
        {project && (
          <>
            <h1>{project.name}</h1>
            <p className="muted">{project.base_url}</p>

            <ProjectAccessBar project={project} onUpdate={reload} />

            <div className="tabs">
              {tabs.map((tab) => {
                const tabKey = tab.toLowerCase().replace(" ", "-");
                return (
                  <button
                    className={activeTab === tab ? "active" : ""}
                    key={tab}
                    onClick={() => setSearch({ tab: tabKey })}
                  >
                    {tab}
                  </button>
                );
              })}
            </div>
            {activeTab === "Test Cases" && <TestCasesTab projectId={id} />}
            {activeTab === "API Endpoints" && <ApiEndpointsTab projectId={id} />}
            {activeTab === "Suites" && <SuitesTab projectId={id} />}
            {activeTab === "Runs" && <RunsTab projectId={id} />}
            {activeTab === "Visual" && <VisualTab projectId={id} />}
          </>
        )}
      </State>
    </section>
  );
}

interface GenerateResponse {
  created: number;
  skipped_invalid: number;
  skipped_duplicate: number;
  test_cases: TestCase[];
}

function TestCasesTab({ projectId }: { projectId: string }) {
  const { data, loading, error, reload } = useResource<TestCase[]>(`/projects/${projectId}/test-cases`);
  const [message, setMessage] = useState("");
  const [pagePath, setPagePath] = useState("");
  const [generating, setGenerating] = useState(false);
  const [runningAll, setRunningAll] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const navigate = useNavigate();

  const isReadOnly = (tc: TestCase) =>
    !tc.steps.some(
      (s) =>
        s.startsWith("fill ") ||
        s.startsWith("select ") ||
        /\b(delete|remove|pay|purchase|order|confirm|submit)\b/i.test(s),
    );

  const approvedCount = (data ?? []).filter((tc) => tc.review_status === "approved").length;
  const pendingReadOnlyCount = (data ?? []).filter(
    (tc) => tc.review_status === "pending" && isReadOnly(tc),
  ).length;

  async function review(id: string, review_status: string) {
    try {
      await api(`/test-cases/${id}/review`, { method: "PATCH", body: JSON.stringify({ review_status }) });
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function approveAllReadOnly() {
    const readOnlyPending = (data ?? []).filter(
      (tc) => tc.review_status === "pending" && isReadOnly(tc),
    );
    if (readOnlyPending.length === 0) return;

    try {
      await Promise.all(
        readOnlyPending.map((tc) =>
          api(`/test-cases/${tc.id}/review`, {
            method: "PATCH",
            body: JSON.stringify({ review_status: "approved" }),
          }),
        ),
      );
      setMessage(`Approved ${readOnlyPending.length} read-only test cases.`);
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function generate() {
    setGenerating(true);
    setMessage("Generating test cases (crawling pages and calling AI, this may take up to 2 minutes)…");
    try {
      const body = pagePath.trim() ? { path: pagePath.trim() } : {};
      const result = await api<GenerateResponse>(`/projects/${projectId}/generate`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      setMessage(
        `Generated ${result.created} pending test cases (${result.skipped_invalid} skipped invalid, ${result.skipped_duplicate} skipped duplicate).`,
      );
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setGenerating(false);
    }
  }

  async function runApproved() {
    if (approvedCount === 0) {
      setMessage("No approved test cases found. Click Approve on one or more test cases first.");
      return;
    }
    setRunningAll(true);
    setMessage("Running approved test cases in headless Chromium…");
    try {
      const run = await api<Run>(`/projects/${projectId}/runs`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      navigate(`/runs/${run.id}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunningAll(false);
    }
  }

  async function runSingle(testCaseId: string) {
    setRunningId(testCaseId);
    setMessage("Executing test case in headless Chromium…");
    try {
      const run = await api<Run>(`/projects/${projectId}/runs`, {
        method: "POST",
        body: JSON.stringify({ test_case_id: testCaseId }),
      });
      navigate(`/runs/${run.id}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunningId(null);
    }
  }

  return (
    <div className="tab-content">
      <div className="section-heading">
        <h2>Test cases</h2>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <input
            placeholder="Page path (optional, e.g. /inventory)"
            value={pagePath}
            onChange={(event) => setPagePath(event.target.value)}
            disabled={generating || runningAll}
            aria-label="Page path"
          />
          <button onClick={generate} disabled={generating || runningAll}>
            {generating ? "Generating…" : "Generate"}
          </button>
          <button
            type="button"
            className="secondary"
            onClick={approveAllReadOnly}
            disabled={runningAll || generating || pendingReadOnlyCount === 0}
          >
            Approve all read-only tests ({pendingReadOnlyCount})
          </button>
          <button
            type="button"
            className="secondary"
            onClick={runApproved}
            disabled={runningAll || generating || approvedCount === 0}
          >
            {runningAll ? "Running…" : `Run approved (${approvedCount})`}
          </button>
        </div>
      </div>
      {message && <p className="notice">{message}</p>}
      <State loading={loading} error={error}>
        {(data ?? []).map((testCase) => (
          <article className="row-card" key={testCase.id}>
            <div>
              <strong>{testCase.title}</strong>
              <p>{testCase.description}</p>
              <span className={`badge ${testCase.review_status}`}>{testCase.review_status}</span>
            </div>
            <div className="actions">
              {testCase.review_status === "pending" && (
                <>
                  <button onClick={() => review(testCase.id, "approved")}>Approve</button>
                  <button className="secondary" onClick={() => review(testCase.id, "rejected")}>
                    Reject
                  </button>
                </>
              )}
              <button
                type="button"
                className="secondary"
                onClick={() => void runSingle(testCase.id)}
                disabled={runningId === testCase.id || runningAll}
              >
                {runningId === testCase.id ? "Running…" : "Run now"}
              </button>
            </div>
          </article>
        ))}
        {data?.length === 0 && <p className="notice">No test cases found.</p>}
      </State>
    </div>
  );
}

function ApiEndpointsTab({ projectId }: { projectId: string }) {
  const { data, loading, error, reload } = useResource<ApiEndpoint[]>(`/projects/${projectId}/api-endpoints`);
  const [name, setName] = useState("");
  const [path, setPath] = useState("/posts/1");
  const [message, setMessage] = useState("");
  const [specText, setSpecText] = useState("");
  const [importing, setImporting] = useState(false);
  const navigate = useNavigate();

  async function addEndpoint(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/projects/${projectId}/api-endpoints`, {
        method: "POST",
        body: JSON.stringify({ name, method: "GET", path, expected_status: 200 }),
      });
      setName("");
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function run() {
    try {
      const result = await api<Run>("/projects/" + projectId + "/api-runs", { method: "POST", body: "{}" });
      navigate(`/runs/${result.id}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function importSpec(event: FormEvent) {
    event.preventDefault();
    setImporting(true);
    setMessage("");
    try {
      const result = await api<{ created: ApiEndpoint[]; skipped: number }>(
        `/projects/${projectId}/api-endpoints/import`,
        { method: "POST", body: JSON.stringify({ specText }) },
      );
      setMessage(`Imported ${result.created.length} pending endpoints; skipped ${result.skipped}.`);
      setSpecText("");
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setImporting(false);
    }
  }

  async function importFile(file?: File) {
    if (!file) return;
    try {
      setSpecText(await file.text());
    } catch {
      setMessage("Could not read the selected OpenAPI file.");
    }
  }

  async function reviewEndpoint(id: string, review_status: "approved" | "rejected") {
    try {
      await api(`/api-endpoints/${id}/review`, { method: "PATCH", body: JSON.stringify({ review_status }) });
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return <div className="tab-content">
    <form className="inline-form" onSubmit={addEndpoint}>
      <input required placeholder="Endpoint name" value={name} onChange={(event) => setName(event.target.value)} />
      <input required placeholder="/path" value={path} onChange={(event) => setPath(event.target.value)} />
      <button>Add GET endpoint</button><button type="button" className="secondary" onClick={run}>Run approved</button>
    </form>
    <form className="stack-form" onSubmit={importSpec}>
      <h3>Import OpenAPI JSON or YAML</h3>
      <input type="file" accept=".json,.yaml,.yml,application/json" onChange={(event) => void importFile(event.target.files?.[0])} />
      <textarea aria-label="OpenAPI specification" rows={8} value={specText} onChange={(event) => setSpecText(event.target.value)} placeholder="Paste an OpenAPI 3.x specification" />
      <button disabled={importing || !specText.trim()}>{importing ? "Importing…" : "Import as pending endpoints"}</button>
    </form>
    {message && <p className="notice error">{message}</p>}
    <State loading={loading} error={error}>
      {(data ?? []).map((endpoint) => <article className="row-card" key={endpoint.id}>
        <div><strong>{endpoint.name}</strong><p>{endpoint.method} {endpoint.path}</p></div>
        <span className={`badge ${endpoint.review_status}`}>{endpoint.review_status}</span>
        {endpoint.review_status === "pending" && <div className="actions"><button onClick={() => void reviewEndpoint(endpoint.id, "approved")}>Approve</button><button className="secondary" onClick={() => void reviewEndpoint(endpoint.id, "rejected")}>Reject</button></div>}
      </article>)}
    </State>
  </div>;
}

function VisualTab({ projectId }: { projectId: string }) {
  const { data, loading, error, reload } = useResource<VisualCheck[]>(`/projects/${projectId}/visual-checks`);
  const [name, setName] = useState("");
  const [path, setPath] = useState("/");
  const [message, setMessage] = useState("");
  const [results, setResults] = useState<Array<Record<string, unknown>>>([]);
  const [busy, setBusy] = useState(false);

  async function createCheck(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api(`/projects/${projectId}/visual-checks`, {
        method: "POST",
        body: JSON.stringify({ name, path }),
      });
      setName("");
      setMessage("Visual check created.");
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function runChecks() {
    setBusy(true);
    setMessage("");
    try {
      const run = await api<{ results: Array<Record<string, unknown>> }>(
        `/projects/${projectId}/visual-runs`,
        { method: "POST", body: "{}" },
      );
      setResults(run.results);
      setMessage("Visual run finished.");
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }

  async function reviewResult(id: string, decision: "accept_change" | "confirm_bug") {
    try {
      await api(`/visual-results/${id}/review`, { method: "PATCH", body: JSON.stringify({ decision }) });
      setMessage(decision === "accept_change" ? "Screenshot accepted as the new baseline." : "Change marked as a confirmed bug.");
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function reviewBaseline(id: string, review_status: "approved" | "rejected") {
    try {
      await api(`/visual-baselines/${id}/review`, { method: "PATCH", body: JSON.stringify({ review_status }) });
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return <div className="tab-content">
    <form className="inline-form" onSubmit={createCheck}>
      <input required placeholder="Visual check name" value={name} onChange={(event) => setName(event.target.value)} />
      <input required placeholder="/path" value={path} onChange={(event) => setPath(event.target.value)} />
      <button disabled={busy}>Create check</button>
      <button type="button" className="secondary" disabled={busy || !data?.length} onClick={() => void runChecks()}>Run all checks</button>
    </form>
    {message && <p className="notice">{message}</p>}
    <State loading={loading} error={error}>
      {(data ?? []).map((check) => <article className="row-card visual-card" key={check.id}>
        <div><strong>{check.name}</strong><p>{check.path}</p></div>
        <div className="visual-images">
          {check.baselines.map((baseline) => <div key={baseline.id}>
            <span>Baseline · {baseline.status}</span>
            <ArtifactImage path={baseline.image_path} />
            {baseline.status === "pending" && <div className="actions"><button onClick={() => void reviewBaseline(baseline.id, "approved")}>Approve baseline</button><button className="secondary" onClick={() => void reviewBaseline(baseline.id, "rejected")}>Reject baseline</button></div>}
          </div>)}
        </div>
      </article>)}
    </State>
    {results.map((result, index) => {
      const check = data?.find((item) => item.id === result.check_id);
      const approved = check?.baselines.find((baseline) => baseline.status === "approved");
      return <article className="row-card visual-card" key={String(result.id ?? index)}>
        <div><strong>{String(result.check_name ?? check?.name ?? "Visual result")}</strong><p>Status: {String(result.status)}{typeof result.diff_ratio === "number" ? ` · difference ${(result.diff_ratio * 100).toFixed(2)}%` : ""}</p>{Boolean(result.error_message) && <p className="error">{String(result.error_message)}</p>}</div>
        <div className="visual-images">
          {approved && <div><span>Approved baseline</span><ArtifactImage path={approved.image_path} /></div>}
          {Boolean(result.screenshot_path) && <div><span>Current screenshot</span><ArtifactImage path={String(result.screenshot_path)} /></div>}
          {Boolean(result.diff_path) && <div><span>Diff</span><ArtifactImage path={String(result.diff_path)} /></div>}
        </div>
        {result.review_status === "pending" && <div className="actions"><button onClick={() => void reviewResult(String(result.id), "accept_change")}>Accept change</button><button className="secondary" onClick={() => void reviewResult(String(result.id), "confirm_bug")}>Confirm bug</button></div>}
      </article>;
    })}
  </div>;
}

function ArtifactImage({ path }: { path: string }) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let objectUrl = "";
    const filename = path.split(/[\\/]/).pop() ?? "";
    fetch(`${apiBase}/artifacts/${encodeURIComponent(filename)}`, { headers: { "x-api-key": apiKey } })
      .then((response) => {
        if (!response.ok) throw new Error(`Image request failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);
  if (error) return <span className="error">{error}</span>;
  return src ? <img className="visual-preview" src={src} alt="Visual test artifact" /> : <span>Loading image…</span>;
}

function SuitesTab({ projectId }: { projectId: string }) {
  const { data, loading, error, reload } = useResource<Suite[]>(`/projects/${projectId}/suites`);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const navigate = useNavigate();
  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/projects/${projectId}/suites`, { method: "POST", body: JSON.stringify({ name }) });
      setName("");
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }
  async function runSuite(id: string) {
    try {
      const result = await api<Run>(`/suites/${id}/run`, { method: "POST", body: "{}" });
      navigate(`/runs/${result.id}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return <div className="tab-content">
    <form className="inline-form" onSubmit={create}><input required placeholder="Suite name" value={name} onChange={(event) => setName(event.target.value)} /><button>Create suite</button></form>
    {message && <p className="notice error">{message}</p>}
    <State loading={loading} error={error}>
      {(data ?? []).map((suite) => <article className="row-card" key={suite.id}><Link to={`/suites/${suite.id}`}>{suite.name}</Link><button onClick={() => runSuite(suite.id)}>Run suite</button></article>)}
    </State>
  </div>;
}

function SuiteDetailPage() {
  const { id = "" } = useParams();
  const { data: suite, loading, error, reload } = useResource<Suite & { members: Array<Record<string, unknown>> }>(`/suites/${id}`);
  const [testCases, setTestCases] = useState<TestCase[]>([]);
  const [endpoints, setEndpoints] = useState<ApiEndpoint[]>([]);
  const [selection, setSelection] = useState("");
  const [kind, setKind] = useState<"test" | "api">("test");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!suite || !("project_id" in suite)) return;
    const projectId = String(suite.project_id);
    Promise.all([
      api<TestCase[]>(`/projects/${projectId}/test-cases`),
      api<ApiEndpoint[]>(`/projects/${projectId}/api-endpoints`),
    ]).then(([cases, apiEndpoints]) => {
      setTestCases(cases.filter((testCase) => testCase.review_status === "approved"));
      setEndpoints(apiEndpoints.filter((endpoint) => endpoint.review_status === "approved"));
    }).catch((reason: unknown) => setMessage(reason instanceof Error ? reason.message : String(reason)));
  }, [suite]);

  async function addMember(event: FormEvent) {
    event.preventDefault();
    try {
      await api(`/suites/${id}/members`, {
        method: "POST",
        body: JSON.stringify(kind === "test" ? { test_case_id: selection } : { endpoint_id: selection }),
      });
      setMessage("Member added.");
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const choices = kind === "test" ? testCases : endpoints;
  return <section>
    <Link to="/projects" className="back-link">← Projects</Link><h1>Suite: {suite?.name ?? ""}</h1>
    <State loading={loading} error={error}>
      <form className="inline-form" onSubmit={addMember}>
        <select value={kind} onChange={(event) => { setKind(event.target.value as "test" | "api"); setSelection(""); }}>
          <option value="test">Web test case</option><option value="api">API endpoint</option>
        </select>
        <select required value={selection} onChange={(event) => setSelection(event.target.value)}>
          <option value="">Choose approved item</option>
          {choices.map((item) => <option key={item.id} value={item.id}>{"title" in item ? item.title : item.name}</option>)}
        </select>
        <button disabled={!selection}>Add member</button>
      </form>
      {message && <p className="notice">{message}</p>}
      <h2>Members</h2>
      {(suite?.members ?? []).map((member, index) => <article className="row-card" key={String(member.test_case_id ?? member.endpoint_id ?? index)}>
        {String(member.test_case_title ?? member.endpoint_name ?? member.test_case_id ?? member.endpoint_id)}
      </article>)}
    </State>
  </section>;
}

function RunsTab({ projectId }: { projectId: string }) {
  const { data: runs, loading, error } = useResource<Run[]>(`/projects/${projectId}/runs`);
  const { data: trends } = useResource<Run[]>(`/projects/${projectId}/trends`);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const navigate = useNavigate();

  async function runApproved() {
    setRunning(true);
    setMessage("Running approved web test cases in headless Chromium…");
    try {
      const run = await api<Run>(`/projects/${projectId}/runs`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      navigate(`/runs/${run.id}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunning(false);
    }
  }

  const points = trends ?? [];
  const width = 600;
  const height = 160;
  const path = points.map((run, index) => {
    const x = points.length < 2 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height - ((run.pass_rate ?? 0) / 100) * height;
    return `${index === 0 ? "M" : "L"} ${x} ${y}`;
  }).join(" ");
  return <div className="tab-content">
    <div className="section-heading">
      <h2>Pass rate trend</h2>
      <button onClick={runApproved} disabled={running}>
        {running ? "Running tests…" : "Run approved web tests"}
      </button>
    </div>
    {message && <p className="notice">{message}</p>}
    {points.length > 0 ? <svg className="trend" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Pass rate by run">
      <line x1="0" y1={height} x2={width} y2={height} />
      <path d={path} />
      {points.map((run, index) => {
        const x = points.length < 2 ? width / 2 : (index / (points.length - 1)) * width;
        const y = height - ((run.pass_rate ?? 0) / 100) * height;
        return <circle key={run.id} cx={x} cy={y} r="4"><title>{run.pass_rate}%</title></circle>;
      })}
    </svg> : <p className="muted">No run trend data yet.</p>}
    <State loading={loading} error={error}>
      {(runs ?? []).map((run) => <Link className="row-card link-row" key={run.id} to={`/runs/${run.id}`}>
        <span>{run.run_type} · {new Date(run.created_at).toLocaleString()}</span>
        <span className={`badge ${run.status}`}>{run.status}</span>
        <span>{run.passed_count ?? 0} passed · {run.failed_count ?? 0} failed</span>
      </Link>)}
    </State>
  </div>;
}

function RunDetailPage() {
  const { id = "" } = useParams();
  const { data, loading, error } = useResource<Record<string, unknown>>(`/runs/${id}`);
  const webResults = (data?.results as Array<Record<string, unknown>> | undefined) ?? [];
  const suiteApiResults = (data?.api_results as Array<Record<string, unknown>> | undefined) ?? [];
  const ordinaryResults = webResults.filter((result) => result.status !== "inconclusive");
  const infrastructureResults = webResults.filter((result) => result.status === "inconclusive");
  const results = [...ordinaryResults, ...suiteApiResults];
  return <section>
    <Link to="/projects" className="back-link">← Projects</Link><h1>Run details</h1>
    <State loading={loading} error={error}>
      <p>Run status: <strong>{String(data?.status ?? "")}</strong></p>
      <div className="actions">
        <RunFileButton runId={id} file="report" label="HTML report" />
        <RunFileButton runId={id} file="report.json" label="JSON report" />
      </div>
      {results.map((result, index) => <article className="row-card" key={String(result.id ?? index)}>
        <div><strong>{String(result.test_case_title ?? result.endpoint_name ?? result.test_case_id ?? result.endpoint_id ?? "Result")}</strong>
          <p>Status: {String(result.status)}</p>
          {Boolean(result.error_message) && <p className="error">{String(result.error_message)}</p>}
          {Boolean(result.screenshot_path) && <RunFileButton runId={id} resultId={String(result.id)} file="screenshot.png" label="Screenshot" />}
          {Boolean(result.trace_path) && <RunFileButton runId={id} resultId={String(result.id)} file="trace.zip" label="Trace ZIP" />}
          {Boolean(result.evidence) && <EvidenceDetails evidence={result.evidence as EvidenceSummary} />}
        </div>
      </article>)}
      {infrastructureResults.length > 0 && <>
        <h2>Infrastructure failures (inconclusive)</h2>
        {infrastructureResults.map((result, index) => <article className="row-card" key={String(result.id ?? index)}>
          <div><strong>{String(result.test_case_title ?? result.test_case_id ?? "Test case")}</strong>
            <p>Status: inconclusive</p>
            {Boolean(result.error_message) && <p className="error">{String(result.error_message)}</p>}
            {Boolean(result.screenshot_path) && <RunFileButton runId={id} resultId={String(result.id)} file="screenshot.png" label="Screenshot" />}
            {Boolean(result.trace_path) && <RunFileButton runId={id} resultId={String(result.id)} file="trace.zip" label="Trace ZIP" />}
            {Boolean(result.evidence) && <EvidenceDetails evidence={result.evidence as EvidenceSummary} />}
          </div>
        </article>)}
      </>}
      {results.length === 0 && <p className="notice">No results recorded.</p>}
    </State>
  </section>;
}

function EvidenceDetails({ evidence }: { evidence: EvidenceSummary }) {
  return <div className="evidence-details">
    {(evidence.browserErrors?.length ?? 0) > 0 && <>
      <strong>Browser errors</strong><ul>{evidence.browserErrors?.map((message, index) => <li key={index}>{message}</li>)}</ul>
    </>}
    {(evidence.failedRequests?.length ?? 0) > 0 && <>
      <strong>Failed network requests</strong><ul>{evidence.failedRequests?.map((request, index) => <li key={index}>{request.method} {request.url} — {request.failure}</li>)}</ul>
    </>}
    {(evidence.httpErrors?.length ?? 0) > 0 && <>
      <strong>HTTP errors</strong><ul>{evidence.httpErrors?.map((response, index) => <li key={index}>{response.method} {response.url} — HTTP {response.status}</li>)}</ul>
    </>}
  </div>;
}

function RunFileButton({
  runId,
  resultId,
  file,
  label,
}: {
  runId: string;
  resultId?: string;
  file: "report" | "report.json" | "screenshot.png" | "trace.zip";
  label: string;
}) {
  const [error, setError] = useState("");
  async function openFile() {
    setError("");
    try {
      const route = resultId
        ? `/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(resultId)}/${encodeURIComponent(file)}`
        : `/runs/${encodeURIComponent(runId)}/${file}`;
      const response = await fetch(`${apiBase}${route}`, { headers: { "x-api-key": apiKey } });
      if (!response.ok) throw new Error(`File request failed (${response.status})`);
      const blobUrl = URL.createObjectURL(await response.blob());
      window.open(blobUrl, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return <span><button className="secondary" onClick={() => void openFile()}>{label}</button>{error && <span className="error">{error}</span>}</span>;
}

function BugReportsPage() {
  const { data, loading, error, reload } = useResource<BugReport[]>("/bug-reports");
  const [message, setMessage] = useState("");
  async function setStatus(id: string, status: string) {
    try {
      await api(`/bug-reports/${id}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }
  return <section><h1>Bug reports</h1>{message && <p className="error">{message}</p>}
    <State loading={loading} error={error}>
      {(data ?? []).map((report) => <article className="row-card" key={report.id}>
        <div><strong>{report.title}</strong><p>{report.classification} · {report.severity}</p><p>{report.probable_cause}</p><span className={`badge ${report.status}`}>{report.status}</span></div>
        <div className="actions"><button onClick={() => setStatus(report.id, "confirmed")}>Confirm</button><button className="secondary" onClick={() => setStatus(report.id, "dismissed")}>Dismiss</button></div>
      </article>)}
    </State>
  </section>;
}

export default function App() {
  return <BrowserRouter><Layout /></BrowserRouter>;
}
