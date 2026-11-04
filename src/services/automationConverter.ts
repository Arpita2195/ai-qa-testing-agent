import { z } from "zod";
import { callGeminiWithRetry } from "./generator";
import { validateMobileDsl } from "./mobile/mobileDsl";

export const webAutomationSchema = z.object({
  target_type: z.literal("web"),
  web_steps: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1).default(1.0),
  reasoning: z.string().optional(),
});

export const apiAutomationSchema = z.object({
  target_type: z.literal("api"),
  api_method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  api_path: z.string().min(1),
  api_headers: z.record(z.string(), z.string()).default({}),
  api_body: z.unknown().optional(),
  api_expected_status: z.number().int().min(100).max(599).default(200),
  api_expected_fields: z.record(
    z.string(),
    z.enum(["string", "number", "boolean", "object", "array"]),
  ).default({}),
  api_max_response_ms: z.number().int().positive().nullable().optional(),
  confidence: z.number().min(0).max(1).default(1.0),
  reasoning: z.string().optional(),
});

export const mobileAutomationSchema = z.object({
  target_type: z.literal("mobile"),
  app_package: z.string().min(1).default("com.android.settings"),
  app_activity: z.string().optional(),
  device_udid: z.string().optional(),
  platform: z.enum(["android", "ios"]).default("android"),
  mobile_steps: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1).default(1.0),
  reasoning: z.string().optional(),
});

export const testCaseAutomationSchema = z.discriminatedUnion("target_type", [
  webAutomationSchema,
  apiAutomationSchema,
  mobileAutomationSchema,
]);

export type TestCaseAutomationInput = z.infer<typeof testCaseAutomationSchema>;
export type WebAutomationInput = z.infer<typeof webAutomationSchema>;
export type ApiAutomationInput = z.infer<typeof apiAutomationSchema>;
export type MobileAutomationInput = z.infer<typeof mobileAutomationSchema>;

export class AutomationValidationError extends Error {
  public readonly errors: string[];
  constructor(message: string, errors: string[] = []) {
    super(message);
    this.name = "AutomationValidationError";
    this.errors = errors;
  }
}

export type AutomationValidationPayload =
  | {
      target_type: "web";
      web_steps?: string[];
      confidence?: number;
      reasoning?: string;
    }
  | {
      target_type: "api";
      api_method?: string;
      api_path?: string;
      api_headers?: Record<string, string>;
      api_body?: unknown;
      api_expected_status?: number;
      api_expected_fields?: Record<string, string>;
      api_max_response_ms?: number | null;
      api_steps?: Array<{
        name?: string;
        method: string;
        path: string;
        headers?: Record<string, string>;
        body?: unknown;
        expected_status?: number;
        expected_fields?: Record<string, string>;
        max_response_ms?: number | null;
        extract?: Record<string, string>;
      }>;
      confidence?: number;
      reasoning?: string;
    }
  | {
      target_type: "mobile";
      app_package?: string;
      app_activity?: string;
      device_udid?: string;
      platform?: "android" | "ios";
      mobile_steps?: string[];
      confidence?: number;
      reasoning?: string;
    };

/**
 * Validates AI-generated or user-edited automation instructions before execution.
 * Enforces strict DSL grammar and completely blocks arbitrary code, shell commands, or protocol attacks.
 */
