import { type AIProviderType } from "./types";

/**
 * Standard token pricing rates per 1M tokens (USD)
 */
export interface ProviderRate {
  promptRatePerMillion: number;
  completionRatePerMillion: number;
}

export interface ProviderPricingInfo {
  provider: AIProviderType;
  model: string;
  promptRatePerMillion: number;
  completionRatePerMillion: number;
  isFreeApi: boolean;
  note: string;
}

export const DEFAULT_RATES: Record<string, ProviderRate> = {
  // Gemini
  "gemini-2.5-flash": { promptRatePerMillion: 0.075, completionRatePerMillion: 0.3 },
  "gemini-1.5-flash": { promptRatePerMillion: 0.075, completionRatePerMillion: 0.3 },
  "gemini-1.5-pro": { promptRatePerMillion: 3.5, completionRatePerMillion: 10.5 },
  "gemini-2.5-pro": { promptRatePerMillion: 3.5, completionRatePerMillion: 10.5 },

  // OpenAI
  "gpt-4o": { promptRatePerMillion: 2.5, completionRatePerMillion: 10.0 },
  "gpt-4o-mini": { promptRatePerMillion: 0.15, completionRatePerMillion: 0.6 },
  "gpt-4-turbo": { promptRatePerMillion: 10.0, completionRatePerMillion: 30.0 },
  "gpt-3.5-turbo": { promptRatePerMillion: 0.5, completionRatePerMillion: 1.5 },

  // Ollama (local execution - zero third-party API fee)
  "ollama": { promptRatePerMillion: 0.0, completionRatePerMillion: 0.0 },

  // Groq
  "openai/gpt-oss-120b": { promptRatePerMillion: 0.15, completionRatePerMillion: 0.60 },
  "llama-3.3-70b-versatile": { promptRatePerMillion: 0.59, completionRatePerMillion: 0.79 },
  "llama-3.1-8b-instant": { promptRatePerMillion: 0.05, completionRatePerMillion: 0.08 },
  "mixtral-8x7b-32768": { promptRatePerMillion: 0.24, completionRatePerMillion: 0.24 },
};

/**
 * Resolves pricing information and disclosures for a given provider and model.
 */
export function getProviderPricing(
  provider: AIProviderType,
  model = "",
): ProviderPricingInfo {
  if (provider === "ollama") {
    return {
      provider: "ollama",
      model: model || "llama3.2",
      promptRatePerMillion: 0,
      completionRatePerMillion: 0,
      isFreeApi: true,
      note: "Local execution incurs no third-party API token fees (local hardware and electricity costs apply).",
    };
  }

  const normalizedModel = model.toLowerCase();
  let rate = DEFAULT_RATES[normalizedModel];

  if (!rate) {
    if (provider === "openai") {
      rate = normalizedModel.includes("mini")
        ? { promptRatePerMillion: 0.15, completionRatePerMillion: 0.6 }
        : { promptRatePerMillion: 2.5, completionRatePerMillion: 10.0 };
    } else if (provider === "groq") {
      rate = normalizedModel.includes("8b")
        ? { promptRatePerMillion: 0.05, completionRatePerMillion: 0.08 }
        : { promptRatePerMillion: 0.59, completionRatePerMillion: 0.79 };
    } else {
      // Gemini default
      rate = normalizedModel.includes("pro")
        ? { promptRatePerMillion: 3.5, completionRatePerMillion: 10.5 }
        : { promptRatePerMillion: 0.075, completionRatePerMillion: 0.3 };
    }
  }

  return {
    provider,
    model: model || "default",
    promptRatePerMillion: rate.promptRatePerMillion,
    completionRatePerMillion: rate.completionRatePerMillion,
    isFreeApi: false,
    note: "Estimated pricing based on published token rates. Actual billed amounts depend on provider invoicing.",
  };
}

/**
 * Calculates estimated cost for AI tokens in USD.
 * Note: Costs are estimations for budgeting/monitoring and do not represent exact third-party billing.
 */
export function calculateEstimatedCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  provider?: AIProviderType,
): number {
  if (provider === "ollama") return 0;

  const validPromptTokens = Math.max(0, promptTokens || 0);
  const validCompletionTokens = Math.max(0, completionTokens || 0);

  if (validPromptTokens === 0 && validCompletionTokens === 0) {
    return 0;
  }

  const normalizedModel = model.toLowerCase();
  let rate = DEFAULT_RATES[normalizedModel];

  if (!rate) {
    if (provider === "openai" || normalizedModel.includes("gpt")) {
      rate = normalizedModel.includes("mini")
        ? { promptRatePerMillion: 0.15, completionRatePerMillion: 0.6 }
        : { promptRatePerMillion: 2.5, completionRatePerMillion: 10.0 };
    } else if (provider === "groq" || normalizedModel.includes("llama") || normalizedModel.includes("mixtral")) {
      rate = normalizedModel.includes("8b")
        ? { promptRatePerMillion: 0.05, completionRatePerMillion: 0.08 }
        : { promptRatePerMillion: 0.59, completionRatePerMillion: 0.79 };
    } else if (normalizedModel.includes("pro")) {
      rate = { promptRatePerMillion: 3.5, completionRatePerMillion: 10.5 };
    } else {
      // Default to Gemini Flash rates
      rate = { promptRatePerMillion: 0.075, completionRatePerMillion: 0.3 };
    }
  }

  const promptCost = (validPromptTokens / 1_000_000) * rate.promptRatePerMillion;
  const completionCost = (validCompletionTokens / 1_000_000) * rate.completionRatePerMillion;
  return Number((promptCost + completionCost).toFixed(6));
}
