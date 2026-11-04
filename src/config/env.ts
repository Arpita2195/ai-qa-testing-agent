import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  GEMINI_API_KEY: z.string().min(1, "GEMINI_API_KEY is required"),
  AI_MODEL: z.string().min(1, "AI_MODEL is required"),
  PLATFORM_API_KEY: z
    .string()
    .min(16, "PLATFORM_API_KEY must be at least 16 characters"),
  COOKIE_SECRET: z
    .string()
    .min(32, "COOKIE_SECRET must be at least 32 characters long")
    .default("replace_with_a_secure_cookie_signing_secret_at_least_32_characters"),
  ALLOW_PRIVATE_TARGETS: z.string().optional().default("false"),
  CORS_ORIGIN: z.string().optional(),
  STOCKFLOW_BASE_URL: z
    .string()
    .url()
    .default("https://stockflow-vert-two.vercel.app"),
  STOCKFLOW_TEST_EMAIL: z.string().optional(),
  STOCKFLOW_TEST_PASSWORD: z.string().optional(),
  // Storage Configuration (Local, MinIO, or AWS S3)
  STORAGE_PROVIDER: z.enum(["local", "s3", "minio"]).default("local"),
  S3_ENDPOINT: z.string().optional(),
  S3_BUCKET: z.string().default("ai-qa-artifacts"),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_REGION: z.string().default("us-east-1"),
  S3_FORCE_PATH_STYLE: z.string().optional().default("true"),
  // Background Job Queue Configuration (PostgreSQL default, BullMQ/Redis optional)
  REDIS_URL: z.string().optional(),
  REDIS_HOST: z.string().optional(),
  REDIS_PORT: z.coerce.number().int().default(6379),
  USE_REDIS_QUEUE: z.string().optional().default("false"),
  // Logging & Observability
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  throw new Error(`Invalid environment configuration: ${details}`);
}

// Production security warnings
if (process.env.NODE_ENV === "production") {
  if (result.data.COOKIE_SECRET.includes("replace_with_a_secure_cookie_signing_secret")) {
    console.warn(
      "[SECURITY WARNING] COOKIE_SECRET is using the default placeholder in production. Set a unique, cryptographically strong secret of at least 32 characters.",
    );
  }
  if (result.data.PLATFORM_API_KEY.includes("replace_with_a_random_key")) {
    console.warn(
      "[SECURITY WARNING] PLATFORM_API_KEY is using the default placeholder in production. Set a unique secret of at least 16 characters.",
    );
  }
  if (result.data.ALLOW_PRIVATE_TARGETS === "true") {
    console.warn(
      "[SECURITY WARNING] ALLOW_PRIVATE_TARGETS is set to 'true' in production. This allows requests to internal/private targets and weakens SSRF protection.",
    );
  }
}

export const env = result.data;
