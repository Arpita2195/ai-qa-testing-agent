import { env } from "../../config/env";
import { pool } from "../../config/db";
import type { IStorageService, StorageProviderType, StorageUploadResult } from "./types";
import { LocalStorageProvider } from "./localStorageProvider";
import { S3StorageProvider } from "./s3StorageProvider";

function createStorageService(): IStorageService {
  const providerType = env.STORAGE_PROVIDER;

  if (providerType === "s3" || providerType === "minio" || Boolean(env.S3_ENDPOINT)) {
    return new S3StorageProvider({
      bucket: env.S3_BUCKET,
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY,
      secretAccessKey: env.S3_SECRET_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
    });
  }

  return new LocalStorageProvider();
}

export const storageService: IStorageService = createStorageService();

/**
 * Persists artifact record in the PostgreSQL database for auditing and retrieval.
 */
export async function recordStoredArtifact(params: {
  projectId: string;
  runId?: string;
  resultId?: string;
  artifactType: string;
  storageKey: string;
  contentType: string;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO stored_artifacts
         (project_id, run_id, result_id, artifact_type, storage_provider, storage_key, content_type, size_bytes, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        params.projectId,
        params.runId || null,
        params.resultId || null,
        params.artifactType,
        storageService.getProviderType(),
        params.storageKey,
        params.contentType,
        params.sizeBytes || 0,
        JSON.stringify(params.metadata || {}),
      ],
    );
  } catch (err) {
    console.warn("[Storage] Failed to record stored artifact in database:", err);
  }
}
