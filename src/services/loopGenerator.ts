import { randomUUID } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { pool } from "../config/db";
import { env } from "../config/env";
import { recordAiUsage } from "./observability/metricsService";
import { logger } from "./observability/logger";
import {
  callGemini,
  validatePageSteps,
  safePageData,
  generatedTestCasesSchema,
  type GeneratedTestCase,
} from "./generator";
import { getAIProviderForProject, isRetryableAIError } from "./ai/providerFactory";
import { generateAiCacheKey, getAiResponseCache, setAiResponseCache } from "./ai/aiCacheService";
import {
  assertProjectAiBudgetAvailable,
  reserveAiBudget,
  reconcileAiBudgetReservation,
  releaseAiBudgetReservation,
  startReservationHeartbeat,
  markReservationUncertain,
  isConfirmedProviderFailure,
} from "./ai/aiBudgetService";
import { executeSingleFlight } from "./ai/aiSingleFlight";
import { optimizePageElements, compactJson } from "./ai/promptOptimizer";
import { reviewCandidateBatch } from "./ai/twoStageReviewService";
import { getActiveStateTransitionsForProject } from "./ai/stateTransitionService";
import type { StateTransitionEvidenceRow } from "./ai/stateTransitionTypes";
import type { PageData, ScrapedPage, SiteData } from "./pageReader";
import { findMatchingPageForPath } from "../utils/urlPageMatcher";
import {
  discoverPageFunctionalities,
  planScenariosForFunctionality,
  persistFunctionalitiesAndScenarios,
  getProjectFunctionalities,
  getProjectScenarios,
  type DiscoveredFunctionality,
  type PlannedScenario,
} from "./functionalityPlanner";

export interface GenerationIterationMetric {
  functionalityId: string;
  functionalityName: string;
  scenariosRequested: number;
  scenariosGenerated: number;
  promptTokens: number;
  completionTokens: number;
  durationMs: number;
  estimatedCostUsd: number;
  retries: number;
  status: "success" | "partial" | "failed" | "skipped";
  error?: string;
}

export interface LoopGenerationResult {
  projectId: string;
  totalFunctionalities: number;
  completedFunctionalities: number;
  totalScenariosPlanned: number;
  totalScenariosGenerated: number;
  missingScenarios: number;
  createdTestCases: Array<{
    id: string;
    title: string;
    review_status: string;
    scenario_id?: string;
    functionality_id?: string;
  }>;
  skippedDuplicates: number;
  skippedInvalid: number;
  iterations: GenerationIterationMetric[];
  status: "completed" | "partial" | "failed";
}

export interface LoopGenerationOptions {
  projectId: string;
  appName?: string;
  maxRetriesPerFunctionality?: number;
  resume?: boolean;
  createdBy?: string;
}

/**
 * Executes an operation with project-level concurrency protection using a dedicated
 * checked-out PostgreSQL connection for advisory lock acquisition and release.
 * Ensures the exact same connection is used for both pg_try_advisory_lock and pg_advisory_unlock,
 * with guaranteed connection cleanup and release in a finally block.
 */
export async function withProjectGenerationLock<T>(
  projectId: string,
  operation: () => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false }> {
  const client = await pool.connect();
  let lockAcquired = false;
  let releaseError: Error | undefined;

  try {
    const lockRes = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext('generate_project_' || $1)) AS locked",
      [projectId],
    );
    lockAcquired = Boolean(lockRes.rows[0]?.locked);

    if (!lockAcquired) {
      return { acquired: false };
    }

    const result = await operation();
    return { acquired: true, result };
  } finally {
    if (lockAcquired) {
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtext('generate_project_' || $1))",
          [projectId],
        );
      } catch (unlockErr) {
        console.error(`[ConcurrencyLock] Failed to release advisory lock for project ${projectId}:`, unlockErr);
        releaseError = unlockErr instanceof Error ? unlockErr : new Error(String(unlockErr));
      }
    }
    client.release(releaseError);
  }
}

/**
 * Safely extracts and parses a JSON array from raw model output.
 * Handles markdown code fences and cleans leading/trailing chatter.
 */
export function extractJsonArray(rawText: string): unknown {
  let cleaned = rawText.trim();
  // Strip code fences (e.g. ```json ... ``` or ``` ...)
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  // Find outermost array bracket
  const firstBracket = cleaned.indexOf("[");
  const lastBracket = cleaned.lastIndexOf("]");
  if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
    cleaned = cleaned.slice(firstBracket, lastBracket + 1);
  }
  return JSON.parse(cleaned);
}

