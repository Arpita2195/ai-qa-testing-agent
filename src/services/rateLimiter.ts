import { pool } from "../config/db";

const MAX_PROJECTS = 100;
const GENERATE_CALLS_PER_MINUTE = 10;
const WINDOW_MS = 60 * 1000;

interface RateBucket {
  timestamps: number[];
}

const generateCallBuckets = new Map<string, RateBucket>();

/**
 * Checks if the API key has exceeded the rate limit for generate and discovery calls.
 */
export function checkGenerateRateLimit(apiKey: string): {
  allowed: boolean;
  retryAfterSeconds?: number;
} {
  const now = Date.now();
  const bucket = generateCallBuckets.get(apiKey) ?? { timestamps: [] };

  // Remove timestamps outside the sliding window
  bucket.timestamps = bucket.timestamps.filter((ts) => now - ts < WINDOW_MS);

  if (bucket.timestamps.length >= GENERATE_CALLS_PER_MINUTE) {
    const oldest = bucket.timestamps[0];
    const retryAfterSeconds = Math.ceil((oldest + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds };
  }

  bucket.timestamps.push(now);
  generateCallBuckets.set(apiKey, bucket);
  return { allowed: true };
}

/**
 * Checks whether the total number of projects has reached the system cap.
 */
export async function assertProjectCapNotReached(): Promise<void> {
  const result = await pool.query<{ count: string }>("SELECT COUNT(*) AS count FROM projects");
  const count = parseInt(result.rows[0]?.count ?? "0", 10);
  if (count >= MAX_PROJECTS) {
    throw new Error(
      `Project cap reached (${MAX_PROJECTS} projects maximum). Please delete old projects to create new ones.`,
    );
  }
}

export const MAX_GEMINI_CALLS_PER_DISCOVERY = 10;
