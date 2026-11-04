import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import "./App.css";
import { MonitoringDashboardPage, ProjectJobsTab } from "./components/MonitoringViews";
import { MobileTestingTab } from "./components/MobileTestingTab";
import {
  describeTestStep,
  isSubmissionOnlyExpectedResult,
} from "../../src/utils/testStepDescription";

export const apiBase = import.meta.env.VITE_API_URL || "http://localhost:3000";

let activeCsrfToken = "";

export function setCsrfToken(token: string) {
  activeCsrfToken = token;
}

export interface User {
  id: string;
  email: string;
  fullName: string;
  role: "admin" | "qa_manager" | "qa_engineer" | "viewer";
  isActive?: boolean;
}

export interface UserRow {
  id: string;
  email: string;
  fullName: string;
  role: "admin" | "qa_manager" | "qa_engineer" | "viewer";
  isActive: boolean;
  createdAt: string;
}

export interface ProjectMemberRow {
  id: string;
  project_id: string;
  user_id: string;
  role: "qa_manager" | "qa_engineer" | "viewer";
  created_at: string;
  email: string;
  full_name: string;
}

export interface AuditLogRow {
  id: string;
  actor_id: string | null;
  action: string;
  project_id: string | null;
  outcome: string;
  ip_address: string | null;
  created_at: string;
}

interface AuthContextType {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  loading: true,
  login: async () => {},
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ user: User; csrfToken: string }>("/auth/me")
      .then((res) => {
        setUser(res.user);
        setCsrfToken(res.csrfToken);
      })
      .catch(() => {
        setUser(null);
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const login = async (email: string, password: string) => {
    const res = await api<{ user: User; csrfToken: string }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    setUser(res.user);
    setCsrfToken(res.csrfToken);
  };

  const logout = async () => {
    try {
      await api("/auth/logout", { method: "POST", body: "{}" });
    } catch {
      // ignore
    }
    setUser(null);
    setCsrfToken("");
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method || "GET").toUpperCase();
  const isMutating = ["POST", "PUT", "PATCH", "DELETE"].includes(method);
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(init?.headers as Record<string, string>),
  };

  if (isMutating && activeCsrfToken) {
    headers["x-csrf-token"] = activeCsrfToken;
  }

  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });

  if (response.status === 401 && !path.startsWith("/auth/login")) {
    throw new Error("Authentication required. Please log in.");
  }

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
  owner_confirmed_at?: string | null;
  owner_confirmed_by?: string | null;
  access_status?: "unknown" | "public" | "login_required" | "ready" | "failed";
  has_credentials?: boolean;
  has_session?: boolean;
  session_saved_at?: string | null;
}

export interface TestCase {
  id: string;
  project_id?: string;
  title: string;
  description: string | null;
  preconditions?: string | null;
  steps: string[];
  expected_result?: string | null;
  priority?: "low" | "medium" | "high" | "critical" | string;
  test_type?: "positive" | "negative" | "boundary" | "edge_case" | string | null;
  review_status: string;
  requirement_doc_id?: string | null;
  created_at?: string;
}

export interface RequirementDocument {
  id: string;
  project_id: string;
  user_id: string | null;
  filename: string;
  file_type: "pdf" | "docx" | "txt";
  file_size: number;
  generated_count: number;
  created_at: string;
}

export interface TestCaseAutomation {
  id: string;
  project_id: string;
  test_case_id: string;
  target_type: "web" | "api" | "mobile";
  status: "draft" | "ready" | "approved" | "archived";
  web_steps: string[];
  api_method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | null;
  api_path: string | null;
  api_headers: Record<string, string>;
  api_body: unknown;
  api_expected_status: number | null;
  api_expected_fields: Record<string, string>;
  api_max_response_ms: number | null;
  mobile_steps?: string[];
  app_package?: string | null;
  app_activity?: string | null;
  device_udid?: string | null;
  platform?: "android" | "ios" | null;
  confidence: number;
  reasoning: string | null;
  last_run_id: string | null;
  last_run_status: string | null;
  last_run_at: string | null;
  last_error_message: string | null;
  test_case_title?: string;
  test_case_description?: string;
  test_case_preconditions?: string;
  manual_steps?: string[];
  test_case_expected_result?: string;
  test_case_type?: string;
  test_case_priority?: string;
  test_case_review_status?: string;
  requirement_doc_filename?: string;
  api_steps?: Array<{
    name: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    expected_status?: number;
    extract?: Record<string, string>;
  }>;
  created_at: string;
  updated_at: string;
}

export interface TestSchedule {
  id: string;
  project_id: string;
  suite_id: string;
  suite_name?: string;
  name: string;
  frequency: "hourly" | "daily" | "weekly" | "cron";
  cron_expression?: string | null;
  concurrency: number;
  retries: number;
  is_active: boolean;
  next_run_at?: string | null;
  last_run_at?: string | null;
  last_run_status?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TestScheduleRun {
  id: string;
  schedule_id: string;
  run_id?: string | null;
  status: "running" | "passed" | "failed" | "error";
  summary?: {
    total?: number;
    passed?: number;
    failed?: number;
    flaky?: number;
    duration_ms?: number;
  };
  error_message?: string | null;
  started_at: string;
  completed_at?: string | null;
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
  project_id?: string;
}

interface Run {
  id: string;
  project_id?: string;
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
  platform?: string;
  deviceUdid?: string;
  appPackage?: string;
  appActivity?: string;
  failureStep?: string | null;
  failureStepIndex?: number | null;
  deviceLogs?: string[];
  crashEvidence?: { crashed: boolean; reason?: string; details?: string };
  stepResults?: Array<{ step: string; action: string; passed: boolean; durationMs: number; error?: string }>;
}

interface FlakyTestItem {
  id: string;
  type: "web" | "api";
  title: string;
  module?: string;
  total_runs: number;
  passed_runs: number;
  failed_runs: number;
  flakiness_score: number;
  last_status: string;
  last_run_at: string;
  last_error?: string | null;
}

interface FlakyResponse {
  project_id: string;
  flaky_tests_count: number;
  flaky_tests: FlakyTestItem[];
}

interface ComparisonResponse {
  summary: {
    base_run_id: string;
    target_run_id: string;
    base_commit_sha?: string | null;
    target_commit_sha?: string | null;
    base_branch?: string | null;
    target_branch?: string | null;
    environment?: string;
    total_tests: number;
    passed_count: number;
    failed_count: number;
    new_failures_count: number;
    recurring_failures_count: number;
    fixed_tests_count: number;
    stable_passes_count: number;
    added_tests_count: number;
    removed_tests_count: number;
    duration_delta_ms: number;
    regression_detected: boolean;
  };
  items: Array<{
    id: string;
    type: "web" | "api";
    title: string;
    base_status: string | null;
    target_status: string | null;
    change_type: "new_failure" | "recurring_failure" | "fixed" | "stable_pass" | "added" | "removed";
    duration_ms?: number | null;
    duration_delta_ms?: number | null;
    error_message?: string | null;
  }>;
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

function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <section className="login-brand-panel" aria-label="QA Control overview">
        <Link to="/" className="login-brand">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </span>
          <span>QA Control</span>
        </Link>
        <div className="login-brand-copy">
          <span className="login-eyebrow">QUALITY ENGINEERING WORKSPACE</span>
          <h2>Ship with confidence.</h2>
          <p>One calm place to plan tests, monitor runs, and turn failures into clear next steps.</p>
        </div>
        <div className="login-brand-footer">
          <span className="login-status-dot" aria-hidden="true" />
          Built for thoughtful, reliable releases
        </div>
        <span className="login-orbit login-orbit-one" aria-hidden="true" />
        <span className="login-orbit login-orbit-two" aria-hidden="true" />
      </section>

      <section className="login-form-panel" aria-labelledby="login-title">
        <div className="login-card">
          <div className="login-mobile-brand">
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
            <span>QA Control</span>
          </div>
          <div className="login-heading">
            <span className="login-eyebrow">WELCOME BACK</span>
            <h1 id="login-title">Sign in to your workspace</h1>
            <p>Use your organizational account to continue.</p>
          </div>
          {error && <p className="login-error" role="alert">{error}</p>}
          <form onSubmit={handleSubmit} className="login-form">
            <div className="login-field">
              <label className="login-form-label" htmlFor="login-email">Email address</label>
              <input
                id="login-email"
                required
                type="email"
                autoComplete="username"
                placeholder="name@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={loading}
              />
            </div>
            <div className="login-field">
              <label className="login-form-label" htmlFor="login-password">Password</label>
              <input
                id="login-password"
                required
                type="password"
                autoComplete="current-password"
                placeholder="Enter your password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
              />
            </div>
            <button type="submit" disabled={loading || !email.trim() || !password} className="login-submit">
              {loading ? "Signing in…" : "Sign in"}
              {!loading && <span aria-hidden="true">→</span>}
            </button>
          </form>
          <div className="login-account-note">
            <span className="login-account-icon" aria-hidden="true">i</span>
            <span><strong>Local demo account</strong><br />admin@qa-testing.local / Admin123456!</span>
          </div>
          <p className="login-privacy-note">Secure access for your quality workspace</p>
        </div>
      </section>
    </main>
  );
}

