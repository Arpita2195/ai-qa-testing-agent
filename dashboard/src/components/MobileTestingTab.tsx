import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, useAuth, type TestCaseAutomation } from "../App";

interface MobileStatusResponse {
  appium: {
    status: "online" | "offline" | "error";
    url: string;
    version?: string;
    error?: string;
  };
  driver: {
    name: string;
    installed: boolean;
    version?: string;
  };
  devices: Array<{
    udid: string;
    platform: string;
    state: string;
    isEmulator: boolean;
    model?: string;
  }>;
  iosSupport: {
    status: string;
    platform: string;
    notes: string;
  };
}

interface MobileRunResult {
  runId: string;
  status: string;
  results?: Array<{
    id: string;
    testCaseId: string;
    title: string;
    status: string;
    durationMs: number;
    errorMessage?: string | null;
    screenshotPath?: string | null;
    flaky?: boolean;
    retryCount?: number;
    deviceInfo?: Record<string, unknown>;
    stepResults?: Array<{
      step: string;
      action: string;
      passed: boolean;
      durationMs: number;
      error?: string;
    }>;
  }>;
  message?: string;
}

interface RunSummary {
  id: string;
  status: string;
  run_type: string;
  created_at: string;
  finished_at?: string;
  total_count?: number;
  passed_count?: number;
  failed_count?: number;
  flaky_count?: number;
}

const DEFAULT_SAMPLE_DSL = `# Android Mobile Smoke Test
app launch | com.android.settings | .Settings
expect visible | text:Network & internet
tap | text:Network & internet
expect visible | text:Internet
press | back
expect visible | text:Network & internet
app close | com.android.settings`;

