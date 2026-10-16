import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { pool } from "../config/db";

async function migrate(): Promise<void> {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz DEFAULT now()
      )
    `);

    const migrationsDirectory = path.resolve(__dirname, "../../database/migrations");
    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((file) => file.endsWith(".sql"))
      .sort();

    for (const name of migrationFiles) {
      const alreadyApplied = await pool.query(
        "SELECT 1 FROM schema_migrations WHERE name = $1",
        [name],
      );

      if (alreadyApplied.rowCount) {
        continue;
      }

      const sql = await readFile(path.join(migrationsDirectory, name), "utf8");
      const client = await pool.connect();
      let transactionStarted = false;

      try {
        await client.query("BEGIN");
        transactionStarted = true;
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        await client.query("COMMIT");
        transactionStarted = false;
        console.log(`Applied migration: ${name}`);
      } catch (error) {
        if (transactionStarted) {
          await client.query("ROLLBACK");
        }
        throw error;
      } finally {
        client.release();
      }
    }
  } finally {
    await pool.end();
  }
}

void migrate().catch((error: unknown) => {
  console.error("Database migration failed:", error);
  process.exitCode = 1;
});
