import crypto from "node:crypto";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../config/db";

export interface DecryptedProjectAccess {
  projectId: string;
  username?: string;
  password?: string;
  session?: any;
  session_saved_at?: Date | null;
}

/**
 * Ensures a valid 32-byte base64 ENCRYPTION_KEY exists.
 * If missing, generates one, appends it to .env without printing, and updates process.env.
 */
export async function ensureEncryptionKey(): Promise<Buffer> {
  let keyString = process.env.ENCRYPTION_KEY?.trim();

  if (!keyString) {
    const newKey = crypto.randomBytes(32).toString("base64");
    process.env.ENCRYPTION_KEY = newKey;
    keyString = newKey;

    try {
      const envPath = path.resolve(__dirname, "../../.env");
      await appendFile(envPath, `\nENCRYPTION_KEY=${newKey}\n`, "utf8");
      console.log("ENCRYPTION_KEY was generated and added to .env.");
    } catch {
      // In testing or environments without writable .env, in-memory process.env is sufficient
    }
  }

  const keyBuffer = Buffer.from(keyString, "base64");
  if (keyBuffer.length !== 32) {
    throw new Error(
      `Invalid ENCRYPTION_KEY: expected 32 bytes (in base64), got ${keyBuffer.length} bytes.`,
    );
  }

  return keyBuffer;
}

/**
 * Encrypts a string using AES-256-GCM with a random 12-byte IV.
 * Format: iv_hex:tag_hex:ciphertext_hex
 */
export function encryptSecret(plaintext: string): string {
  let keyString = process.env.ENCRYPTION_KEY?.trim();
  if (!keyString) {
    const newKey = crypto.randomBytes(32).toString("base64");
    process.env.ENCRYPTION_KEY = newKey;
    keyString = newKey;
    try {
      const envPath = path.resolve(__dirname, "../../.env");
      appendFile(envPath, `\nENCRYPTION_KEY=${newKey}\n`, "utf8").catch(() => {});
      console.log("ENCRYPTION_KEY was generated and added to .env.");
    } catch {}
  }

  const key = Buffer.from(keyString, "base64");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts a string encrypted with encryptSecret.
 */
export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid ciphertext format: expected iv:tag:content");
  }

  const [ivHex, tagHex, dataHex] = parts;
  const keyString = process.env.ENCRYPTION_KEY?.trim();
  if (!keyString) {
    throw new Error("ENCRYPTION_KEY is missing from environment");
  }

  const key = Buffer.from(keyString, "base64");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const data = Buffer.from(dataHex, "hex");

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Retrieves and decrypts credentials/session for a project.
 */
export async function getProjectAccess(projectId: string): Promise<DecryptedProjectAccess | null> {
  const result = await pool.query(
    `SELECT project_id, username_enc, password_enc, session_enc, session_saved_at
     FROM project_access
     WHERE project_id = $1`,
    [projectId],
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];
  let username: string | undefined;
  let password: string | undefined;
  let session: any | undefined;

  if (row.username_enc) {
    try {
      username = decryptSecret(row.username_enc);
    } catch {
      // Ignore decryption failure or log sanitized error
    }
  }

  if (row.password_enc) {
    try {
      password = decryptSecret(row.password_enc);
    } catch {}
  }

  if (row.session_enc) {
    try {
      const raw = decryptSecret(row.session_enc);
      session = JSON.parse(raw);
    } catch {}
  }

  return {
    projectId: row.project_id,
    username,
    password,
    session,
    session_saved_at: row.session_saved_at,
  };
}

/**
 * Saves encrypted username and password for a project.
 */
export async function setProjectCredentials(
  projectId: string,
  username: string,
  password: string,
): Promise<void> {
  const usernameEnc = encryptSecret(username);
  const passwordEnc = encryptSecret(password);

  await pool.query(
    `INSERT INTO project_access (project_id, username_enc, password_enc, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (project_id)
     DO UPDATE SET username_enc = $2, password_enc = $3, updated_at = NOW()`,
    [projectId, usernameEnc, passwordEnc],
  );

  await pool.query(
    `UPDATE projects SET access_status = 'ready' WHERE id = $1`,
    [projectId],
  );
}

/**
 * Saves encrypted Playwright storageState for a project.
 */
export async function setProjectSession(
  projectId: string,
  storageState: any,
): Promise<void> {
  const sessionString = typeof storageState === "string" ? storageState : JSON.stringify(storageState);
  const sessionEnc = encryptSecret(sessionString);

  await pool.query(
    `INSERT INTO project_access (project_id, session_enc, session_saved_at, updated_at)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (project_id)
     DO UPDATE SET session_enc = $2, session_saved_at = NOW(), updated_at = NOW()`,
    [projectId, sessionEnc],
  );

  await pool.query(
    `UPDATE projects SET access_status = 'ready' WHERE id = $1`,
    [projectId],
  );
}

/**
 * Deletes stored username and password for a project.
 */
export async function deleteProjectCredentials(projectId: string): Promise<void> {
  await pool.query(
    `UPDATE project_access
     SET username_enc = NULL, password_enc = NULL, updated_at = NOW()
     WHERE project_id = $1`,
    [projectId],
  );

  const check = await pool.query(
    `SELECT session_enc FROM project_access WHERE project_id = $1`,
    [projectId],
  );

  if (!check.rows[0]?.session_enc) {
    await pool.query(
      `UPDATE projects SET access_status = 'login_required' WHERE id = $1`,
      [projectId],
    );
  }
}

/**
 * Deletes stored session for a project.
 */
export async function deleteProjectSession(projectId: string): Promise<void> {
  await pool.query(
    `UPDATE project_access
     SET session_enc = NULL, session_saved_at = NULL, updated_at = NOW()
     WHERE project_id = $1`,
    [projectId],
  );

  const check = await pool.query(
    `SELECT username_enc FROM project_access WHERE project_id = $1`,
    [projectId],
  );

  if (!check.rows[0]?.username_enc) {
    await pool.query(
      `UPDATE projects SET access_status = 'login_required' WHERE id = $1`,
      [projectId],
    );
  }
}

/**
 * Imports StockFlow credentials from .env into project_access for the StockFlow project if not already present.
 */
export async function ensureStockFlowCredentialsImported(): Promise<void> {
  const stockflowUrl = process.env.STOCKFLOW_BASE_URL?.trim() || "https://stockflow-vert-two.vercel.app";
  const email = process.env.STOCKFLOW_TEST_EMAIL?.trim();
  const password = process.env.STOCKFLOW_TEST_PASSWORD?.trim();

  if (!email || !password) return;

  const projectResult = await pool.query<{ id: string }>(
    `SELECT id FROM projects WHERE base_url = $1 OR base_url = $2 LIMIT 1`,
    [stockflowUrl, stockflowUrl.replace(/\/+$/, "")],
  );

  if (projectResult.rowCount === 0) return;
  const projectId = projectResult.rows[0].id;

  const access = await pool.query(
    `SELECT username_enc, password_enc FROM project_access WHERE project_id = $1`,
    [projectId],
  );

  if (access.rowCount === 0 || !access.rows[0].username_enc || !access.rows[0].password_enc) {
    await setProjectCredentials(projectId, email, password);
  }
}