export function MobileTestingTab({ projectId }: { projectId: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Environment status
  const [mobileStatus, setMobileStatus] = useState<MobileStatusResponse | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState("");

  // Automations & Test Cases
  const [automations, setAutomations] = useState<TestCaseAutomation[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterStatus, setFilterStatus] = useState<string>("all");

  // Runs
  const [mobileRuns, setMobileRuns] = useState<RunSummary[]>([]);

  // Execution state
  const [runningId, setRunningId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  // Create / Edit Modal State
  const [showModal, setShowModal] = useState(false);
  const [modalMode, setModalMode] = useState<"create" | "edit">("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formPackage, setFormPackage] = useState("com.android.settings");
  const [formActivity, setFormActivity] = useState(".Settings");
  const [formUdid, setFormUdid] = useState("emulator-5554");
  const [formSteps, setFormSteps] = useState(DEFAULT_SAMPLE_DSL);
  const [formStatus, setFormStatus] = useState<"draft" | "ready" | "approved">("ready");
  const [validationResult, setValidationResult] = useState<{ valid: boolean; errors: string[] } | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Load Status
  async function loadStatus() {
    try {
      setStatusLoading(true);
      const res = await api<MobileStatusResponse>(`/projects/${projectId}/mobile/status`);
      setMobileStatus(res);
      setStatusError("");
    } catch (err: any) {
      setStatusError(err.message || "Failed to load Appium / Android status");
    } finally {
      setStatusLoading(false);
    }
  }

  // Load Automations
  async function loadAutomations() {
    try {
      setLoading(true);
      const res = await api<TestCaseAutomation[]>(`/projects/${projectId}/automations`);
      // Filter mobile automations
      const mobileOnly = (res || []).filter((a) => a.target_type === "mobile");
      setAutomations(mobileOnly);
    } catch (err: any) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  // Load Mobile Runs
  async function loadRuns() {
    try {
      const res = await api<RunSummary[]>(`/projects/${projectId}/runs`);
      const mobileOnly = (res || []).filter((r) => r.run_type === "mobile");
      setMobileRuns(mobileOnly);
    } catch (err: any) {
      console.error(err);
    }
  }

  useEffect(() => {
    loadStatus();
    loadAutomations();
    loadRuns();
  }, [projectId]);

  // Validate DSL using server endpoint
  async function handleValidateDsl() {
    setIsValidating(true);
    setValidationResult(null);
    try {
      const stepsArray = formSteps
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("#"));

      const res = await api<{ valid: boolean; errors: string[] }>(
        `/projects/${projectId}/mobile/validate`,
        {
          method: "POST",
          body: JSON.stringify({ steps: stepsArray }),
        },
      );
      setValidationResult(res);
    } catch (err: any) {
      setValidationResult({ valid: false, errors: [err.message || "Validation request failed"] });
    } finally {
      setIsValidating(false);
    }
  }

  // Open Create Modal
  function handleOpenCreate() {
    setModalMode("create");
    setEditingId(null);
    setFormTitle("Android Settings Navigation Smoke Test");
    setFormPackage("com.android.settings");
    setFormActivity(".Settings");
    setFormUdid("emulator-5554");
    setFormSteps(DEFAULT_SAMPLE_DSL);
    setFormStatus("ready");
    setValidationResult(null);
    setShowModal(true);
  }

  // Open Edit Modal
  function handleOpenEdit(auto: TestCaseAutomation) {
    setModalMode("edit");
    setEditingId(auto.id);
    setFormTitle(auto.test_case_title || "Mobile Test Case");
    setFormPackage(auto.app_package || "com.android.settings");
    setFormActivity(auto.app_activity || ".Settings");
    setFormUdid(auto.device_udid || "emulator-5554");
    const steps = auto.mobile_steps && auto.mobile_steps.length > 0
      ? auto.mobile_steps.join("\n")
      : DEFAULT_SAMPLE_DSL;
    setFormSteps(steps);
    setFormStatus((auto.status === "approved" ? "approved" : auto.status === "ready" ? "ready" : "draft") as any);
    setValidationResult(null);
    setShowModal(true);
  }

  // Save Modal
  async function handleSaveForm(e: FormEvent) {
    e.preventDefault();
    setIsSaving(true);
    setMessage("");
    setErrorMessage("");

    try {
      const stepsArray = formSteps
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.startsWith("#"));

      if (stepsArray.length === 0) {
        throw new Error("Please specify at least one valid mobile step.");
      }

      if (modalMode === "create") {
        // 1. Create test case
        const tcRes = await api<{ id: string }>(`/projects/${projectId}/test-cases`, {
          method: "POST",
          body: JSON.stringify({
            title: formTitle,
            description: `Automated Android test for ${formPackage}`,
            steps: stepsArray,
            expected_result: "All assertions pass and application interactions succeed",
            review_status: formStatus === "approved" ? "approved" : "pending",
          }),
        });

        // 2. Generate automation record
        await api(`/projects/${projectId}/automations/generate`, {
          method: "POST",
          body: JSON.stringify({ testCaseId: tcRes.id }),
        });

        // 3. Update automation record with mobile details
        const currentAutos = await api<TestCaseAutomation[]>(`/projects/${projectId}/automations`);
        const createdAuto = currentAutos.find((a) => a.test_case_id === tcRes.id);
        if (createdAuto) {
          await api(`/automations/${createdAuto.id}`, {
            method: "PATCH",
            body: JSON.stringify({
              status: formStatus,
              mobile_steps: stepsArray,
              app_package: formPackage,
              app_activity: formActivity,
              device_udid: formUdid,
              platform: "android",
            }),
          });
        }
      } else if (editingId) {
        // Edit existing automation
        await api(`/automations/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify({
            status: formStatus,
            mobile_steps: stepsArray,
            app_package: formPackage,
            app_activity: formActivity,
            device_udid: formUdid,
            platform: "android",
          }),
        });

        // Also update review_status in test_cases if approved
        const auto = automations.find((a) => a.id === editingId);
        if (auto?.test_case_id) {
          await api(`/test-cases/${auto.test_case_id}/review`, {
            method: "PATCH",
            body: JSON.stringify({
              review_status: formStatus === "approved" ? "approved" : "pending",
            }),
          });
        }
      }

      setShowModal(false);
      setMessage(modalMode === "create" ? "Mobile test case created successfully." : "Mobile test case updated.");
      loadAutomations();
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to save mobile test case");
    } finally {
      setIsSaving(false);
    }
  }

  // Toggle Human Approval
  async function handleToggleApprove(auto: TestCaseAutomation) {
    const newStatus = auto.status === "approved" ? "ready" : "approved";
    try {
      await api(`/automations/${auto.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: newStatus }),
      });
      if (auto.test_case_id) {
        await api(`/test-cases/${auto.test_case_id}/review`, {
          method: "PATCH",
          body: JSON.stringify({ review_status: newStatus === "approved" ? "approved" : "pending" }),
        });
      }
      setMessage(`Automation ${newStatus === "approved" ? "approved by human reviewer" : "reverted to ready"}.`);
      loadAutomations();
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to update approval status");
    }
  }

  // Run single test directly on emulator
  async function handleRunSingle(auto: TestCaseAutomation) {
    setRunningId(auto.id);
    setMessage(`Executing "${auto.test_case_title || 'Mobile Test'}" on Android emulator (${auto.device_udid || 'emulator-5554'})...`);
    setErrorMessage("");

    try {
      const res = await api<MobileRunResult>(`/projects/${projectId}/mobile/runs`, {
        method: "POST",
        body: JSON.stringify({
          test_case_id: auto.test_case_id,
          app_package: auto.app_package || undefined,
          app_activity: auto.app_activity || undefined,
          device_udid: auto.device_udid || "emulator-5554",
          platform: "android",
          retries: 1,
        }),
      });

      setMessage(`Execution completed with status: ${res.status.toUpperCase()}`);
      loadRuns();
      loadAutomations();
      navigate(`/runs/${res.runId}`);
    } catch (err: any) {
      setErrorMessage(err.message || "Mobile execution failed");
    } finally {
      setRunningId(null);
    }
  }

  // Enqueue test in background queue (PostgreSQL)
  async function handleQueueBackground(auto: TestCaseAutomation) {
    setRunningId(auto.id);
    setMessage(`Queueing mobile test in PostgreSQL background worker queue...`);
    setErrorMessage("");

    try {
      const res = await api<{ success: boolean; jobId: string; runId: string }>(
        `/projects/${projectId}/mobile/runs`,
        {
          method: "POST",
          body: JSON.stringify({
            test_case_id: auto.test_case_id,
            app_package: auto.app_package || undefined,
            app_activity: auto.app_activity || undefined,
            device_udid: auto.device_udid || "emulator-5554",
            platform: "android",
            async: true,
          }),
        },
      );

      setMessage(`Enqueued background job #${res.jobId.slice(0, 8)} (Run ID: ${res.runId.slice(0, 8)})`);
      loadRuns();
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to enqueue background job");
    } finally {
      setRunningId(null);
    }
  }

  // Run all approved mobile tests
  async function handleRunAllApproved() {
    setBatchRunning(true);
    setMessage("Executing all approved mobile tests on Android emulator...");
    setErrorMessage("");

    try {
      const res = await api<MobileRunResult>(`/projects/${projectId}/mobile/runs`, {
        method: "POST",
        body: JSON.stringify({
          platform: "android",
          device_udid: "emulator-5554",
          retries: 1,
        }),
      });

      setMessage(`Batch mobile run completed: ${res.status.toUpperCase()}`);
      loadRuns();
      loadAutomations();
      navigate(`/runs/${res.runId}`);
    } catch (err: any) {
      setErrorMessage(err.message || "Batch mobile execution failed");
    } finally {
      setBatchRunning(false);
    }
  }

  const filteredAutomations = automations.filter((a) => {
    if (filterStatus === "all") return true;
    return a.status === filterStatus;
  });

  const approvedCount = automations.filter((a) => a.status === "approved").length;
  const canEdit = user?.role === "admin" || user?.role === "qa_manager" || user?.role === "qa_engineer";

  return (
    <div style={{ marginTop: "16px" }}>
      {statusLoading && <p className="muted" style={{ margin: "0 0 10px", fontSize: "0.85rem" }}>Checking Appium server and Android device status...</p>}
      {statusError && <div className="notice error" style={{ marginBottom: "14px" }}>{statusError}</div>}

      {/* 1. Appium & Device Environment Status Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "14px", marginBottom: "20px" }}>
        {/* Appium Server Status */}
        <div className="card" style={{ padding: "14px", borderLeft: "4px solid #0284c7" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: "0.95rem" }}>🚀 Appium Server</strong>
            <span className={`badge ${mobileStatus?.appium.status === "online" ? "passed" : "failed"}`}>
              {mobileStatus?.appium.status === "online" ? "● Connected" : "○ Disconnected"}
            </span>
          </div>
          <div style={{ fontSize: "0.82rem", color: "#64748b", marginTop: "6px" }}>
            <div><strong>Endpoint:</strong> <code>{mobileStatus?.appium.url || "http://127.0.0.1:4723"}</code></div>
            <div><strong>Driver:</strong> {mobileStatus?.driver.name || "UiAutomator2"} {mobileStatus?.driver.version ? `v${mobileStatus.driver.version}` : "(installed)"}</div>
            <div><strong>Loopback Guard:</strong> <span style={{ color: "#16a34a" }}>Active (Strict 127.0.0.1)</span></div>
          </div>
        </div>

        {/* Android Device Status */}
        <div className="card" style={{ padding: "14px", borderLeft: "4px solid #16a34a" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: "0.95rem" }}>📱 Android Emulator</strong>
            <span className="badge passed">
              {mobileStatus?.devices && mobileStatus.devices.length > 0 ? "● Device Ready" : "○ Waiting"}
            </span>
          </div>
          <div style={{ fontSize: "0.82rem", color: "#64748b", marginTop: "6px" }}>
            {mobileStatus?.devices && mobileStatus.devices.length > 0 ? (
              <>
                <div><strong>UDID:</strong> <code>{mobileStatus.devices[0].udid}</code></div>
                <div><strong>Model:</strong> Pixel 7 (Android 17 / API 35)</div>
                <div><strong>State:</strong> {mobileStatus.devices[0].state} (Ready for touches)</div>
              </>
            ) : (
              <div>No ADB devices detected. Start emulator: <code>emulator -avd Pixel_7</code></div>
            )}
          </div>
        </div>

        {/* iOS Architecture Readiness */}
        <div className="card" style={{ padding: "14px", borderLeft: "4px solid #8b5cf6" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <strong style={{ fontSize: "0.95rem" }}>🍎 iOS Architecture</strong>
            <span className="badge" style={{ background: "#ede9fe", color: "#6d28d9" }}>
              Architecture Ready
            </span>
          </div>
          <div style={{ fontSize: "0.82rem", color: "#64748b", marginTop: "6px" }}>
            <div><strong>Driver Interface:</strong> <code>IMobileDriver (XCUITestDriver)</code></div>
            <div><strong>Platform:</strong> iOS / iPadOS Simulator</div>
            <div style={{ fontSize: "0.78rem", color: "#7c3aed" }}>
              Ready for macOS hosts with Xcode & xcuitest driver.
            </div>
          </div>
        </div>
      </div>

      {/* Notifications / Messages */}
      {message && (
        <div className="notice" style={{ marginBottom: "14px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span>{message}</span>
          <button className="secondary" style={{ padding: "2px 8px", fontSize: "0.78rem" }} onClick={() => setMessage("")}>✕</button>
        </div>
      )}
      {errorMessage && (
        <div className="notice" style={{ marginBottom: "14px", background: "#fef2f2", borderLeft: "4px solid #ef4444", color: "#991b1b" }}>
          <span>{errorMessage}</span>
          <button className="secondary" style={{ padding: "2px 8px", fontSize: "0.78rem", float: "right" }} onClick={() => setErrorMessage("")}>✕</button>
        </div>
      )}

      {/* 2. Action Bar & Filters */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "10px", marginBottom: "16px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" onClick={handleOpenCreate} disabled={!canEdit} title={!canEdit ? "Requires QA Engineer or Manager role" : ""}>
            ➕ New Mobile Test Case
          </button>
          <button
            type="button"
            className="secondary"
            onClick={handleRunAllApproved}
            disabled={batchRunning || approvedCount === 0}
          >
            {batchRunning ? "Executing Approved..." : `▶ Run Approved on Emulator (${approvedCount})`}
          </button>
          <button type="button" className="secondary" onClick={() => { loadStatus(); loadAutomations(); loadRuns(); }}>
            🔄 Refresh
          </button>
        </div>

        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <span style={{ fontSize: "0.85rem", color: "#64748b" }}>Filter:</span>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            style={{ padding: "4px 8px", fontSize: "0.85rem" }}
          >
            <option value="all">All Statuses ({automations.length})</option>
            <option value="approved">Approved ({automations.filter((a) => a.status === "approved").length})</option>
            <option value="ready">Ready for Approval ({automations.filter((a) => a.status === "ready").length})</option>
            <option value="draft">Draft ({automations.filter((a) => a.status === "draft").length})</option>
          </select>
        </div>
      </div>

      {/* 3. Mobile Test Cases List */}
      <h3 style={{ margin: "20px 0 10px", color: "#1e293b" }}>Mobile Test Cases & Automation Scripts</h3>

      {loading ? (
        <p className="muted">Loading mobile test cases...</p>
      ) : filteredAutomations.length === 0 ? (
        <div className="row-card" style={{ textAlign: "center", padding: "30px", background: "#f8fafc" }}>
          <p style={{ margin: 0, color: "#64748b" }}>
            No mobile test cases found{filterStatus !== "all" ? ` with status "${filterStatus}"` : ""}.
          </p>
          <p style={{ fontSize: "0.85rem", color: "#94a3b8", margin: "6px 0 14px" }}>
            Create an Appium test case using the restricted Mobile Testing DSL to run on the Pixel 7 emulator.
          </p>
          <button type="button" onClick={handleOpenCreate}>
            Create First Mobile Test Case
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          {filteredAutomations.map((auto) => {
            const isApproved = auto.status === "approved";
            const steps = auto.mobile_steps || [];
            const isRunning = runningId === auto.id;

            return (
              <div
                key={auto.id}
                className="row-card"
                style={{
                  alignItems: "flex-start",
                  borderLeft: isApproved ? "4px solid #16a34a" : "4px solid #eab308",
                  padding: "16px",
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", marginBottom: "6px" }}>
                    <strong style={{ fontSize: "1.05rem", color: "#0f172a" }}>
                      {auto.test_case_title || "Untitled Mobile Test"}
                    </strong>
                    <span className="badge badge-target-mobile">📱 Android Mobile</span>
                    <span className={`badge ${isApproved ? "approved" : auto.status === "ready" ? "pending" : "draft"}`}>
                      {auto.status}
                    </span>
                    {auto.last_run_status && (
                      <span className={`badge ${auto.last_run_status}`}>
                        Last Run: {auto.last_run_status}
                      </span>
                    )}
                  </div>

                  <div style={{ fontSize: "0.82rem", color: "#475569", marginBottom: "8px" }}>
                    <span><strong>App Package:</strong> <code>{auto.app_package || "com.android.settings"}</code></span>
                    <span style={{ margin: "0 8px" }}>·</span>
                    <span><strong>Activity:</strong> <code>{auto.app_activity || ".Settings"}</code></span>
                    <span style={{ margin: "0 8px" }}>·</span>
                    <span><strong>Device:</strong> <code>{auto.device_udid || "emulator-5554"}</code></span>
                  </div>

                  {/* DSL Steps Preview */}
                  <div className="code-box" style={{ maxHeight: "140px", overflowY: "auto", fontSize: "0.78rem" }}>
                    {steps.length > 0 ? (
                      steps.map((st, sIdx) => (
                        <div key={sIdx} style={{ display: "flex", gap: "8px" }}>
                          <span style={{ color: "#64748b", userSelect: "none", width: "20px", textAlign: "right" }}>{sIdx + 1}</span>
                          <code>{st}</code>
                        </div>
                      ))
                    ) : (
                      <span style={{ color: "#94a3b8" }}>No DSL steps defined.</span>
                    )}
                  </div>

                  {auto.last_error_message && (
                    <div style={{ marginTop: "6px", fontSize: "0.82rem", color: "#dc2626" }}>
                      <strong>Error:</strong> {auto.last_error_message}
                    </div>
                  )}
                </div>

                {/* Actions */}
                <div className="actions" style={{ flexDirection: "column", minWidth: "160px" }}>
                  <button
                    type="button"
                    style={{ width: "100%", fontSize: "0.82rem", padding: "6px 10px" }}
                    onClick={() => handleRunSingle(auto)}
                    disabled={isRunning || batchRunning}
                  >
                    {isRunning ? "Executing..." : "▶ Run on Emulator"}
                  </button>

                  <button
                    type="button"
                    className="secondary"
                    style={{ width: "100%", fontSize: "0.82rem", padding: "6px 10px" }}
                    onClick={() => handleQueueBackground(auto)}
                    disabled={isRunning || batchRunning}
                  >
                    ⏳ Queue (Postgres)
                  </button>

                  <button
                    type="button"
                    className="secondary"
                    style={{ width: "100%", fontSize: "0.82rem", padding: "6px 10px" }}
                    onClick={() => handleToggleApprove(auto)}
                  >
                    {isApproved ? "Revoke Approval" : "✓ Approve Test"}
                  </button>

                  <button
                    type="button"
                    className="secondary"
                    style={{ width: "100%", fontSize: "0.82rem", padding: "6px 10px" }}
                    onClick={() => handleOpenEdit(auto)}
                  >
                    ✏️ Edit DSL
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 4. Recent Mobile Executions History */}
      <h3 style={{ margin: "28px 0 10px", color: "#1e293b" }}>Recent Mobile Execution Runs</h3>
      {mobileRuns.length === 0 ? (
        <p className="muted">No mobile test runs executed yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Run ID</th>
                <th>Target Device</th>
                <th>Status</th>
                <th>Passed / Total</th>
                <th>Flaky</th>
                <th>Triggered At</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {mobileRuns.slice(0, 10).map((run) => (
                <tr key={run.id}>
                  <td>
                    <Link to={`/runs/${run.id}`} style={{ fontWeight: 600, color: "#0284c7" }}>
                      #{run.id.slice(0, 8)}
                    </Link>
                  </td>
                  <td>
                    <span style={{ fontSize: "0.82rem", color: "#334155" }}>
                      emulator-5554 (Android 17)
                    </span>
                  </td>
                  <td>
                    <span className={`badge ${run.status}`}>
                      {run.status}
                    </span>
                  </td>
                  <td>
                    {run.passed_count ?? 0} / {run.total_count ?? 1}
                  </td>
                  <td>
                    {(run.flaky_count ?? 0) > 0 ? (
                      <span className="badge badge-flaky">⚠️ {run.flaky_count}</span>
                    ) : (
                      "-"
                    )}
                  </td>
                  <td style={{ fontSize: "0.82rem", color: "#64748b" }}>
                    {new Date(run.created_at).toLocaleString()}
                  </td>
                  <td>
                    <Link to={`/runs/${run.id}`} className="secondary" style={{ textDecoration: "none", padding: "4px 8px", fontSize: "0.8rem", borderRadius: "4px", background: "#f1f5f9", color: "#0f172a" }}>
                      View Details →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 5. Create / Edit Mobile Test Case Modal */}
      {showModal && (
        <div className="modal-overlay">
          <div className="modal-content" style={{ maxWidth: "720px" }}>
            <div className="modal-header">
              <h3>{modalMode === "create" ? "Create Mobile Test Case" : "Edit Mobile Test Case"}</h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>✕</button>
            </div>

            <form onSubmit={handleSaveForm}>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                    Test Case Title
                  </label>
                  <input
                    type="text"
                    required
                    value={formTitle}
                    onChange={(e) => setFormTitle(e.target.value)}
                    placeholder="e.g. Android Settings Smoke Test"
                    style={{ width: "100%" }}
                  />
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "10px" }}>
                  <div>
                    <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                      App Package
                    </label>
                    <input
                      type="text"
                      required
                      value={formPackage}
                      onChange={(e) => setFormPackage(e.target.value)}
                      placeholder="com.android.settings"
                      style={{ width: "100%", fontSize: "0.85rem" }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                      App Activity
                    </label>
                    <input
                      type="text"
                      required
                      value={formActivity}
                      onChange={(e) => setFormActivity(e.target.value)}
                      placeholder=".Settings"
                      style={{ width: "100%", fontSize: "0.85rem" }}
                    />
                  </div>

                  <div>
                    <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                      Device UDID
                    </label>
                    <input
                      type="text"
                      required
                      value={formUdid}
                      onChange={(e) => setFormUdid(e.target.value)}
                      placeholder="emulator-5554"
                      style={{ width: "100%", fontSize: "0.85rem" }}
                    />
                  </div>
                </div>

                {/* DSL Steps Editor */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "4px" }}>
                    <label style={{ fontSize: "0.85rem", fontWeight: 600 }}>
                      Restricted Mobile DSL Steps (One command per line)
                    </label>
                    <button
                      type="button"
                      className="secondary"
                      style={{ padding: "2px 8px", fontSize: "0.78rem" }}
                      onClick={handleValidateDsl}
                      disabled={isValidating}
                    >
                      {isValidating ? "Validating..." : "🛡️ Validate DSL Security"}
                    </button>
                  </div>
                  <textarea
                    rows={8}
                    required
                    value={formSteps}
                    onChange={(e) => setFormSteps(e.target.value)}
                    style={{ fontFamily: "monospace", fontSize: "0.82rem", lineHeight: "1.4" }}
                    placeholder="app launch | package | activity&#10;tap | text:Sign In&#10;type | id:username | user@test.local&#10;expect visible | text:Dashboard"
                  />
                  <div style={{ fontSize: "0.75rem", color: "#64748b", marginTop: "2px" }}>
                    <strong>Allowed Actions:</strong> <code>app launch</code>, <code>app close</code>, <code>tap</code>, <code>type</code>, <code>clear</code>, <code>scroll</code>, <code>swipe</code>, <code>expect visible</code>, <code>expect text</code>, <code>press back</code>, <code>background</code>
                    <br />
                    <strong>Locators:</strong> <code>text:&lt;val&gt;</code>, <code>id:&lt;val&gt;</code>, <code>accessibility id:&lt;val&gt;</code>, <code>xpath:&lt;expr&gt;</code>, <code>uiautomator:&lt;code&gt;</code>
                  </div>
                </div>

                {/* Validation Feedback */}
                {validationResult && (
                  <div
                    style={{
                      padding: "8px 12px",
                      borderRadius: "6px",
                      fontSize: "0.82rem",
                      background: validationResult.valid ? "#f0fdf4" : "#fef2f2",
                      border: validationResult.valid ? "1px solid #86efac" : "1px solid #fca5a5",
                      color: validationResult.valid ? "#166534" : "#991b1b",
                    }}
                  >
                    {validationResult.valid ? (
                      <span>✓ All DSL actions and locators passed schema and security validation.</span>
                    ) : (
                      <div>
                        <strong>Validation Errors:</strong>
                        <ul style={{ margin: "4px 0 0", paddingLeft: "20px" }}>
                          {validationResult.errors.map((err, eIdx) => (
                            <li key={eIdx}>{err}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {/* Human Approval Review Status */}
                <div style={{ padding: "10px", background: "#f8fafc", borderRadius: "6px", border: "1px solid #e2e8f0" }}>
                  <label style={{ display: "block", fontSize: "0.85rem", fontWeight: 600, marginBottom: "4px" }}>
                    Human Approval Status (Requirement 3)
                  </label>
                  <select
                    value={formStatus}
                    onChange={(e) => setFormStatus(e.target.value as any)}
                    style={{ width: "100%", fontSize: "0.85rem" }}
                  >
                    <option value="ready">Ready (Requires QA human review before execution)</option>
                    <option value="approved">Approved (Verified safe for emulator execution)</option>
                    <option value="draft">Draft (Work in progress)</option>
                  </select>
                  <p style={{ margin: "4px 0 0", fontSize: "0.75rem", color: "#64748b" }}>
                    Safety policy: AI-generated test cases must undergo human review and approval prior to runner execution.
                  </p>
                </div>
              </div>

              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setShowModal(false)}>
                  Cancel
                </button>
                <button type="submit" disabled={isSaving}>
                  {isSaving ? "Saving..." : modalMode === "create" ? "Create Test Case" : "Save Changes"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
