import { pool } from "../config/db";

export interface AuditLogEntry {
  actorId?: string | null;
  action: string;
  projectId?: string | null;
  targetResource?: string | null;
  outcome?: "success" | "failure" | "denied";
  details?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

/**
 * Persists security audit events to the audit_logs table.
 * Strips any sensitive credentials before recording.
 */
export async function logAuditEvent(entry: AuditLogEntry): Promise<void> {
  try {
    // Sanitize details: strip password, token, or secret fields
    let sanitizedDetails = entry.details;
    if (sanitizedDetails) {
      const copy = { ...sanitizedDetails };
      for (const key of Object.keys(copy)) {
        if (/password|token|secret|api_?key/i.test(key)) {
          copy[key] = "[REDACTED]";
        }
      }
      sanitizedDetails = copy;
    }

    await pool.query(
      `INSERT INTO audit_logs (actor_id, action, project_id, target_resource, outcome, details, ip_address, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        entry.actorId ?? null,
        entry.action,
        entry.projectId ?? null,
        entry.targetResource ?? null,
        entry.outcome ?? "success",
        sanitizedDetails ? JSON.stringify(sanitizedDetails) : null,
        entry.ipAddress ?? null,
      ],
    );
  } catch (err) {
    console.error(
      "[auditLogger] Failed to persist audit log entry:",
      err instanceof Error ? err.message : String(err),
    );
  }
}