export function validateAutomationInstructions(
  automation: AutomationValidationPayload,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (automation.target_type === "web") {
    if (!automation.web_steps || automation.web_steps.length === 0) {
      errors.push("Web automation must contain at least one actionable step.");
      return { valid: false, errors };
    }

    const allowedPrefixes = [
      "goto ",
      "click ",
      "fill ",
      "select ",
      "expect visible ",
      "expect not visible ",
      "expect text ",
      "expect invalid ",
      "wait ",
      "wait for selector ",
      "wait for navigation",
      "check ",
      "uncheck ",
      "screenshot",
      "upload ",
      "frame ",
      "dialog accept",
      "dialog dismiss",
    ];

    for (let i = 0; i < automation.web_steps.length; i++) {
      const step = automation.web_steps[i].trim();
      const matchingPrefix = allowedPrefixes.find((p) => step.startsWith(p));
      if (!matchingPrefix) {
        errors.push(
          `Step ${i + 1}: Invalid or forbidden step instruction "${step}". Must start with one of: ${allowedPrefixes.join(", ")}`,
        );
        continue;
      }

      // Security check: Never permit arbitrary script execution or dangerous protocols
      if (/javascript:|data:|file:|<script|\b(eval|process|require|import|exec|spawn)\b/i.test(step)) {
        errors.push(`Step ${i + 1}: Security violation: forbidden executable expression in step.`);
      }

      if (step.startsWith("goto ")) {
        const dest = step.slice("goto ".length).trim();
        if (!dest) {
          errors.push(`Step ${i + 1}: "goto" requires a destination path.`);
        } else if (/^[a-z]+:\/\//i.test(dest) && !/^https?:\/\//i.test(dest)) {
          errors.push(`Step ${i + 1}: Only HTTP, HTTPS, or relative paths are permitted in goto.`);
        }
      } else if (step.startsWith("fill ")) {
        const payload = step.slice("fill ".length);
        if (!payload.includes("|")) {
          errors.push(`Step ${i + 1}: "fill" step requires delimiter "|" format: fill <selector> | <value>`);
        }
      } else if (step.startsWith("select ")) {
        const payload = step.slice("select ".length);
        if (!payload.includes("|") && !payload.includes(" ")) {
          errors.push(`Step ${i + 1}: "select" step requires delimiter "|" format: select <selector> | <option>`);
        }
      } else if (step.startsWith("frame ")) {
        const payload = step.slice("frame ".length);
        if (!payload.includes("|")) {
          errors.push(`Step ${i + 1}: "frame" step requires delimiter "|" format: frame <frame_selector> | <action>`);
        }
      }
    }
  } else if (automation.target_type === "api") {
    const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];

    if (automation.api_steps && automation.api_steps.length > 0) {
      for (let i = 0; i < automation.api_steps.length; i++) {
        const step = automation.api_steps[i];
        if (!step.method || !allowedMethods.includes(step.method.toUpperCase())) {
          errors.push(`Step ${i + 1}: Unsupported HTTP method "${step.method}". Must be one of: ${allowedMethods.join(", ")}`);
        }
        if (!step.path || step.path.trim() === "") {
          errors.push(`Step ${i + 1}: API step requires a path.`);
        } else {
          const p = step.path.trim();
          if (/^[a-z]+:\/\//i.test(p) && !/^https?:\/\//i.test(p)) {
            errors.push(`Step ${i + 1}: API path contains an invalid protocol.`);
          }
          if (/localhost|127\.0\.0\.1|169\.254\.|10\.|192\.168\./i.test(p)) {
            errors.push(`Step ${i + 1}: API path targets loopback or private network address directly.`);
          }
        }
        if (
          step.expected_status !== undefined &&
          (typeof step.expected_status !== "number" || step.expected_status < 100 || step.expected_status > 599)
        ) {
          errors.push(`Step ${i + 1}: Invalid expected status code: ${step.expected_status}`);
        }
      }
    } else {
      if (!automation.api_method || !allowedMethods.includes(automation.api_method)) {
        errors.push(`Unsupported HTTP method "${automation.api_method}". Must be one of: ${allowedMethods.join(", ")}`);
      }

      if (!automation.api_path || automation.api_path.trim() === "") {
        errors.push("API automation requires a path.");
      } else {
        const p = automation.api_path.trim();
        if (/^[a-z]+:\/\//i.test(p) && !/^https?:\/\//i.test(p)) {
          errors.push("API path contains an invalid protocol. Only relative paths or HTTP/HTTPS are allowed.");
        }
        if (/localhost|127\.0\.0\.1|169\.254\.|10\.|192\.168\./i.test(p)) {
          errors.push("API path targets loopback or private network address directly.");
        }
      }

      if (
        typeof automation.api_expected_status !== "number" ||
        automation.api_expected_status < 100 ||
        automation.api_expected_status > 599
      ) {
        errors.push(`Invalid expected HTTP status code: ${automation.api_expected_status}`);
      }
    }
  } else if (automation.target_type === "mobile") {
    if (!automation.mobile_steps || automation.mobile_steps.length === 0) {
      errors.push("Mobile automation must contain at least one actionable step.");
      return { valid: false, errors };
    }
    const mobileCheck = validateMobileDsl(automation.mobile_steps);
    if (!mobileCheck.valid) {
      errors.push(...mobileCheck.errors);
    }
  }

  return { valid: errors.length === 0, errors };
}

