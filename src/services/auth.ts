import { timingSafeEqual } from "node:crypto";
import type { onRequestHookHandler } from "fastify";

export function createApiKeyHook(apiKey: string): onRequestHookHandler {
  const expected = Buffer.from(apiKey);
  return async (request, reply) => {
    if (request.method === "OPTIONS") {
      return;
    }
    if (request.method === "GET" && request.routeOptions.url === "/health") {
      return;
    }

    const supplied = request.headers["x-api-key"];
    const actual = Buffer.from(typeof supplied === "string" ? supplied : "");
    const matches =
      actual.length === expected.length && timingSafeEqual(actual, expected);

    if (!matches) {
      return reply.code(401).send({ error: "Unauthorized" });
    }
  };
}
