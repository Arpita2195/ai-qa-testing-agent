import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "../config/env";
import type { PageData } from "./pageReader";

const generatedTestCaseSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  steps: z.array(z.string().min(1)).min(1),
  expected_result: z.string().min(1),
});

const generatedTestCasesSchema = z.array(generatedTestCaseSchema).min(3).max(6);

async function callGemini(prompt: string): Promise<string> {
  const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const response = await client.models.generateContent({
    model: env.AI_MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json" },
  });

  if (!response.text) {
    throw new Error("Gemini returned an empty response");
  }

  return response.text;
}

function validateSteps(pageData: PageData, testCases: z.infer<typeof generatedTestCasesSchema>): void {
  const selectors = new Set(pageData.elements.map((element) => element.selector));
  const visibleText = [pageData.title, pageData.text, ...pageData.elements.map((element) => element.text)];
  const pagePath = new URL(pageData.url).pathname;

  for (const [testCaseIndex, testCase] of testCases.entries()) {
    for (const [stepIndex, step] of testCase.steps.entries()) {
      if (step.startsWith("goto ")) {
        const path = step.slice("goto ".length).trim();
        if (!path.startsWith("/")) {
          throw new Error(`Generated test case ${testCaseIndex + 1}, step ${stepIndex + 1}: goto path must start with "/"`);
        }
        if (path !== pagePath) {
          throw new Error(`Generated test case ${testCaseIndex + 1}, step ${stepIndex + 1}: path "${path}" is not present in the page data`);
        }
        continue;
      }

      if (step.startsWith("click ")) {
        const selector = step.slice("click ".length).trim();
        if (!selectors.has(selector)) {
          throw new Error(`Generated test case ${testCaseIndex + 1}, step ${stepIndex + 1}: selector "${selector}" is not present in the page data`);
        }
        continue;
      }

      if (step.startsWith("fill ")) {
        const input = step.slice("fill ".length);
        const separator = input.indexOf("|");
        if (separator === -1) {
          throw new Error(`Generated test case ${testCaseIndex + 1}, step ${stepIndex + 1}: invalid fill format`);
        }

        const selector = input.slice(0, separator).trim();
        const value = input.slice(separator + 1).trim();
        if (!selectors.has(selector)) {
          throw new Error(`Generated test case ${testCaseIndex + 1}, step ${stepIndex + 1}: selector "${selector}" is not present in the page data`);
        }
        if (!visibleText.some((text) => text.includes(value))) {
          throw new Error(`Generated test case ${testCaseIndex + 1}, step ${stepIndex + 1}: fill text "${value}" is not present in the page data`);
        }
        continue;
      }

      if (step.startsWith("expect text ")) {
        const text = step.slice("expect text ".length).trim();
        if (!text || !visibleText.some((pageText) => pageText.includes(text))) {
          throw new Error(`Generated test case ${testCaseIndex + 1}, step ${stepIndex + 1}: expected text is not present in the page data`);
        }
        continue;
      }

      throw new Error(`Generated test case ${testCaseIndex + 1}, step ${stepIndex + 1}: unsupported step format "${step}"`);
    }
  }
}

export async function generateTestCases(
  pageData: PageData,
): Promise<z.infer<typeof generatedTestCasesSchema>> {
  const prompt = `Generate 3 to 6 useful browser test cases for this page. Return JSON only as an array of objects with exactly these fields: "title", "description", "steps" (array of strings), and "expected_result". Steps may use only these formats: "goto /path", "click <css selector>", "fill <css selector> | <value>", "expect text <text>". Only use selectors and text that appear in the page data. Use only the current page path for goto.

Page data:
${JSON.stringify(pageData)}`;

  const responseText = await callGemini(prompt);
  let parsedJson: unknown;

  try {
    parsedJson = JSON.parse(responseText);
  } catch {
    throw new Error("Gemini returned invalid JSON for generated test cases");
  }

  const result = generatedTestCasesSchema.safeParse(parsedJson);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Gemini returned invalid test cases: ${details}`);
  }

  validateSteps(pageData, result.data);
  return result.data;
}
