import { describe, expect, it } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  setProjectCredentials,
  getProjectAccess,
  deleteProjectCredentials,
  setProjectSession,
  deleteProjectSession,
} from "../services/secretStore";
import { pool } from "../config/db";

describe("secretStore AES-256-GCM encryption", () => {
  it("encrypts and decrypts strings correctly (round trip)", () => {
    const secret = "SuperSecretPassword123!@#";
    const encrypted = encryptSecret(secret);
    expect(encrypted).not.toBe(secret);
    expect(encrypted).not.toContain(secret);

    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(secret);
  });

  it("uses random IV per value so identical plaintexts produce different ciphertexts", () => {
    const secret = "SamePasswordTwice";
    const enc1 = encryptSecret(secret);
    const enc2 = encryptSecret(secret);
    expect(enc1).not.toBe(enc2);

    expect(decryptSecret(enc1)).toBe(secret);
    expect(decryptSecret(enc2)).toBe(secret);
  });

  it("stores credentials encrypted in the database with no plaintext values", async () => {
    // Create a temporary project
    const projResult = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('SecretStoreTest', 'https://example.com', true, 'unknown')
       RETURNING id`,
    );
    const projectId = projResult.rows[0].id;

    try {
      const username = "testuser_unique_12345";
      const password = "testpass_unique_67890";

      await setProjectCredentials(projectId, username, password);

      // Inspect raw database table to ensure no plaintext is stored
      const rawAccess = await pool.query(
        "SELECT username_enc, password_enc FROM project_access WHERE project_id = $1",
        [projectId],
      );
      expect(rawAccess.rowCount).toBe(1);
      const row = rawAccess.rows[0];

      // Raw DB columns must NOT contain plaintext
      expect(row.username_enc).not.toContain(username);
      expect(row.password_enc).not.toContain(password);

      // getProjectAccess should decrypt them accurately
      const access = await getProjectAccess(projectId);
      expect(access).not.toBeNull();
      expect(access?.username).toBe(username);
      expect(access?.password).toBe(password);

      // Delete credentials
      await deleteProjectCredentials(projectId);
      const afterDelete = await getProjectAccess(projectId);
      expect(afterDelete?.username).toBeUndefined();
      expect(afterDelete?.password).toBeUndefined();
    } finally {
      await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    }
  });

  it("stores session state encrypted with no plaintext storageState", async () => {
    const projResult = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('SessionStoreTest', 'https://example.com', true, 'unknown')
       RETURNING id`,
    );
    const projectId = projResult.rows[0].id;

    try {
      const fakeSession = {
        cookies: [{ name: "session_token", value: "super_secret_cookie_val_abc" }],
        origins: [],
      };

      await setProjectSession(projectId, fakeSession);

      const rawAccess = await pool.query(
        "SELECT session_enc FROM project_access WHERE project_id = $1",
        [projectId],
      );
      expect(rawAccess.rowCount).toBe(1);
      expect(rawAccess.rows[0].session_enc).not.toContain("super_secret_cookie_val_abc");

      const access = await getProjectAccess(projectId);
      expect(access?.session).toBeDefined();
      expect(access?.session).toEqual(fakeSession);

      await deleteProjectSession(projectId);
      const afterDel = await getProjectAccess(projectId);
      expect(afterDel?.session).toBeUndefined();
    } finally {
      await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
    }
  });
});
