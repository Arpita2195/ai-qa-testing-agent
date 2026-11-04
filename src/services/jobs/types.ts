export type JobType =
  | "web_execution"
  | "api_execution"
  | "mobile_execution"
  | "regression_run"
  | "ai_generation";

export type JobStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed"
  | "retrying"
  | "cancelled";

export interface JobRecord {
  id: string;
  projectId: string;
  queueName: string;
  jobType: JobType;
  status: JobStatus;
  payload: any;
  result?: any;
  errorMessage?: string | null;
  retries: number;
  maxRetries: number;
  concurrencyKey?: string | null;
  deduplicationId?: string | null;
  enqueuedAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
  queueDelayMs?: number | null;
  durationMs?: number | null;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type JobHandler = (payload: any, job: JobRecord) => Promise<any>;