/**
 * Builds a compact, feature-focused prompt for a specific functionality and its planned scenarios.
 * Avoids sending the entire page or unrelated DOM elements.
 */
function buildFunctionalityPrompt(
  func: DiscoveredFunctionality,
  scenarios: PlannedScenario[],
  appName: string,
): string {
  const scenarioList = scenarios
    .map(
      (s, idx) =>
        `${idx + 1}. [Scenario ID: "${s.scenarioId}"] (${s.category.toUpperCase()} - Priority: ${s.priority})\n   Title: ${s.title}\n   Expected Behavior: ${s.expectedBehavior}`,
    )
    .join("\n");

  const compactElements = func.elements.map((el) => ({
    tag: el.tag,
    text: el.text ? el.text.slice(0, 80) : "",
    selector: el.selector,
    type: el.type,
    name: el.name,
    placeholder: el.placeholder,
    options: el.options?.slice(0, 10),
  }));

  const optimizedElements = optimizePageElements(compactElements);

  return `You are a QA automation engineer generating browser test cases.
Generate realistic browser test cases for this specific application feature:
Feature: "${func.name}"
Category: ${func.category}
Page Path: "${func.pagePath}"

You must generate test cases corresponding to these PLANNED SCENARIOS:
${scenarioList}

Return JSON ONLY as an array of objects where each object has:
- "title": string (clear, descriptive)
- "description": string (explanation of the scenario)
- "scenario_id": string (must match the planned Scenario ID from above, e.g. "${scenarios[0]?.scenarioId || "SCEN-01"}")
- "category": "${scenarios[0]?.category || "positive"}" ("positive" | "negative" | "boundary" | "edge_case")
- "priority": "${scenarios[0]?.priority || "medium"}" ("critical" | "high" | "medium" | "low")
- "steps": array of strings using ONLY these valid grammar formats:
    "goto ${func.pagePath}"
    "click <css selector>"
    "fill <css selector> | <value>"
    "expect text <text>"
- "expected_result": string (specific verification assertion)

Rules for steps:
- Use only selectors and text that exist in the provided feature elements.
- For fill steps on text fields, use clearly fake values like "Sample text" or "12345". Use {{STOCKFLOW_TEST_EMAIL}} and {{STOCKFLOW_TEST_PASSWORD}} for credentials.
- Never use generic text like "${appName}". Assert on specific labels or messages.

<FEATURE_ELEMENTS>
${compactJson(optimizedElements)}
</FEATURE_ELEMENTS>`;
}

/**
 * Executes functionality-wise loop-based AI test case generation.
 * Features:
 * - Reuses single GoogleGenAI client across iterations
 * - Functionality-by-functionality batching
 * - Deterministic completeness validation
 * - Duplicate prevention
 * - Incremental database saving
 * - Exponential backoff with jitter on rate limits
 * - Resumable generation from last completed functionality
 */
