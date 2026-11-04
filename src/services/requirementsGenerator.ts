import { z } from "zod";
import { callGeminiWithRetry, isRetryableGeminiError } from "./generator";
import { redactSecrets } from "./runner";

export const requirementTestCaseSchema = z.object({
  title: z.string().min(1).max(255),
  requirement_description: z.string().min(1),
  preconditions: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  expected_result: z.string().min(1),
  priority: z.enum(["low", "medium", "high", "critical"]),
  test_type: z.enum(["positive", "negative", "boundary", "edge_case"]),
});

export type RequirementTestCase = z.infer<typeof requirementTestCaseSchema>;

export const requirementTestCasesSchema = z.array(requirementTestCaseSchema).min(1).max(25);

export class RequirementsGenerationError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(message);
    this.name = "RequirementsGenerationError";
  }
}

function cleanJsonResponse(raw: string): string {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.slice(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.slice(0, -3);
  }
  return cleaned.trim();
}

/**
 * Generate comprehensive test cases from requirements text using Gemini AI.
 * Covers positive, negative, boundary, and edge-case scenarios.
 */
export async function generateTestCasesFromRequirements(
  requirementsText: string,
  projectContext?: { name?: string; baseUrl?: string },
): Promise<RequirementTestCase[]> {
  const contextSnippet = projectContext?.name
    ? `Target Project: ${projectContext.name} (${projectContext.baseUrl || "Web/API/Mobile Application"})`
    : "Target Project: Web/API/Mobile Application";

  const prompt = `You are a Principal QA Automation Engineer and Requirements Analysis Specialist.
Analyze the following Software Requirements Specification (SRS) / User Stories / Functional Requirements document.

${contextSnippet}

Generate a comprehensive, rigorous suite of test cases covering all aspects of the requirements.
You MUST provide test cases across ALL four categories:
1. "positive": Valid inputs, expected user flows, core functional criteria, successful transactions.
2. "negative": Invalid inputs, authentication/permission failures, format violations, missing required fields, error handling.
3. "boundary": Min/max thresholds, zero/empty inputs, character limits, numeric boundaries (e.g. 0, 1, max, max+1).
4. "edge_case": Rare race conditions, unusual sequences, special/unicode characters, session expiration, unexpected state transitions.

Requirements Document:
"""
${requirementsText.slice(0, 30000)}
"""

Return a JSON array where each object strictly has the following structure:
[
  {
    "title": "Clear and descriptive test case title",
    "requirement_description": "The specific requirement or business rule being validated",
    "preconditions": "Initial setup, account status, or environment condition required before test execution",
    "steps": [
      "Step 1: Navigate to ... or Action ...",
      "Step 2: Enter ...",
      "Step 3: Click ..."
    ],
    "expected_result": "Exact verifiable assertion or system behavior",
    "priority": "critical" | "high" | "medium" | "low",
    "test_type": "positive" | "negative" | "boundary" | "edge_case"
  }
]

CRITICAL RULES:
- Return ONLY the valid JSON array. Do not include markdown code blocks or explanatory text.
- Generate between 5 and 15 high-value, non-duplicate test cases.
- Every test case must have clear, actionable steps.
- Prioritize:
  - "critical": Core business paths, authentication, data loss prevention.
  - "high": Key functionality and major negative validations.
  - "medium": Boundary tests and standard validations.
  - "low": Minor formatting and edge cases.`;

  let responseText: string;
  try {
    responseText = await callGeminiWithRetry(prompt);
  } catch (error) {
    if (isRetryableGeminiError(error)) {
      throw new RequirementsGenerationError(
        "AI service is temporarily busy or rate limited. Please try again in a few moments.",
        error,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new RequirementsGenerationError(`AI model error during requirement analysis: ${message}`, error);
  }

  const cleaned = cleanJsonResponse(responseText);

  let rawParsed: unknown;
  try {
    rawParsed = JSON.parse(cleaned);
  } catch (parseError) {
    throw new RequirementsGenerationError(
      "AI model output was not valid JSON. Please try again with clearer requirement text.",
      cleaned.slice(0, 500),
    );
  }

  const validated = requirementTestCasesSchema.safeParse(rawParsed);
  if (!validated.success) {
    // If array has some valid items and some invalid, attempt to recover valid items
    if (Array.isArray(rawParsed)) {
      const recovered: RequirementTestCase[] = [];
      for (const item of rawParsed) {
        const itemResult = requirementTestCaseSchema.safeParse(item);
        if (itemResult.success) {
          recovered.push(itemResult.data);
        }
      }
      if (recovered.length >= 2) {
        return recovered.map(sanitizeTestCase);
      }
    }
    throw new RequirementsGenerationError(
      `AI test cases failed schema validation: ${validated.error.issues.map((i) => i.message).join(", ")}`,
      validated.error.issues,
    );
  }

  return validated.data.map(sanitizeTestCase);
}

function sanitizeTestCase(tc: RequirementTestCase): RequirementTestCase {
  return {
    title: redactSecrets(tc.title).trim(),
    requirement_description: redactSecrets(tc.requirement_description).trim(),
    preconditions: redactSecrets(tc.preconditions).trim(),
    steps: tc.steps.map((step) => redactSecrets(step).trim()),
    expected_result: redactSecrets(tc.expected_result).trim(),
    priority: tc.priority,
    test_type: tc.test_type,
  };
}
