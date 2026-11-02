import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { orchestrate } from "../services/orchestrator/orchestrator";

// Set of processed delivery IDs for idempotency
const processedDeliveries = new Set<string>();

const githubPullRequestPayloadSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    head: z.object({
      sha: z.string(),
      ref: z.string(),
    }),
    base: z.object({
      ref: z.string(),
    }),
  }).optional(),
  repository: z.object({
    name: z.string(),
    full_name: z.string().optional(),
    html_url: z.string().optional(),
  }).optional(),
});

function verifyGitHubSignature(secret: string, signatureHeader: string | undefined, rawBody: string): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) {
    return false;
  }
  const expectedSig = signatureHeader.slice(7);
  const hmac = createHmac("sha256", secret);
  hmac.update(rawBody);
  const actualSig = hmac.digest("hex");

  if (actualSig.length !== expectedSig.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(actualSig, "utf8"), Buffer.from(expectedSig, "utf8"));
}

const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post("/webhooks/github", async (request, reply) => {
    const deliveryId = request.headers["x-github-delivery"];
    const event = request.headers["x-github-event"];
    const signature = request.headers["x-hub-signature-256"];

    if (!deliveryId || typeof deliveryId !== "string") {
      return reply.code(400).send({ error: "Missing x-github-delivery header" });
    }

    // 1. Safe handling of duplicate events (idempotency check)
    if (processedDeliveries.has(deliveryId)) {
      return reply.code(200).send({
        status: "duplicate_ignored",
        delivery_id: deliveryId,
        message: "Delivery already processed",
      });
    }

    // 2. Verified signature verification (if secret is configured)
    const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
    if (webhookSecret) {
      const rawPayload = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      const isValid = verifyGitHubSignature(
        webhookSecret,
        typeof signature === "string" ? signature : undefined,
        rawPayload,
      );
      if (!isValid) {
        return reply.code(401).send({ error: "Invalid webhook HMAC signature" });
      }
    }

    // Mark delivery as processed (retains last 10,000 IDs in memory)
    if (processedDeliveries.size > 10000) {
      processedDeliveries.clear();
    }
    processedDeliveries.add(deliveryId);

    // 3. Process Pull Request events
    if (event === "pull_request") {
      const parsed = githubPullRequestPayloadSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid PR payload format", details: parsed.error.issues });
      }

      const action = parsed.data.action;
      if (["opened", "synchronize", "reopened"].includes(action) && parsed.data.pull_request) {
        const pr = parsed.data.pull_request;
        const sha = pr.head.sha;
        const branch = pr.head.ref;

        // Resolve default project to test
        const projectQuery = await pool.query<{ id: string }>(
          "SELECT id FROM projects ORDER BY created_at ASC LIMIT 1",
        );
        const projectId = projectQuery.rows[0]?.id;

        if (projectId) {
          // Asynchronously trigger orchestrator without blocking webhook response
          setImmediate(async () => {
            try {
              await orchestrate({
                projectId,
                intent: `CI Pull Request #${pr.number} (${action}) on branch ${branch}`,
                commitSha: sha,
                branch,
                environment: "test",
                maxSteps: 4,
              });
            } catch (err) {
              fastify.log.error(err, `Failed to orchestrate PR #${pr.number}`);
            }
          });
        }

        return reply.code(202).send({
          status: "queued",
          delivery_id: deliveryId,
          event,
          action,
          pr_number: pr.number,
          commit_sha: sha,
        });
      }
    }

    return reply.code(200).send({
      status: "acknowledged",
      delivery_id: deliveryId,
      event,
    });
  });
};

export default webhookRoutes;