export interface TestCaseForAutomation {
  title: string;
  description?: string | null;
  preconditions?: string | null;
  steps: string[];
  expected_result?: string | null;
  test_type?: string | null;
}

export interface ProjectContext {
  name: string;
  base_url: string;
}

/**
 * Heuristic classifier to determine whether a test case is Web UI, REST API, or Mobile.
 */
export function classifyTestType(testCase: TestCaseForAutomation): "web" | "api" | "mobile" {
  const combined = [
    testCase.title,
    testCase.description ?? "",
    testCase.preconditions ?? "",
    ...(testCase.steps ?? []),
    testCase.expected_result ?? "",
  ].join(" ").toLowerCase();

  const mobilePatterns = [
    /\b(android|ios|appium|emulator|apk|mobile app|mobile application|touchscreen|uiautomator|xcuitest)\b/i,
    /\b(tap|swipe|scroll up|scroll down|press back|press home)\b/i,
    /\b(app launch|app close|device|com\.[a-z0-9_]+)\b/i,
  ];

  const apiPatterns = [
    /\b(api|rest|endpoint|http|payload|header|status code|json|get|post|put|patch|delete)\b/i,
    /\/api\//i,
    /\b(200 ok|201 created|400 bad request|401 unauthorized|403 forbidden|404 not found)\b/i,
    /curl\b/i,
  ];

  const webPatterns = [
    /\b(click|button|input|form|dropdown|select|page|modal|dialog|view|screen|navigate|browser|login form|checkbox)\b/i,
    /\b(visible|displayed|hidden|ui)\b/i,
  ];

  let mobileScore = 0;
  let apiScore = 0;
  let webScore = 0;

  for (const p of mobilePatterns) {
    if (p.test(combined)) mobileScore += 3;
  }
  for (const p of apiPatterns) {
    if (p.test(combined)) apiScore += 2;
  }
  for (const p of webPatterns) {
    if (p.test(combined)) webScore += 2;
  }

  // If specific HTTP method is mentioned as a step or title
  if (/\b(get|post|put|patch|delete)\s+\/[a-z0-9_-]/i.test(combined)) {
    apiScore += 4;
  }

  if (mobileScore > apiScore && mobileScore > webScore) {
    return "mobile";
  }
  return apiScore > webScore ? "api" : "web";
}

/**
 * Builds deterministic fallback automation when AI is unavailable or offline.
 */
