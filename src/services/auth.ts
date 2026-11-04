import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest, onRequestHookHandler, preHandlerHookHandler } from "fastify";
import { env } from "../config/env";
import {
  validateSession,
  assertProjectAccess,
  type AuthenticatedUser,
  type PlatformRole,
  type ProjectRole,
  type UserSession,
  AccessDeniedError,
} from "./authService";

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    session?: UserSession;
    isCookieAuth?: boolean;
  }
}

export const SYSTEM_SERVICE_USER: AuthenticatedUser = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "ci-service@qa-testing.local",
  fullName: "CI/CD Service Account",
  role: "admin",
  isActive: true,
  isServiceAccount: true,
};

/**
 * Global authentication hook for Fastify.
 * Resolves identity from:
 * 1. HTTP-only session cookie (qa_session)
 * 2. Bearer session token (Authorization: Bearer <token>)
 * 3. Platform service API key (x-api-key) for CI/CD automation
 */
export function createAuthHook(platformApiKey: string): onRequestHookHandler {
  const expectedApiKey = Buffer.from(platformApiKey);

  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method === "OPTIONS") {
      return;
    }

    // 1. Try Platform API Key (Service Account / CI/CD)
    const suppliedApiKey = request.headers["x-api-key"];
    if (typeof suppliedApiKey === "string" && suppliedApiKey.length > 0) {
      const actualKey = Buffer.from(suppliedApiKey);
      const matches =
        actualKey.length === expectedApiKey.length &&
        timingSafeEqual(actualKey, expectedApiKey);

      if (matches) {
        request.user = SYSTEM_SERVICE_USER;
        return;
      }
    }

    // 2. Try HTTP-only session cookie
    const cookies = (request as any).cookies as Record<string, string | undefined> | undefined;
    let cookieToken = cookies?.["qa_session"];
    if (cookieToken && typeof (request as any).unsignCookie === "function") {
      const unsigned = (request as any).unsignCookie(cookieToken);
      if (unsigned.valid && unsigned.value) {
        cookieToken = unsigned.value;
      }
    }
    if (cookieToken) {
      const sessionData = await validateSession(cookieToken);
      if (sessionData) {
        request.user = sessionData.user;
        request.session = sessionData.session;
        request.isCookieAuth = true;

        // Enforce CSRF protection for state-changing HTTP methods on cookie-authenticated requests
        if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
          const csrfHeader = request.headers["x-csrf-token"];
          if (
            !csrfHeader ||
            typeof csrfHeader !== "string" ||
            csrfHeader !== sessionData.session.csrfToken
          ) {
            return reply.code(403).send({
              error: "CSRF verification failed: missing or invalid x-csrf-token header.",
            });
          }
        }
        return;
      }
    }

    // 3. Try Authorization: Bearer <token>
    const authHeader = request.headers["authorization"];
    if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
      const bearerToken = authHeader.slice(7).trim();
      const sessionData = await validateSession(bearerToken);
      if (sessionData) {
        request.user = sessionData.user;
        request.session = sessionData.session;
        request.isCookieAuth = false;
        return;
      }
    }

    // Allow unauthenticated requests only for public routes
    const url = request.url.split("?")[0];
    const isPublic =
      url === "/health" ||
      url === "/api/monitoring/health" ||
      url === "/metrics" ||
      url === "/api/artifacts/download" ||
      url.startsWith("/webhooks/") ||
      url === "/auth/login" ||
      url === "/auth/logout" ||
      url === "/auth/register";

    if (isPublic) {
      return;
    }

    // If none of the authentication methods succeeded, return 401 Unauthorized
    return reply.code(401).send({ error: "Unauthorized" });
  };
}

/**
 * Pre-handler hook requiring that the request is authenticated.
 */
export const requireAuth: preHandlerHookHandler = async (request, reply) => {
  if (!request.user) {
    return reply.code(401).send({ error: "Unauthorized: Authentication required" });
  }
};

/**
 * Pre-handler hook enforcing platform-level roles (e.g. admin, qa_manager).
 */
export function requirePlatformRole(...allowedRoles: PlatformRole[]): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: "Unauthorized: Authentication required" });
    }
    if (request.user.role === "admin" || request.user.isServiceAccount) {
      return;
    }
    if (!allowedRoles.includes(request.user.role)) {
      return reply.code(403).send({
        error: `Forbidden: Action requires one of [${allowedRoles.join(", ")}] platform roles.`,
      });
    }
  };
}

/**
 * Pre-handler hook enforcing project-level access and role.
 */
export function requireProjectRole(
  paramKey = "projectId",
  minRole: ProjectRole = "viewer",
): preHandlerHookHandler {
  return async (request, reply) => {
    if (!request.user) {
      return reply.code(401).send({ error: "Unauthorized: Authentication required" });
    }

    const params = request.params as Record<string, string | undefined>;
    const projectId = params[paramKey] ?? params["id"] ?? params["projectId"];

    if (!projectId) {
      return reply.code(400).send({ error: `Missing project parameter: ${paramKey}` });
    }

    try {
      await assertProjectAccess(request.user, projectId, minRole);
    } catch (err) {
      if (err instanceof AccessDeniedError) {
        return reply.code(403).send({ error: err.message });
      }
      return reply.code(403).send({ error: "Forbidden: Access to this project is denied." });
    }
  };
}

/**
 * Legacy API Key Hook preserved for backward compatibility in tests.
 */
export function createApiKeyHook(apiKey: string): onRequestHookHandler {
  return createAuthHook(apiKey);
}
