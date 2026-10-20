import type { FastifyPluginAsync } from "fastify";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";
import { pool } from "../config/db";
import { assertProjectCapNotReached } from "../services/rateLimiter";
import {
  setProjectCredentials,
  deleteProjectCredentials,
  setProjectSession,
  deleteProjectSession,
  ensureStockFlowCredentialsImported,
} from "../services/secretStore";
import { detectAccess } from "../services/loginDetector";
import { assertTargetUrlAllowed } from "../services/urlGuard";

const createProjectSchema = z.object({
  name: z.string().optional(),
  base_url: z.string().min(1),
  owner_confirmed: z.boolean().optional(),
});

const projectParamsSchema = z.object({
  id: z.string().uuid(),
});

const credentialsSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

interface ActiveInteractiveSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  timer: NodeJS.Timeout;
}

const activeInteractiveSessions = new Map<string, ActiveInteractiveSession>();

const projectRoutes: FastifyPluginAsync = async (fastify) => {
  // Try importing StockFlow credentials once on startup
  ensureStockFlowCredentialsImported().catch(() => {});

  fastify.post("/projects", async (request, reply) => {
    const body = createProjectSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: `Invalid request body: ${body.error.issues.map((issue) => issue.message).join(", ")}`,
      });
    }

    try {
      await assertProjectCapNotReached();
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Project limit reached",
      });
    }

    try {
      await assertTargetUrlAllowed(body.data.base_url);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Target URL rejected by security guard",
      });
    }

    const ownerConfirmed = body.data.owner_confirmed ?? false;
    let projectName = body.data.name?.trim();
    if (!projectName) {
      try {
        const parsed = new URL(body.data.base_url);
        projectName = parsed.hostname.replace(/^www\./, "");
      } catch {
        projectName = "Test App";
      }
    }

    const result = await pool.query(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ($1, $2, $3, 'unknown')
       RETURNING id, name, base_url, created_at, owner_confirmed, access_status`,
      [projectName, body.data.base_url, ownerConfirmed],
    );

    const createdProject = result.rows[0];

    // Detect access asynchronously or synchronously
    try {
      const accessStatus = await detectAccess(createdProject.base_url, createdProject.id);
      createdProject.access_status = accessStatus;
    } catch (detectErr) {
      console.warn("Initial login detection failed:", detectErr instanceof Error ? detectErr.message : String(detectErr));
    }

    return reply.code(201).send({
      ...createdProject,
      has_credentials: false,
      has_session: false,
      session_saved_at: null,
    });
  });

  fastify.get("/projects", async () => {
    const result = await pool.query(`
      SELECT
        p.id,
        p.name,
        p.base_url,
        p.created_at,
        p.owner_confirmed,
        p.access_status,
        (pa.username_enc IS NOT NULL AND pa.password_enc IS NOT NULL) AS has_credentials,
        (pa.session_enc IS NOT NULL) AS has_session,
        pa.session_saved_at
      FROM projects p
      LEFT JOIN project_access pa ON p.id = pa.project_id
      ORDER BY p.created_at DESC
    `);
    return result.rows;
  });

  fastify.get<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
    }

    const result = await pool.query(
      `
      SELECT
        p.id,
        p.name,
        p.base_url,
        p.created_at,
        p.owner_confirmed,
        p.access_status,
        (pa.username_enc IS NOT NULL AND pa.password_enc IS NOT NULL) AS has_credentials,
        (pa.session_enc IS NOT NULL) AS has_session,
        pa.session_saved_at
      FROM projects p
      LEFT JOIN project_access pa ON p.id = pa.project_id
      WHERE p.id = $1
    `,
      [params.data.id],
    );

    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "Project not found" });
    }

    return result.rows[0];
  });

  fastify.post<{ Params: { id: string } }>("/projects/:id/detect-access", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
    }

    const project = await pool.query<{ id: string; base_url: string }>(
      "SELECT id, base_url FROM projects WHERE id = $1",
      [params.data.id],
    );

    if (project.rowCount === 0) {
      return reply.code(404).send({ error: "Project not found" });
    }

    try {
      const accessStatus = await detectAccess(project.rows[0].base_url, project.rows[0].id);
      return reply.code(200).send({ access_status: accessStatus });
    } catch (error) {
      return reply.code(500).send({
        error: error instanceof Error ? error.message : "Access detection failed",
      });
    }
  });

  fastify.put<{ Params: { id: string } }>("/projects/:id/credentials", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
    }

    const body = credentialsSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: `Invalid credentials: ${body.error.issues.map((i) => i.message).join(", ")}`,
      });
    }

    const project = await pool.query("SELECT id FROM projects WHERE id = $1", [params.data.id]);
    if (project.rowCount === 0) {
      return reply.code(404).send({ error: "Project not found" });
    }

    await setProjectCredentials(params.data.id, body.data.username, body.data.password);
    return reply.code(200).send({ status: "ok", message: "Credentials saved" });
  });

  fastify.delete<{ Params: { id: string } }>("/projects/:id/credentials", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
    }

    await deleteProjectCredentials(params.data.id);
    return reply.code(200).send({ status: "ok", message: "Credentials removed" });
  });

  fastify.post<{ Params: { id: string } }>("/projects/:id/session/start", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
    }

    if (process.env.ALLOW_INTERACTIVE_LOGIN === "false") {
      return reply.code(403).send({
        error: "Interactive login is disabled in this environment.",
      });
    }

    const projectResult = await pool.query<{ id: string; base_url: string }>(
      "SELECT id, base_url FROM projects WHERE id = $1",
      [params.data.id],
    );

    if (projectResult.rowCount === 0) {
      return reply.code(404).send({ error: "Project not found" });
    }

    const project = projectResult.rows[0];
    await assertTargetUrlAllowed(project.base_url);

    // Clean up any existing interactive session for this project
    const existing = activeInteractiveSessions.get(project.id);
    if (existing) {
      clearTimeout(existing.timer);
      await existing.browser.close().catch(() => {});
      activeInteractiveSessions.delete(project.id);
    }

    let browser: Browser;
    try {
      browser = await chromium.launch({ headless: false });
    } catch (launchErr) {
      return reply.code(500).send({
        error: `Could not launch interactive browser: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}`,
      });
    }

    const context = await browser.newContext();
    const page = await context.newPage();

    // 5-minute timeout to close browser automatically
    const timer = setTimeout(async () => {
      try {
        const storageState = await context.storageState();
        await setProjectSession(project.id, storageState);
      } catch {}
      await browser.close().catch(() => {});
      activeInteractiveSessions.delete(project.id);
    }, 5 * 60 * 1000);

    page.on("close", async () => {
      try {
        const storageState = await context.storageState();
        await setProjectSession(project.id, storageState);
      } catch {}
    });

    browser.on("disconnected", () => {
      clearTimeout(timer);
      activeInteractiveSessions.delete(project.id);
    });

    activeInteractiveSessions.set(project.id, {
      browser,
      context,
      page,
      timer,
    });

    try {
      await page.goto(project.base_url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      // Allow user to interact even if navigation was slow
    }

    return reply.code(200).send({
      status: "ok",
      message: "Interactive browser window opened. Log in manually, then click Done in the dashboard.",
    });
  });

  fastify.post<{ Params: { id: string } }>("/projects/:id/session/finish", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
    }

    const session = activeInteractiveSessions.get(params.data.id);
    if (!session) {
      // Check if session was already saved when user closed the window
      const access = await pool.query<{ session_saved_at: string | null }>(
        "SELECT session_saved_at FROM project_access WHERE project_id = $1",
        [params.data.id],
      );
      if (access.rowCount && access.rows[0]?.session_saved_at) {
        return reply.code(200).send({
          status: "ok",
          message: "Session saved successfully.",
          session_saved_at: access.rows[0].session_saved_at,
        });
      }

      return reply.code(400).send({
        error: "No active interactive login session found for this project. Please click Start login first.",
      });
    }

    try {
      const storageState = await session.context.storageState();
      await setProjectSession(params.data.id, storageState);
      clearTimeout(session.timer);
      await session.browser.close().catch(() => {});
      activeInteractiveSessions.delete(params.data.id);

      return reply.code(200).send({
        status: "ok",
        message: "Session saved successfully.",
        session_saved_at: new Date().toISOString(),
      });
    } catch (err) {
      return reply.code(500).send({
        error: `Failed to capture session state: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  });

  fastify.delete<{ Params: { id: string } }>("/projects/:id/session", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
    }

    await deleteProjectSession(params.data.id);
    return reply.code(200).send({ status: "ok", message: "Session removed" });
  });
};

export default projectRoutes;
