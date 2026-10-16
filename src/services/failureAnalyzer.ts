import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "../config/env";

export interface FailureAnalysisInput {
  title: string;
  steps: string[];
  expected_result: string | null;
  errorMessage: string;
  pageUrl: string;
  pageText?: string;
}

const failureAnalysisSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.enum(["low", "medium", "high", "critical"]),
  classification: z.enum(["product_bug", "test_issue", "environment_issue", "unknown"]),
  probable_cause: z.string().min(1),
  reproduction_steps: z.array(z.string()),
});

async function callGemini(prompt: string): Promise<string> {
  const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const response = await client.models.generateContent({
    model: env.AI_MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json" },
  });

  if (!response.text) {
    throw new Error("Gemini returned an empty failure analysis");
  }

  return response.text;
}

export async function analyzeFailure(
  input: FailureAnalysisInput,
): Promise<z.infer<typeof failureAnalysisSchema>> {
  const prompt = `Analyze this test failure and return JSON only with exactly these fields: "title", "description", "severity" ("low", "medium", "high", or "critical"), "classification" ("product_bug", "test_issue", "environment_issue", or "unknown"), "probable_cause", and "reproduction_steps" (array of strings).

The test runner has already determined that this test failed. Do not decide or change its pass/fail status. Base your explanation only on the given data and do not invent evidence. An expected text being absent from the page is not, by itself, proof of a product bug; classify it as a test issue when the test expectation itself is unsupported by the supplied page data. Use classification "unknown" when unsure.

Failure data:
${JSON.stringify(input)}`;

  const responseText = await callGemini(prompt);
  let parsed: unknown;

  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error("Gemini returned invalid JSON for failure analysis");
  }

  const result = failureAnalysisSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Gemini returned an invalid failure analysis: ${details}`);
  }

  return result.data;
}
