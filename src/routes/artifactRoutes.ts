import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { assertProjectAccess } from "../services/authService";
import { storageService } from "../services/storage/storageService";
import { LocalStorageProvider } from "../services/storage/localStorageProvider";

const signedUrlQuerySchema = z.object({
  runId: z.string().uuid(),
  resultId: z.string().uuid().optional(),
  file: z.string().min(1),
});

const downloadQuerySchema = z.object({
  key: z.string().min(1),
  expires: z.coerce.number().int().positive(),
  sig: z.string().min(1),
});

const artifactRoutes: FastifyPluginAsync = async (fastify) => {
  // 1. Generate secure, time-limited signed download URL
  fastify.get("/artifacts/signed-url", async (request, reply) => {
    const query = signedUrlQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({
        error: `Invalid query parameters: ${query.error.issues.map((i) => i.message).join(", ")}`,
      });
    }

    const { runId, resultId, file } = query.data;

    // Verify run exists and user has project viewer access
    const runRes = await pool.query<{ project_id: string }>(
      "SELECT project_id FROM test_runs WHERE id = $1",
      [runId],
    );
    if (runRes.rowCount === 0) {
      return reply.code(404).send({ error: "Test run not found" });
    }

    const projectId = runRes.rows[0].project_id;
    if (request.user) {
      await assertProjectAccess(request.user, projectId, "viewer");
    }

    // Build artifact storage key
    const key = resultId
      ? `runs/${runId}/${resultId}/${file}`
      : `runs/${runId}/${file}`;

    const expiresInSeconds = 900; // 15 minutes
    const signedUrl = await storageService.getSignedUrl(key, expiresInSeconds);

    return reply.code(200).send({
      key,
      signedUrl,
      expiresInSeconds,
      storageProvider: storageService.getProviderType(),
    });
  });

  // 2. Direct download endpoint for HMAC-signed local URLs
  fastify.get("/api/artifacts/download", async (request, reply) => {
    const query = downloadQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Missing or invalid signature parameters" });
    }

    const { key, expires, sig } = query.data;

    // Validate signature using LocalStorageProvider
    const localProvider = new LocalStorageProvider();
    const isValid = localProvider.verifySignature(key, expires, sig);

    if (!isValid) {
      return reply.code(403).send({ error: "Forbidden: Invalid or expired artifact signature" });
    }

    try {
      const artifact = await storageService.download(key);
      reply.header("Content-Type", artifact.contentType);
      reply.header("Cache-Control", "private, no-transform, max-age=900");
      return reply.send(artifact.buffer);
    } catch {
      return reply.code(404).send({ error: "Requested artifact not found" });
    }
  });
};

export { artifactRoutes };
export default artifactRoutes;
