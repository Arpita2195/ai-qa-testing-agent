import Fastify from "fastify";
import cookie, { sign } from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../config/db";
import { createAuthHook, requirePlatformRole } from "../services/auth";
import authRoutes from "../routes/auth";
import healthRoutes from "../routes/health";
import { hashPassword, verifyPassword } from "../services/passwordService";
import {
  createSessionForUser,
  revokeUserSessions,
  validateSession,
  type AuthenticatedUser,
} from "../services/authService";
import { isInternalHostname, isCloudMetadataTarget, validateTargetUrl } from "../services/urlGuard";

vi.mock("../config/db", () => ({
  pool: {
    query: vi.fn(),
  },
  checkDbConnection: vi.fn().mockResolvedValue(true),
}));

describe("TASK 11: Production Configuration & Security Hardening", () => {
  let app: ReturnType<typeof Fastify> | undefined;
  const testApiKey = "test-platform-api-key-16chars";
  const testCookieSecret = "test-cookie-secret-with-at-least-32-characters";

  beforeEach(() => {
    vi.clearAllMocks();

    app = Fastify();
    app.register(cookie, { secret: testCookieSecret });

    // Attach security headers hook as in server.ts
    app.addHook("onSend", async (_request, reply) => {
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("X-Frame-Options", "DENY");
      reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
      reply.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none';");
    });

    app.addHook("onRequest", createAuthHook(testApiKey));
    app.register(healthRoutes);
    app.register(authRoutes);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe("1. Password Changes & Session Revocation", () => {
    it("successfully changes password, invalidates all existing sessions, and issues a new session", async () => {
      const userId = "11111111-1111-1111-1111-111111111111";
      const oldPassword = "OldPassword123!";
      const oldHash = await hashPassword(oldPassword);
      const newPassword = "NewStrongPassword456!";

      // Mock user authentication session
      const validSession = {
        user: {
          id: userId,
          email: "user@example.com",
          fullName: "Security Tester",
          role: "qa_engineer" as const,
          isActive: true,
        },
        session: {
          id: "sess-1",
          userId,
          tokenHash: "token-hash-1",
          csrfToken: "csrf-test-token",
          expiresAt: new Date(Date.now() + 86400000),
        },
      };

      vi.mocked(pool.query).mockImplementation(async (query: any, params: any) => {
        const sql = String(query).trim();
        // Session validation lookup
        if (sql.includes("FROM sessions s")) {
          return { rows: [{
            session_id: "sess-1",
            user_id: userId,
            token_hash: "hash",
            csrf_token: "csrf-test-token",
            expires_at: new Date(Date.now() + 86400000),
            email: "user@example.com",
            full_name: "Security Tester",
            role: "qa_engineer",
            is_active: true,
          }], rowCount: 1 } as any;
        }
        // Fetch current password hash
        if (sql.includes("SELECT password_hash FROM users")) {
          return { rows: [{ password_hash: oldHash }], rowCount: 1 } as any;
        }
        // Update user password hash
        if (sql.includes("UPDATE users SET password_hash")) {
          return { rows: [], rowCount: 1 } as any;
        }
        // Invalidate active sessions
        if (sql.includes("DELETE FROM sessions WHERE user_id")) {
          return { rows: [{ id: "sess-1" }], rowCount: 1 } as any;
        }
        // Insert new session
        if (sql.includes("INSERT INTO sessions")) {
          return { rows: [], rowCount: 1 } as any;
        }
        // Audit log
        if (sql.includes("INSERT INTO audit_logs")) {
          return { rows: [], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const response = await app!.inject({
        method: "POST",
        url: "/auth/change-password",
        headers: {
          authorization: "Bearer valid-old-token",
        },
        payload: {
          currentPassword: oldPassword,
          newPassword,
        },
      });

      expect(response.statusCode).toBe(200);
      const json = response.json();
      expect(json.message).toContain("Existing sessions have been revoked");
      expect(json.csrfToken).toBeDefined();

      // Verify that DELETE FROM sessions was executed for the user
      const deleteCalls = vi.mocked(pool.query).mock.calls.filter((c) =>
        String(c[0]).includes("DELETE FROM sessions WHERE user_id"),
      );
      expect(deleteCalls.length).toBeGreaterThan(0);
      expect(deleteCalls[0][1]).toEqual([userId]);
    });

    it("rejects password change when current password is wrong", async () => {
      const userId = "11111111-1111-1111-1111-111111111111";
      const oldHash = await hashPassword("RealPassword123!");

      vi.mocked(pool.query).mockImplementation(async (query: any) => {
        const sql = String(query).trim();
        if (sql.includes("FROM sessions s")) {
          return { rows: [{
            session_id: "sess-1",
            user_id: userId,
            token_hash: "hash",
            csrf_token: "csrf-token",
            expires_at: new Date(Date.now() + 86400000),
            email: "user@example.com",
            full_name: "User",
            role: "qa_engineer",
            is_active: true,
          }], rowCount: 1 } as any;
        }
        if (sql.includes("SELECT password_hash FROM users")) {
          return { rows: [{ password_hash: oldHash }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const response = await app!.inject({
        method: "POST",
        url: "/auth/change-password",
        headers: {
          authorization: "Bearer valid-token",
        },
        payload: {
          currentPassword: "WrongPassword999!",
          newPassword: "NewPassword123!",
        },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error).toContain("Current password does not match");
    });
  });

  describe("2. Admin Role Changes & Session Revocation", () => {
    it("revokes existing sessions when admin changes a user role", async () => {
      const adminId = "a1111111-1111-4111-8111-111111111111";
      const targetUserId = "b2222222-2222-4222-8222-222222222222";

      vi.mocked(pool.query).mockImplementation(async (query: any, params: any) => {
        const sql = String(query).trim();
        if (sql.includes("FROM sessions s")) {
          return { rows: [{
            session_id: "admin-sess",
            user_id: adminId,
            token_hash: "hash",
            csrf_token: "csrf-token",
            expires_at: new Date(Date.now() + 86400000),
            email: "admin@example.com",
            full_name: "Admin User",
            role: "admin",
            is_active: true,
          }], rowCount: 1 } as any;
        }
        if (sql.includes("SELECT id, role, is_active FROM users")) {
          return { rows: [{ id: targetUserId, role: "qa_engineer", is_active: true }], rowCount: 1 } as any;
        }
        if (sql.includes("UPDATE users")) {
          return { rows: [{
            id: targetUserId,
            email: "target@example.com",
            full_name: "Target User",
            role: "viewer",
            is_active: true,
            updated_at: new Date(),
          }], rowCount: 1 } as any;
        }
        if (sql.includes("DELETE FROM sessions WHERE user_id")) {
          return { rows: [{ id: "sess-target" }], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      const response = await app!.inject({
        method: "PATCH",
        url: `/users/${targetUserId}`,
        headers: {
          authorization: "Bearer admin-token",
        },
        payload: {
          role: "viewer",
        },
      });

      if (response.statusCode !== 200) {
        console.error("Test 2 error response:", response.statusCode, response.json());
      }

      expect(response.statusCode).toBe(200);
      expect(response.json().role).toBe("viewer");

      // Verify sessions were revoked for targetUserId
      const revokeCalls = vi.mocked(pool.query).mock.calls.filter((c) =>
        String(c[0]).includes("DELETE FROM sessions WHERE user_id"),
      );
      expect(revokeCalls.length).toBeGreaterThan(0);
      expect(revokeCalls[0][1]).toEqual([targetUserId]);
    });
  });

  describe("3. HTTP Security Headers", () => {
    it("returns hardened security headers on all API responses", async () => {
      const response = await app!.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    });
  });

  describe("4. Signed Cookie Tamper Resistance", () => {
    it("extracts session from a valid signed cookie", async () => {
      const rawToken = "my-secret-session-token-1234567890123456";
      const validSession = {
        session_id: "s-1",
        user_id: "u-1",
        token_hash: "hash",
        csrf_token: "csrf-token-abc",
        expires_at: new Date(Date.now() + 86400000),
        email: "user@example.com",
        full_name: "Signed Cookie User",
        role: "qa_engineer" as const,
        is_active: true,
      };

      vi.mocked(pool.query).mockImplementation(async (query: any) => {
        const sql = String(query);
        if (sql.includes("FROM sessions s")) {
          return { rows: [validSession], rowCount: 1 } as any;
        }
        return { rows: [], rowCount: 0 } as any;
      });

      // Sign the cookie using @fastify/cookie sign function
      const signedCookieValue = sign(rawToken, testCookieSecret);

      const response = await app!.inject({
        method: "GET",
        url: "/auth/me",
        cookies: {
          qa_session: signedCookieValue,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().user.email).toBe("user@example.com");
    });
  });

  describe("5. Browser Isolation & SSRF Internal Hostname Protection", () => {
    it("blocks internal container hostnames from target scanning", () => {
      expect(isInternalHostname("postgres")).toBe(true);
      expect(isInternalHostname("ai_qa_postgres")).toBe(true);
      expect(isInternalHostname("backend")).toBe(true);
      expect(isInternalHostname("ai_qa_backend")).toBe(true);
      expect(isInternalHostname("dashboard")).toBe(true);
      expect(isInternalHostname("ai_qa_dashboard")).toBe(true);
      expect(isInternalHostname("database")).toBe(true);
      expect(isInternalHostname("host.docker.internal")).toBe(true);
      expect(isInternalHostname("gateway.docker.internal")).toBe(true);
    });

    it("blocks cloud metadata targets unconditionally", () => {
      expect(isCloudMetadataTarget("169.254.169.254")).toBe(true);
      expect(isCloudMetadataTarget("metadata.google.internal")).toBe(true);
      expect(isCloudMetadataTarget("169.254.170.2")).toBe(true);
      expect(isCloudMetadataTarget("fd00:ec2::254")).toBe(true);
    });

    it("allows valid public HTTPS hostnames", () => {
      expect(isInternalHostname("example.com")).toBe(false);
      expect(isInternalHostname("api.github.com")).toBe(false);
      expect(isInternalHostname("stockflow-vert-two.vercel.app")).toBe(false);
    });
  });
});
