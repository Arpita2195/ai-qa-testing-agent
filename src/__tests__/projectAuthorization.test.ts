import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pool } from "../config/db";
import { createAuthHook } from "../services/auth";
import authRoutes from "../routes/auth";
import projectRoutes from "../routes/projects";
import { hashPassword } from "../services/passwordService";

vi.mock("../config/db", () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock("../services/rateLimiter", () => ({
  assertProjectCapNotReached: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/loginDetector", () => ({
  detectAccess: vi.fn().mockResolvedValue("public"),
}));

vi.mock("../services/secretStore", () => ({
  setProjectCredentials: vi.fn(),
  deleteProjectCredentials: vi.fn(),
  setProjectSession: vi.fn(),
  deleteProjectSession: vi.fn(),
  ensureStockFlowCredentialsImported: vi.fn().mockResolvedValue(undefined),
}));

describe("TASK 4: Website Ownership and Authorization Confirmation", () => {
  let app: ReturnType<typeof Fastify> | undefined;
  const testApiKey = "test-platform-api-key";

  beforeEach(() => {
    vi.clearAllMocks();
    app = Fastify();
    app.register(cookie);
    app.addHook("onRequest", createAuthHook(testApiKey));
    app.register(projectRoutes);
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("creates project when website ownership confirmation is explicitly provided", async () => {
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT") return { rowCount: 0, rows: [] };
        if (sql.includes("INSERT INTO projects")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
                name: "StockFlow",
                base_url: "https://stockflow-vert-two.vercel.app",
                owner_confirmed: true,
                owner_confirmed_at: new Date().toISOString(),
                owner_confirmed_by: "00000000-0000-0000-0000-000000000001",
                access_status: "unknown",
                created_at: new Date().toISOString(),
              },
            ],
          };
        }
        if (sql.includes("INSERT INTO website_authorizations")) {
          return { rowCount: 1, rows: [] };
        }
        if (sql.includes("INSERT INTO project_members")) {
          return { rowCount: 1, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn(),
    };

    vi.mocked(pool.connect).mockResolvedValueOnce(mockClient as any);
    vi.mocked(pool.query).mockResolvedValue({ rowCount: 1, rows: [] } as any);

    const res = await app!.inject({
      method: "POST",
      url: "/projects",
      headers: { "x-api-key": testApiKey },
      payload: {
        name: "StockFlow",
        base_url: "https://stockflow-vert-two.vercel.app",
        owner_confirmed: true,
        declaration_text: "I confirm that I own StockFlow and authorize automated testing.",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.owner_confirmed).toBe(true);
    expect(body.id).toBe("a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11");

    // Verify database transaction recorded authorization
    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO website_authorizations"),
      expect.arrayContaining([
        "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        "https://stockflow-vert-two.vercel.app",
        "I confirm that I own StockFlow and authorize automated testing.",
      ]),
    );

    // Verify audit log call
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO audit_logs"),
      expect.arrayContaining(["WEBSITE_AUTHORIZATION_CONFIRMED"]),
    );
  });

  it("uses a login cookie for /auth/me, project listing, and project creation", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    const sessionId = "00000000-0000-0000-0000-000000000002";
    const passwordHash = await hashPassword("ValidPassword123!");
    let session: { tokenHash: string; csrfToken: string; expiresAt: Date } | undefined;
    const listedProject = {
      id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      name: "Existing Project",
      base_url: "https://example.com",
    };

    vi.mocked(pool.query).mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("FROM users WHERE email = $1")) {
        return {
          rowCount: 1,
          rows: [{
            id: userId,
            email: "admin@example.com",
            password_hash: passwordHash,
            full_name: "Test Admin",
            role: "admin",
            is_active: true,
          }],
        } as any;
      }
      if (sql.includes("INSERT INTO sessions")) {
        session = {
          tokenHash: values?.[1] as string,
          csrfToken: values?.[2] as string,
          expiresAt: values?.[3] as Date,
        };
        return { rowCount: 1, rows: [] } as any;
      }
      if (sql.includes("FROM sessions s")) {
        return session
          ? {
              rowCount: 1,
              rows: [{
                session_id: sessionId,
                user_id: userId,
                token_hash: session.tokenHash,
                csrf_token: session.csrfToken,
                expires_at: session.expiresAt,
                email: "admin@example.com",
                full_name: "Test Admin",
                role: "admin",
                is_active: true,
              }],
            } as any
          : { rowCount: 0, rows: [] } as any;
      }
      if (sql.includes("FROM projects p")) {
        return { rowCount: 1, rows: [listedProject] } as any;
      }
      return { rowCount: 1, rows: [] } as any;
    });

    const createdProject = {
      id: "00000000-0000-0000-0000-000000000003",
      name: "New Project",
      base_url: "https://new-example.com",
      owner_confirmed: true,
      owner_confirmed_at: new Date().toISOString(),
      owner_confirmed_by: userId,
      access_status: "unknown",
      created_at: new Date().toISOString(),
    };
    const mockClient = {
      query: vi.fn().mockImplementation(async (sql: string) => {
        if (sql.includes("INSERT INTO projects")) {
          return { rowCount: 1, rows: [createdProject] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    vi.mocked(pool.connect).mockResolvedValueOnce(mockClient as any);

    app!.register(authRoutes);
    const login = await app!.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@example.com", password: "ValidPassword123!" },
    });
    expect(login.statusCode).toBe(200);
    const sessionCookie = login.cookies.find((cookie) => cookie.name === "qa_session");
    expect(sessionCookie).toBeDefined();
    const cookies = { qa_session: sessionCookie!.value };

    const currentUser = await app!.inject({ method: "GET", url: "/auth/me", cookies });
    expect(currentUser.statusCode).toBe(200);
    expect(currentUser.json().user.email).toBe("admin@example.com");

    const projects = await app!.inject({ method: "GET", url: "/projects", cookies });
    expect(projects.statusCode).toBe(200);
    expect(projects.json()).toEqual([listedProject]);

    const creation = await app!.inject({
      method: "POST",
      url: "/projects",
      cookies,
      headers: { "x-csrf-token": login.json().csrfToken },
      payload: {
        name: "New Project",
        base_url: "https://new-example.com",
        owner_confirmed: true,
        declaration_text: "I confirm I am authorized to test this website.",
      },
    });
    expect(creation.statusCode).toBe(201);
    expect(creation.json().id).toBe(createdProject.id);
  });

  it("rejects project creation when owner_confirmed is missing (direct API bypass attempt)", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/projects",
      headers: { "x-api-key": testApiKey },
      payload: {
        name: "Unauthorized Target",
        base_url: "https://example.com",
        // owner_confirmed omitted
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Invalid request body");
  });

  it("rejects project creation when owner_confirmed is explicitly false", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/projects",
      headers: { "x-api-key": testApiKey },
      payload: {
        name: "Unauthorized Target",
        base_url: "https://example.com",
        owner_confirmed: false,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Website ownership or explicit testing authorization must be confirmed");
  });

  it("validates target URL security and blocks SSRF targets even with confirmation", async () => {
    const res = await app!.inject({
      method: "POST",
      url: "/projects",
      headers: { "x-api-key": testApiKey },
      payload: {
        name: "Cloud Metadata",
        base_url: "http://169.254.169.254/latest/meta-data",
        owner_confirmed: true,
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Target URL rejected by security guard");
  });

  it("returns confirmation metadata in project details", async () => {
    vi.mocked(pool.query).mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM projects WHERE id = $1")) {
        return { rowCount: 1, rows: [{ 1: 1 }] } as any;
      }
      if (sql.includes("FROM projects p")) {
        return {
          rowCount: 1,
          rows: [
            {
              id: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
              name: "StockFlow",
              base_url: "https://stockflow-vert-two.vercel.app",
              owner_confirmed: true,
              owner_confirmed_at: "2026-10-27T10:00:00.000Z",
              owner_confirmed_by: "00000000-0000-0000-0000-000000000001",
              access_status: "public",
              has_credentials: false,
              has_session: false,
              session_saved_at: null,
            },
          ],
        } as any;
      }
      return { rowCount: 0, rows: [] } as any;
    });

    const res = await app!.inject({
      method: "GET",
      url: "/projects/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
      headers: { "x-api-key": testApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.owner_confirmed).toBe(true);
    expect(body.owner_confirmed_at).toBe("2026-10-27T10:00:00.000Z");
  });

  it("prevents unauthorized modification of website authorization records", async () => {
    // Attempting to modify authorization records via unsupported mutating routes is blocked
    const res = await app!.inject({
      method: "PATCH",
      url: "/projects/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11/authorization",
      headers: { "x-api-key": testApiKey },
      payload: { owner_confirmed: false },
    });

    // 404 or method not allowed because authorization records are immutable
    expect(res.statusCode).toBe(404);
  });
});