export async function runLoopGeneration(
  siteData: SiteData,
  options: LoopGenerationOptions,
): Promise<LoopGenerationResult> {
  const { projectId, appName = "StockFlow", maxRetriesPerFunctionality = 2, resume = false, createdBy } = options;

  // Resolve AI provider for this project
  const aiProvider = await getAIProviderForProject(projectId, { maxOutputTokens: 8192 });

  let functionalities: DiscoveredFunctionality[];
  let allPlannedScenarios: PlannedScenario[];

  if (resume) {
    // Load existing inventory and planned scenarios
    functionalities = await getProjectFunctionalities(projectId);
    allPlannedScenarios = await getProjectScenarios(projectId);
  } else {
    functionalities = [];
    allPlannedScenarios = [];
  }

  // If no existing inventory in DB or fresh run, discover & plan from scraped pages
  if (functionalities.length === 0) {
    for (const page of siteData.pages) {
      const pageFuncs = discoverPageFunctionalities(page, projectId);
      for (const func of pageFuncs) {
        functionalities.push(func);
        const scenarios = planScenariosForFunctionality(func);
        allPlannedScenarios.push(...scenarios);
      }
    }

    // Persist discovered inventory and scenario checklist
    await persistFunctionalitiesAndScenarios(projectId, functionalities, allPlannedScenarios);
  }

  // Preload existing test case titles and ground-truth scenario statuses for duplicate prevention & true resumability
  const existingRows = await pool.query<{ title: string; scenario_id: string | null }>(
    "SELECT title, scenario_id FROM test_cases WHERE project_id = $1",
    [projectId],
  );
  const existingTitles = new Set(existingRows.rows.map((r) => r.title.toLowerCase().trim()));
  const existingScenarioIds = new Set(
    existingRows.rows.map((r) => r.scenario_id).filter((s): s is string => Boolean(s)),
  );
  const existingCompositeKeys = new Set<string>();

  const dbScenariosRes = await pool.query<{ functionality_id: string; scenario_id: string; status: string; test_case_id: string | null }>(
    `SELECT sc.functionality_id, sc.scenario_id, sc.status, sc.test_case_id
     FROM scenario_checklists sc
     LEFT JOIN test_cases tc ON sc.test_case_id = tc.id
     WHERE sc.project_id = $1`,
    [projectId],
  );
  for (const r of dbScenariosRes.rows) {
    if (r.status === "generated" && r.test_case_id) {
      existingScenarioIds.add(r.scenario_id);
      if (r.functionality_id) {
        existingCompositeKeys.add(`${r.functionality_id}:${r.scenario_id}`);
      }
    }
  }

  // Sync in-memory planned scenarios with DB state using composite key
  for (const s of allPlannedScenarios) {
    const isGenerated =
      existingCompositeKeys.has(`${s.functionalityId}:${s.scenarioId}`) ||
      (!s.functionalityId && existingScenarioIds.has(s.scenarioId));
    if (isGenerated) {
      s.status = "generated";
    }
  }

  const createdTestCases: LoopGenerationResult["createdTestCases"] = [];
  const iterations: GenerationIterationMetric[] = [];
  let skippedDuplicates = 0;
  let skippedInvalid = 0;
  let completedFunctionalities = 0;

  // Functionality-by-functionality loop
  for (const func of functionalities) {
    // Find ungenerated scenarios for this functionality using composite key
    let funcPendingScenarios = allPlannedScenarios.filter(
      (s) =>
        s.functionalityId === func.id &&
        s.status === "planned" &&
        !existingCompositeKeys.has(`${func.id}:${s.scenarioId}`),
    );

    if (funcPendingScenarios.length === 0) {
      iterations.push({
        functionalityId: func.id,
        functionalityName: func.name,
        scenariosRequested: 0,
        scenariosGenerated: 0,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: 0,
        estimatedCostUsd: 0,
        retries: 0,
        status: "skipped",
      });
      completedFunctionalities++;
      continue;
    }

    // Find the corresponding page for step validation using deterministic page identity matching
    const pageMatch = findMatchingPageForPath(siteData.pages, func.pagePath, siteData.baseUrl);
    if (!pageMatch.page) {
      const skipReason = pageMatch.error || `Page evidence missing: No crawled page matched functionality path "${func.pagePath}"`;
      logger.warn(`No crawled page evidence matched functionality path: "${func.pagePath}"`, {
        functionalityId: func.id,
        pagePath: func.pagePath,
        error: skipReason,
      });

      for (const s of funcPendingScenarios) {
        s.status = "skipped";
        await pool.query(
          `UPDATE scenario_checklists
           SET status = 'skipped', error_message = $1, updated_at = NOW()
           WHERE project_id = $2 AND functionality_id = $3 AND scenario_id = $4 AND status = 'planned'`,
          [skipReason, projectId, func.id, s.scenarioId],
        );
      }

      await pool.query(
        `UPDATE functionality_inventory SET status = 'failed', updated_at = NOW() WHERE id = $1`,
        [func.id],
      );

      iterations.push({
        functionalityId: func.id,
        functionalityName: func.name,
        scenariosRequested: funcPendingScenarios.length,
        scenariosGenerated: 0,
        promptTokens: 0,
        completionTokens: 0,
        durationMs: 0,
        estimatedCostUsd: 0,
        retries: 0,
        status: "skipped",
        error: skipReason,
      });
      continue;
    }

    const pageObj = pageMatch.page;
    const sanitizedPage = safePageData(pageObj);

    const initialRequestedCount = funcPendingScenarios.length;
    const BATCH_SIZE = 5;
    let totalValidForFunc = 0;
    let totalPromptTokens = 0;
    let totalCompletionTokens = 0;
    let totalDurationMs = 0;
    let funcRetries = 0;
    let funcError: string | undefined;

    // Controlled Replenishment: Up to 2 passes per functionality (1 primary + 1 replenishment)
    // to recover omitted scenarios or validation-rejected candidates without unbounded loops
    const MAX_REPLENISHMENT_PASSES = 2;
    let replenishmentPass = 0;

    while (replenishmentPass < MAX_REPLENISHMENT_PASSES && funcPendingScenarios.length > 0) {
      replenishmentPass++;
      const currentBatchTarget = [...funcPendingScenarios];
      let passValidCount = 0;

      for (let b = 0; b < currentBatchTarget.length; b += BATCH_SIZE) {
        const scenarioBatch = currentBatchTarget.slice(b, b + BATCH_SIZE);
      const prompt = buildFunctionalityPrompt(func, scenarioBatch, appName);
      let attempts = 0;
      let batchSuccess = false;
      let generatedCasesForBatch: GeneratedTestCase[] = [];
      let promptTokens = Math.ceil(prompt.length / 4);
      let completionTokens = 0;
      let durationMs = 0;
      let lastError: string | undefined;
      let fromCache = false;

      // 1. Generate cache key
      const cacheKey = generateAiCacheKey({
        projectId,
        provider: aiProvider.providerType,
        model: aiProvider.defaultModel || env.AI_MODEL,
        feature: "loop_test_generation",
        prompt,
        responseFormat: "json",
        maxOutputTokens: 8192,
      });

      // 2. Check AI response cache
      try {
        const cached = await getAiResponseCache(projectId, cacheKey);
        if (cached) {
          const parsedJson = extractJsonArray(cached.text);
          const parseResult = generatedTestCasesSchema.safeParse(parsedJson);
          if (parseResult.success) {
            generatedCasesForBatch = parseResult.data;
            batchSuccess = true;
            promptTokens = cached.promptTokens;
            completionTokens = cached.completionTokens;
            durationMs = 0;
            fromCache = true;
          }
        }
      } catch {
        // Cache miss or parse error, fall through to provider generation
      }

      // 3. Provider invocation if not served from cache
      while (attempts <= maxRetriesPerFunctionality && !batchSuccess) {
        attempts++;
        const t0 = Date.now();
        // Atomically reserve AI budget before provider invocation
        const reservation = await reserveAiBudget(projectId, {
          estimatedTokens: 8000,
          estimatedCostUsd: 0.0008,
          feature: "loop_test_generation",
          actorId: createdBy,
        });

        // Start heartbeat to keep reservation active during long requests (>5 minutes)
        const heartbeat = startReservationHeartbeat(reservation.id, reservation.ownerToken, 45000, 300);

        try {
          const flightResult = await executeSingleFlight(
            `loop:${projectId}:${cacheKey}`,
            async () => {
              return await aiProvider.generateText({
                prompt,
                responseFormat: "json",
                maxOutputTokens: 8192,
              });
            },
            {
              projectId,
              onCacheCheck: async () => {
                const c = await getAiResponseCache(projectId, cacheKey);
                if (c) {
                  return {
                    text: c.text,
                    promptTokens: c.promptTokens,
                    completionTokens: c.completionTokens,
                    totalTokens: c.totalTokens,
                    durationMs: 0,
                    provider: c.provider,
                    model: c.model,
                    estimatedCostUsd: c.estimatedCostUsd,
                  };
                }
                return null;
              },
            },
          );
          const genResult = flightResult.result;

          durationMs = genResult.durationMs || Date.now() - t0;
          promptTokens = genResult.promptTokens;
          completionTokens = genResult.completionTokens;
          const responseText = genResult.text;

          let parsedJson: unknown;
          try {
            parsedJson = extractJsonArray(responseText);
          } catch {
            throw new Error("Invalid or truncated JSON response from AI provider");
          }

          const parseResult = generatedTestCasesSchema.safeParse(parsedJson);
          if (!parseResult.success) {
            throw new Error(`Generated output did not conform to test case schema: ${parseResult.error.message}`);
          }

          generatedCasesForBatch = parseResult.data;
          batchSuccess = true;

          // Reconcile budget reservation and record committed usage
          await reconcileAiBudgetReservation(
            reservation.id,
            {
              promptTokens,
              completionTokens,
              estimatedCostUsd: genResult.estimatedCostUsd,
              model: genResult.model || aiProvider.defaultModel || env.AI_MODEL,
              provider: genResult.provider || aiProvider.providerType,
              feature: "loop_test_generation",
              durationMs,
              createdBy,
            },
            reservation.ownerToken,
          );

          // Save valid response to cache
          await setAiResponseCache({
            projectId,
            cacheKey,
            provider: genResult.provider || aiProvider.providerType,
            model: genResult.model || aiProvider.defaultModel || env.AI_MODEL,
            feature: "loop_test_generation",
            prompt,
            responseText,
            promptTokens,
            completionTokens,
            estimatedCostUsd: genResult.estimatedCostUsd,
          });
        } catch (err) {
          if (isConfirmedProviderFailure(err)) {
            await releaseAiBudgetReservation(reservation.id, reservation.ownerToken);
          } else {
            const reason = err instanceof Error ? err.message : String(err);
            await markReservationUncertain(reservation.id, reason, reservation.ownerToken);
          }
          lastError = err instanceof Error ? err.message : String(err);
          const isRetryable =
            isRetryableAIError(err) ||
            err instanceof SyntaxError ||
            (err instanceof Error && err.message.toLowerCase().includes("json"));

          if (attempts <= maxRetriesPerFunctionality && isRetryable) {
            const delay = Math.pow(2, attempts) * 1000 + Math.random() * 500;
            logger.warn(
              `AI generation for ${func.name} (batch ${Math.floor(b / BATCH_SIZE) + 1}) encountered retryable issue: ${lastError}. Retrying in ${Math.round(delay)}ms...`,
              { error: lastError, attempt: attempts },
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else if (!isRetryable) {
            break;
          }
        } finally {
          heartbeat.stop();
        }
      }

      totalPromptTokens += promptTokens;
      totalCompletionTokens += completionTokens;
      totalDurationMs += durationMs;
      funcRetries += Math.max(0, attempts - 1);

      if (!batchSuccess || generatedCasesForBatch.length === 0) {
        funcError = lastError || "Failed to generate valid test cases";
        if (replenishmentPass >= MAX_REPLENISHMENT_PASSES) {
          // Mark failed scenarios in DB on final pass
          await pool.query(
            `UPDATE scenario_checklists
             SET status = 'failed', error_message = $1, updated_at = NOW()
             WHERE project_id = $2 AND functionality_id = $3 AND scenario_id = ANY($4::varchar[]) AND status = 'planned'`,
            [funcError, projectId, func.id, scenarioBatch.map((s) => s.scenarioId)],
          );
          for (const s of scenarioBatch) {
            if (s.status === "planned") s.status = "failed";
          }
        }
        continue;
      }

      // Two-Stage Review: Audit candidate test cases with Groq independent reviewer
      let funcTransitions: StateTransitionEvidenceRow[] = [];
      try {
        funcTransitions = await getActiveStateTransitionsForProject(pool, projectId, {
          functionalityId: func.id,
          pagePath: func.pagePath,
        });
      } catch {
        funcTransitions = [];
      }

      const reviewedCandidates = await reviewCandidateBatch({
        projectId,
        candidates: generatedCasesForBatch.map((tc) => ({
          title: tc.title,
          description: tc.description,
          steps: tc.steps,
          expected_result: tc.expected_result,
          category: tc.category,
          priority: tc.priority,
          scenario_id: tc.scenario_id,
          functionality_id: func.id,
          preconditions: tc.preconditions,
          test_data: tc.test_data,
        })),
        evidence: {
          source: "crawler_dom",
          appName,
          page: sanitizedPage,
          pagePath: func.pagePath,
          functionalityName: func.name,
          elements: func.elements,
          transitions: funcTransitions,
        },
        actorId: createdBy,
      });

      // Deterministic validation & incremental saving for this batch
      const plannedScenarioMap = new Map(scenarioBatch.map((s) => [s.scenarioId, s]));

      for (const testCase of reviewedCandidates) {
        // 1. Duplicate title check
        const normalizedTitle = testCase.title.toLowerCase().trim();
        if (existingTitles.has(normalizedTitle)) {
          skippedDuplicates++;
          continue;
        }

        // 2. Step syntax and DOM validation
        try {
          validatePageSteps(sanitizedPage, testCase, appName);
        } catch {
          skippedInvalid++;
          continue;
        }

        // 3. Match scenario ID or map to first available ungenerated planned scenario in batch
        const matchedScenario =
          testCase.scenario_id && plannedScenarioMap.has(testCase.scenario_id)
            ? plannedScenarioMap.get(testCase.scenario_id)!
            : scenarioBatch.find((s) => s.status === "planned") || scenarioBatch[0];

        // Prepare final steps with login prepended if needed
        let finalSteps: string[];
        if (siteData.isLoggedIn && siteData.loginSteps.length > 0) {
          const remainingSteps = testCase.steps.filter(
            (step, index) => !(index === 0 && step.startsWith("goto ")),
          );
          finalSteps = [...siteData.loginSteps, `goto ${func.pagePath}`, ...remainingSteps];
        } else {
          finalSteps = testCase.steps;
        }

        // 4. Incremental database insert (Always in Pending human QA review_status)
        const insertRes = await pool.query<{ id: string; title: string; review_status: string }>(
          `INSERT INTO test_cases
             (id, project_id, title, description, steps, expected_result, review_status,
              functionality_id, scenario_id, priority, test_type, ai_review_metadata)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10)
           RETURNING id, title, review_status`,
          [
            projectId,
            testCase.title,
            testCase.description,
            JSON.stringify(finalSteps),
            testCase.expected_result,
            func.id,
            matchedScenario.scenarioId,
            testCase.priority || matchedScenario.priority || "medium",
            testCase.category || matchedScenario.category || "positive",
            JSON.stringify(testCase.ai_review_metadata),
          ],
        );

        const savedRow = insertRes.rows[0];
        if (savedRow) {
          createdTestCases.push({
            id: savedRow.id,
            title: savedRow.title,
            review_status: savedRow.review_status,
            scenario_id: matchedScenario.scenarioId,
            functionality_id: func.id,
          });

          existingTitles.add(normalizedTitle);
          existingScenarioIds.add(matchedScenario.scenarioId);
          existingCompositeKeys.add(`${func.id}:${matchedScenario.scenarioId}`);

          // Update scenario checklist status to 'generated' and link test_case_id
          await pool.query(
            `UPDATE scenario_checklists
             SET status = 'generated', test_case_id = $1, error_message = NULL, updated_at = NOW()
             WHERE project_id = $2 AND functionality_id = $3 AND scenario_id = $4`,
            [savedRow.id, projectId, func.id, matchedScenario.scenarioId],
          );

          matchedScenario.status = "generated";
          passValidCount++;
          totalValidForFunc++;
        }
      }
    }

    // Re-filter ungenerated scenarios for this functionality before next replenishment pass
    funcPendingScenarios = allPlannedScenarios.filter(
      (s) =>
        s.functionalityId === func.id &&
        s.status === "planned" &&
        !existingCompositeKeys.has(`${func.id}:${s.scenarioId}`),
    );

    // If all scenarios for this functionality are generated, or if no progress was made and error occurred, break
    if (funcPendingScenarios.length === 0 || passValidCount === 0) {
      break;
    }
  }

  // Record precise status in scenario_checklists for any scenarios that remain ungenerated
  if (funcPendingScenarios.length > 0) {
    const skipReason = funcError || "Replenishment limit reached: candidate omitted by provider or rejected by step validation";
    for (const s of funcPendingScenarios) {
      s.status = "skipped";
      await pool.query(
        `UPDATE scenario_checklists
         SET status = 'skipped', error_message = $1, updated_at = NOW()
         WHERE project_id = $2 AND functionality_id = $3 AND scenario_id = $4 AND status = 'planned'`,
        [skipReason, projectId, func.id, s.scenarioId],
      );
    }
  }

  // Update functionality status
  const funcStatus = totalValidForFunc > 0 ? "completed" : "failed";
  await pool.query(
    `UPDATE functionality_inventory SET status = $1, updated_at = NOW() WHERE id = $2`,
    [funcStatus, func.id],
  );

  if (totalValidForFunc > 0) completedFunctionalities++;

  iterations.push({
    functionalityId: func.id,
    functionalityName: func.name,
    scenariosRequested: initialRequestedCount,
    scenariosGenerated: totalValidForFunc,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
    durationMs: totalDurationMs,
    estimatedCostUsd: Number((totalPromptTokens * 0.00000015 + totalCompletionTokens * 0.0000006).toFixed(6)),
    retries: funcRetries,
    status: totalValidForFunc >= initialRequestedCount ? "success" : totalValidForFunc > 0 ? "partial" : "failed",
    error: funcError,
  });
}

  // Completeness check
  const totalScenariosGenerated = allPlannedScenarios.filter((s) => s.status === "generated").length;
  const missingScenarios = Math.max(0, allPlannedScenarios.length - totalScenariosGenerated);

  return {
    projectId,
    totalFunctionalities: functionalities.length,
    completedFunctionalities,
    totalScenariosPlanned: allPlannedScenarios.length,
    totalScenariosGenerated,
    missingScenarios,
    createdTestCases,
    skippedDuplicates,
    skippedInvalid,
    iterations,
    status: missingScenarios === 0 ? "completed" : "partial",
  };
}