export function generateFallbackAutomation(
  testCase: TestCaseForAutomation,
  targetType: "web" | "api" | "mobile",
): TestCaseAutomationInput {
  if (targetType === "mobile") {
    const steps: string[] = ["app launch com.android.settings"];
    for (const s of testCase.steps) {
      const trimmed = s.trim();
      if (/tap|click|press/i.test(trimmed)) {
        const item = trimmed.replace(/^(tap|click|press)\s+(on\s+)?/i, "").trim() || "OK";
        steps.push(`tap text:${item}`);
      } else if (/type|fill|enter/i.test(trimmed)) {
        const val = /password/i.test(trimmed) ? "{{APP_PASSWORD}}" : "test-input";
        steps.push(`type id:android:id/input | ${val}`);
      } else if (/swipe|scroll/i.test(trimmed)) {
        steps.push("scroll down");
      }
    }
    if (testCase.expected_result) {
      const textSnippet = testCase.expected_result.split(/[.,;\n]/)[0].trim().slice(0, 30);
      steps.push(`expect text ${textSnippet || "Settings"}`);
    } else {
      steps.push("expect visible id:android:id/content");
    }

    return {
      target_type: "mobile",
      app_package: "com.android.settings",
      platform: "android",
      mobile_steps: steps,
      confidence: 0.85,
      reasoning: "Rule-based mobile automation steps translated from requirement instructions.",
    };
  }

  if (targetType === "api") {
    // Determine method from text
    let method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" = "GET";
    const text = (
      testCase.title +
      " " +
      testCase.steps.join(" ") +
      " " +
      (testCase.expected_result ?? "")
    ).toUpperCase();
    if (text.includes("POST") || text.includes("CREATE")) method = "POST";
    else if (text.includes("PUT") || text.includes("UPDATE")) method = "PUT";
    else if (text.includes("PATCH")) method = "PATCH";
    else if (text.includes("DELETE") || text.includes("REMOVE")) method = "DELETE";

    // Determine status
    let expectedStatus = 200;
    if (testCase.test_type === "negative" || text.includes("400") || text.includes("INVALID")) expectedStatus = 400;
    else if (text.includes("401") || text.includes("UNAUTHORIZED")) expectedStatus = 401;
    else if (text.includes("403") || text.includes("FORBIDDEN")) expectedStatus = 403;
    else if (text.includes("404") || text.includes("NOT FOUND")) expectedStatus = 404;
    else if (method === "POST" && (testCase.test_type === "positive" || text.includes("201"))) expectedStatus = 201;

    // Extract path if present
    const pathMatch = testCase.title.match(/(\/[a-zA-Z0-9_\-\/]+)/) ||
      testCase.steps.join(" ").match(/(\/[a-zA-Z0-9_\-\/]+)/);
    const path = pathMatch ? pathMatch[1] : "/api/test";

    return {
      target_type: "api",
      api_method: method,
      api_path: path,
      api_headers: { "Content-Type": "application/json" },
      api_body: method !== "GET" ? {} : null,
      api_expected_status: expectedStatus,
      api_expected_fields: {},
      api_max_response_ms: 5000,
      confidence: 0.85,
      reasoning: "Rule-based automation template derived from requirement steps and expected result.",
    };
  }

  // Web fallback: translate steps into safe DSL commands
  const steps: string[] = ["goto /"];
  for (const s of testCase.steps) {
    const trimmed = s.trim();
    if (/navigate|open|visit|go to/i.test(trimmed)) {
      const route = trimmed.match(/\/([a-zA-Z0-9_\-\/]*)/);
      if (route) steps.push(`goto /${route[1]}`);
    } else if (/fill|enter|type|input/i.test(trimmed)) {
      const hasPassword = /password/i.test(trimmed);
      const selector = hasPassword ? 'input[type="password"]' : 'input[type="text"]';
      const val = hasPassword ? "{{APP_PASSWORD}}" : "test-input";
      steps.push(`fill ${selector} | ${val}`);
    } else if (/click|submit|press|choose button/i.test(trimmed)) {
      const isSubmit = /submit|save|confirm|sign in|login/i.test(trimmed);
      steps.push(isSubmit ? 'click button[type="submit"]' : "click button");
    } else if (/select|dropdown/i.test(trimmed)) {
      steps.push("select select | 1");
    }
  }

  if (testCase.expected_result) {
    const textSnippet = testCase.expected_result.split(/[.,;\n]/)[0].trim().slice(0, 30);
    if (textSnippet.length > 3) {
      steps.push(`expect text ${textSnippet}`);
    } else {
      steps.push("expect visible body");
    }
  } else {
    steps.push("expect visible body");
  }

  return {
    target_type: "web",
    web_steps: steps,
    confidence: 0.85,
    reasoning: "Rule-based browser automation steps translated from requirement instructions.",
  };
}

/**
 * Converts an approved requirement test case into executable automation instructions using Gemini AI.
 */
