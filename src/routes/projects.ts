import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";

const createProjectSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().min(1),
});

const projectParamsSchema = z.object({
  id: z.string().uuid(),
});

const projectRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/projects", async (request, reply) => {
    const body = createProjectSchema.safeParse(request.body);

    if (!body.success) {
      return reply.code(400).send({
        error: `Invalid request body: ${body.error.issues.map((issue) => issue.message).join(", ")}`,
      });
    }

    const result = await pool.query(
      "INSERT INTO projects (name, base_url) VALUES ($1, $2) RETURNING *",
      [body.data.name, body.data.base_url],
    );

    return reply.code(201).send(result.rows[0]);
  });

  fastify.get("/projects", async () => {
    const result = await pool.query("SELECT * FROM projects ORDER BY created_at DESC");
    return result.rows;
  });

  fastify.get<{ Params: { id: string } }>("/projects/:id", async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);

    if (!params.success) {
      return reply.code(400).send({ error: "Invalid project id: expected a UUID" });
    }

    const result = await pool.query("SELECT * FROM projects WHERE id = $1", [params.data.id]);

    if (result.rowCount === 0) {
      return reply.code(404).send({ error: "Project not found" });
    }

    return result.rows[0];
  });
};

export default projectRoutes;