function UserManagementPage() {
  const { user } = useAuth();
  const { data: users, loading, error, reload } = useResource<UserRow[]>("/users");
  const { data: auditLogs, reload: reloadLogs } = useResource<AuditLogRow[]>("/audit-logs");
  const [activeTab, setActiveTab] = useState<"users" | "audit">("users");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "qa_manager" | "qa_engineer" | "viewer">("qa_engineer");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  const [successMsg, setSuccessMsg] = useState("");

  if (user?.role !== "admin") {
    return (
      <div className="notice error">
        <strong>Access Denied:</strong> Action requires platform Administrator privileges.
      </div>
    );
  }

  async function handleCreateUser(e: FormEvent) {
    e.preventDefault();
    setCreating(true);
    setCreateError("");
    setSuccessMsg("");
    try {
      await api("/auth/register", {
        method: "POST",
        body: JSON.stringify({
          fullName: fullName.trim(),
          email: email.trim(),
          password,
          role,
        }),
      });
      setFullName("");
      setEmail("");
      setPassword("");
      setSuccessMsg("User account created successfully.");
      reload();
      reloadLogs();
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleRoleChange(userId: string, newRole: string) {
    try {
      await api(`/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      });
      reload();
      reloadLogs();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleToggleStatus(userId: string, currentStatus: boolean) {
    try {
      await api(`/users/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !currentStatus }),
      });
      reload();
      reloadLogs();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <h1>User & Access Management</h1>
      <p className="muted">Manage organizational user accounts, platform roles, and security audit events.</p>

      <div className="tabs">
        <button
          className={activeTab === "users" ? "active" : ""}
          onClick={() => setActiveTab("users")}
        >
          Users & Platform Roles
        </button>
        <button
          className={activeTab === "audit" ? "active" : ""}
          onClick={() => setActiveTab("audit")}
        >
          Security Audit Logs
        </button>
      </div>

      {activeTab === "users" && (
        <>
          <div className="test-app-box" style={{ maxWidth: "650px", marginBottom: "28px" }}>
            <h2>Create New User</h2>
            {createError && <p className="notice error">{createError}</p>}
            {successMsg && <p className="notice" style={{ color: "var(--positive)", background: "var(--positive-bg)" }}>{successMsg}</p>}
            <form onSubmit={handleCreateUser} style={{ display: "flex", flexDirection: "column", gap: "12px", marginTop: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <input
                  required
                  placeholder="Full Name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  disabled={creating}
                />
                <input
                  required
                  type="email"
                  placeholder="Email Address"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={creating}
                />
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <input
                  required
                  type="password"
                  placeholder="Password (minimum 8 characters)"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={creating}
                />
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as any)}
                  disabled={creating}
                >
                  <option value="viewer">Viewer (Read-Only)</option>
                  <option value="qa_engineer">QA Engineer</option>
                  <option value="qa_manager">QA Manager</option>
                  <option value="admin">Platform Admin</option>
                </select>
              </div>
              <button disabled={creating || !fullName.trim() || !email.trim() || !password} style={{ alignSelf: "flex-start" }}>
                {creating ? "Creating…" : "Create User"}
              </button>
            </form>
          </div>

          <h2>Platform Users</h2>
          <State loading={loading} error={error}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Platform Role</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(users ?? []).map((u) => (
                  <tr key={u.id}>
                    <td><strong>{u.fullName}</strong></td>
                    <td>{u.email}</td>
                    <td>
                      <select
                        value={u.role}
                        onChange={(e) => void handleRoleChange(u.id, e.target.value)}
                        style={{ padding: "4px 8px", fontSize: "0.85rem" }}
                      >
                        <option value="viewer">Viewer</option>
                        <option value="qa_engineer">QA Engineer</option>
                        <option value="qa_manager">QA Manager</option>
                        <option value="admin">Platform Admin</option>
                      </select>
                    </td>
                    <td>
                      <span className={`badge ${u.isActive ? "approved" : "rejected"}`}>
                        {u.isActive ? "Active" : "Disabled"}
                      </span>
                    </td>
                    <td><small>{new Date(u.createdAt).toLocaleDateString()}</small></td>
                    <td>
                      <button
                        className="secondary"
                        style={{ padding: "4px 8px", fontSize: "0.8rem" }}
                        onClick={() => void handleToggleStatus(u.id, u.isActive)}
                      >
                        {u.isActive ? "Deactivate" : "Activate"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </State>
        </>
      )}

      {activeTab === "audit" && (
        <div>
          <h2>Security Audit Logs</h2>
          <table className="data-table">
            <thead>
              <tr>
                <th>Timestamp</th>
                <th>Action</th>
                <th>Outcome</th>
                <th>Project ID</th>
                <th>IP Address</th>
              </tr>
            </thead>
            <tbody>
              {(auditLogs ?? []).map((log) => (
                <tr key={log.id}>
                  <td><small>{new Date(log.created_at).toLocaleString()}</small></td>
                  <td><code>{log.action}</code></td>
                  <td>
                    <span className={`badge ${log.outcome === "success" ? "approved" : "rejected"}`}>
                      {log.outcome}
                    </span>
                  </td>
                  <td><small>{log.project_id || "-"}</small></td>
                  <td><small>{log.ip_address || "-"}</small></td>
                </tr>
              ))}
              {auditLogs?.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: "center", color: "#64748b" }}>
                    No audit log records found.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function ProjectTeamTab({ projectId }: { projectId: string }) {
  const { user } = useAuth();
  const { data: members, loading, error, reload } = useResource<ProjectMemberRow[]>(
    `/projects/${projectId}/members`,
  );
  const { data: allUsers } = useResource<UserRow[]>("/users");

  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedRole, setSelectedRole] = useState<"qa_manager" | "qa_engineer" | "viewer">("qa_engineer");
  const [saving, setSaving] = useState(false);
  const [memberError, setMemberError] = useState("");

  const canManageTeam = user?.role === "admin" || user?.role === "qa_manager";

  async function handleAddMember(e: FormEvent) {
    e.preventDefault();
    if (!selectedUserId) return;
    setSaving(true);
    setMemberError("");
    try {
      await api(`/projects/${projectId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: selectedUserId, role: selectedRole }),
      });
      setSelectedUserId("");
      reload();
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!confirm("Are you sure you want to remove this user from the project?")) return;
    try {
      await api(`/projects/${projectId}/members/${userId}`, {
        method: "DELETE",
      });
      reload();
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="tab-content">
      {canManageTeam && (
        <div className="test-app-box" style={{ maxWidth: "600px" }}>
          <h3>Assign Team Member</h3>
          <p className="muted" style={{ margin: "4px 0 12px", fontSize: "0.88rem" }}>
            Grant project-specific permissions to team members.
          </p>
          {memberError && <p className="notice error">{memberError}</p>}
          <form onSubmit={handleAddMember} style={{ display: "flex", gap: "10px", marginTop: "10px", flexWrap: "wrap" }}>
            <select
              required
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              disabled={saving}
              style={{ flex: 1 }}
            >
              <option value="">Select User…</option>
              {(allUsers ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName} ({u.email})
                </option>
              ))}
            </select>
            <select
              value={selectedRole}
              onChange={(e) => setSelectedRole(e.target.value as any)}
              disabled={saving}
            >
              <option value="viewer">Viewer (Read-Only)</option>
              <option value="qa_engineer">QA Engineer</option>
              <option value="qa_manager">QA Manager</option>
            </select>
            <button disabled={saving || !selectedUserId}>Assign</button>
          </form>
        </div>
      )}

      <h3>Project Team Members</h3>
      <State loading={loading} error={error}>
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Project Role</th>
              <th>Assigned Date</th>
              {canManageTeam && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {(members ?? []).map((m) => (
              <tr key={m.id || m.user_id || m.email}>
                <td><strong>{m.full_name || "-"}</strong></td>
                <td>{m.email}</td>
                <td><span className={`role-tag role-${m.role}`}>{m.role.replace("_", " ")}</span></td>
                <td>{new Date(m.created_at).toLocaleDateString()}</td>
                {canManageTeam && (
                  <td>
                    <button
                      className="secondary"
                      style={{ padding: "4px 8px", fontSize: "0.8rem" }}
                      onClick={() => void handleRemoveMember(m.user_id)}
                    >
                      Remove
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {members?.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", color: "#64748b" }}>
                  No explicit members assigned yet. Platform administrators have default full access.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </State>
    </div>
  );
}

function Layout() {
  const { user, logout } = useAuth();
  const { pathname } = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(
    () => !window.matchMedia("(max-width: 820px)").matches,
  );

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 820px)");
    const updateSidebarForViewport = (event: MediaQueryListEvent) => {
      setSidebarOpen(!event.matches);
    };

    mediaQuery.addEventListener("change", updateSidebarForViewport);
    return () => mediaQuery.removeEventListener("change", updateSidebarForViewport);
  }, []);

  useEffect(() => {
    if (!sidebarOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setSidebarOpen(false);
    }

    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [sidebarOpen]);

  function closeSidebarOnMobile() {
    if (window.matchMedia("(max-width: 820px)").matches) {
      setSidebarOpen(false);
    }
  }

  return (
    <div className="app-shell" data-sidebar-open={sidebarOpen}>
      <button
        type="button"
        className={`sidebar-backdrop${sidebarOpen ? " is-visible" : ""}`}
        aria-label="Close navigation"
        tabIndex={sidebarOpen ? 0 : -1}
        onClick={() => setSidebarOpen(false)}
      />
      <aside id="primary-sidebar" className="app-sidebar" inert={!sidebarOpen}>
        <div className="sidebar-brand-row">
          <Link to="/projects" className="brand" onClick={closeSidebarOnMobile}>
            <span className="brand-mark" aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
            </span>
            <span>QA Control</span>
          </Link>
          <button
            type="button"
            className="sidebar-dismiss"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close navigation"
          >
            Close
          </button>
        </div>
        <div className="sidebar-group">
          <p className="sidebar-label">Workspace</p>
          <nav className="primary-nav" aria-label="Primary navigation">
            <NavLink to="/projects" className={pathname === "/" ? "active" : undefined} onClick={closeSidebarOnMobile}>Projects</NavLink>
            <NavLink to="/bug-reports" onClick={closeSidebarOnMobile}>Bug reports</NavLink>
            <NavLink to="/monitoring" onClick={closeSidebarOnMobile}>Observability</NavLink>
            {user?.role === "admin" && <NavLink to="/users" onClick={closeSidebarOnMobile}>User management</NavLink>}
          </nav>
        </div>
        <div className="sidebar-footer">
          <span className="sidebar-footer-mark" aria-hidden="true" />
          <span>
            <strong>Quality workspace</strong>
            <small>Automated testing</small>
          </span>
        </div>
      </aside>
      <div className="app-main">
        <header className="topbar">
          <div className="topbar-leading">
            <button
              type="button"
              className="sidebar-toggle secondary"
              aria-controls="primary-sidebar"
              aria-expanded={sidebarOpen}
              aria-label={sidebarOpen ? "Collapse navigation" : "Expand navigation"}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <span className="menu-glyph" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
            </button>
            <div className="workspace-context">
              <span>Workspace</span>
              <span aria-hidden="true">/</span>
              <strong>Quality engineering</strong>
            </div>
          </div>
          {user && (
            <div className="topbar-user">
              <span className="user-avatar" aria-hidden="true">
                {(user.fullName || user.email).trim().charAt(0).toUpperCase()}
              </span>
              <span className="user-name">{user.fullName || user.email}</span>
              <span className={`role-tag role-${user.role}`}>{user.role.replace("_", " ")}</span>
              <button className="secondary sign-out-button" onClick={() => void logout()}>
                Sign out
              </button>
            </div>
          )}
        </header>
        <main className="page-surface">
          <Routes>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route path="/suites/:id" element={<SuiteDetailPage />} />
            <Route path="/runs/:id" element={<RunDetailPage />} />
            <Route path="/bug-reports" element={<BugReportsPage />} />
            <Route path="/monitoring" element={<MonitoringDashboardPage />} />
            {user?.role === "admin" && <Route path="/users" element={<UserManagementPage />} />}
            <Route path="*" element={<p className="notice">Page not found.</p>} />
          </Routes>
        </main>
      </div>
    </div>
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
        body: JSON.stringify({
          base_url: url.trim(),
          owner_confirmed: true,
          declaration_text: `I confirm that I own ${url.trim()} or have explicit authorization from its owner to test it.`,
        }),
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
      <div className="legal-callout">
        <strong>Website Ownership & Authorization Notice</strong>
        Automated testing executes simulated user interactions, crawls, and functional tests against the target domain.
        You must confirm that you own this website or have explicit authorization from its owner before scanning.
      </div>
      <form onSubmit={handleStart} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          <input
            style={{ flex: 1, minWidth: "280px" }}
            required
            type="url"
            aria-label="App URL"
            placeholder="https://shop.northstar.test"
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
          <span>I confirm that I own this website or have explicit authorization from its owner to test it.</span>
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
  const { user } = useAuth();
  const { data, loading, error, reload } = useResource<Project[]>("/projects");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [ownerConfirmed, setOwnerConfirmed] = useState(false);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (!ownerConfirmed) {
      setFormError("Website ownership or testing authorization must be confirmed before creating a project.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      await api<Project>("/projects", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          base_url: baseUrl.trim(),
          owner_confirmed: true,
          declaration_text: `I confirm that I own ${baseUrl.trim()} or have explicit authorization from its owner to test it.`,
        }),
      });
      setName("");
      setBaseUrl("");
      setOwnerConfirmed(false);
      reload();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  }

  const canCreate = user?.role !== "viewer";

  return (
    <section>
      <div className="page-heading">
        <div>
          <h1>Projects</h1>
          <p className="muted">Manage authorized sites, test coverage, and execution access.</p>
        </div>
      </div>
      {canCreate ? (
        <TestNewAppBox onProjectCreated={reload} />
      ) : (
        <div className="notice" style={{ marginBottom: "20px" }}>
          You have Viewer (read-only) permissions. You can view all projects assigned to you below.
        </div>
      )}

      <h2 style={{ marginTop: "32px" }}>All Projects</h2>
      {canCreate && (
        <form className="stack-form" style={{ maxWidth: "600px", margin: "16px 0" }} onSubmit={createProject}>
          <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
            <input
              required
              aria-label="Project name"
              placeholder="Project name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              style={{ flex: 1 }}
            />
            <input
              required
              type="url"
              aria-label="Base URL"
              placeholder="https://portal.northstar.test"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              style={{ flex: 1 }}
            />
          </div>

          <div className="legal-callout">
            <strong>Website Ownership & Authorization Notice</strong>
            Automated QA tests execute simulated user inputs, form submissions, and automated browser traffic.
            You must declare that you own the target website or have authorization from the site owner.
          </div>

          <label className="checkbox-label">
            <input
              type="checkbox"
              required
              checked={ownerConfirmed}
              onChange={(e) => setOwnerConfirmed(e.target.checked)}
            />
            <span>I confirm that I own this website or have explicit authorization from its owner to test it.</span>
          </label>

          <button disabled={saving || !ownerConfirmed} style={{ alignSelf: "flex-start" }}>
            {saving ? "Creating…" : "Create project"}
          </button>
        </form>
      )}
      {formError && <p className="error">{formError}</p>}
      <State loading={loading} error={error}>
        <div className="cards">
          {(data ?? []).map((project) => (
            <Link className="card" key={project.id} to={`/projects/${project.id}`}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <strong>{project.name}</strong>
                {project.owner_confirmed && (
                  <span className="authorization-status">Authorized</span>
                )}
              </div>
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

const tabs = ["Test Cases", "Requirements", "Automations", "API Endpoints", "Mobile Testing", "Suites", "Schedules", "Runs", "Visual", "Jobs & Monitoring", "Team"] as const;
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

            <div className="auth-notice-banner" style={{ margin: "14px 0" }}>
              {project.owner_confirmed_at ? (
                <span>
                  <strong>Website Ownership & Authorization Declared:</strong> Confirmed on{" "}
                  {new Date(project.owner_confirmed_at).toLocaleString()}{" "}
                  {project.owner_confirmed_by ? `(User: ${project.owner_confirmed_by.slice(0, 8)}...)` : ""}.
                  Automated scanning authorized under user declaration.
                </span>
              ) : (
                <span>
                  <strong>Authorization Notice:</strong> Legacy project record. Target: {project.base_url}. Ensure valid testing authorization is maintained.
                </span>
              )}
            </div>

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
            {activeTab === "Requirements" && <RequirementsTab projectId={id} />}
            {activeTab === "Automations" && <AutomationsTab projectId={id} />}
            {activeTab === "API Endpoints" && <ApiEndpointsTab projectId={id} />}
            {activeTab === "Mobile Testing" && <MobileTestingTab projectId={id} />}
            {activeTab === "Suites" && <SuitesTab projectId={id} />}
            {activeTab === "Schedules" && <SchedulesTab projectId={id} />}
            {activeTab === "Runs" && <RunsTab projectId={id} />}
            {activeTab === "Visual" && <VisualTab projectId={id} />}
            {activeTab === "Jobs & Monitoring" && <ProjectJobsTab projectId={id} />}
            {activeTab === "Team" && <ProjectTeamTab projectId={id} />}
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
              <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
                <strong>{testCase.title}</strong>
                {testCase.test_type && (
                  <span className={`badge badge-type-${testCase.test_type}`}>
                    {testCase.test_type.replace("_", " ")}
                  </span>
                )}
                {testCase.priority && (
                  <span className={`badge badge-priority-${testCase.priority}`}>
                    {testCase.priority}
                  </span>
                )}
              </div>
              <p>{testCase.description}</p>
              {testCase.preconditions && (
                <p style={{ fontSize: "0.85rem", color: "#64748b", margin: "4px 0" }}>
                  <strong>Preconditions:</strong> {testCase.preconditions}
                </p>
              )}
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

function RequirementsTab({ projectId }: { projectId: string }) {
  const { user } = useAuth();
  const { data: documents, loading: docsLoading, error: docsError, reload: reloadDocs } =
    useResource<RequirementDocument[]>(`/projects/${projectId}/requirements/documents`);
  const { data: testCases, loading: tcLoading, error: tcError, reload: reloadTc } =
    useResource<TestCase[]>(`/projects/${projectId}/test-cases`);

  const [uploadMode, setUploadMode] = useState<"file" | "text">("file");
  const [file, setFile] = useState<File | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [selectedDocId, setSelectedDocId] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [generating, setGenerating] = useState(false);
  const [message, setMessage] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  const [editingCase, setEditingCase] = useState<TestCase | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editPreconditions, setEditPreconditions] = useState("");
  const [editSteps, setEditSteps] = useState("");
  const [editExpectedResult, setEditExpectedResult] = useState("");
  const [editPriority, setEditPriority] = useState<string>("medium");
  const [editTestType, setEditTestType] = useState<string>("positive");
  const [editReviewStatus, setEditReviewStatus] = useState<string>("pending");
  const [savingEdit, setSavingEdit] = useState(false);
  const [batchApproving, setBatchApproving] = useState(false);

  const [automatingId, setAutomatingId] = useState<string | null>(null);
  const [batchAutomating, setBatchAutomating] = useState(false);

  const canUploadAndGenerate =
    user?.role === "admin" || user?.role === "qa_manager" || user?.role === "qa_engineer";
  const canApprove = user?.role === "admin" || user?.role === "qa_manager";
  const canEdit = user?.role === "admin" || user?.role === "qa_manager" || user?.role === "qa_engineer";

  const requirementTestCases = (testCases ?? []).filter((tc) => {
    if (selectedDocId !== "all") {
      if (tc.requirement_doc_id !== selectedDocId) return false;
    } else {
      if (!tc.requirement_doc_id && !tc.test_type) return false;
    }

    if (filterType !== "all" && tc.test_type !== filterType) return false;
    if (filterStatus !== "all" && tc.review_status !== filterStatus) return false;

    return true;
  });

  const pendingRequirementCount = requirementTestCases.filter((tc) => tc.review_status === "pending").length;
  const approvedCountInView = requirementTestCases.filter((tc) => tc.review_status === "approved").length;

  async function handleAutomateSingle(testCaseId: string) {
    setAutomatingId(testCaseId);
    setErrorMsg("");
    setMessage("");
    try {
      const res = await api<{ automations: TestCaseAutomation[]; generated_count: number }>(
        `/projects/${projectId}/automations/generate`,
        {
          method: "POST",
          body: JSON.stringify({ testCaseId }),
        },
      );
      setMessage(
        `Generated ${res.automations[0].target_type.toUpperCase()} automated test script. Switch to the "Automations" tab to review, edit, or run it!`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setAutomatingId(null);
    }
  }

  async function handleBatchAutomate() {
    const approvedIds = requirementTestCases
      .filter((tc) => tc.review_status === "approved")
      .map((tc) => tc.id);

    if (approvedIds.length === 0) return;
    setBatchAutomating(true);
    setErrorMsg("");
    setMessage("");
    try {
      const res = await api<{ automations: TestCaseAutomation[]; generated_count: number }>(
        `/projects/${projectId}/automations/generate`,
        {
          method: "POST",
          body: JSON.stringify({ testCaseIds: approvedIds }),
        },
      );
      setMessage(
        `Successfully converted ${res.generated_count} approved test cases into executable automations. View and run them in the "Automations" tab!`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBatchAutomating(false);
    }
  }

  async function handleGenerate(e: FormEvent) {
    e.preventDefault();
    if (!canUploadAndGenerate) {
      setErrorMsg("Action requires QA Engineer, QA Manager, or Admin privileges.");
      return;
    }
    setErrorMsg("");
    setMessage("");
    setGenerating(true);

    try {
      if (uploadMode === "file") {
        if (!file) throw new Error("Please select a requirements file (PDF, DOCX, or TXT).");
        const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
        if (!["pdf", "docx", "txt"].includes(ext)) {
          throw new Error("Invalid file format. Only PDF, DOCX, and TXT files are supported.");
        }
        if (file.size > 10 * 1024 * 1024) {
          throw new Error("File exceeds maximum allowed size of 10 MB.");
        }

        const formData = new FormData();
        formData.append("file", file);

        const res = await api<{
          document: RequirementDocument;
          generated_count: number;
          test_cases: TestCase[];
        }>(`/projects/${projectId}/requirements/generate`, {
          method: "POST",
          body: formData,
        });

        setMessage(
          `Success: Processed "${res.document.filename}" (${(res.document.file_size / 1024).toFixed(1)} KB) and generated ${res.generated_count} test cases with positive, negative, boundary, and edge-case scenarios.`
        );
        setFile(null);
        setSelectedDocId(res.document.id);
      } else {
        if (pasteText.trim().length < 20) {
          throw new Error("Requirements text must contain at least 20 characters.");
        }

        const res = await api<{
          document: RequirementDocument;
          generated_count: number;
          test_cases: TestCase[];
        }>(`/projects/${projectId}/requirements/generate`, {
          method: "POST",
          body: JSON.stringify({
            filename: "requirements.txt",
            text: pasteText.trim(),
          }),
        });

        setMessage(`Success: Processed requirements text and generated ${res.generated_count} test cases.`);
        setPasteText("");
        setSelectedDocId(res.document.id);
      }

      reloadDocs();
      reloadTc();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function handleReview(testCaseId: string, status: "approved" | "rejected") {
    if (!canApprove) {
      setErrorMsg("Approving or rejecting test cases requires QA Manager or Admin role.");
      return;
    }
    setErrorMsg("");
    try {
      await api(`/test-cases/${testCaseId}/review`, {
        method: "PATCH",
        body: JSON.stringify({ review_status: status }),
      });
      setMessage(`Test case marked as ${status}.`);
      reloadTc();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  }

  async function handleBatchApprove() {
    if (!canApprove) {
      setErrorMsg("Batch approval requires QA Manager or Admin role.");
      return;
    }
    setBatchApproving(true);
    setErrorMsg("");
    try {
      const payload: { documentId?: string } = {};
      if (selectedDocId !== "all") {
        payload.documentId = selectedDocId;
      }
      const res = await api<{ approved_count: number; message: string }>(
        `/projects/${projectId}/requirements/batch-approve`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        }
      );
      setMessage(res.message);
      reloadTc();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBatchApproving(false);
    }
  }

  function startEdit(tc: TestCase) {
    setEditingCase(tc);
    setEditTitle(tc.title);
    setEditDesc(tc.description || "");
    setEditPreconditions(tc.preconditions || "");
    setEditSteps(tc.steps.join("\n"));
    setEditExpectedResult(tc.expected_result || "");
    setEditPriority(tc.priority || "medium");
    setEditTestType(tc.test_type || "positive");
    setEditReviewStatus(tc.review_status);
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingCase) return;
    setSavingEdit(true);
    setErrorMsg("");
    try {
      const parsedSteps = editSteps
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

      const payload: Record<string, any> = {
        title: editTitle.trim(),
        description: editDesc.trim() || null,
        preconditions: editPreconditions.trim() || null,
        steps: parsedSteps.length > 0 ? parsedSteps : ["Execute scenario"],
        expected_result: editExpectedResult.trim() || null,
        priority: editPriority,
        test_type: editTestType,
      };

      if (canApprove) {
        payload.review_status = editReviewStatus;
      }

      await api(`/test-cases/${editingCase.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });

      setMessage(`Updated test case: "${editTitle.trim()}".`);
      setEditingCase(null);
      reloadTc();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <div className="tab-content">
      <div className="section-heading">
        <div>
          <h2>Requirements AI Test Case Generation</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Upload specifications (PDF, DOCX, TXT) or paste user stories to generate positive, negative, boundary, and edge-case test suites.
          </p>
        </div>
      </div>

      {message && <p className="notice" style={{ background: "#ecfdf5", color: "#065f46" }}>{message}</p>}
      {errorMsg && <p className="notice error">{errorMsg}</p>}

      {canUploadAndGenerate ? (
        <div className="test-app-box" style={{ marginTop: "12px", marginBottom: "20px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "14px" }}>
            <h3 style={{ margin: 0, color: "#17324d", fontSize: "1.1rem" }}>Ingest Requirements</h3>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                type="button"
                className={uploadMode === "file" ? "" : "secondary"}
                onClick={() => setUploadMode("file")}
                style={{ padding: "6px 12px", fontSize: "0.85rem" }}
              >
                Document upload
              </button>
              <button
                type="button"
                className={uploadMode === "text" ? "" : "secondary"}
                onClick={() => setUploadMode("text")}
                style={{ padding: "6px 12px", fontSize: "0.85rem" }}
              >
                Paste text
              </button>
            </div>
          </div>

          <form onSubmit={handleGenerate} style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
            {uploadMode === "file" ? (
              <div>
                <label className="upload-dropzone" style={{ display: "block" }}>
                  <input
                    type="file"
                    accept=".pdf,.docx,.txt"
                    onChange={(e) => {
                      if (e.target.files && e.target.files[0]) {
                        setFile(e.target.files[0]);
                      }
                    }}
                    style={{ display: "none" }}
                    disabled={generating}
                  />
                  <strong>Click to select requirements document</strong>
                  <p className="muted" style={{ fontSize: "0.85rem", margin: "4px 0" }}>
                    Supports PDF, Word DOCX, and TXT files (Maximum 10 MB)
                  </p>
                </label>
                {file && (
                  <div className="file-info-chip">
                    <span>{file.name}</span>
                    <span className="muted">({(file.size / 1024).toFixed(1)} KB)</span>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setFile(null)}
                      style={{ padding: "2px 6px", fontSize: "0.75rem", marginLeft: "6px" }}
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px", color: "#334e68" }}>
                  Requirements / User Stories / Acceptance Criteria
                </label>
                <textarea
                  rows={6}
                  placeholder="Paste functional requirements, user stories, or acceptance criteria (min 20 characters)..."
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  disabled={generating}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
                <span className="muted" style={{ fontSize: "0.8rem" }}>
                  {pasteText.length} characters (min 20 required)
                </span>
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "4px" }}>
              <button
                type="submit"
                disabled={generating || (uploadMode === "file" ? !file : pasteText.trim().length < 20)}
              >
                {generating ? "Analyzing with Gemini AI…" : "Generate Test Cases with AI"}
              </button>
              {generating && (
                <span className="muted" style={{ fontSize: "0.88rem" }}>
                  Extracting text and generating positive, negative, boundary & edge-case scenarios...
                </span>
              )}
            </div>
          </form>
        </div>
      ) : (
        <div className="notice" style={{ marginBottom: "20px" }}>
          You have Viewer (read-only) permissions. Generating requirement test cases requires QA Engineer or QA Manager role.
        </div>
      )}

      {/* Filter and Batch Actions Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", margin: "16px 0 8px" }}>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={selectedDocId}
            onChange={(e) => setSelectedDocId(e.target.value)}
            style={{ fontSize: "0.88rem", padding: "6px 10px" }}
          >
            <option value="all">All Documents ({documents?.length ?? 0})</option>
            {(documents ?? []).map((doc) => (
              <option key={doc.id} value={doc.id}>
                {doc.filename} ({doc.generated_count} tests)
              </option>
            ))}
          </select>

          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            style={{ fontSize: "0.88rem", padding: "6px 10px" }}
          >
            <option value="all">All Test Types</option>
            <option value="positive">Positive Scenarios</option>
            <option value="negative">Negative Scenarios</option>
            <option value="boundary">Boundary Scenarios</option>
            <option value="edge_case">Edge-Case Scenarios</option>
          </select>

          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{ fontSize: "0.88rem", padding: "6px 10px" }}
          >
            <option value="all">All Statuses</option>
            <option value="pending">Pending Review</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {canEdit && approvedCountInView > 0 && (
            <button
              type="button"
              onClick={handleBatchAutomate}
              disabled={batchAutomating}
              style={{ padding: "8px 14px", fontSize: "0.85rem", fontWeight: 600, background: "var(--accent)" }}
            >
              {batchAutomating ? "Automating…" : `Automate approved (${approvedCountInView})`}
            </button>
          )}

          {canApprove && (
            <button
              type="button"
              className="secondary"
              onClick={handleBatchApprove}
              disabled={batchApproving || pendingRequirementCount === 0}
              style={{ padding: "8px 14px", fontSize: "0.85rem", fontWeight: 600 }}
            >
              {batchApproving ? "Approving…" : `Batch Approve Pending (${pendingRequirementCount})`}
            </button>
          )}
        </div>
      </div>

      {/* Test Cases List */}
      <State loading={tcLoading || docsLoading} error={tcError || docsError}>
        {requirementTestCases.map((tc) => (
          <article className="row-card" key={tc.id} style={{ alignItems: "flex-start", flexDirection: "column", gap: "12px" }}>
            <div style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "6px" }}>
                  <strong style={{ fontSize: "1.05rem", color: "#17324d" }}>{tc.title}</strong>
                  {tc.test_type && (
                    <span className={`badge badge-type-${tc.test_type}`}>
                      {tc.test_type.replace("_", " ")}
                    </span>
                  )}
                  {tc.priority && (
                    <span className={`badge badge-priority-${tc.priority}`}>
                      {tc.priority}
                    </span>
                  )}
                  <span className={`badge ${tc.review_status}`}>{tc.review_status}</span>
                </div>

                {tc.description && (
                  <p style={{ margin: "4px 0 8px", color: "#475569", fontSize: "0.92rem" }}>
                    <strong>Requirement:</strong> {tc.description}
                  </p>
                )}

                {tc.preconditions && (
                  <p style={{ margin: "4px 0 8px", color: "#64748b", fontSize: "0.88rem" }}>
                    <strong>Preconditions:</strong> {tc.preconditions}
                  </p>
                )}

                {tc.steps && tc.steps.length > 0 && (
                  <div style={{ margin: "8px 0" }}>
                    <strong style={{ fontSize: "0.85rem", color: "#334155" }}>Test Steps:</strong>
                    <ol style={{ margin: "4px 0 0", paddingLeft: "20px", fontSize: "0.88rem", color: "#475569" }}>
                      {tc.steps.map((step, idx) => (
                        <li key={idx} style={{ margin: "2px 0" }}>{describeTestStep(step)}</li>
                      ))}
                    </ol>
                  </div>
                )}

                {tc.expected_result && (
                  <div style={{ marginTop: "8px", padding: "8px 12px", background: "var(--positive-bg)", border: "1px solid #c9e6d3", borderRadius: "6px", fontSize: "0.88rem", color: "var(--positive)" }}>
                    <strong>Expected Result:</strong> {tc.expected_result}
                    {isSubmissionOnlyExpectedResult(tc.expected_result) && (
                      <p style={{ margin: "5px 0 0", color: "var(--warning)" }}>
                        This confirms the form submitted, but does not verify that the requested change appears in the application.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Action buttons */}
              <div className="actions" style={{ marginTop: "4px" }}>
                {canEdit && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => startEdit(tc)}
                    style={{ padding: "6px 12px", fontSize: "0.82rem" }}
                  >
                    Edit
                  </button>
                )}

                {canApprove && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleReview(tc.id, "approved")}
                      disabled={tc.review_status === "approved"}
                      style={{ padding: "6px 12px", fontSize: "0.82rem" }}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleReview(tc.id, "rejected")}
                      disabled={tc.review_status === "rejected"}
                      style={{ padding: "6px 12px", fontSize: "0.82rem" }}
                    >
                      Reject
                    </button>
                  </>
                )}

                {tc.review_status === "approved" && canEdit && (
                  <button
                    type="button"
                    onClick={() => handleAutomateSingle(tc.id)}
                    disabled={automatingId === tc.id}
                    style={{ padding: "6px 12px", fontSize: "0.82rem", background: "var(--accent)" }}
                  >
                    {automatingId === tc.id ? "Converting…" : "Automate with AI"}
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}

        {requirementTestCases.length === 0 && (
          <p className="notice">
            No requirement test cases found. Upload a specification document above or adjust your filters.
          </p>
        )}
      </State>

      {/* Edit Test Case Modal */}
      {editingCase && (
        <div className="modal-overlay" onClick={() => setEditingCase(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Edit Requirement Test Case</h3>
              <button type="button" className="modal-close" onClick={() => setEditingCase(null)}>
                ×
              </button>
            </div>

            <form onSubmit={handleSaveEdit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                  Test Case Title *
                </label>
                <input
                  required
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  disabled={savingEdit}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                    Test Scenario Type
                  </label>
                  <select
                    value={editTestType}
                    onChange={(e) => setEditTestType(e.target.value)}
                    disabled={savingEdit}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  >
                    <option value="positive">Positive</option>
                    <option value="negative">Negative</option>
                    <option value="boundary">Boundary</option>
                    <option value="edge_case">Edge Case</option>
                  </select>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                    Priority
                  </label>
                  <select
                    value={editPriority}
                    onChange={(e) => setEditPriority(e.target.value)}
                    disabled={savingEdit}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                  Requirement Description
                </label>
                <textarea
                  rows={2}
                  value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)}
                  disabled={savingEdit}
                  placeholder="Requirement or user story text..."
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                  Preconditions
                </label>
                <textarea
                  rows={2}
                  value={editPreconditions}
                  onChange={(e) => setEditPreconditions(e.target.value)}
                  disabled={savingEdit}
                  placeholder="e.g. User account is active and verified..."
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                  Test Steps (one step per line)
                </label>
                <textarea
                  rows={4}
                  value={editSteps}
                  onChange={(e) => setEditSteps(e.target.value)}
                  disabled={savingEdit}
                  placeholder="Step 1&#10;Step 2&#10;Step 3..."
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                  Expected Result *
                </label>
                <textarea
                  required
                  rows={2}
                  value={editExpectedResult}
                  onChange={(e) => setEditExpectedResult(e.target.value)}
                  disabled={savingEdit}
                  placeholder="Expected system behavior..."
                />
              </div>

              {canApprove && (
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                    Review Status
                  </label>
                  <select
                    value={editReviewStatus}
                    onChange={(e) => setEditReviewStatus(e.target.value)}
                    disabled={savingEdit}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  >
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="rejected">Rejected</option>
                  </select>
                </div>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEditingCase(null)}
                  disabled={savingEdit}
                >
                  Cancel
                </button>
                <button type="submit" disabled={savingEdit || !editTitle.trim()}>
                  {savingEdit ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

function AutomationsTab({ projectId }: { projectId: string }) {
  const { user } = useAuth();
  const { data: automations, loading, error, reload } =
    useResource<TestCaseAutomation[]>(`/projects/${projectId}/automations`);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterRunStatus, setFilterRunStatus] = useState<string>("all");
  const [runningId, setRunningId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [errorMsg, setErrorMsg] = useState("");

  // Edit Automation Modal State
  const [editingAuto, setEditingAuto] = useState<TestCaseAutomation | null>(null);
  const [editStatus, setEditStatus] = useState<"draft" | "ready" | "approved" | "archived">("ready");
  const [editWebSteps, setEditWebSteps] = useState("");
  const [editApiMethod, setEditApiMethod] = useState<"GET" | "POST" | "PUT" | "PATCH" | "DELETE">("GET");
  const [editApiPath, setEditApiPath] = useState("");
  const [editApiHeaders, setEditApiHeaders] = useState("{}");
  const [editApiBody, setEditApiBody] = useState("");
  const [editApiExpectedStatus, setEditApiExpectedStatus] = useState(200);
  const [savingEdit, setSavingEdit] = useState(false);

  // Live execution results map
  const [recentResults, setRecentResults] = useState<Record<string, any>>({});

  const canEdit = user?.role === "admin" || user?.role === "qa_manager" || user?.role === "qa_engineer";

  const filteredAutomations = (automations ?? []).filter((a) => {
    if (filterType !== "all" && a.target_type !== filterType) return false;
    if (filterStatus !== "all" && a.status !== filterStatus) return false;
    if (filterRunStatus !== "all") {
      const currentRunStatus = recentResults[a.id]?.status ?? a.last_run_status ?? "unrun";
      if (filterRunStatus === "unrun" && currentRunStatus !== "unrun") return false;
      if (filterRunStatus !== "unrun" && currentRunStatus !== filterRunStatus) return false;
    }
    return true;
  });

  const readyCount = (automations ?? []).filter((a) => a.status === "ready" || a.status === "approved").length;

  async function handleRunSingle(auto: TestCaseAutomation) {
    setRunningId(auto.id);
    setErrorMsg("");
    setMessage("");
    try {
      const res = await api<any>(`/automations/${auto.id}/run`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setRecentResults((prev) => ({ ...prev, [auto.id]: res }));
      setMessage(
        `Automated test "${auto.test_case_title || "Test"}" executed: ${res.status.toUpperCase()} (${res.duration_ms}ms).`,
      );
      reload();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningId(null);
    }
  }

  async function handleBatchRun() {
    setBatchRunning(true);
    setErrorMsg("");
    setMessage("");
    try {
      const res = await api<{
        total: number;
        passed: number;
        failed: number;
        inconclusive: number;
      }>(`/projects/${projectId}/automations/batch-run`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setMessage(
        `Batch execution finished: ${res.passed} passed, ${res.failed} failed, ${res.inconclusive} inconclusive out of ${res.total} automated tests.`,
      );
      reload();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBatchRunning(false);
    }
  }

  function openEdit(auto: TestCaseAutomation) {
    setEditingAuto(auto);
    setEditStatus(auto.status);
    setEditWebSteps(auto.web_steps ? auto.web_steps.join("\n") : "");
    setEditApiMethod(auto.api_method || "GET");
    setEditApiPath(auto.api_path || "/api");
    setEditApiHeaders(JSON.stringify(auto.api_headers ?? {}, null, 2));
    setEditApiBody(auto.api_body ? JSON.stringify(auto.api_body, null, 2) : "");
    setEditApiExpectedStatus(auto.api_expected_status || 200);
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingAuto) return;
    setSavingEdit(true);
    setErrorMsg("");

    try {
      const payload: Record<string, any> = {
        status: editStatus,
      };

      if (editingAuto.target_type === "web") {
        const steps = editWebSteps
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (steps.length === 0) {
          throw new Error("Web automation must contain at least one step.");
        }
        payload.web_steps = steps;
      } else {
        payload.api_method = editApiMethod;
        payload.api_path = editApiPath.trim();
        payload.api_expected_status = Number(editApiExpectedStatus);

        try {
          payload.api_headers = JSON.parse(editApiHeaders || "{}");
        } catch {
          throw new Error("Invalid JSON format in Headers.");
        }

        if (editApiBody.trim()) {
          try {
            payload.api_body = JSON.parse(editApiBody);
          } catch {
            throw new Error("Invalid JSON format in Request Body.");
          }
        } else {
          payload.api_body = null;
        }
      }

      await api(`/automations/${editingAuto.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });

      setMessage("Automation script updated and validated successfully.");
      setEditingAuto(null);
      reload();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  }

  return (
    <div className="tab-content">
      <div className="section-heading">
        <div>
          <h2>Automated Execution of AI-Generated Test Cases</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Execute approved requirements tests in headless Chromium or REST API runner with full evidence capture.
          </p>
        </div>
      </div>

      {message && <p className="notice" style={{ background: "#ecfdf5", color: "#065f46" }}>{message}</p>}
      {errorMsg && <p className="notice error">{errorMsg}</p>}

      {/* Filter and Action Bar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px", margin: "14px 0 6px" }}>
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            style={{ fontSize: "0.88rem", padding: "6px 10px" }}
          >
            <option value="all">All Automation Types</option>
            <option value="web">Web UI (Playwright)</option>
            <option value="api">REST API (HTTP)</option>
            <option value="mobile">Android Mobile (Appium)</option>
          </select>

          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{ fontSize: "0.88rem", padding: "6px 10px" }}
          >
            <option value="all">All Script Statuses</option>
            <option value="ready">Ready to Run</option>
            <option value="draft">Draft</option>
            <option value="approved">Approved</option>
          </select>

          <select
            value={filterRunStatus}
            onChange={(e) => setFilterRunStatus(e.target.value)}
            style={{ fontSize: "0.88rem", padding: "6px 10px" }}
          >
            <option value="all">All Execution Results</option>
            <option value="passed">Passed</option>
            <option value="failed">Failed</option>
            <option value="inconclusive">Inconclusive</option>
            <option value="unrun">Not Run Yet</option>
          </select>
        </div>

        {canEdit && (
          <button
            type="button"
            onClick={handleBatchRun}
            disabled={batchRunning || readyCount === 0}
            style={{ padding: "8px 16px", fontSize: "0.88rem", fontWeight: 600, background: "var(--primary)" }}
          >
            {batchRunning ? "Executing All Automations…" : `▶ Run All Ready Automations (${readyCount})`}
          </button>
        )}
      </div>

      {/* Automations List */}
      <State loading={loading} error={error}>
        {filteredAutomations.map((auto) => {
          const liveResult = recentResults[auto.id];
          const displayStatus = liveResult?.status ?? auto.last_run_status ?? "unrun";
          const displayDuration = liveResult?.duration_ms ?? null;
          const displayError = liveResult?.error_message ?? auto.last_error_message;

          return (
            <article className="row-card" key={auto.id} style={{ alignItems: "flex-start", flexDirection: "column", gap: "12px" }}>
              <div style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "12px" }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "6px" }}>
                    <strong style={{ fontSize: "1.05rem", color: "#17324d" }}>
                      {auto.test_case_title || "Automated Test Case"}
                    </strong>
                    <span className={`badge ${auto.target_type === "web" ? "badge-target-web" : auto.target_type === "api" ? "badge-target-api" : "badge-target-mobile"}`}>
                      {auto.target_type === "web" ? "Web UI (Playwright)" : auto.target_type === "api" ? "REST API (HTTP)" : "Android Mobile (Appium)"}
                    </span>
                    <span className={`badge ${displayStatus}`}>
                      {displayStatus === "unrun" ? "Not Run Yet" : displayStatus}
                    </span>
                    {auto.confidence && (
                      <span className="muted" style={{ fontSize: "0.78rem" }}>
                        AI Confidence: {(auto.confidence * 100).toFixed(0)}%
                      </span>
                    )}
                  </div>

                  {auto.requirement_doc_filename && (
                    <p style={{ margin: "2px 0 6px", fontSize: "0.84rem", color: "#64748b" }}>
                      <strong>Requirement Source:</strong> {auto.requirement_doc_filename}
                    </p>
                  )}

                  {auto.test_case_description && (
                    <p style={{ margin: "4px 0", color: "#475569", fontSize: "0.9rem" }}>
                      <strong>Requirement:</strong> {auto.test_case_description}
                    </p>
                  )}

                  {/* Automation Details Rendering */}
                  {auto.target_type === "web" ? (
                    <div style={{ marginTop: "8px" }}>
                      <strong style={{ fontSize: "0.84rem", color: "#334155" }}>Playwright Steps:</strong>
                      <div className="code-box">
                        {auto.web_steps && auto.web_steps.length > 0 ? (
                          auto.web_steps.map((st, i) => (
                            <div key={i} style={{ margin: "2px 0" }}>
                              <code>{st}</code>
                            </div>
                          ))
                        ) : (
                          <span className="muted">No steps defined</span>
                        )}
                      </div>
                    </div>
                  ) : auto.target_type === "mobile" ? (
                    <div style={{ marginTop: "8px" }}>
                      <strong style={{ fontSize: "0.84rem", color: "#334155" }}>
                        Appium Mobile Steps ({auto.app_package || "com.android.settings"}):
                      </strong>
                      <div className="code-box">
                        {auto.mobile_steps && auto.mobile_steps.length > 0 ? (
                          auto.mobile_steps.map((st, i) => (
                            <div key={i} style={{ margin: "2px 0" }}>
                              <code>{st}</code>
                            </div>
                          ))
                        ) : (
                          <span className="muted">No mobile steps defined</span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div style={{ marginTop: "8px" }}>
                      {auto.api_steps && auto.api_steps.length > 0 ? (
                        <>
                          <strong style={{ fontSize: "0.84rem", color: "#334155" }}>
                            Chained Multi-Step API Workflow ({auto.api_steps.length} requests):
                          </strong>
                          <div className="workflow-step-chain">
                            {auto.api_steps.map((st, idx) => (
                              <span key={idx} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                                <span className="step-item">
                                  <span className={`http-method-pill method-${st.method}`} style={{ fontSize: "0.7rem", padding: "1px 5px", marginRight: "4px" }}>
                                    {st.method}
                                  </span>
                                  {st.name || st.path}
                                </span>
                                {idx < auto.api_steps!.length - 1 && <span className="step-arrow">→</span>}
                              </span>
                            ))}
                          </div>
                        </>
                      ) : (
                        <>
                          <strong style={{ fontSize: "0.84rem", color: "#334155" }}>HTTP Request Specification:</strong>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", margin: "6px 0" }}>
                            <span className={`http-method-pill method-${auto.api_method || "GET"}`}>
                              {auto.api_method || "GET"}
                            </span>
                            <code style={{ fontSize: "0.9rem", color: "#0f172a", fontWeight: 600 }}>{auto.api_path}</code>
                            <span className="badge" style={{ fontSize: "0.78rem" }}>
                              Expected Status: {auto.api_expected_status || 200}
                            </span>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* Execution Results & Evidence */}
                  {(auto.last_run_at || liveResult) && (
                    <div style={{ marginTop: "10px", padding: "10px 14px", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: "6px", fontSize: "0.88rem" }}>
                      <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", alignItems: "center" }}>
                        <span>
                          <strong>Outcome: </strong>
                          <span className={`badge ${displayStatus}`}>{displayStatus}</span>
                        </span>
                        {(displayDuration !== null || auto.last_run_status) && (
                          <span className="muted">
                            Duration: {displayDuration ?? "~"}ms
                          </span>
                        )}
                        {auto.last_run_at && (
                          <span className="muted">
                            Executed on {new Date(auto.last_run_at).toLocaleString()}
                          </span>
                        )}
                      </div>

                      {displayError && (
                        <div style={{ marginTop: "6px", color: "#a13232", fontSize: "0.85rem", background: "#fde8e7", padding: "6px 10px", borderRadius: "4px" }}>
                          <strong>Error Details: </strong>{displayError}
                        </div>
                      )}

                      {/* Evidence Links */}
                      {liveResult?.screenshot_path && (
                        <div style={{ marginTop: "8px" }}>
                          <button
                            type="button"
                            className="secondary"
                            onClick={() => window.open(`${apiBase}/${liveResult.screenshot_path}`, "_blank")}
                            style={{ padding: "4px 10px", fontSize: "0.8rem" }}
                          >
                            View screenshot
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="actions" style={{ marginTop: "4px", display: "flex", flexDirection: "column", gap: "6px" }}>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => handleRunSingle(auto)}
                      disabled={runningId === auto.id || batchRunning}
                      style={{ padding: "8px 14px", fontSize: "0.85rem", background: "var(--primary)" }}
                    >
                      {runningId === auto.id ? "Running…" : "▶ Run Test"}
                    </button>
                  )}

                  {canEdit && (
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => openEdit(auto)}
                      disabled={runningId === auto.id || batchRunning}
                      style={{ padding: "6px 12px", fontSize: "0.82rem" }}
                    >
                      Edit automation
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}

        {filteredAutomations.length === 0 && (
          <p className="notice">
            No automated test cases found. Go to the "Requirements" tab to select approved test cases and click "Automate with AI".
          </p>
        )}
      </State>

      {/* Edit Automation Modal */}
      {editingAuto && (
        <div className="modal-overlay" onClick={() => setEditingAuto(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Edit Automation: {editingAuto.test_case_title || "Test Case"}</h3>
              <button type="button" className="modal-close" onClick={() => setEditingAuto(null)}>
                ×
              </button>
            </div>

            <form onSubmit={handleSaveEdit} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                    Automation Type
                  </label>
                  <input
                    disabled
                    value={editingAuto.target_type === "web" ? "Web UI (Playwright)" : "REST API (HTTP)"}
                    style={{ width: "100%", boxSizing: "border-box", background: "#f1f5f9" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                    Script Status
                  </label>
                  <select
                    value={editStatus}
                    onChange={(e) => setEditStatus(e.target.value as any)}
                    disabled={savingEdit}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  >
                    <option value="ready">Ready to Run</option>
                    <option value="draft">Draft</option>
                    <option value="approved">Approved</option>
                  </select>
                </div>
              </div>

              {editingAuto.target_type === "web" ? (
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                    Playwright Browser Steps (one step per line) *
                  </label>
                  <textarea
                    rows={8}
                    required
                    value={editWebSteps}
                    onChange={(e) => setEditWebSteps(e.target.value)}
                    disabled={savingEdit}
                    style={{ fontFamily: "ui-monospace,SFMono-Regular,Consolas,monospace", fontSize: "0.88rem" }}
                  />
                  <div style={{ marginTop: "4px", fontSize: "0.78rem", color: "#64748b", background: "#f8fafc", padding: "6px 10px", borderRadius: "4px" }}>
                    <strong>Allowed Actions:</strong> goto &lt;path&gt; · click &lt;selector&gt; · fill &lt;selector&gt; | &lt;value&gt; · select &lt;selector&gt; | &lt;option&gt; · expect visible &lt;selector&gt; · expect not visible &lt;selector&gt; · expect text &lt;text&gt; · expect invalid &lt;selector&gt;
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: "10px" }}>
                    <div>
                      <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                        Method
                      </label>
                      <select
                        value={editApiMethod}
                        onChange={(e) => setEditApiMethod(e.target.value as any)}
                        disabled={savingEdit}
                        style={{ width: "100%" }}
                      >
                        <option value="GET">GET</option>
                        <option value="POST">POST</option>
                        <option value="PUT">PUT</option>
                        <option value="PATCH">PATCH</option>
                        <option value="DELETE">DELETE</option>
                      </select>
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                        Endpoint Path *
                      </label>
                      <input
                        required
                        value={editApiPath}
                        onChange={(e) => setEditApiPath(e.target.value)}
                        disabled={savingEdit}
                        style={{ width: "100%", boxSizing: "border-box" }}
                      />
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                    <div>
                      <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                        Expected HTTP Status *
                      </label>
                      <input
                        type="number"
                        required
                        value={editApiExpectedStatus}
                        onChange={(e) => setEditApiExpectedStatus(Number(e.target.value))}
                        disabled={savingEdit}
                        style={{ width: "100%", boxSizing: "border-box" }}
                      />
                    </div>
                    <div>
                      <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                        Headers (JSON)
                      </label>
                      <input
                        value={editApiHeaders}
                        onChange={(e) => setEditApiHeaders(e.target.value)}
                        disabled={savingEdit}
                        style={{ width: "100%", boxSizing: "border-box" }}
                      />
                    </div>
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                      Request Body (JSON, optional)
                    </label>
                    <textarea
                      rows={4}
                      value={editApiBody}
                      onChange={(e) => setEditApiBody(e.target.value)}
                      disabled={savingEdit}
                      placeholder="{}"
                      style={{ fontFamily: "ui-monospace,SFMono-Regular,Consolas,monospace", fontSize: "0.88rem" }}
                    />
                  </div>
                </>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setEditingAuto(null)}
                  disabled={savingEdit}
                >
                  Cancel
                </button>
                <button type="submit" disabled={savingEdit}>
                  {savingEdit ? "Validating & Saving…" : "Save Automation Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
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
    fetch(`${apiBase}/artifacts/${encodeURIComponent(filename)}`, { credentials: "include" })
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
  const [runningId, setRunningId] = useState<string | null>(null);
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
    setRunningId(id);
    setMessage("");
    try {
      const result = await api<Run>(`/suites/${id}/run`, {
        method: "POST",
        body: JSON.stringify({ concurrency: 3, retries: 1 }),
      });
      navigate(`/runs/${result.id}`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRunningId(null);
    }
  }

  return (
    <div className="tab-content">
      <form className="inline-form" onSubmit={create}>
        <input required placeholder="Suite name" value={name} onChange={(event) => setName(event.target.value)} />
        <button>Create suite</button>
      </form>
      {message && <p className="notice error">{message}</p>}
      <State loading={loading} error={error}>
        {(data ?? []).map((suite) => (
          <article className="row-card" key={suite.id}>
            <Link to={`/suites/${suite.id}`}>{suite.name}</Link>
            <button disabled={runningId === suite.id} onClick={() => runSuite(suite.id)}>
              {runningId === suite.id ? "Launching Suite…" : "Run suite (3x parallel)"}
            </button>
          </article>
        ))}
      </State>
    </div>
  );
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
    <Link to={suite?.project_id ? `/projects/${suite.project_id}?tab=suites` : "/projects"} className="back-link">
      ← {suite?.project_id ? "Project suites" : "Projects"}
    </Link><h1>Suite: {suite?.name ?? ""}</h1>
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

function SchedulesTab({ projectId }: { projectId: string }) {
  const { user } = useAuth();
  const { data: schedules, loading, error, reload } =
    useResource<TestSchedule[]>(`/projects/${projectId}/schedules`);
  const { data: suites } = useResource<Suite[]>(`/projects/${projectId}/suites`);

  const [message, setMessage] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);

  // Create form state
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [suiteId, setSuiteId] = useState("");
  const [frequency, setFrequency] = useState<"hourly" | "daily" | "weekly" | "cron">("daily");
  const [cronExpression, setCronExpression] = useState("0 2 * * *");
  const [concurrency, setConcurrency] = useState(3);
  const [retries, setRetries] = useState(1);
  const [isActive, setIsActive] = useState(true);
  const [creating, setCreating] = useState(false);

  // Edit modal state
  const [editingSchedule, setEditingSchedule] = useState<TestSchedule | null>(null);
  const [editName, setEditName] = useState("");
  const [editSuiteId, setEditSuiteId] = useState("");
  const [editFrequency, setEditFrequency] = useState<"hourly" | "daily" | "weekly" | "cron">("daily");
  const [editCronExpression, setEditCronExpression] = useState("");
  const [editConcurrency, setEditConcurrency] = useState(3);
  const [editRetries, setEditRetries] = useState(1);
  const [savingEdit, setSavingEdit] = useState(false);

  // History modal state
  const [viewingHistorySchedule, setViewingHistorySchedule] = useState<TestSchedule | null>(null);
  const [historyRuns, setHistoryRuns] = useState<TestScheduleRun[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const canManage = user?.role === "admin" || user?.role === "qa_manager" || user?.role === "qa_engineer";

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!name.trim() || !suiteId) return;
    setCreating(true);
    setErrorMsg("");
    setMessage("");

    try {
      await api(`/projects/${projectId}/schedules`, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          suite_id: suiteId,
          frequency,
          cron_expression: frequency === "cron" ? cronExpression.trim() : null,
          concurrency,
          retries,
          is_active: isActive,
        }),
      });
      setName("");
      setSuiteId("");
      setShowCreate(false);
      setMessage("Test execution schedule created successfully.");
      reload();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleToggleActive(schedule: TestSchedule) {
    setBusyId(schedule.id);
    setErrorMsg("");
    try {
      await api(`/schedules/${schedule.id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_active: !schedule.is_active }),
      });
      reload();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleRunNow(schedule: TestSchedule) {
    setBusyId(schedule.id);
    setErrorMsg("");
    setMessage("");
    try {
      const res = await api<any>(`/schedules/${schedule.id}/run-now`, {
        method: "POST",
      });
      setMessage(`Schedule execution started for "${schedule.name}". Suite run #${res.run_id?.slice(0, 8)} created.`);
      reload();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(schedule: TestSchedule) {
    if (!confirm(`Are you sure you want to delete schedule "${schedule.name}"?`)) return;
    setBusyId(schedule.id);
    setErrorMsg("");
    try {
      await api(`/schedules/${schedule.id}`, {
        method: "DELETE",
      });
      setMessage(`Schedule "${schedule.name}" deleted.`);
      reload();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function openEdit(schedule: TestSchedule) {
    setEditingSchedule(schedule);
    setEditName(schedule.name);
    setEditSuiteId(schedule.suite_id);
    setEditFrequency(schedule.frequency);
    setEditCronExpression(schedule.cron_expression || "0 2 * * *");
    setEditConcurrency(schedule.concurrency || 3);
    setEditRetries(schedule.retries ?? 1);
  }

  async function handleSaveEdit(e: FormEvent) {
    e.preventDefault();
    if (!editingSchedule) return;
    setSavingEdit(true);
    setErrorMsg("");

    try {
      await api(`/schedules/${editingSchedule.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: editName.trim(),
          suite_id: editSuiteId,
          frequency: editFrequency,
          cron_expression: editFrequency === "cron" ? editCronExpression.trim() : null,
          concurrency: editConcurrency,
          retries: editRetries,
        }),
      });
      setEditingSchedule(null);
      setMessage("Schedule updated successfully.");
      reload();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingEdit(false);
    }
  }

  async function openHistory(schedule: TestSchedule) {
    setViewingHistorySchedule(schedule);
    setHistoryLoading(true);
    try {
      const runs = await api<TestScheduleRun[]>(`/schedules/${schedule.id}/runs`);
      setHistoryRuns(runs);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setHistoryLoading(false);
    }
  }

  return (
    <div className="tab-content">
      <div className="section-heading">
        <div>
          <h2>Automated Test Execution Schedules</h2>
          <p className="muted" style={{ margin: "4px 0 0" }}>
            Schedule test suites for recurring autonomous execution with parallel threads, retries, and flaky detection.
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={() => setShowCreate(!showCreate)}
            style={{ fontWeight: 600 }}
          >
            {showCreate ? "Cancel" : "+ New Schedule"}
          </button>
        )}
      </div>

      {message && <p className="notice" style={{ background: "#ecfdf5", color: "#065f46" }}>{message}</p>}
      {errorMsg && <p className="notice error">{errorMsg}</p>}

      {/* Create Schedule Form */}
      {showCreate && (
        <form className="stack-form" onSubmit={handleCreate} style={{ maxWidth: "680px", margin: "10px 0 20px" }}>
          <h3>Create Execution Schedule</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                Schedule Name *
              </label>
              <input
                required
                placeholder="e.g. Nightly Regression Suite"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={creating}
                style={{ width: "100%", boxSizing: "border-box" }}
              />
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                Target Test Suite *
              </label>
              <select
                required
                value={suiteId}
                onChange={(e) => setSuiteId(e.target.value)}
                disabled={creating}
                style={{ width: "100%", boxSizing: "border-box" }}
              >
                <option value="">Select Suite…</option>
                {(suites ?? []).map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                Frequency *
              </label>
              <select
                value={frequency}
                onChange={(e) => setFrequency(e.target.value as any)}
                disabled={creating}
                style={{ width: "100%", boxSizing: "border-box" }}
              >
                <option value="hourly">Hourly (Every 1 hour)</option>
                <option value="daily">Daily (Every 24 hours)</option>
                <option value="weekly">Weekly (Every 7 days)</option>
                <option value="cron">Custom Cron Expression</option>
              </select>
            </div>

            {frequency === "cron" ? (
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                  Cron Expression (5-part) *
                </label>
                <input
                  required
                  placeholder="0 2 * * * (At 02:00 AM daily)"
                  value={cronExpression}
                  onChange={(e) => setCronExpression(e.target.value)}
                  disabled={creating}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </div>
            ) : (
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                  Status
                </label>
                <label className="checkbox-label" style={{ marginTop: "10px" }}>
                  <input
                    type="checkbox"
                    checked={isActive}
                    onChange={(e) => setIsActive(e.target.checked)}
                    disabled={creating}
                  />
                  <span>Schedule Active Immediately</span>
                </label>
              </div>
            )}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                Parallel Concurrency: <strong>{concurrency} threads</strong>
              </label>
              <input
                type="range"
                min={1}
                max={10}
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                disabled={creating}
                style={{ width: "100%" }}
              />
              <span className="muted" style={{ fontSize: "0.78rem" }}>1 (sequential) to 10 parallel test workers</span>
            </div>
            <div>
              <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                Automatic Retries on Failure: <strong>{retries} retry</strong>
              </label>
              <input
                type="range"
                min={0}
                max={5}
                value={retries}
                onChange={(e) => setRetries(Number(e.target.value))}
                disabled={creating}
                style={{ width: "100%" }}
              />
              <span className="muted" style={{ fontSize: "0.78rem" }}>Detects flaky tests without passing inconclusive runs</span>
            </div>
          </div>

          <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
            <button disabled={creating || !name.trim() || !suiteId}>
              {creating ? "Scheduling…" : "Create Schedule"}
            </button>
            <button type="button" className="secondary" onClick={() => setShowCreate(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {/* Schedules List */}
      <State loading={loading} error={error}>
        {(schedules ?? []).map((schedule) => (
          <article className="row-card" key={schedule.id} style={{ alignItems: "flex-start", flexDirection: "column", gap: "10px" }}>
            <div style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "10px" }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "4px" }}>
                  <strong style={{ fontSize: "1.1rem", color: "#17324d" }}>{schedule.name}</strong>
                  <span className={`badge-freq badge-freq-${schedule.frequency}`}>
                    {schedule.frequency === "cron" ? `Cron: ${schedule.cron_expression}` : schedule.frequency}
                  </span>
                  <span className={`badge ${schedule.is_active ? "approved" : "rejected"}`}>
                    {schedule.is_active ? "Active" : "Paused"}
                  </span>
                  {schedule.last_run_status && (
                    <span className={`badge ${schedule.last_run_status}`}>
                      Last: {schedule.last_run_status}
                    </span>
                  )}
                </div>

                <p style={{ margin: "4px 0", color: "#475569", fontSize: "0.88rem" }}>
                  Target Suite: <strong>{schedule.suite_name || schedule.suite_id}</strong> · Concurrency: <strong>{schedule.concurrency}x</strong> · Retries: <strong>{schedule.retries}</strong>
                </p>

                <div style={{ display: "flex", gap: "14px", flexWrap: "wrap", fontSize: "0.82rem", color: "#64748b", marginTop: "4px" }}>
                  {schedule.next_run_at && (
                    <span>Next execution: <strong>{new Date(schedule.next_run_at).toLocaleString()}</strong></span>
                  )}
                  {schedule.last_run_at && (
                    <span>Last run: {new Date(schedule.last_run_at).toLocaleString()}</span>
                  )}
                </div>
              </div>

              {/* Action Buttons */}
              <div className="actions" style={{ flexWrap: "wrap" }}>
                {canManage && (
                  <>
                    <button
                      type="button"
                      onClick={() => handleRunNow(schedule)}
                      disabled={busyId === schedule.id}
                      style={{ padding: "6px 12px", fontSize: "0.85rem", background: "var(--primary)" }}
                    >
                      ▶ Run Now
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleToggleActive(schedule)}
                      disabled={busyId === schedule.id}
                      style={{ padding: "6px 12px", fontSize: "0.85rem" }}
                    >
                      {schedule.is_active ? "⏸ Pause" : "▶ Resume"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => openEdit(schedule)}
                      disabled={busyId === schedule.id}
                      style={{ padding: "6px 12px", fontSize: "0.85rem" }}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => openHistory(schedule)}
                      style={{ padding: "6px 12px", fontSize: "0.85rem" }}
                    >
                      History
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => handleDelete(schedule)}
                      disabled={busyId === schedule.id}
                      style={{ padding: "6px 10px", fontSize: "0.85rem", color: "#a13232" }}
                    >
                      Delete
                    </button>
                  </>
                )}
                {!canManage && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => openHistory(schedule)}
                    style={{ padding: "6px 12px", fontSize: "0.85rem" }}
                  >
                    View history
                  </button>
                )}
              </div>
            </div>
          </article>
        ))}

        {schedules?.length === 0 && (
          <p className="notice">No execution schedules configured for this project yet.</p>
        )}
      </State>

      {/* Edit Schedule Modal */}
      {editingSchedule && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: "560px" }}>
            <div className="modal-header">
              <h3>Edit Schedule: {editingSchedule.name}</h3>
              <button className="modal-close" onClick={() => setEditingSchedule(null)}>Close</button>
            </div>
            <form onSubmit={handleSaveEdit} className="stack-form">
              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                  Schedule Name *
                </label>
                <input
                  required
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  disabled={savingEdit}
                  style={{ width: "100%", boxSizing: "border-box" }}
                />
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                  Target Suite *
                </label>
                <select
                  required
                  value={editSuiteId}
                  onChange={(e) => setEditSuiteId(e.target.value)}
                  disabled={savingEdit}
                  style={{ width: "100%", boxSizing: "border-box" }}
                >
                  {(suites ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                  Frequency *
                </label>
                <select
                  value={editFrequency}
                  onChange={(e) => setEditFrequency(e.target.value as any)}
                  disabled={savingEdit}
                  style={{ width: "100%", boxSizing: "border-box" }}
                >
                  <option value="hourly">Hourly</option>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="cron">Custom Cron</option>
                </select>
              </div>

              {editFrequency === "cron" && (
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                    Cron Expression *
                  </label>
                  <input
                    required
                    value={editCronExpression}
                    onChange={(e) => setEditCronExpression(e.target.value)}
                    disabled={savingEdit}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                    Concurrency ({editConcurrency}x)
                  </label>
                  <input
                    type="range"
                    min={1}
                    max={10}
                    value={editConcurrency}
                    onChange={(e) => setEditConcurrency(Number(e.target.value))}
                    disabled={savingEdit}
                    style={{ width: "100%" }}
                  />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                    Retries ({editRetries})
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={5}
                    value={editRetries}
                    onChange={(e) => setEditRetries(Number(e.target.value))}
                    disabled={savingEdit}
                    style={{ width: "100%" }}
                  />
                </div>
              </div>

              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setEditingSchedule(null)} disabled={savingEdit}>
                  Cancel
                </button>
                <button type="submit" disabled={savingEdit || !editName.trim()}>
                  {savingEdit ? "Saving…" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Schedule History Modal */}
      {viewingHistorySchedule && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: "720px" }}>
            <div className="modal-header">
              <div>
                <h3>Schedule Execution History</h3>
                <p className="muted" style={{ margin: "2px 0 0", fontSize: "0.85rem" }}>
                  {viewingHistorySchedule.name} (Suite: {viewingHistorySchedule.suite_name || viewingHistorySchedule.suite_id})
                </p>
              </div>
              <button className="modal-close" onClick={() => setViewingHistorySchedule(null)}>Close</button>
            </div>

            {historyLoading ? (
              <p className="muted">Loading execution history…</p>
            ) : (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Started</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Results Summary</th>
                    <th>Link</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRuns.map((hr) => {
                    const dur = hr.completed_at
                      ? Math.round((new Date(hr.completed_at).getTime() - new Date(hr.started_at).getTime()) / 1000)
                      : null;
                    return (
                      <tr key={hr.id}>
                        <td><small>{new Date(hr.started_at).toLocaleString()}</small></td>
                        <td><span className={`badge ${hr.status}`}>{hr.status}</span></td>
                        <td><small>{dur !== null ? `${dur}s` : "running"}</small></td>
                        <td>
                          {hr.summary ? (
                            <small>
                              {hr.summary.passed} passed · {hr.summary.failed} failed
                              {Number(hr.summary.flaky ?? 0) > 0 ? ` · ${hr.summary.flaky} flaky` : ""}
                            </small>
                          ) : hr.error_message ? (
                            <small className="error">{hr.error_message}</small>
                          ) : (
                            <small className="muted">-</small>
                          )}
                        </td>
                        <td>
                          {hr.run_id ? (
                            <Link to={`/runs/${hr.run_id}`} style={{ fontSize: "0.82rem" }}>
                              View Run →
                            </Link>
                          ) : (
                            <small className="muted">-</small>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {historyRuns.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ textAlign: "center", color: "#64748b" }}>
                        No execution records found for this schedule.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}

            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => setViewingHistorySchedule(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RunsTab({ projectId }: { projectId: string }) {
  const { data: runs, loading, error } = useResource<Run[]>(`/projects/${projectId}/runs`);
  const { data: trends } = useResource<Run[]>(`/projects/${projectId}/trends`);
  const { data: flakyData } = useResource<FlakyResponse>(`/projects/${projectId}/flaky-tests`);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedRuns, setSelectedRuns] = useState<string[]>([]);
  const [comparison, setComparison] = useState<ComparisonResponse | null>(null);
  const [comparing, setComparing] = useState(false);
  const [comparisonError, setComparisonError] = useState("");
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

  async function compareLatest() {
    setComparing(true);
    setComparisonError("");
    try {
      const res = await api<ComparisonResponse>(`/projects/${projectId}/runs/latest-comparison`);
      setComparison(res);
    } catch (reason) {
      setComparisonError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setComparing(false);
    }
  }

  async function compareSelected() {
    if (selectedRuns.length !== 2) return;
    setComparing(true);
    setComparisonError("");
    try {
      const res = await api<ComparisonResponse>(
        `/projects/${projectId}/runs/compare?baseRunId=${selectedRuns[1]}&targetRunId=${selectedRuns[0]}`,
      );
      setComparison(res);
    } catch (reason) {
      setComparisonError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setComparing(false);
    }
  }

  function toggleRunSelect(runId: string) {
    setSelectedRuns((prev) => {
      if (prev.includes(runId)) return prev.filter((id) => id !== runId);
      if (prev.length >= 2) return [runId, prev[0]];
      return [...prev, runId];
    });
  }

  const points = trends ?? [];
  const width = 600;
  const height = 160;
  const path = points.map((run, index) => {
    const x = points.length < 2 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height - ((run.pass_rate ?? 0) / 100) * height;
    return `${index === 0 ? "M" : "L"} ${x} ${y}`;
  }).join(" ");

  return (
    <div className="tab-content">
      {/* Flaky Tests Alert */}
      {(flakyData?.flaky_tests_count ?? 0) > 0 && (
        <div className="card" style={{ borderLeft: "3px solid var(--warning)", padding: "16px", background: "var(--warning-bg)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong>Flaky tests detected ({flakyData?.flaky_tests_count})</strong>
            <span style={{ fontSize: "0.85rem", color: "var(--warning)" }}>
              Tests with inconsistent pass/fail results across recent runs
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px", marginTop: "10px" }}>
            {flakyData?.flaky_tests.map((ft) => (
              <div key={ft.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", padding: "8px 12px", borderRadius: "6px", border: "1px solid #fef3c7" }}>
                <div>
                  <strong>{ft.title}</strong>
                  <span style={{ marginLeft: "8px", color: "#6b7280", fontSize: "0.85rem" }}>
                    ({ft.passed_runs} passed / {ft.failed_runs} failed across {ft.total_runs} runs)
                  </span>
                  {ft.last_error && <p className="error" style={{ fontSize: "0.8rem", margin: "2px 0 0" }}>Last error: {ft.last_error}</p>}
                </div>
                <span className="badge" style={{ background: "var(--warning-bg)", color: "var(--warning)", fontWeight: "bold" }}>
                  Flakiness: {Math.round(ft.flakiness_score * 100)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Regression Comparison Section */}
      <div className="section-heading">
        <h2>Pass rate trend & Build History</h2>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            type="button"
            className="secondary"
            onClick={compareLatest}
            disabled={comparing || (runs?.length ?? 0) < 2}
          >
            {comparing ? "Comparing…" : "Compare latest builds"}
          </button>
          {selectedRuns.length === 2 && (
            <button
              type="button"
              className="secondary"
              onClick={compareSelected}
              disabled={comparing}
            >
              Compare 2 selected runs
            </button>
          )}
          <button onClick={runApproved} disabled={running}>
            {running ? "Running tests…" : "Run approved web tests"}
          </button>
        </div>
      </div>

      {message && <p className="notice">{message}</p>}
      {comparisonError && <p className="notice error">{comparisonError}</p>}

      {/* Comparison Results Card */}
      {comparison && (
        <div className="card" style={{ padding: "18px", border: "1px solid #cbd5e1", background: "#f8fafc" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <h3 style={{ margin: "0 0 4px" }}>Build Regression Analysis</h3>
              <p className="muted" style={{ margin: 0, fontSize: "0.85rem" }}>
                Target run {comparison.summary.target_run_id.slice(0, 8)} vs Base run {comparison.summary.base_run_id.slice(0, 8)}
                {comparison.summary.target_commit_sha ? ` (Commit ${comparison.summary.target_commit_sha.slice(0, 7)})` : ""}
              </p>
            </div>
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <span
                className="badge"
                style={{
                  background: comparison.summary.regression_detected ? "var(--negative-bg)" : "var(--positive-bg)",
                  color: comparison.summary.regression_detected ? "var(--negative)" : "var(--positive)",
                  fontWeight: "bold",
                  fontSize: "0.9rem",
                  padding: "6px 12px",
                }}
              >
                {comparison.summary.regression_detected
                  ? `Regression detected (${comparison.summary.new_failures_count} new)`
                  : "Clean build (no regression)"}
              </span>
              <button
                type="button"
                className="secondary"
                onClick={() => setComparison(null)}
                style={{ padding: "4px 8px", fontSize: "0.85rem" }}
              >
                Close
              </button>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: "10px", margin: "14px 0" }}>
            <div className="card" style={{ padding: "10px", textAlign: "center" }}>
              <span style={{ fontSize: "1.3rem", fontWeight: "bold", color: "var(--negative)" }}>
                {comparison.summary.new_failures_count}
              </span>
              <span style={{ fontSize: "0.8rem", color: "#64748b" }}>New Failures</span>
            </div>
            <div className="card" style={{ padding: "10px", textAlign: "center" }}>
              <span style={{ fontSize: "1.3rem", fontWeight: "bold", color: "var(--warning)" }}>
                {comparison.summary.recurring_failures_count}
              </span>
              <span style={{ fontSize: "0.8rem", color: "#64748b" }}>Recurring Failures</span>
            </div>
            <div className="card" style={{ padding: "10px", textAlign: "center" }}>
              <span style={{ fontSize: "1.3rem", fontWeight: "bold", color: "var(--positive)" }}>
                {comparison.summary.fixed_tests_count}
              </span>
              <span style={{ fontSize: "0.8rem", color: "#64748b" }}>Fixed Tests</span>
            </div>
            <div className="card" style={{ padding: "10px", textAlign: "center" }}>
              <span style={{ fontSize: "1.3rem", fontWeight: "bold", color: "var(--accent)" }}>
                {comparison.summary.stable_passes_count}
              </span>
              <span style={{ fontSize: "0.8rem", color: "#64748b" }}>Stable Passes</span>
            </div>
            <div className="card" style={{ padding: "10px", textAlign: "center" }}>
              <span style={{ fontSize: "1.3rem", fontWeight: "bold", color: "#475569" }}>
                {comparison.summary.duration_delta_ms > 0 ? `+${comparison.summary.duration_delta_ms}` : comparison.summary.duration_delta_ms} ms
              </span>
              <span style={{ fontSize: "0.8rem", color: "#64748b" }}>Duration Δ</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "8px", maxHeight: "300px", overflowY: "auto" }}>
            {comparison.items.map((item) => (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  background: "#fff",
                  padding: "8px 12px",
                  borderRadius: "6px",
                  border: item.change_type === "new_failure" ? "1px solid #fca5a5" : "1px solid #e2e8f0",
                }}
              >
                <div>
                  <strong>{item.title}</strong>
                  <span style={{ marginLeft: "8px", fontSize: "0.8rem", color: "#64748b" }}>
                    ({item.type})
                  </span>
                  {item.error_message && (
                    <p className="error" style={{ fontSize: "0.8rem", margin: "2px 0 0" }}>
                      {item.error_message}
                    </p>
                  )}
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <span style={{ fontSize: "0.8rem", color: "#64748b" }}>
                    {item.base_status ?? "none"} → {item.target_status ?? "none"}
                  </span>
                  <span
                    className="badge"
                    style={{
                      background:
                        item.change_type === "new_failure"
                            ? "var(--negative-bg)"
                          : item.change_type === "recurring_failure"
                              ? "var(--warning-bg)"
                            : item.change_type === "fixed"
                                ? "var(--positive-bg)"
                              : "#f1f5f9",
                      color:
                        item.change_type === "new_failure"
                            ? "var(--negative)"
                          : item.change_type === "recurring_failure"
                              ? "var(--warning)"
                            : item.change_type === "fixed"
                                ? "var(--positive)"
                              : "#475569",
                      fontWeight: "bold",
                    }}
                  >
                    {item.change_type.replace("_", " ")}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Trend Graph */}
      {points.length > 0 ? (
        <svg className="trend" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Pass rate by run">
          <line x1="0" y1={height} x2={width} y2={height} />
          <path d={path} />
          {points.map((run, index) => {
            const x = points.length < 2 ? width / 2 : (index / (points.length - 1)) * width;
            const y = height - ((run.pass_rate ?? 0) / 100) * height;
            return (
              <circle key={run.id} cx={x} cy={y} r="4">
                <title>{run.pass_rate}%</title>
              </circle>
            );
          })}
        </svg>
      ) : (
        <p className="muted">No run trend data yet.</p>
      )}

      {/* Runs List with checkboxes for comparison */}
      <State loading={loading} error={error}>
        {(runs ?? []).map((run) => (
          <div
            className="row-card"
            key={run.id}
            style={{
              borderLeft: selectedRuns.includes(run.id) ? "4px solid #16827c" : undefined,
              background: selectedRuns.includes(run.id) ? "#f0fdfa" : undefined,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <input
                type="checkbox"
                aria-label={`Select run ${run.id} for comparison`}
                checked={selectedRuns.includes(run.id)}
                onChange={() => toggleRunSelect(run.id)}
              />
              <Link className="link-row" to={`/runs/${run.id}`}>
                <div>
                  <strong>{run.run_type}</strong>
                  <span style={{ marginLeft: "8px", color: "#64748b", fontSize: "0.85rem" }}>
                    {new Date(run.created_at).toLocaleString()}
                  </span>
                </div>
                <div style={{ fontSize: "0.85rem", color: "#64748b", marginTop: "2px" }}>
                  {run.passed_count ?? 0} passed · {run.failed_count ?? 0} failed
                </div>
              </Link>
            </div>
            <div className="actions" style={{ alignItems: "center" }}>
              <span className={`badge ${run.status}`}>{run.status}</span>
              <Link to={`/runs/${run.id}`} className="button secondary" style={{ fontSize: "0.85rem", padding: "6px 10px", textDecoration: "none" }}>
                Details →
              </Link>
            </div>
          </div>
        ))}
      </State>
    </div>
  );
}

function RunDetailPage() {
  const { id = "" } = useParams();
  const { data, loading, error } = useResource<Record<string, unknown>>(`/runs/${id}`);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState("");
  const [analysisError, setAnalysisError] = useState("");
  const [analysisReportCount, setAnalysisReportCount] = useState<number | null>(null);
  const webResults = (data?.results as Array<Record<string, unknown>> | undefined) ?? [];
  const suiteApiResults = (data?.api_results as Array<Record<string, unknown>> | undefined) ?? [];
  const allResults = [...webResults, ...suiteApiResults];
  const results = allResults.filter((result) => result.status !== "inconclusive");
  const infrastructureResults = allResults.filter((result) => result.status === "inconclusive");
  const failedWebResultCount = webResults.filter((result) => result.status === "failed").length;
  const projectId = typeof data?.project_id === "string" ? data.project_id : null;

  async function analyzeFailures() {
    setAnalysisLoading(true);
    setAnalysisMessage("");
    setAnalysisError("");
    try {
      const response = await api<{
        reports: BugReport[];
        errors: Array<{ result_id: string; error: string }>;
      }>(`/runs/${encodeURIComponent(id)}/analyze`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const reportCount = response.reports.length;
      const failureCount = response.errors.length;
      setAnalysisReportCount(reportCount);
      setAnalysisMessage(
        `${reportCount} bug report${reportCount === 1 ? "" : "s"} created.` +
          (failureCount > 0 ? ` Analysis failed for ${failureCount} test result${failureCount === 1 ? "" : "s"}.` : ""),
      );
      if (failureCount > 0) {
        setAnalysisError(response.errors.map((item) => item.error).join(" "));
      }
    } catch (reason) {
      setAnalysisError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function downloadExport(format: "csv" | "json") {
    try {
      const response = await fetch(`${apiBase}/runs/${encodeURIComponent(id)}/export?format=${format}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `run-${id.slice(0, 8)}-report.${format}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <Link to={projectId ? `/projects/${projectId}?tab=runs` : "/projects"} className="back-link">
        ← {projectId ? "Project runs" : "Projects"}
      </Link>
      <h1>Run details</h1>
      <State loading={loading} error={error}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap", margin: "8px 0 16px" }}>
          <span>Run status: <strong>{String(data?.status ?? "")}</strong></span>
          {Number(data?.flaky_count ?? 0) > 0 && (
            <span className="badge badge-flaky">{String(data?.flaky_count)} flaky tests</span>
          )}
          {Boolean(data?.concurrency) && (
            <span className="badge">Concurrency: {String(data?.concurrency)}x</span>
          )}
          {Boolean(data?.retries) && (
            <span className="badge">Max Retries: {String(data?.retries)}</span>
          )}
        </div>
        {failedWebResultCount > 0 && (
          <div className="analysis-callout">
            <div>
              <strong>{failedWebResultCount} failed web test{failedWebResultCount === 1 ? "" : "s"}</strong>
              <p>Analyze these failures to create bug reports with probable causes and reproduction steps.</p>
            </div>
            <button type="button" disabled={analysisLoading} onClick={() => void analyzeFailures()}>
              {analysisLoading ? "Analyzing…" : "Analyze failures"}
            </button>
            {analysisMessage && (
              <p role="status">
                {analysisMessage}{" "}
                {analysisReportCount !== null && analysisReportCount > 0 && (
                  <Link to="/bug-reports">View bug reports</Link>
                )}
              </p>
            )}
            {analysisError && <p className="error" role="alert">{analysisError}</p>}
          </div>
        )}
        <div className="actions" style={{ flexWrap: "wrap", marginBottom: "16px" }}>
          <RunFileButton runId={id} file="report" label="HTML report" />
          <RunFileButton runId={id} file="report.json" label="JSON report" />
          <button className="secondary" type="button" onClick={() => downloadExport("csv")}>
            Download CSV report
          </button>
          <button className="secondary" type="button" onClick={() => downloadExport("json")}>
            Download JSON export
          </button>
        </div>
        {results.map((result, index) => {
          const isFlaky = Boolean(result.flaky);
          const retryCount = Number(result.retry_count ?? 0);
          const attempts = Array.isArray(result.attempts) ? result.attempts : [];
          const stepResults = Array.isArray(result.step_results) ? result.step_results : [];

          return (
            <article className="row-card" key={String(result.id ?? index)}>
              <div style={{ width: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
                  <strong>{String(result.test_case_title ?? result.endpoint_name ?? result.title ?? result.test_case_id ?? result.endpoint_id ?? "Result")}</strong>
                  <span className={`badge ${String(result.status)}`}>{String(result.status)}</span>
                  {isFlaky && <span className="badge badge-flaky">Flaky (passed after retry)</span>}
                  {retryCount > 0 && <span className="badge badge-retry">Attempt {retryCount + 1}</span>}
                </div>
                {Boolean(result.duration_ms) && <p className="muted" style={{ fontSize: "0.82rem", margin: "2px 0" }}>Duration: {String(result.duration_ms)}ms</p>}
                {Boolean(result.error_message) && <p className="error">{String(result.error_message)}</p>}

                {/* Chained API Step Breakdown */}
                {stepResults.length > 0 && (
                  <div style={{ margin: "8px 0", padding: "8px 12px", background: "#f8fafc", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                    <strong style={{ fontSize: "0.82rem", color: "#334155" }}>Workflow Step Execution ({stepResults.length} steps):</strong>
                    <div style={{ display: "flex", flexDirection: "column", gap: "4px", marginTop: "4px" }}>
                      {stepResults.map((st: any, sIdx: number) => (
                        <div key={sIdx} style={{ fontSize: "0.82rem", display: "flex", alignItems: "center", gap: "8px" }}>
                          <span className={`badge ${st.passed ? "passed" : "failed"}`} style={{ fontSize: "0.72rem", padding: "1px 6px" }}>
                            {st.status_code || (st.passed ? "OK" : "ERR")}
                          </span>
                          <span><strong>{st.name}</strong> ({st.method} {st.path})</span>
                          <span className="muted">{st.duration_ms}ms</span>
                          {st.error && <span className="error" style={{ fontSize: "0.8rem" }}>: {st.error}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Retry Attempts Breakdown */}
                {attempts.length > 1 && (
                  <div style={{ margin: "8px 0", padding: "8px 12px", background: "#fffbeb", borderRadius: "6px", border: "1px solid #fef3c7" }}>
                    <strong style={{ fontSize: "0.82rem", color: "var(--warning)" }}>Retry History ({attempts.length} attempts):</strong>
                    <ul style={{ margin: "4px 0 0", paddingLeft: "18px", fontSize: "0.82rem", color: "var(--warning)" }}>
                      {attempts.map((att: any, aIdx: number) => (
                        <li key={aIdx}>
                          Attempt {att.attempt}: <strong>{att.status}</strong> ({att.duration_ms}ms)
                          {att.error_message ? `: ${att.error_message}` : ""}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <div className="actions" style={{ marginTop: "6px" }}>
                  {Boolean(result.screenshot_path) && <RunFileButton runId={id} resultId={String(result.id)} file="screenshot.png" label="Screenshot" />}
                  {Boolean(result.trace_path) && <RunFileButton runId={id} resultId={String(result.id)} file="trace.zip" label="Trace ZIP" />}
                  <RunFileButton runId={id} resultId={String(result.id)} file="evidence.json" label="Evidence JSON" />
                </div>
                {Boolean(result.device_info) && (
                  <div style={{ fontSize: "0.82rem", color: "#475569", margin: "4px 0" }}>
                    📱 <strong>Device:</strong> {String((result.device_info as any)?.deviceName || (result.device_info as any)?.udid || "Android")} ({(result.device_info as any)?.platform || "Android"} {(result.device_info as any)?.osVersion || ""})
                  </div>
                )}
                {Boolean(result.evidence) && <EvidenceDetails evidence={result.evidence as EvidenceSummary} />}
              </div>
            </article>
          );
        })}
        {infrastructureResults.length > 0 && <>
          <h2>Infrastructure failures (inconclusive)</h2>
          {infrastructureResults.map((result, index) => <article className="row-card" key={String(result.id ?? index)}>
            <div><strong>{String(result.test_case_title ?? result.title ?? result.test_case_id ?? "Test case")}</strong>
              <p>Status: inconclusive</p>
              {Boolean(result.error_message) && <p className="error">{String(result.error_message)}</p>}
              {Boolean(result.screenshot_path) && <RunFileButton runId={id} resultId={String(result.id)} file="screenshot.png" label="Screenshot" />}
              {Boolean(result.trace_path) && <RunFileButton runId={id} resultId={String(result.id)} file="trace.zip" label="Trace ZIP" />}
              <RunFileButton runId={id} resultId={String(result.id)} file="evidence.json" label="Evidence JSON" />
              {Boolean(result.evidence) && <EvidenceDetails evidence={result.evidence as EvidenceSummary} />}
            </div>
          </article>)}
        </>}
        {results.length === 0 && <p className="notice">No results recorded.</p>}
      </State>
    </section>
  );
}

function EvidenceDetails({ evidence }: { evidence: EvidenceSummary }) {
  const [showLogs, setShowLogs] = useState(false);

  return (
    <div className="evidence-details">
      {(evidence.browserErrors?.length ?? 0) > 0 && (
        <>
          <strong>Browser errors</strong>
          <ul>
            {evidence.browserErrors?.map((message, index) => (
              <li key={index}>{message}</li>
            ))}
          </ul>
        </>
      )}
      {(evidence.failedRequests?.length ?? 0) > 0 && (
        <>
          <strong>Failed network requests</strong>
          <ul>
            {evidence.failedRequests?.map((request, index) => (
              <li key={index}>
                {request.method} {request.url}: {request.failure}
              </li>
            ))}
          </ul>
        </>
      )}
      {(evidence.httpErrors?.length ?? 0) > 0 && (
        <>
          <strong>HTTP errors</strong>
          <ul>
            {evidence.httpErrors?.map((response, index) => (
              <li key={index}>
                {response.method} {response.url}: HTTP {response.status}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Mobile Execution Details */}
      {evidence.platform && (
        <div style={{ marginTop: "6px", fontSize: "0.85rem" }}>
          <div>
            📱 <strong>Mobile Target:</strong> {evidence.platform.toUpperCase()}
            {evidence.deviceUdid ? ` (${evidence.deviceUdid})` : ""}
            {evidence.appPackage ? ` · App: ${evidence.appPackage}` : ""}
            {evidence.appActivity ? ` · Activity: ${evidence.appActivity}` : ""}
          </div>
          {evidence.crashEvidence?.crashed && (
            <div
              style={{
                marginTop: "6px",
                padding: "8px 12px",
                background: "#fef2f2",
                border: "1px solid #f87171",
                borderRadius: "4px",
                color: "#991b1b",
              }}
            >
              🚨 <strong>Application Crash Detected:</strong> {evidence.crashEvidence.reason || "Process termination / ANR"}
              {evidence.crashEvidence.details && (
                <pre style={{ margin: "4px 0 0", fontSize: "0.75rem", whiteSpace: "pre-wrap" }}>
                  {evidence.crashEvidence.details}
                </pre>
              )}
            </div>
          )}
          {evidence.failureStep && (
            <div style={{ marginTop: "4px", color: "#b91c1c" }}>
              ⚠️ <strong>Failed at step:</strong> <code>{evidence.failureStep}</code>
            </div>
          )}
          {evidence.deviceLogs && evidence.deviceLogs.length > 0 && (
            <div style={{ marginTop: "8px" }}>
              <button
                type="button"
                className="secondary"
                style={{ fontSize: "0.75rem", padding: "2px 8px" }}
                onClick={() => setShowLogs(!showLogs)}
              >
                {showLogs ? "Hide Logcat Logs" : `View Logcat Logs (${evidence.deviceLogs.length} lines)`}
              </button>
              {showLogs && (
                <pre
                  style={{
                    maxHeight: "220px",
                    overflowY: "auto",
                    background: "#1e293b",
                    color: "#f8fafc",
                    padding: "8px",
                    borderRadius: "4px",
                    fontSize: "0.72rem",
                    marginTop: "6px",
                  }}
                >
                  {evidence.deviceLogs.slice(-150).join("\n")}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunFileButton({
  runId,
  resultId,
  file,
  label,
}: {
  runId: string;
  resultId?: string;
  file: "report" | "report.json" | "screenshot.png" | "trace.zip" | "evidence.json";
  label: string;
}) {
  const [error, setError] = useState("");
  async function openFile() {
    setError("");
    try {
      const route = resultId
        ? `/runs/${encodeURIComponent(runId)}/evidence/${encodeURIComponent(resultId)}/${encodeURIComponent(file)}`
        : `/runs/${encodeURIComponent(runId)}/${file}`;
      const response = await fetch(`${apiBase}${route}`, { credentials: "include" });
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
      {(data ?? []).length === 0 ? (
        <div className="empty-state">
          <h2>No bug reports yet</h2>
          <p>Bug reports are created from failed web-test results after failure analysis. Passing tests do not create reports.</p>
          <ol>
            <li>Open a project and run its approved test cases.</li>
            <li>When a web test fails, open that run and select <strong>Analyze failures</strong>.</li>
            <li>Review the generated report here, then confirm or dismiss it.</li>
          </ol>
          <Link className="button-link" to="/projects">Open projects</Link>
        </div>
      ) : (data ?? []).map((report) => <article className="row-card" key={report.id}>
          <div><strong>{report.title}</strong><p>{report.classification} · {report.severity}</p><p>{report.probable_cause}</p><span className={`badge ${report.status}`}>{report.status}</span></div>
          <div className="actions"><button onClick={() => setStatus(report.id, "confirmed")}>Confirm</button><button className="secondary" onClick={() => setStatus(report.id, "dismissed")}>Dismiss</button></div>
        </article>)}
    </State>
  </section>;
}

function AppContent() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: "100vh" }}>
        <p className="muted">Loading secure session…</p>
      </div>
    );
  }

  if (!user) {
    return <LoginPage />;
  }

  return <Layout />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppContent />
      </AuthProvider>
    </BrowserRouter>
  );
}
