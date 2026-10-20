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
  STOCKFLOW_BASE_URL: z
    .string()
    .url()
    .default("https://stockflow-vert-two.vercel.app"),
  STOCKFLOW_TEST_EMAIL: z.string().optional(),
  STOCKFLOW_TEST_PASSWORD: z.string().optional(),
});

const result = envSchema.safeParse(process.env);

if (!result.success) {
  const details = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");

  throw new Error(`Invalid environment configuration: ${details}`);
}

export const env = result.data;
