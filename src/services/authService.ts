import crypto from "node:crypto";
import { pool } from "../config/db";
import { hashPassword, verifyPassword } from "./passwordService";
import { logAuditEvent } from "./auditLogger";

export type PlatformRole = "admin" | "qa_manager" | "qa_engineer" | "viewer";
export type ProjectRole = "qa_manager" | "qa_engineer" | "viewer";

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string;
  role: PlatformRole;
  isActive: boolean;
  isServiceAccount?: boolean;
}

export interface UserSession {
  id: string;
  userId: string;
  tokenHash: string;
  csrfToken: string;
  expiresAt: Date;
}

export class AuthenticationError extends Error {
  statusCode = 401;
  constructor(message = "Authentication required") {
    super(message);
    this.name = "AuthenticationError";
  }
}

export class AccessDeniedError extends Error {
  statusCode = 403;
  constructor(message = "Access denied") {
    super(message);
    this.name = "AccessDeniedError";
  }
}

// In-memory rate limiting for login attempts (protection against brute force)
interface RateLimitRecord {
  attempts: number;
  firstAttemptAt: number;
  blockedUntil?: number;
}
const loginRateLimitMap = new Map<string, RateLimitRecord>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const BLOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes block

export function checkLoginRateLimit(key: string): { allowed: boolean; retryAfterSeconds?: number } {
  const now = Date.now();
  const record = loginRateLimitMap.get(key);

  if (!record) return { allowed: true };

  if (record.blockedUntil && record.blockedUntil > now) {
    const retryAfter = Math.ceil((record.blockedUntil - now) / 1000);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  if (now - record.firstAttemptAt > WINDOW_MS) {
    loginRateLimitMap.delete(key);
    return { allowed: true };
  }

  if (record.attempts >= MAX_ATTEMPTS) {
    record.blockedUntil = now + BLOCK_DURATION_MS;
    const retryAfter = Math.ceil(BLOCK_DURATION_MS / 1000);
    return { allowed: false, retryAfterSeconds: retryAfter };
  }

  return { allowed: true };
}

export function recordFailedLogin(key: string): void {
  const now = Date.now();
  const record = loginRateLimitMap.get(key);
  if (!record || now - record.firstAttemptAt > WINDOW_MS) {
    loginRateLimitMap.set(key, { attempts: 1, firstAttemptAt: now });
  } else {
    record.attempts += 1;
    if (record.attempts >= MAX_ATTEMPTS) {
      record.blockedUntil = now + BLOCK_DURATION_MS;
    }
  }
}

export function resetLoginRateLimit(key: string): void {
  loginRateLimitMap.delete(key);
}

/**
 * Hash raw session token using SHA-256 for secure database storage.
 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Authenticates user credentials and generates a server-managed session.
 */
export async function authenticateCredentials(
  emailInput: string,
  passwordInput: string,
  ipAddress?: string,
): Promise<{
  user: AuthenticatedUser;
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}> {
  const email = emailInput.trim().toLowerCase();
  const rateLimitKey = `${ipAddress ?? "unknown"}:${email}`;
  const rateLimit = checkLoginRateLimit(rateLimitKey);

  if (!rateLimit.allowed) {
    await logAuditEvent({
      action: "LOGIN_RATE_LIMITED",
      outcome: "denied",
      details: { email, retryAfterSeconds: rateLimit.retryAfterSeconds },
      ipAddress,
    });
    throw new AccessDeniedError(
      `Too many failed login attempts. Please try again in ${rateLimit.retryAfterSeconds} seconds.`,
    );
  }

  const userQuery = await pool.query<{
    id: string;
    email: string;
    password_hash: string;
    full_name: string;
    role: PlatformRole;
    is_active: boolean;
  }>("SELECT id, email, password_hash, full_name, role, is_active FROM users WHERE email = $1", [
    email,
  ]);

  const userRow = userQuery.rows[0];
  if (!userRow || !userRow.is_active) {
    recordFailedLogin(rateLimitKey);
    await logAuditEvent({
      action: "LOGIN_FAILURE",
      outcome: "failure",
      details: { email, reason: "User not found or inactive" },
      ipAddress,
    });
    throw new AuthenticationError("Invalid email or password");
  }

  const isValidPassword = await verifyPassword(passwordInput, userRow.password_hash);
  if (!isValidPassword) {
    recordFailedLogin(rateLimitKey);
    await logAuditEvent({
      actorId: userRow.id,
      action: "LOGIN_FAILURE",
      outcome: "failure",
      details: { email, reason: "Password mismatch" },
      ipAddress,
    });
    throw new AuthenticationError("Invalid email or password");
  }

  resetLoginRateLimit(rateLimitKey);

  // Generate cryptographically secure tokens and persist session
  const { sessionToken, csrfToken, expiresAt } = await createSessionForUser(userRow.id);

  await logAuditEvent({
    actorId: userRow.id,
    action: "LOGIN_SUCCESS",
    outcome: "success",
    details: { email: userRow.email, role: userRow.role },
    ipAddress,
  });

  return {
    user: {
      id: userRow.id,
      email: userRow.email,
      fullName: userRow.full_name,
      role: userRow.role,
      isActive: userRow.is_active,
    },
    sessionToken,
    csrfToken,
    expiresAt,
  };
}

/**
 * Validates session token against the database and checks expiration.
 */
export async function validateSession(rawToken: string): Promise<{
  user: AuthenticatedUser;
  session: UserSession;
} | null> {
  if (!rawToken || typeof rawToken !== "string") return null;

  const tokenHash = hashToken(rawToken);
  const query = await pool.query<{
    session_id: string;
    user_id: string;
    token_hash: string;
    csrf_token: string;
    expires_at: Date;
    email: string;
    full_name: string;
    role: PlatformRole;
    is_active: boolean;
  }>(
    `SELECT
       s.id as session_id, s.user_id, s.token_hash, s.csrf_token, s.expires_at,
       u.email, u.full_name, u.role, u.is_active
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active = TRUE`,
    [tokenHash],
  );

  const row = query.rows[0];
  if (!row) return null;

  return {
    user: {
      id: row.user_id,
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      isActive: row.is_active,
    },
    session: {
      id: row.session_id,
      userId: row.user_id,
      tokenHash: row.token_hash,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
    },
  };
}

/**
 * Revokes a session on logout.
 */
export async function revokeSession(rawToken: string, actorId?: string): Promise<void> {
  if (!rawToken) return;
  const tokenHash = hashToken(rawToken);
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
  await logAuditEvent({
    actorId: actorId ?? null,
    action: "LOGOUT",
    outcome: "success",
  });
}

/**
 * Creates and persists a cryptographically secure session for a user.
 */
export async function createSessionForUser(userId: string): Promise<{
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
}> {
  const sessionToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(sessionToken);
  const csrfToken = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24-hour expiration

  await pool.query(
    `INSERT INTO sessions (user_id, token_hash, csrf_token, expires_at, created_at, last_active_at)
     VALUES ($1, $2, $3, $4, NOW(), NOW())`,
    [userId, tokenHash, csrfToken, expiresAt],
  );

  return { sessionToken, csrfToken, expiresAt };
}

/**
 * Revokes all active sessions for a specific user.
 * Triggered on password change, administrative role modification, or account deactivation.
 */
export async function revokeUserSessions(
  userId: string,
  reason = "CREDENTIAL_OR_ROLE_MODIFIED",
): Promise<number> {
  if (!userId) return 0;
  const result = await pool.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  await logAuditEvent({
    actorId: userId,
    action: "ALL_SESSIONS_REVOKED",
    outcome: "success",
    details: { reason, count: result.rowCount },
  });
  return result.rowCount ?? 0;
}

/**
 * Role hierarchy levels for comparison.
 */
const ROLE_HIERARCHY: Record<string, number> = {
  admin: 4,
  qa_manager: 3,
  qa_engineer: 2,
  viewer: 1,
};

/**
 * Asserts that the authenticated user has access to a specific project.
 * Admins have full access to all projects.
 * Other users must be an explicit member of the project.
 */
export async function assertProjectAccess(
  user: AuthenticatedUser,
  projectId: string,
  minRequiredRole: ProjectRole = "viewer",
): Promise<{ projectRole: ProjectRole }> {
  // Admins have automatic full project access
  if (user.role === "admin" || user.isServiceAccount) {
    return { projectRole: "qa_manager" };
  }

  const membershipQuery = await pool.query<{ role: ProjectRole }>(
    "SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2",
    [projectId, user.id],
  );

  const membership = membershipQuery.rows[0];
  if (!membership) {
    await logAuditEvent({
      actorId: user.id,
      action: "UNAUTHORIZED_PROJECT_ACCESS_ATTEMPT",
      projectId,
      outcome: "denied",
    });
    throw new AccessDeniedError("Access denied: You are not assigned to this project.");
  }

  const userLevel = ROLE_HIERARCHY[membership.role] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[minRequiredRole] ?? 0;

  if (userLevel < requiredLevel) {
    await logAuditEvent({
      actorId: user.id,
      action: "INSUFFICIENT_PROJECT_PERMISSIONS",
      projectId,
      outcome: "denied",
      details: { userRole: membership.role, requiredRole: minRequiredRole },
    });
    throw new AccessDeniedError(
      `Access denied: Action requires '${minRequiredRole}' role or higher on this project.`,
    );
  }

  return { projectRole: membership.role };
}
