import type { FastifyPluginAsync } from "fastify";
import { checkDbConnection } from "../config/db";

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get("/health", async (_request, reply) => {
    try {
      await checkDbConnection();
      return { status: "ok", database: "connected" };
    } catch {
      return reply.code(500).send({
        status: "error",
        database: "disconnected",
      });
    }
  });
};

export default healthRoutes;
