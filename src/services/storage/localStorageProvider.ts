import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, unlink, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env";
import type { IStorageService, StorageDownloadResult, StorageProviderType, StorageUploadResult } from "./types";

export class LocalStorageProvider implements IStorageService {
  private baseDir: string;
  private signingSecret: string;

  constructor(baseDir?: string, signingSecret?: string) {
    this.baseDir = baseDir ?? path.resolve(process.cwd(), "artifacts");
    this.signingSecret = signingSecret ?? env.COOKIE_SECRET ?? "fallback-local-signing-secret-key-32chars";
  }

  private resolveSafePath(key: string): string {
    if (key.includes("..")) {
      throw new Error(`Path traversal attempt blocked: ${key}`);
    }
    const sanitizedKey = key.replace(/^[/\\]+/, "");
    const resolved = path.resolve(this.baseDir, sanitizedKey);
    if (!resolved.startsWith(this.baseDir)) {
      throw new Error(`Path traversal attempt blocked: ${key}`);
    }
    return resolved;
  }

  getProviderType(): StorageProviderType {
    return "local";
  }

  async isAvailable(): Promise<boolean> {
    try {
      await mkdir(this.baseDir, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async upload(
    key: string,
    data: Buffer | string,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<StorageUploadResult> {
    const filePath = this.resolveSafePath(key);
    await mkdir(path.dirname(filePath), { recursive: true });

    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    await writeFile(filePath, buffer);

    return {
      key,
      location: filePath,
      provider: "local",
      sizeBytes: buffer.length,
    };
  }

  async download(key: string): Promise<StorageDownloadResult> {
    const filePath = this.resolveSafePath(key);
    const buffer = await readFile(filePath);
    const ext = path.extname(key).toLowerCase();

    let contentType = "application/octet-stream";
    if (ext === ".png") contentType = "image/png";
    else if (ext === ".jpg" || ext === ".jpeg") contentType = "image/jpeg";
    else if (ext === ".json") contentType = "application/json";
    else if (ext === ".html") contentType = "text/html; charset=utf-8";
    else if (ext === ".csv") contentType = "text/csv; charset=utf-8";
    else if (ext === ".zip") contentType = "application/zip";
    else if (ext === ".txt") contentType = "text/plain; charset=utf-8";

    return {
      buffer,
      contentType,
      contentLength: buffer.length,
    };
  }

  async getSignedUrl(key: string, expiresInSeconds: number = 900): Promise<string> {
    const expiresAt = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = this.generateSignature(key, expiresAt);
    return `/api/artifacts/download?key=${encodeURIComponent(key)}&expires=${expiresAt}&sig=${signature}`;
  }

  async delete(key: string): Promise<void> {
    try {
      const filePath = this.resolveSafePath(key);
      await unlink(filePath);
    } catch (err: any) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  generateSignature(key: string, expiresAt: number): string {
    return createHmac("sha256", this.signingSecret)
      .update(`${key}:${expiresAt}`)
      .digest("hex");
  }

  verifySignature(key: string, expiresAt: number, signature: string): boolean {
    if (Math.floor(Date.now() / 1000) > expiresAt) {
      return false; // Expired
    }
    const expected = this.generateSignature(key, expiresAt);
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf = Buffer.from(signature, "hex");
    if (expectedBuf.length !== actualBuf.length) {
      return false;
    }
    return timingSafeEqual(expectedBuf, actualBuf);
  }
}
