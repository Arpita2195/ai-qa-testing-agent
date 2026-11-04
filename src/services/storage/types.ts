export type StorageProviderType = "local" | "s3" | "minio";

export interface StorageUploadResult {
  key: string;
  location: string;
  provider: StorageProviderType;
  sizeBytes: number;
}

export interface StorageDownloadResult {
  buffer: Buffer;
  contentType: string;
  contentLength?: number;
}

export interface IStorageService {
  upload(
    key: string,
    data: Buffer | string,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<StorageUploadResult>;

  download(key: string): Promise<StorageDownloadResult>;

  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;

  delete(key: string): Promise<void>;

  isAvailable(): Promise<boolean>;

  getProviderType(): StorageProviderType;
}
