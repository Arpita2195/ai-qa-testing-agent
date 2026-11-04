import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Readable } from "node:stream";
import type { IStorageService, StorageDownloadResult, StorageProviderType, StorageUploadResult } from "./types";
import { LocalStorageProvider } from "./localStorageProvider";

export interface S3StorageConfig {
  bucket: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export class S3StorageProvider implements IStorageService {
  private client: S3Client;
  private bucket: string;
  private isMinio: boolean;
  private localFallback: LocalStorageProvider;
  private bucketEnsured: boolean = false;

  constructor(config: S3StorageConfig, localFallback?: LocalStorageProvider) {
    this.bucket = config.bucket;
    this.isMinio = Boolean(config.endpoint && config.endpoint.includes("minio"));
    this.localFallback = localFallback ?? new LocalStorageProvider();

    const clientConfig: any = {
      region: config.region || "us-east-1",
    };

    if (config.endpoint) {
      clientConfig.endpoint = config.endpoint;
    }
    if (config.forcePathStyle !== undefined) {
      clientConfig.forcePathStyle = config.forcePathStyle;
    } else if (config.endpoint) {
      clientConfig.forcePathStyle = true;
    }

    if (config.accessKeyId && config.secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      };
    }

    this.client = new S3Client(clientConfig);
  }

  getProviderType(): StorageProviderType {
    return this.isMinio ? "minio" : "s3";
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.ensureBucket();
      return true;
    } catch {
      return false;
    }
  }

  async ensureBucket(): Promise<void> {
    if (this.bucketEnsured) return;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
      this.bucketEnsured = true;
    } catch (headErr: any) {
      if (headErr.name === "NotFound" || headErr.$metadata?.httpStatusCode === 404) {
        try {
          await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
          this.bucketEnsured = true;
        } catch (createErr) {
          console.warn(`[Storage] Failed to auto-create bucket ${this.bucket}:`, createErr);
        }
      }
    }
  }

  async upload(
    key: string,
    data: Buffer | string,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<StorageUploadResult> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");

    try {
      await this.ensureBucket();
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: buffer,
          ContentType: contentType,
          Metadata: metadata,
        }),
      );

      return {
        key,
        location: `s3://${this.bucket}/${key}`,
        provider: this.getProviderType(),
        sizeBytes: buffer.length,
      };
    } catch (err) {
      console.warn(
        `[Storage] S3/MinIO upload failed for key "${key}" (${err instanceof Error ? err.message : String(err)}); falling back to local storage.`,
      );
      return this.localFallback.upload(key, data, contentType, metadata);
    }
  }

  async download(key: string): Promise<StorageDownloadResult> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      const stream = response.Body as Readable;
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const buffer = Buffer.concat(chunks);

      return {
        buffer,
        contentType: response.ContentType || "application/octet-stream",
        contentLength: response.ContentLength ?? buffer.length,
      };
    } catch (err) {
      // Attempt local fallback if file exists on disk
      try {
        return await this.localFallback.download(key);
      } catch {
        throw new Error(`Artifact "${key}" not found in S3/MinIO or local fallback.`);
      }
    }
  }

  async getSignedUrl(key: string, expiresInSeconds: number = 900): Promise<string> {
    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });
      return await getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
    } catch (err) {
      console.warn(`[Storage] Failed to generate S3 presigned URL for "${key}"; falling back to local signed URL.`, err);
      return this.localFallback.getSignedUrl(key, expiresInSeconds);
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );
    } catch (err) {
      console.warn(`[Storage] S3 delete failed for "${key}":`, err);
    }
    // Also cleanup local if present
    await this.localFallback.delete(key).catch(() => {});
  }
}
