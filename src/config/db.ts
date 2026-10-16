import { Pool } from "pg";
import { env } from "./env";

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
});

export async function checkDbConnection(): Promise<void> {
  await pool.query("SELECT 1");
}
