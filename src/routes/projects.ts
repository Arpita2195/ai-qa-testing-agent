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
import { requireAuth } from "../services/auth";
import { assertProjectAccess, AccessDeniedError } from "../services/authService";
import { logAuditEvent } from "../services/auditLogger";

const createProjectSchema = z.object({
  name: z.string().optional(),
  base_url: z.string().min(1),
  owner_confirmed: z.boolean(),
  declaration_text: z.string().optional(),
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

  // 1. Create a new project (requires explicit website ownership / testing authorization confirmation)
  fastify.post("/projects", { preHandler: [requireAuth] }, async (request, reply) => {
    // Platform Role check: Viewers cannot create projects
    if (request.user && request.user.role === "viewer") {
      return reply.code(403).send({
        error: "Forbidden: Users with 'viewer' role cannot create projects.",
      });
    }

    const body = createProjectSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: `Invalid request body: ${body.error.issues.map((issue) => issue.message).join(", ")}`,
      });
    }

    // REQUIREMENT: Must explicitly confirm ownership / authorization
    if (body.data.owner_confirmed !== true) {
      return reply.code(400).send({
        error:
          "Website ownership or explicit testing authorization must be confirmed before creating a project.",
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
        error: `Target URL rejected by security guard: ${error instanceof Error ? error.message : "Restricted address"}`,
      });
    }

    let projectName = body.data.name?.trim();
    if (!projectName) {
      try {
        const parsed = new URL(body.data.base_url);
        projectName = parsed.hostname.replace(/^www\./, "");
      } catch {
        projectName = "Test App";
      }
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const insertProjectQuery = await client.query(
        `INSERT INTO projects (name, base_url, owner_confirmed, owner_confirmed_at, owner_confirmed_by, access_status)
         VALUES ($1, $2, TRUE, NOW(), $3, 'unknown')
         RETURNING id, name, base_url, created_at, owner_confirmed, owner_confirmed_at, owner_confirmed_by, access_status`,
        [projectName, body.data.base_url, request.user?.id ?? null],
      );

      const createdProject = insertProjectQuery.rows[0];

      // Record immutable authorization confirmation record
      const declaration =
        body.data.declaration_text?.trim() ||
        "I declare and confirm that I own this website/API or have explicit authorized permission from its owner to perform automated testing.";

      await client.query(
        `INSERT INTO website_authorizations (project_id, user_id, target_url, confirmed_at, declaration_text, ip_address, user_agent)
         VALUES ($1, $2, $3, NOW(), $4, $5, $6)`,
        [
          createdProject.id,
          request.user?.id ?? null,
          createdProject.base_url,
          declaration,
          request.ip,
          request.headers["user-agent"] ?? null,
        ],
      );

      // Assign project creator as QA Manager of this project
      if (request.user?.id && !request.user.isServiceAccount) {
        await client.query(
          `INSERT INTO project_members (project_id, user_id, role, created_at)
           VALUES ($1, $2, 'qa_manager', NOW())
           ON CONFLICT (project_id, user_id) DO NOTHING`,
          [createdProject.id, request.user.id],
        );
      }

      await client.query("COMMIT");

      // Audit logs
      await logAuditEvent({
        actorId: request.user?.id,
        action: "WEBSITE_AUTHORIZATION_CONFIRMED",
        projectId: createdProject.id,
        targetResource: createdProject.base_url,
        outcome: "success",
        details: { declaration, confirmed_at: createdProject.owner_confirmed_at },
        ipAddress: request.ip,
      });

      await logAuditEvent({
        actorId: request.user?.id,
        action: "PROJECT_CREATED",
        projectId: createdProject.id,
        targetResource: createdProject.name,
        outcome: "success",
        ipAddress: request.ip,
      });

      // Detect access asynchronously or synchronously
      try {
        const accessStatus = await detectAccess(createdProject.base_url, createdProject.id);
        createdProject.access_status = accessStatus;
      } catch (detectErr) {
        console.warn(
          "Initial login detection failed:",
          detectErr instanceof Error ? detectErr.message : String(detectErr),
        );
      }

      return reply.code(201).send({
        ...createdProject,
        has_credentials: false,
        has_session: false,
        session_saved_at: null,
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  });

  // 2. List projects (scoped to user's assigned projects unless admin)
  fastify.get("/projects", { preHandler: [requireAuth] }, async (request, reply) => {
    let result;
    if (request.user?.role === "admin" || request.user?.isServiceAccount) {
      result = await pool.query(`
        SELECT
          p.id,
          p.name,
          p.base_url,
          p.created_at,
          p.owner_confirmed,
          p.owner_confirmed_at,
          p.owner_confirmed_by,
          p.access_status,
          'qa_manager' AS user_project_role,
          (pa.username_enc IS NOT NULL AND pa.password_enc IS NOT NULL) AS has_credentials,
          (pa.session_enc IS NOT NULL) AS has_session,
          pa.session_saved_at
        FROM projects p
        LEFT JOIN project_access pa ON p.id = pa.project_id
        ORDER BY p.created_at DESC
      `);
    } else {
      result = await pool.query(
        `
        SELECT
          p.id,
          p.name,
          p.base_url,
          p.created_at,
          p.owner_confirmed,
          p.owner_confirmed_at,
          p.owner_confirmed_by,
          p.access_status,
          pm.role AS user_project_role,
          (pa.username_enc IS NOT NULL AND pa.password_enc IS NOT NULL) AS has_credentials,
          (pa.session_enc IS NOT NULL) AS has_session,
          pa.session_saved_at
        FROM projects p
        JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = $1
        LEFT JOIN project_access pa ON p.id = pa.project_id
        ORDER BY p.created_at DESC
      `,
        [request.user?.id],
      );
    }

    return reply.code(200).send(result.rows);
  });

  // 3. Get single project (verifies project membership)
  fastify.get<{ Params: { id: string } }>(
    "/projects/:id",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
      }

      // Check project existence
      const existsCheck = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
        params.data.id,
      ]);
      if (existsCheck.rowCount === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }

      // Check access permission
      if (request.user) {
        try {
          await assertProjectAccess(request.user, params.data.id, "viewer");
        } catch (err) {
          if (err instanceof AccessDeniedError) {
            return reply.code(403).send({ error: err.message });
          }
          return reply.code(403).send({ error: "Forbidden: Access to this project is denied." });
        }
      }

      const result = await pool.query(
        `
        SELECT
          p.id,
          p.name,
          p.base_url,
          p.created_at,
          p.owner_confirmed,
          p.owner_confirmed_at,
          p.owner_confirmed_by,
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

      return reply.code(200).send(result.rows[0]);
    },
  );

  // 4. Delete project (requires admin or project qa_manager)
  fastify.delete<{ Params: { id: string } }>(
    "/projects/:id",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
      }

      const project = await pool.query<{ id: string; name: string }>(
        "SELECT id, name FROM projects WHERE id = $1",
        [params.data.id],
      );
      if (project.rowCount === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }

      // Check permission: Admin or QA Manager of project
      if (request.user) {
        try {
          await assertProjectAccess(request.user, params.data.id, "qa_manager");
        } catch (err) {
          if (err instanceof AccessDeniedError) {
            return reply.code(403).send({ error: err.message });
          }
          return reply.code(403).send({ error: "Forbidden: Only QA Managers can delete projects." });
        }
      }

      await pool.query("DELETE FROM projects WHERE id = $1", [params.data.id]);

      await logAuditEvent({
        actorId: request.user?.id,
        action: "PROJECT_DELETED",
        projectId: params.data.id,
        targetResource: project.rows[0].name,
        outcome: "success",
        ipAddress: request.ip,
      });

      return reply.code(200).send({ message: "Project deleted successfully" });
    },
  );

  // 5. Trigger access detection
  fastify.post<{ Params: { id: string } }>(
    "/projects/:id/detect-access",
    { preHandler: [requireAuth] },
    async (request, reply) => {
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

      if (request.user) {
        try {
          await assertProjectAccess(request.user, params.data.id, "qa_engineer");
        } catch (err) {
          if (err instanceof AccessDeniedError) {
            return reply.code(403).send({ error: err.message });
          }
          return reply.code(403).send({ error: "Forbidden: Access to this project is denied." });
        }
      }

      try {
        const accessStatus = await detectAccess(project.rows[0].base_url, project.rows[0].id);
        return reply.code(200).send({ access_status: accessStatus });
      } catch (error) {
        return reply.code(500).send({
          error: error instanceof Error ? error.message : "Access detection failed",
        });
      }
    },
  );

  // 6. Set credentials (requires qa_manager role on project)
  fastify.put<{ Params: { id: string } }>(
    "/projects/:id/credentials",
    { preHandler: [requireAuth] },
    async (request, reply) => {
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

      if (request.user) {
        try {
          await assertProjectAccess(request.user, params.data.id, "qa_manager");
        } catch (err) {
          if (err instanceof AccessDeniedError) {
            return reply.code(403).send({ error: err.message });
          }
          return reply
            .code(403)
            .send({ error: "Forbidden: Only QA Managers can configure project credentials." });
        }
      }

      await setProjectCredentials(params.data.id, body.data.username, body.data.password);

      await logAuditEvent({
        actorId: request.user?.id,
        action: "PROJECT_CREDENTIALS_UPDATED",
        projectId: params.data.id,
        outcome: "success",
        ipAddress: request.ip,
      });

      return reply.code(200).send({ message: "Credentials saved securely" });
    },
  );

  // 7. Delete credentials
  fastify.delete<{ Params: { id: string } }>(
    "/projects/:id/credentials",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
      }

      if (request.user) {
        try {
          await assertProjectAccess(request.user, params.data.id, "qa_manager");
        } catch (err) {
          if (err instanceof AccessDeniedError) {
            return reply.code(403).send({ error: err.message });
          }
          return reply
            .code(403)
            .send({ error: "Forbidden: Only QA Managers can delete project credentials." });
        }
      }

      await deleteProjectCredentials(params.data.id);
      return reply.code(200).send({ message: "Credentials removed" });
    },
  );

  // 8. Delete saved browser session
  fastify.delete<{ Params: { id: string } }>(
    "/projects/:id/session",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
      }

      if (request.user) {
        try {
          await assertProjectAccess(request.user, params.data.id, "qa_manager");
        } catch (err) {
          if (err instanceof AccessDeniedError) {
            return reply.code(403).send({ error: err.message });
          }
          return reply.code(403).send({ error: "Forbidden." });
        }
      }

      await deleteProjectSession(params.data.id);
      return reply.code(200).send({ message: "Session removed" });
    },
  );

  // 9. Interactive browser login session
  fastify.post<{ Params: { id: string } }>(
    "/projects/:id/interactive-login",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
      }

      const projectResult = await pool.query<{ id: string; base_url: string }>(
        "SELECT id, base_url FROM projects WHERE id = $1",
        [params.data.id],
      );
      const project = projectResult.rows[0];
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      if (request.user) {
        try {
          await assertProjectAccess(request.user, params.data.id, "qa_manager");
        } catch (err) {
          if (err instanceof AccessDeniedError) {
            return reply.code(403).send({ error: err.message });
          }
          return reply.code(403).send({ error: "Forbidden." });
        }
      }

      const existingSession = activeInteractiveSessions.get(params.data.id);
      if (existingSession) {
        return reply.code(400).send({
          error: "An interactive login session is already active for this project.",
        });
      }

      try {
        const browser = await chromium.launch({ headless: false });
        const context = await browser.newContext();
        const page = await context.newPage();

        const timer = setTimeout(
          async () => {
            activeInteractiveSessions.delete(params.data.id);
            try {
              await page.close();
              await context.close();
              await browser.close();
            } catch {}
          },
          5 * 60 * 1000,
        );

        activeInteractiveSessions.set(params.data.id, { browser, context, page, timer });

        await page.goto(project.base_url, { waitUntil: "domcontentloaded", timeout: 30000 });

        return reply.code(200).send({
          message:
            "A browser window has opened. Please complete login, then click 'Save Session'. Session closes automatically after 5 minutes.",
        });
      } catch (err) {
        return reply.code(500).send({
          error:
            err instanceof Error
              ? err.message
              : "Failed to launch interactive browser session",
        });
      }
    },
  );

  // 10. Complete and save interactive session
  fastify.post<{ Params: { id: string } }>(
    "/projects/:id/interactive-login/save",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
      }

      const active = activeInteractiveSessions.get(params.data.id);
      if (!active) {
        return reply.code(404).send({
          error: "No active interactive login session found for this project.",
        });
      }

      try {
        clearTimeout(active.timer);
        activeInteractiveSessions.delete(params.data.id);

        const storageState = await active.context.storageState();
        await setProjectSession(params.data.id, JSON.stringify(storageState));

        await active.page.close().catch(() => {});
        await active.context.close().catch(() => {});
        await active.browser.close().catch(() => {});

        await pool.query("UPDATE projects SET access_status = 'ready' WHERE id = $1", [
          params.data.id,
        ]);

        await logAuditEvent({
          actorId: request.user?.id,
          action: "PROJECT_SESSION_SAVED",
          projectId: params.data.id,
          outcome: "success",
          ipAddress: request.ip,
        });

        return reply.code(200).send({
          message: "Session saved successfully. Tests can now run authenticated.",
          access_status: "ready",
        });
      } catch (err) {
        return reply.code(500).send({
          error: err instanceof Error ? err.message : "Failed to save interactive session",
        });
      }
    },
  );
};

export default projectRoutes;
