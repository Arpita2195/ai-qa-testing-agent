import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { importOpenApi, skipExistingEndpoints } from "../services/openapiImporter";

const methodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const fieldTypeSchema = z.enum(["string", "number", "boolean", "object", "array"]);
const endpointSchema = z.object({
  name: z.string().min(1),
  method: methodSchema,
  path: z.string().startsWith("/"),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  expected_status: z.number().int().min(100).max(599),
  expected_fields: z.record(z.string(), fieldTypeSchema).default({}),
  max_response_ms: z.number().int().positive().nullable().optional(),
});
const projectParamsSchema = z.object({ projectId: z.string().uuid() });
const idParamsSchema = z.object({ id: z.string().uuid() });
const importBodySchema = z.object({
  spec: z.record(z.string(), z.unknown()).optional(),
  specText: z.string().max(2 * 1024 * 1024).optional(),
}).refine((body) => (body.spec !== undefined) !== (body.specText !== undefined), {
  message: "Provide exactly one of spec or specText",
});
const reviewBodySchema = z.object({ review_status: z.enum(["approved", "rejected"]) });

const apiEndpointRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/api-endpoints/import",
    { bodyLimit: 2 * 1024 * 1024 },
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }
      const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [
        params.data.projectId,
      ]);
      if (project.rowCount === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const body = importBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid import body: ${body.error.issues.map((issue) => issue.message).join(", ")}`,
        });
      }
      let drafts;
      try {
        drafts = importOpenApi(body.data.spec ?? body.data.specText!);
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : "Invalid OpenAPI specification",
        });
      }

      const existingResult = await pool.query<{ method: string; path: string }>(
        "SELECT method, path FROM api_endpoints WHERE project_id = $1",
        [params.data.projectId],
      );
      const { created: newDrafts, skipped: existingSkipped } = skipExistingEndpoints(
        drafts,
        existingResult.rows as Array<{ method: import("../services/apiRunner").ApiMethod; path: string }>,
      );
      const created = [];
      for (const draft of newDrafts) {
        const inserted = await pool.query(
          `INSERT INTO api_endpoints
             (project_id, name, method, path, headers, body, expected_status, expected_fields, review_status)
           VALUES ($1, $2, $3, $4, '{}'::jsonb, $5, $6, $7, 'pending')
           RETURNING *`,
          [
            params.data.projectId,
            draft.name,
            draft.method,
            draft.path,
            draft.body === undefined ? null : JSON.stringify(draft.body),
            draft.expected_status,
            JSON.stringify(draft.expected_fields),
          ],
        );
        if (inserted.rows[0]) created.push(inserted.rows[0]);
      }
      return reply.code(201).send({
        created,
        skipped: existingSkipped + (newDrafts.length - created.length),
      });
    },
  );

  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/api-endpoints",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }
      const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [params.data.projectId]);
      if (project.rowCount === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const body = endpointSchema.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid request body: ${body.error.issues.map((issue) => issue.message).join(", ")}`,
        });
      }
      if (
        Object.keys(body.data.headers).some((header) =>
          ["authorization", "cookie", "x-api-key"].includes(header.toLowerCase()),
        )
      ) {
        return reply.code(400).send({
          error: "Sensitive headers (authorization, cookie, x-api-key) cannot be stored",
        });
      }

      const result = await pool.query(
        `INSERT INTO api_endpoints
           (project_id, name, method, path, headers, body, expected_status,
            expected_fields, max_response_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          params.data.projectId,
          body.data.name,
          body.data.method,
          body.data.path,
          JSON.stringify(body.data.headers),
          body.data.body === undefined ? null : JSON.stringify(body.data.body),
          body.data.expected_status,
          JSON.stringify(body.data.expected_fields),
          body.data.max_response_ms ?? null,
        ],
      );
      return reply.code(201).send(result.rows[0]);
    },
  );

  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/api-endpoints",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }
      const project = await pool.query("SELECT 1 FROM projects WHERE id = $1", [params.data.projectId]);
      if (project.rowCount === 0) {
        return reply.code(404).send({ error: "Project not found" });
      }
      const endpoints = await pool.query(
        "SELECT * FROM api_endpoints WHERE project_id = $1 ORDER BY created_at DESC",
        [params.data.projectId],
      );
      return endpoints.rows;
    },
  );

  fastify.delete<{ Params: { id: string } }>("/api-endpoints/:id", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid endpoint id: expected a UUID" });
    }
    const result = await pool.query("DELETE FROM api_endpoints WHERE id = $1 RETURNING id", [
      params.data.id,
    ]);
    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "API endpoint not found" });
    }
    return reply.code(204).send();
  });

  fastify.patch<{ Params: { id: string } }>("/api-endpoints/:id/review", async (request, reply) => {
    const params = idParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid endpoint id: expected a UUID" });
    }
    const body = reviewBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "review_status must be approved or rejected" });
    }
    const result = await pool.query(
      "UPDATE api_endpoints SET review_status = $1 WHERE id = $2 RETURNING *",
      [body.data.review_status, params.data.id],
    );
    if (!result.rows[0]) {
      return reply.code(404).send({ error: "API endpoint not found" });
    }
    return result.rows[0];
  });
};

export default apiEndpointRoutes;
