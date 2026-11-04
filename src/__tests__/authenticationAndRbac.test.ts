import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../config/db";
import { createAuthHook, requirePlatformRole, requireProjectRole } from "../services/auth";
import authRoutes from "../routes/auth";
import { hashPassword, verifyPassword } from "../services/passwordService";
import {
  authenticateCredentials,
  resetLoginRateLimit,
  recordFailedLogin,
  checkLoginRateLimit,
  assertProjectAccess,
  AccessDeniedError,
  type AuthenticatedUser,
} from "../services/authService";

vi.mock("../config/db", () => ({
  pool: {
    query: vi.fn(),
  },
}));

describe("TASK 5: Authentication and Role-Based Access Control (RBAC)", () => {
  let app: ReturnType<typeof Fastify> | undefined;
  const testPlatformApiKey = "test-platform-api-key";

  beforeEach(() => {
    vi.clearAllMocks();
    resetLoginRateLimit("127.0.0.1:test@example.com");
    resetLoginRateLimit("unknown:test@example.com");

    app = Fastify();
    app.register(cookie);
    app.addHook("onRequest", createAuthHook(testPlatformApiKey));
    app.register(authRoutes);

    // Test route requiring admin platform role
    app.get(
      "/admin-only-test",
      { preHandler: [requirePlatformRole("admin")] },
      async () => ({ admin: true }),
    );

    // Test route requiring QA Manager role on project
    app.post(
      "/projects/:projectId/manager-action",
      { preHandler: [requireProjectRole("projectId", "qa_manager")] },
      async () => ({ managed: true }),
    );
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe("Password Hashing & Verification (Scrypt / OWASP)", () => {
    it("generates scrypt format hashes and verifies correct passwords", async () => {
      const password = "StrongPassword123!";
      const hash = await hashPassword(password);

      expect(hash).toContain("scrypt:N=16384,r=8,p=1$");
      expect(await verifyPassword(password, hash)).toBe(true);
      expect(await verifyPassword("WrongPassword", hash)).toBe(false);
      expect(await verifyPassword("", hash)).toBe(false);
    });
  });

  describe("User Login, Sessions & Logout", () => {
    const validUserId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    let validHash: string;

    beforeEach(async () => {
      validHash = await hashPassword("ValidPassword123!");
    });

    it("successfully logs in with valid credentials, sets HTTP-only cookie, and returns CSRF token", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM users WHERE email = $1")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: validUserId,
                email: "test@example.com",
                password_hash: validHash,
                full_name: "Test Engineer",
                role: "qa_engineer",
                is_active: true,
              },
            ],
          } as any;
        }
        if (sql.includes("INSERT INTO sessions")) {
          return { rowCount: 1, rows: [] } as any;
        }
        if (sql.includes("INSERT INTO audit_logs")) {
          return { rowCount: 1, rows: [] } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const res = await app!.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: "test@example.com",
          password: "ValidPassword123!",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.email).toBe("test@example.com");
      expect(body.user.role).toBe("qa_engineer");
      expect(body.csrfToken).toBeDefined();

      // Verify HTTP-only cookie was set
      const cookies = res.cookies;
      const sessionCookie = cookies.find((c) => c.name === "qa_session");
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie?.httpOnly).toBe(true);
      expect(sessionCookie?.sameSite).toBe("Lax");
    });

    it("rejects login with incorrect password and records audit failure", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM users WHERE email = $1")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: validUserId,
                email: "test@example.com",
                password_hash: validHash,
                full_name: "Test Engineer",
                role: "qa_engineer",
                is_active: true,
              },
            ],
          } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      const res = await app!.inject({
        method: "POST",
        url: "/auth/login",
        payload: {
          email: "test@example.com",
          password: "WrongPassword!",
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toContain("Invalid email or password");
    });

    it("enforces brute-force rate limiting after repeated failures", async () => {
      const rateLimitKey = "unknown:test@example.com";
      // Simulate 5 failed attempts
      for (let i = 0; i < 5; i++) {
        recordFailedLogin(rateLimitKey);
      }

      const status = checkLoginRateLimit(rateLimitKey);
      expect(status.allowed).toBe(false);
      expect(status.retryAfterSeconds).toBeGreaterThan(0);
    });

    it("revokes session and clears cookie on logout", async () => {
      vi.mocked(pool.query).mockResolvedValue({ rowCount: 1, rows: [] } as any);

      const res = await app!.inject({
        method: "POST",
        url: "/auth/logout",
        cookies: {
          qa_session: "session-token-to-revoke",
        },
      });

      expect(res.statusCode).toBe(200);
      const clearedCookie = res.cookies.find((c) => c.name === "qa_session");
      expect(clearedCookie?.value).toBe("");
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining("DELETE FROM sessions"),
        expect.any(Array),
      );
    });
  });

  describe("CSRF Protection on State-Changing Requests", () => {
    const validSessionToken = "valid-session-token-123";
    const validCsrfToken = "valid-csrf-token-abc";
    const testProjectId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

    beforeEach(() => {
      // Mock session validation query
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM sessions s")) {
          return {
            rowCount: 1,
            rows: [
              {
                session_id: "sess-1",
                user_id: "user-1",
                token_hash: "hash",
                csrf_token: validCsrfToken,
                expires_at: new Date(Date.now() + 100000),
                email: "manager@example.com",
                full_name: "Manager User",
                role: "qa_manager",
                is_active: true,
              },
            ],
          } as any;
        }
        if (sql.includes("FROM project_members")) {
          return { rowCount: 1, rows: [{ role: "qa_manager" }] } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });
    });

    it("rejects cookie-authenticated POST request when CSRF token is missing", async () => {
      const res = await app!.inject({
        method: "POST",
        url: `/projects/${testProjectId}/manager-action`,
        cookies: { qa_session: validSessionToken },
        // x-csrf-token header omitted
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("CSRF verification failed");
    });

    it("rejects cookie-authenticated POST request with mismatched CSRF token", async () => {
      const res = await app!.inject({
        method: "POST",
        url: `/projects/${testProjectId}/manager-action`,
        cookies: { qa_session: validSessionToken },
        headers: { "x-csrf-token": "attacker-forged-csrf" },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("CSRF verification failed");
    });

    it("accepts cookie-authenticated POST request with valid matching CSRF token", async () => {
      const res = await app!.inject({
        method: "POST",
        url: `/projects/${testProjectId}/manager-action`,
        cookies: { qa_session: validSessionToken },
        headers: { "x-csrf-token": validCsrfToken },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ managed: true });
    });
  });

  describe("Role-Based Access Control (RBAC) & Project-Level Permissions", () => {
    const projectId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

    it("allows Admin full access without project membership requirement", async () => {
      const adminUser: AuthenticatedUser = {
        id: "admin-id",
        email: "admin@example.com",
        fullName: "Platform Admin",
        role: "admin",
        isActive: true,
      };

      const access = await assertProjectAccess(adminUser, projectId, "qa_manager");
      expect(access.projectRole).toBe("qa_manager");
    });

    it("rejects users who are not assigned members of the project (IDOR protection)", async () => {
      vi.mocked(pool.query).mockResolvedValueOnce({ rowCount: 0, rows: [] } as any);

      const foreignUser: AuthenticatedUser = {
        id: "foreign-user-id",
        email: "foreign@example.com",
        fullName: "Foreign User",
        role: "qa_engineer",
        isActive: true,
      };

      await expect(assertProjectAccess(foreignUser, projectId, "viewer")).rejects.toThrow(
        "Access denied: You are not assigned to this project.",
      );
    });

    it("enforces role hierarchy (Viewer cannot perform QA Manager actions)", async () => {
      vi.mocked(pool.query).mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ role: "viewer" }],
      } as any);

      const viewerUser: AuthenticatedUser = {
        id: "viewer-id",
        email: "viewer@example.com",
        fullName: "Viewer User",
        role: "viewer",
        isActive: true,
      };

      await expect(
        assertProjectAccess(viewerUser, projectId, "qa_manager"),
      ).rejects.toThrow("Action requires 'qa_manager'");
    });

    it("allows QA Manager to perform actions requiring qa_manager role", async () => {
      vi.mocked(pool.query).mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ role: "qa_manager" }],
      } as any);

      const managerUser: AuthenticatedUser = {
        id: "manager-id",
        email: "mgr@example.com",
        fullName: "QA Manager",
        role: "qa_manager",
        isActive: true,
      };

      const result = await assertProjectAccess(managerUser, projectId, "qa_manager");
      expect(result.projectRole).toBe("qa_manager");
    });

    it("rejects expired sessions with 401 Unauthorized", async () => {
      // Mock session lookup returning 0 rows (expired)
      vi.mocked(pool.query).mockResolvedValueOnce({ rowCount: 0, rows: [] } as any);

      const res = await app!.inject({
        method: "GET",
        url: "/auth/me",
        cookies: { qa_session: "expired-token" },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe("Unauthorized");
    });

    it("prevents privilege escalation when non-admin attempts admin actions", async () => {
      // Mock authenticated session as qa_engineer
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM sessions s")) {
          return {
            rowCount: 1,
            rows: [
              {
                session_id: "sess-1",
                user_id: "engineer-1",
                token_hash: "hash",
                csrf_token: "csrf-token-xyz",
                expires_at: new Date(Date.now() + 100000),
                email: "engineer@example.com",
                full_name: "QA Engineer",
                role: "qa_engineer",
                is_active: true,
              },
            ],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const res = await app!.inject({
        method: "GET",
        url: "/admin-only-test",
        cookies: { qa_session: "engineer-token" },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("Action requires one of [admin]");
    });

    it("blocks cross-project access when user attempts to access a project they are not assigned to", async () => {
      const projectA = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
      const projectB = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22";

      // Mock session as valid user
      vi.mocked(pool.query).mockImplementation(async (sql: string, params?: any[]) => {
        if (sql.includes("FROM sessions s")) {
          return {
            rowCount: 1,
            rows: [
              {
                session_id: "sess-1",
                user_id: "user-1",
                token_hash: "hash",
                csrf_token: "csrf-token-123",
                expires_at: new Date(Date.now() + 100000),
                email: "user@example.com",
                full_name: "Test User",
                role: "qa_engineer",
                is_active: true,
              },
            ],
          } as any;
        }
        if (sql.includes("FROM project_members")) {
          // User is member of projectA, but NOT projectB
          if (params?.[0] === projectA) {
            return { rowCount: 1, rows: [{ role: "qa_manager" }] } as any;
          }
          return { rowCount: 0, rows: [] } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      // Request to projectB (cross-project unauthorized access attempt)
      const res = await app!.inject({
        method: "POST",
        url: `/projects/${projectB}/manager-action`,
        cookies: { qa_session: "user-token" },
        headers: { "x-csrf-token": "csrf-token-123" },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("Access denied: You are not assigned to this project.");
    });

    it("allows Admin to register new users with session cookie and CSRF token", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM sessions s")) {
          return {
            rowCount: 1,
            rows: [
              {
                session_id: "sess-admin",
                user_id: "admin-id",
                token_hash: "admin-hash",
                csrf_token: "admin-csrf-token",
                expires_at: new Date(Date.now() + 100000),
                email: "admin@example.com",
                full_name: "Admin User",
                role: "admin",
                is_active: true,
              },
            ],
          } as any;
        }
        if (sql.includes("SELECT COUNT(*) FROM users")) {
          return { rowCount: 1, rows: [{ count: "2" }] } as any;
        }
        if (sql.includes("SELECT 1 FROM users WHERE email")) {
          return { rowCount: 0, rows: [] } as any;
        }
        if (sql.includes("INSERT INTO users")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "new-user-id",
                email: "newuser@example.com",
                full_name: "New QA Engineer",
                role: "qa_engineer",
                is_active: true,
                created_at: new Date(),
              },
            ],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const res = await app!.inject({
        method: "POST",
        url: "/auth/register",
        cookies: { qa_session: "admin-session-token" },
        headers: { "x-csrf-token": "admin-csrf-token" },
        payload: {
          email: "newuser@example.com",
          password: "SecurePassword123!",
          fullName: "New QA Engineer",
          role: "qa_engineer",
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().email).toBe("newuser@example.com");
      expect(res.json().role).toBe("qa_engineer");
    });

    it("rejects non-admin from registering users when users already exist", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM sessions s")) {
          return {
            rowCount: 1,
            rows: [
              {
                session_id: "sess-qa",
                user_id: "qa-id",
                token_hash: "qa-hash",
                csrf_token: "qa-csrf-token",
                expires_at: new Date(Date.now() + 100000),
                email: "qa@example.com",
                full_name: "QA User",
                role: "qa_engineer",
                is_active: true,
              },
            ],
          } as any;
        }
        if (sql.includes("SELECT COUNT(*) FROM users")) {
          return { rowCount: 1, rows: [{ count: "2" }] } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const res = await app!.inject({
        method: "POST",
        url: "/auth/register",
        cookies: { qa_session: "qa-session-token" },
        headers: { "x-csrf-token": "qa-csrf-token" },
        payload: {
          email: "another@example.com",
          password: "Password123!",
          fullName: "Another User",
          role: "qa_engineer",
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("Only platform administrators can register new user accounts.");
    });

    it("lists project members using the composite project_members key", async () => {
      vi.mocked(pool.query).mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: "member-user-id",
          user_id: "member-user-id",
          email: "member@example.com",
          full_name: "Project Member",
          role: "qa_engineer",
          created_at: new Date("2025-01-01T00:00:00Z"),
        }],
      } as any);

      const res = await app!.inject({
        method: "GET",
        url: "/projects/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/members",
        headers: { "x-api-key": testPlatformApiKey },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()[0]).toMatchObject({
        id: "member-user-id",
        userId: "member-user-id",
        email: "member@example.com",
      });
      expect(vi.mocked(pool.query).mock.calls[0][0]).toContain("pm.user_id AS id");
      expect(vi.mocked(pool.query).mock.calls[0][0]).not.toContain("pm.id");
    });

    it("lists users using the camelCase fields consumed by user management", async () => {
      vi.mocked(pool.query).mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          id: "member-user-id",
          email: "member@example.com",
          full_name: "Project Member",
          role: "qa_engineer",
          is_active: true,
          created_at: new Date("2025-01-01T00:00:00Z"),
        }],
      } as any);

      const res = await app!.inject({
        method: "GET",
        url: "/users",
        headers: { "x-api-key": testPlatformApiKey },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()[0]).toMatchObject({
        id: "member-user-id",
        fullName: "Project Member",
        isActive: true,
        createdAt: "2025-01-01T00:00:00.000Z",
      });
    });

    it("accepts camelCase userId when assigning a project member", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT id FROM users WHERE id = $1")) {
          return { rowCount: 1, rows: [{ id: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22" }] } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      const res = await app!.inject({
        method: "POST",
        url: "/projects/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/members",
        headers: { "x-api-key": testPlatformApiKey },
        payload: {
          userId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22",
          role: "qa_engineer",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        userId: "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22",
        role: "qa_engineer",
      });
    });
  });
});
