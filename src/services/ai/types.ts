export type AIProviderType = "gemini" | "openai" | "ollama" | "groq";

export type AIErrorCode =
  | "INVALID_CREDENTIALS"
  | "RATE_LIMIT_EXCEEDED"
  | "MODEL_UNAVAILABLE"
  | "PROVIDER_UNAVAILABLE"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "TOKEN_LIMIT_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "CONFIGURATION_ERROR"
  | "UNKNOWN_ERROR";

export class AIProviderError extends Error {
  public readonly code: AIErrorCode;
  public readonly provider: AIProviderType;
  public readonly statusCode?: number;
  public readonly retryable: boolean;
  public readonly originalError?: unknown;

  constructor(params: {
    message: string;
    code: AIErrorCode;
    provider: AIProviderType;
    statusCode?: number;
    retryable?: boolean;
    originalError?: unknown;
  }) {
    super(params.message);
    this.name = "AIProviderError";
    this.code = params.code;
    this.provider = params.provider;
    this.statusCode = params.statusCode;
    this.retryable = params.retryable ?? false;
    this.originalError = params.originalError;
  }
}

export interface AIGenerateOptions {
  prompt: string;
  systemInstruction?: string;
  maxOutputTokens?: number;
  temperature?: number;
  responseFormat?: "json" | "text";
  timeoutMs?: number;
  stopSequences?: string[];
  model?: string;
}

export interface AIGenerateResult {
  text: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  model: string;
  provider: AIProviderType;
  durationMs: number;
  isUsageEstimated: boolean;
}

export interface AIConnectionTestResult {
  success: boolean;
  provider: AIProviderType;
  model: string;
  latencyMs: number;
  error?: string;
}

export interface AIProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string; // For Ollama or custom endpoints
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface AIProvider {
  readonly providerType: AIProviderType;
  readonly defaultModel: string;

  generateText(options: AIGenerateOptions): Promise<AIGenerateResult>;
  testConnection(): Promise<AIConnectionTestResult>;
}

