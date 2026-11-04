import { AsyncLocalStorage } from "node:async_hooks";
import { env } from "../../config/env";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  correlationId?: string;
  executionId?: string;
  jobId?: string;
  userId?: string;
  projectId?: string;
  service?: string;
  isTestFailure?: boolean;
  [key: string]: any;
}

export interface StructuredLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  correlationId?: string;
  executionId?: string;
  jobId?: string;
  userId?: string;
  projectId?: string;
  service: string;
  category: "application" | "test_execution" | "security" | "system";
  isTestFailure?: boolean;
  meta?: Record<string, any>;
  error?: {
    name?: string;
    message?: string;
    stack?: string;
    code?: string;
  };
}

// AsyncLocalStorage for ambient request / execution context
export const asyncLogStorage = new AsyncLocalStorage<LogContext>();

/**
 * Runs a function within an ambient logging context (e.g. correlation ID, execution ID).
 */
export function runWithLogContext<T>(context: LogContext, fn: () => T): T {
  const current = asyncLogStorage.getStore() || {};
  return asyncLogStorage.run({ ...current, ...context }, fn);
}

/**
 * Checks whether an object key represents sensitive user credentials.
 * Specifically excludes telemetry metrics such as totalTokens, promptTokens, completionTokens.
 */
export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.includes("tokens") || lower.includes("tokencount") || lower.includes("token_count")) {
    return false;
  }
  return /password|secret|authorization|cookie|apikey|api_key|access_token|refresh_token|private_key|session_token|credentials?|credit_card|\btoken\b|_token/i.test(key);
}

/**
 * Regex patterns to redact credentials in raw strings and log messages.
 */
const PATTERNS_TO_REDACT: Array<{ regex: RegExp; replacement: string }> = [
  { regex: /bearer\s+[A-Za-z0-9_\-\.]+/gi, replacement: "Bearer [REDACTED_TOKEN]" },
  { regex: /ai_qa_sess=[A-Za-z0-9_\-\.%]+/gi, replacement: "ai_qa_sess=[REDACTED_COOKIE]" },
  { regex: /AIzaSy[A-Za-z0-9_\-]{20,}/gi, replacement: "AIzaSy[REDACTED_API_KEY]" },
  { regex: /(https?:\/\/[^:]+:)[^@]+(@)/gi, replacement: "$1[REDACTED_AUTH]$2" }, // redact user:pass in URLs
  { regex: /("?(?:password|token|secret|apiKey|api_key|access_token)"?\s*[:=]\s*"?)[^"&,\s}]+("?)/gi, replacement: "$1[REDACTED]$2" },
];

/**
 * Recursively redacts sensitive keys and values from an object or string.
 */
export function redactSensitiveData<T>(input: T): T {
  if (input === null || input === undefined) return input;

  if (typeof input === "string") {
    let sanitized: string = input;
    for (const { regex, replacement } of PATTERNS_TO_REDACT) {
      sanitized = sanitized.replace(regex, replacement);
    }
    return sanitized as unknown as T;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveData(item)) as unknown as T;
  }

  if (typeof input === "object") {
    if (input instanceof Error) {
      return {
        name: input.name,
        message: redactSensitiveData(input.message),
        stack: redactSensitiveData(input.stack),
        ...(input as any),
      } as unknown as T;
    }

    const sanitizedObj: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
      if (isSensitiveKey(key)) {
        sanitizedObj[key] = "[REDACTED]";
      } else {
        sanitizedObj[key] = redactSensitiveData(value);
      }
    }
    return sanitizedObj as unknown as T;
  }

  return input;
}

const LOG_LEVEL_HIERARCHY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getActiveLogLevel(): LogLevel {
  const configured = (env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
  return LOG_LEVEL_HIERARCHY[configured] !== undefined ? configured : "info";
}

function shouldLog(level: LogLevel): boolean {
  const currentThreshold = LOG_LEVEL_HIERARCHY[getActiveLogLevel()] ?? 1;
  return LOG_LEVEL_HIERARCHY[level] >= currentThreshold;
}

class Logger {
  private defaultService: string;

  constructor(service: string = "ai-qa-backend") {
    this.defaultService = service;
  }

  private emit(
    level: LogLevel,
    message: string,
    meta?: Record<string, any>,
    err?: Error | unknown,
    category: "application" | "test_execution" | "security" | "system" = "application",
  ): void {
    if (!shouldLog(level)) return;

    const ambient = asyncLogStorage.getStore() || {};
    const sanitizedMsg = redactSensitiveData(message);
    const sanitizedMeta = meta ? redactSensitiveData(meta) : undefined;

    let errorObj: StructuredLogEntry["error"] = undefined;
    if (err instanceof Error) {
      errorObj = {
        name: err.name,
        message: redactSensitiveData(err.message),
        stack: redactSensitiveData(err.stack),
        code: (err as any).code,
      };
    } else if (err) {
      errorObj = {
        message: redactSensitiveData(String(err)),
      };
    }

    const entry: StructuredLogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message: sanitizedMsg,
      correlationId: meta?.correlationId || ambient.correlationId,
      executionId: meta?.executionId || ambient.executionId,
      jobId: meta?.jobId || ambient.jobId,
      userId: meta?.userId || ambient.userId,
      projectId: meta?.projectId || ambient.projectId,
      service: meta?.service || ambient.service || this.defaultService,
      category,
      isTestFailure: meta?.isTestFailure ?? ambient.isTestFailure ?? false,
      meta: sanitizedMeta,
      error: errorObj,
    };

    // Clean undefined fields for compact logging
    const cleanEntry: Record<string, any> = {};
    for (const [k, v] of Object.entries(entry)) {
      if (v !== undefined) cleanEntry[k] = v;
    }

    const jsonString = JSON.stringify(cleanEntry);

    if (level === "error") {
      process.stderr.write(jsonString + "\n");
    } else {
      process.stdout.write(jsonString + "\n");
    }
  }

  debug(message: string, meta?: Record<string, any>): void {
    this.emit("debug", message, meta, undefined, "application");
  }

  info(message: string, meta?: Record<string, any>): void {
    this.emit("info", message, meta, undefined, "application");
  }

  warn(message: string, meta?: Record<string, any>): void {
    this.emit("warn", message, meta, undefined, "application");
  }

  error(message: string, error?: Error | unknown, meta?: Record<string, any>): void {
    this.emit("error", message, meta, error, "application");
  }

  /**
   * Specifically logs a test execution failure (distinguishing it from an application error).
   */
  testFailure(message: string, meta?: Record<string, any>): void {
    this.emit("warn", `[Test Failure] ${message}`, { ...meta, isTestFailure: true }, undefined, "test_execution");
  }

  /**
   * Logs a security event (e.g. CSRF violation, unauthorized access, SSRF block).
   */
  securityEvent(message: string, meta?: Record<string, any>): void {
    this.emit("warn", `[Security Event] ${message}`, meta, undefined, "security");
  }

  child(context: LogContext): Logger {
    const childLogger = new Logger(context.service || this.defaultService);
    return childLogger;
  }
}

export const logger = new Logger("ai-qa-agent");