export async function convertTestCaseToAutomation(
  testCase: TestCaseForAutomation,
  project: ProjectContext,
): Promise<TestCaseAutomationInput> {
  const prompt = `You are a Senior QA Automation Architect. Convert the following approved requirements test case into executable automated test instructions.

Target Application Context:
- Project Name: ${project.name}
- Base URL: ${project.base_url}

Approved Test Case Details:
- Title: ${testCase.title}
- Requirement Description: ${testCase.description ?? "N/A"}
- Preconditions: ${testCase.preconditions ?? "N/A"}
- Test Scenario Type: ${testCase.test_type ?? "positive"}
- Manual Test Steps:
${testCase.steps.map((s, idx) => `  ${idx + 1}. ${s}`).join("\n")}
- Expected Result: ${testCase.expected_result ?? "N/A"}

Your Task:
1. Identify whether this test case is a "web" UI interaction test, an "api" HTTP test, or a "mobile" app test (Android/iOS emulator, gestures, screen interactions).
2. For "web" UI tests, generate Playwright-compatible step strings using ONLY the following safe grammar:
   - "goto <relative_path>" (e.g. "goto /login", "goto /dashboard")
   - "click <css_selector>" (e.g. "click button[type=\\"submit\\"]", "click #login-btn", "click a.nav-link")
   - "fill <css_selector> | <value>" (e.g. "fill input[name=\\"email\\"] | user@example.com", "fill input[type=\\"password\\"] | {{APP_PASSWORD}}")
   - "select <css_selector> | <option_value>" (e.g. "select #role | manager")
   - "expect visible <css_selector>" (e.g. "expect visible .dashboard-container")
   - "expect not visible <css_selector>" (e.g. "expect not visible .error-modal")
   - "expect text <exact_or_partial_text>" (e.g. "expect text Welcome back")
   - "expect invalid <css_selector>" (e.g. "expect invalid input[name=\\"email\\"]")
   DO NOT output arbitrary JavaScript, eval, shell scripts, or selectors with script tags.

3. For "api" tests, generate a structured HTTP request:
   - "api_method": "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
   - "api_path": relative endpoint path (e.g. "/api/v1/auth/login")
   - "api_headers": HTTP headers object (e.g. {"Content-Type": "application/json"})
   - "api_body": JSON object or string (null for GET)
   - "api_expected_status": Integer expected HTTP status code (e.g. 200, 201, 400, 401, 404)
   - "api_expected_fields": Mapping of expected JSON fields to types ("string", "number", "boolean", "object", "array")
   - "api_max_response_ms": Timeout threshold in ms (e.g. 5000)

4. For "mobile" tests, generate Appium Mobile DSL steps using ONLY the safe grammar:
   - "app launch <appPackage>" (e.g. "app launch com.android.settings")
   - "tap <selector>" (e.g. "tap text:Network & internet", "tap id:android:id/button1")
   - "type <selector> | <text>" (e.g. "type id:com.android.settings:id/search_src_text | Display")
   - "clear <selector>"
   - "scroll <up|down|left|right>"
   - "swipe <startX> <startY> <endX> <endY>"
   - "expect visible <selector>"
   - "expect not visible <selector>"
   - "expect text <expectedText>" or "expect text <selector> | <expectedText>"
   - "wait <ms>"
   - "press <back|home|enter>"
   - "screenshot"
   DO NOT output adb commands, shell commands, eval, or raw code.

Return ONLY a valid JSON object matching this schema:
For Web:
{
  "target_type": "web",
  "web_steps": ["goto /path", "fill ...", "click ...", "expect text ..."],
  "confidence": 0.95,
  "reasoning": "Reason for web UI classification..."
}

For API:
{
  "target_type": "api",
  "api_method": "POST",
  "api_path": "/api/...",
  "api_headers": {"Content-Type": "application/json"},
  "api_body": { ... },
  "api_expected_status": 200,
  "api_expected_fields": {"token": "string"},
  "api_max_response_ms": 3000,
  "confidence": 0.95,
  "reasoning": "Reason for API classification..."
}

For Mobile:
{
  "target_type": "mobile",
  "app_package": "com.android.settings",
  "mobile_steps": ["app launch com.android.settings", "tap text:Network & internet", "expect text Network"],
  "platform": "android",
  "confidence": 0.95,
  "reasoning": "Reason for mobile classification..."
}
`;

  try {
    const rawAiOutput = await callGeminiWithRetry(prompt);
    const jsonMatch = rawAiOutput.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Gemini AI did not return a valid JSON object");
    }

    const parsedJson = JSON.parse(jsonMatch[0]);
    const validationResult = testCaseAutomationSchema.safeParse(parsedJson);

    if (!validationResult.success) {
      throw new Error(
        `Gemini output schema validation failed: ${validationResult.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const instructionCheck = validateAutomationInstructions(validationResult.data);
    if (!instructionCheck.valid) {
      throw new AutomationValidationError(
        `AI-generated instructions failed security validation: ${instructionCheck.errors.join("; ")}`,
        instructionCheck.errors,
      );
    }

    return validationResult.data;
  } catch (error) {
    if (error instanceof AutomationValidationError) {
      throw error;
    }
    // Fall back to rule-based template generation so workflow is not halted
    const predictedType = classifyTestType(testCase);
    const fallback = generateFallbackAutomation(testCase, predictedType);
    fallback.reasoning = `Fallback generator: ${error instanceof Error ? error.message : String(error)}`;
    return fallback;
  }
}
