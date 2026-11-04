import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import {
  authenticateCredentials,
  createSessionForUser,
  revokeSession,
  revokeUserSessions,
  type PlatformRole,
  type ProjectRole,
} from "../services/authService";
import { requireAuth, requirePlatformRole } from "../services/auth";
import { hashPassword, verifyPassword } from "../services/passwordService";
import { logAuditEvent } from "../services/auditLogger";

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters long"),
  fullName: z.string().min(1, "Full name is required"),
  role: z.enum(["admin", "qa_manager", "qa_engineer", "viewer"]).default("qa_engineer"),
});

const updateUserSchema = z.object({
  fullName: z.string().min(1).optional(),
  role: z.enum(["admin", "qa_manager", "qa_engineer", "viewer"]).optional(),
  isActive: z.boolean().optional(),
});

const projectMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["qa_manager", "qa_engineer", "viewer"]).default("qa_engineer"),
});

const userParamsSchema = z.object({
  id: z.string().uuid(),
});

const projectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

const memberParamsSchema = z.object({
  projectId: z.string().uuid(),
  userId: z.string().uuid(),
});

const authRoutes: FastifyPluginAsync = async (fastify) => {
  // 1. Login endpoint
  fastify.post("/auth/login", async (request, reply) => {
    const body = loginBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: `Invalid login credentials: ${body.error.issues.map((i) => i.message).join(", ")}`,
      });
    }

    try {
      const result = await authenticateCredentials(
        body.data.email,
        body.data.password,
        request.ip,
      );

      // Set secure HTTP-only cookie (signed when cookie secret is configured)
      try {
        (reply as any).setCookie("qa_session", result.sessionToken, {
          path: "/",
          httpOnly: true,
          secure: process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true",
          sameSite: "lax",
          maxAge: 24 * 60 * 60, // 24 hours
          signed: true,
        });
      } catch {
        (reply as any).setCookie("qa_session", result.sessionToken, {
          path: "/",
          httpOnly: true,
          secure: process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true",
          sameSite: "lax",
          maxAge: 24 * 60 * 60, // 24 hours
        });
      }

      return reply.code(200).send({
        user: result.user,
        csrfToken: result.csrfToken,
        expiresAt: result.expiresAt.toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Authentication failed";
      if (message.includes("Too many failed login attempts")) {
        return reply.code(429).send({ error: message });
      }
      return reply.code(401).send({ error: message });
    }
  });

  // 2. Logout endpoint
  fastify.post("/auth/logout", async (request, reply) => {
    const cookies = (request as any).cookies as Record<string, string | undefined> | undefined;
    let cookieToken = cookies?.["qa_session"];
    if (cookieToken && typeof (request as any).unsignCookie === "function") {
      const unsigned = (request as any).unsignCookie(cookieToken);
      if (unsigned.valid && unsigned.value) {
        cookieToken = unsigned.value;
      }
    }
    const authHeader = request.headers["authorization"];
    const bearerToken =
      typeof authHeader === "string" && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : undefined;

    const token = cookieToken || bearerToken;
    if (token) {
      await revokeSession(token, request.user?.id);
    }

    (reply as any).clearCookie("qa_session", { path: "/" });
    return reply.code(200).send({ message: "Logged out successfully" });
  });

  // 3. Current authenticated user profile
  fastify.get("/auth/me", { preHandler: [requireAuth] }, async (request, reply) => {
    return reply.code(200).send({
      user: request.user,
      csrfToken: request.session?.csrfToken,
    });
  });

  // 4. Register new user (Admins or initial setup)
  fastify.post("/auth/register", async (request, reply) => {
    // If users already exist, only Admins can create new users
    const userCountResult = await pool.query<{ count: string }>("SELECT COUNT(*) FROM users");
    const count = parseInt(userCountResult.rows[0].count, 10);

    if (count > 0) {
      if (!request.user || (request.user.role !== "admin" && !request.user.isServiceAccount)) {
        return reply.code(403).send({
          error: "Forbidden: Only platform administrators can register new user accounts.",
        });
      }
    }

    const body = registerBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: `Invalid registration data: ${body.error.issues.map((i) => i.message).join(", ")}`,
      });
    }

    const email = body.data.email.trim().toLowerCase();
    const existing = await pool.query("SELECT 1 FROM users WHERE email = $1", [email]);
    if (existing.rowCount && existing.rowCount > 0) {
      return reply.code(409).send({ error: "A user with this email address already exists." });
    }

    const passwordHash = await hashPassword(body.data.password);
    const assignedRole: PlatformRole = count === 0 ? "admin" : body.data.role;

    const insertResult = await pool.query<{
      id: string;
      email: string;
      full_name: string;
      role: PlatformRole;
      is_active: boolean;
      created_at: Date;
    }>(
      `INSERT INTO users (email, password_hash, full_name, role, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, NOW(), NOW())
       RETURNING id, email, full_name, role, is_active, created_at`,
      [email, passwordHash, body.data.fullName.trim(), assignedRole],
    );

    const newUser = insertResult.rows[0];

    await logAuditEvent({
      actorId: request.user?.id ?? newUser.id,
      action: "USER_CREATED",
      outcome: "success",
      details: { userId: newUser.id, email: newUser.email, role: newUser.role },
      ipAddress: request.ip,
    });

    return reply.code(201).send({
      id: newUser.id,
      email: newUser.email,
      fullName: newUser.full_name,
      role: newUser.role,
      isActive: newUser.is_active,
      createdAt: newUser.created_at,
    });
  });

  // 5. List users (Admin only)
  fastify.get("/users", { preHandler: [requirePlatformRole("admin")] }, async (request, reply) => {
    const result = await pool.query<{
      id: string;
      email: string;
      full_name: string;
      role: PlatformRole;
      is_active: boolean;
      created_at: Date;
    }>(
      "SELECT id, email, full_name, role, is_active, created_at FROM users ORDER BY created_at ASC",
    );

    return reply.code(200).send(
      result.rows.map((u) => ({
        id: u.id,
        email: u.email,
        fullName: u.full_name,
        role: u.role,
        isActive: u.is_active,
        createdAt: u.created_at,
      })),
    );
  });

  // 6. Update user role / status (Admin only)
  fastify.patch(
    "/users/:id",
    { preHandler: [requirePlatformRole("admin")] },
    async (request, reply) => {
      const params = userParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid user ID: expected a UUID" });
      }

      const body = updateUserSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid update payload: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      // Prevent admin from disabling their own account
      if (params.data.id === request.user?.id && body.data.isActive === false) {
        return reply.code(400).send({ error: "Cannot deactivate your own administrator account." });
      }

      const existingUser = await pool.query<{ id: string; role: string; is_active: boolean }>(
        "SELECT id, role, is_active FROM users WHERE id = $1",
        [params.data.id],
      );
      if (existingUser.rowCount === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      const updates: string[] = ["updated_at = NOW()"];
      const values: any[] = [params.data.id];

      if (body.data.fullName !== undefined) {
        values.push(body.data.fullName.trim());
        updates.push(`full_name = $${values.length}`);
      }
      if (body.data.role !== undefined) {
        values.push(body.data.role);
        updates.push(`role = $${values.length}`);
      }
      if (body.data.isActive !== undefined) {
        values.push(body.data.isActive);
        updates.push(`is_active = $${values.length}`);
      }

      const query = `
        UPDATE users
        SET ${updates.join(", ")}
        WHERE id = $1
        RETURNING id, email, full_name, role, is_active, updated_at
      `;

      const result = await pool.query(query, values);
      const updated = result.rows[0];

      // Invalidate active sessions if role or status was modified
      if (body.data.role !== undefined || body.data.isActive === false) {
        await revokeUserSessions(
          updated.id,
          body.data.role !== undefined ? "ROLE_CHANGED" : "ACCOUNT_DEACTIVATED",
        );
      }

      await logAuditEvent({
        actorId: request.user?.id,
        action: body.data.role !== undefined ? "ROLE_CHANGED" : "USER_UPDATED",
        outcome: "success",
        details: { targetUserId: updated.id, updates: body.data },
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        id: updated.id,
        email: updated.email,
        fullName: updated.full_name,
        role: updated.role,
        isActive: updated.is_active,
        updatedAt: updated.updated_at,
      });
    },
  );

  // 6b. Change password for currently authenticated user
  const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z.string().min(8, "New password must be at least 8 characters long"),
  });

  fastify.post(
    "/auth/change-password",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const body = changePasswordSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid password payload: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const user = request.user!;
      const userRecord = await pool.query<{ password_hash: string }>(
        "SELECT password_hash FROM users WHERE id = $1",
        [user.id],
      );

      if (userRecord.rowCount === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      const isCurrentValid = await verifyPassword(
        body.data.currentPassword,
        userRecord.rows[0].password_hash,
      );
      if (!isCurrentValid) {
        await logAuditEvent({
          actorId: user.id,
          action: "PASSWORD_CHANGE_FAILED",
          outcome: "failure",
          details: { reason: "Current password mismatch" },
          ipAddress: request.ip,
        });
        return reply.code(400).send({ error: "Current password does not match" });
      }

      if (body.data.currentPassword === body.data.newPassword) {
        return reply.code(400).send({
          error: "New password must be different from current password",
        });
      }

      const newHash = await hashPassword(body.data.newPassword);
      await pool.query(
        "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
        [newHash, user.id],
      );

      // Invalidate all existing sessions for this user
      await revokeUserSessions(user.id, "PASSWORD_CHANGED");

      // Issue a fresh new session
      const newSession = await createSessionForUser(user.id);

      try {
        (reply as any).setCookie("qa_session", newSession.sessionToken, {
          path: "/",
          httpOnly: true,
          secure: process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true",
          sameSite: "lax",
          maxAge: 24 * 60 * 60,
          signed: true,
        });
      } catch {
        (reply as any).setCookie("qa_session", newSession.sessionToken, {
          path: "/",
          httpOnly: true,
          secure: process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true",
          sameSite: "lax",
          maxAge: 24 * 60 * 60,
        });
      }

      await logAuditEvent({
        actorId: user.id,
        action: "PASSWORD_CHANGED",
        outcome: "success",
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        message: "Password changed successfully. Existing sessions have been revoked.",
        csrfToken: newSession.csrfToken,
        expiresAt: newSession.expiresAt.toISOString(),
      });
    },
  );

  // 6c. Admin reset user password
  const resetPasswordSchema = z.object({
    newPassword: z.string().min(8, "New password must be at least 8 characters long"),
  });

  fastify.post(
    "/users/:id/reset-password",
    { preHandler: [requirePlatformRole("admin")] },
    async (request, reply) => {
      const params = userParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid user ID: expected a UUID" });
      }

      const body = resetPasswordSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid payload: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const userExists = await pool.query("SELECT id, email FROM users WHERE id = $1", [
        params.data.id,
      ]);
      if (userExists.rowCount === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      const newHash = await hashPassword(body.data.newPassword);
      await pool.query(
        "UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2",
        [newHash, params.data.id],
      );

      // Invalidate all active sessions for target user
      await revokeUserSessions(params.data.id, "PASSWORD_RESET_BY_ADMIN");

      await logAuditEvent({
        actorId: request.user?.id,
        action: "PASSWORD_RESET_BY_ADMIN",
        outcome: "success",
        details: { targetUserId: params.data.id },
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        message:
          "Password has been reset by administrator. All active sessions for this user have been revoked.",
      });
    },
  );

  // 7. Manage project members: List members
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/members",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      const members = await pool.query<{
        id: string;
        user_id: string;
        email: string;
        full_name: string;
        role: ProjectRole;
        created_at: Date;
      }>(
        `SELECT pm.user_id AS id, pm.user_id, u.email, u.full_name, pm.role, pm.created_at
         FROM project_members pm
         JOIN users u ON u.id = pm.user_id
         WHERE pm.project_id = $1
         ORDER BY pm.created_at ASC`,
        [params.data.projectId],
      );

      return reply.code(200).send(
        members.rows.map((m) => ({
          id: m.id,
          userId: m.user_id,
          user_id: m.user_id,
          email: m.email,
          fullName: m.full_name,
          full_name: m.full_name,
          role: m.role,
          createdAt: m.created_at,
          created_at: m.created_at,
        })),
      );
    },
  );

  // 8. Add or update project member
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/members",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      // Check permissions: only Admin or QA Manager of the project can add members
      if (request.user?.role !== "admin" && !request.user?.isServiceAccount) {
        const mgrCheck = await pool.query(
          "SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 AND role = 'qa_manager'",
          [params.data.projectId, request.user?.id],
        );
        if (mgrCheck.rowCount === 0) {
          return reply.code(403).send({
            error: "Forbidden: Only QA Managers or Platform Administrators can manage project members.",
          });
        }
      }

      const body = projectMemberSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid member payload: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      const userExists = await pool.query("SELECT id FROM users WHERE id = $1", [body.data.userId]);
      if (userExists.rowCount === 0) {
        return reply.code(404).send({ error: "User not found" });
      }

      await pool.query(
        `INSERT INTO project_members (project_id, user_id, role, created_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (project_id, user_id)
         DO UPDATE SET role = EXCLUDED.role`,
        [params.data.projectId, body.data.userId, body.data.role],
      );

      await logAuditEvent({
        actorId: request.user?.id,
        action: "PROJECT_MEMBER_ADDED",
        projectId: params.data.projectId,
        outcome: "success",
        details: { targetUserId: body.data.userId, role: body.data.role },
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        projectId: params.data.projectId,
        userId: body.data.userId,
        role: body.data.role,
      });
    },
  );

  // 9. Remove project member
  fastify.delete<{ Params: { projectId: string; userId: string } }>(
    "/projects/:projectId/members/:userId",
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const params = memberParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid parameters: expected UUIDs" });
      }

      // Only Admin or QA Manager of this project can remove members
      if (request.user?.role !== "admin" && !request.user?.isServiceAccount) {
        const mgrCheck = await pool.query(
          "SELECT 1 FROM project_members WHERE project_id = $1 AND user_id = $2 AND role = 'qa_manager'",
          [params.data.projectId, request.user?.id],
        );
        if (mgrCheck.rowCount === 0) {
          return reply.code(403).send({
            error: "Forbidden: Only QA Managers or Platform Administrators can remove project members.",
          });
        }
      }

      await pool.query(
        "DELETE FROM project_members WHERE project_id = $1 AND user_id = $2",
        [params.data.projectId, params.data.userId],
      );

      await logAuditEvent({
        actorId: request.user?.id,
        action: "PROJECT_MEMBER_REMOVED",
        projectId: params.data.projectId,
        outcome: "success",
        details: { removedUserId: params.data.userId },
        ipAddress: request.ip,
      });

      return reply.code(200).send({ message: "Member removed from project successfully" });
    },
  );

  // 10. Audit Logs endpoint (Admin only)
  fastify.get(
    "/audit-logs",
    { preHandler: [requirePlatformRole("admin")] },
    async (request, reply) => {
      const logs = await pool.query<{
        id: string;
        actor_id: string | null;
        actor_email: string | null;
        action: string;
        project_id: string | null;
        target_resource: string | null;
        outcome: string;
        details: unknown;
        ip_address: string | null;
        created_at: Date;
      }>(
        `SELECT
           a.id, a.actor_id, u.email as actor_email, a.action, a.project_id,
           a.target_resource, a.outcome, a.details, a.ip_address, a.created_at
         FROM audit_logs a
         LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.created_at DESC
         LIMIT 100`,
      );

      return reply.code(200).send(logs.rows);
    },
  );
};

export default authRoutes;
