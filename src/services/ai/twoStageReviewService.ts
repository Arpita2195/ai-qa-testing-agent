import crypto from "node:crypto";
import Groq from "groq-sdk";
import { pool } from "../../config/db";
import { env } from "../../config/env";
import { redactSecrets } from "../runner";
import { calculateEstimatedCostUsd } from "./pricing";
import {
  reserveAiBudget,
  reconcileAiBudgetReservation,
  releaseAiBudgetReservation,
  markReservationUncertain,
  startReservationHeartbeat,
  isConfirmedProviderFailure,
} from "./aiBudgetService";
import {
  type CandidateTestCase,
  type GroqReviewOutput,
  type AIReviewMetadata,
  type SemanticValidation,
  candidateTestCaseSchema,
  groqReviewOutputSchema,
} from "./twoStageReviewSchemas";
import { getDecryptedProjectAiConfig } from "./projectAiConfigService";
import type { PageData, ScrapedPage, PageElement } from "../pageReader";
import { StateTransitionEvidenceRow } from "./stateTransitionTypes";
import { validateCandidateSemanticEvidence } from "./semanticEvidenceValidator";

export interface EvidenceContext {
  source: "crawler_dom" | "requirements_doc";
  appName?: string;
  page?: PageData | ScrapedPage;
  pages?: (PageData | ScrapedPage)[];
  functionalityName?: string;
  pagePath?: string;
  elements?: PageElement[];
  visibleText?: string[];
  requirementText?: string;
  transitions?: StateTransitionEvidenceRow[];
}

export interface ReviewBatchInput {
  projectId: string;
  candidates: Array<{
    title: string;
    description?: string;
    steps: string[];
    expected_result: string;
    category?: "positive" | "negative" | "boundary" | "edge_case" | string;
    priority?: "critical" | "high" | "medium" | "low" | string;
    scenario_id?: string;
    functionality_id?: string;
    preconditions?: string;
    test_data?: Record<string, unknown>;
  }>;
  evidence: EvidenceContext;
  actorId?: string;
}

export interface ReviewedCandidateResult {
  candidate_id: string;
  title: string;
  description: string;
  steps: string[];
  expected_result: string;
  category: "positive" | "negative" | "boundary" | "edge_case";
  priority: "critical" | "high" | "medium" | "low";
  scenario_id?: string;
  functionality_id?: string;
  preconditions?: string;
  test_data?: Record<string, unknown>;
  ai_review_metadata: AIReviewMetadata;
}

/**
 * Validates browser automation steps against crawler DOM evidence.
 * Ensures selectors exist, actions match element types, and asserted text is present on the page.
 */
export function validateStepsAgainstDomEvidence(
  steps: string[],
  evidence: EvidenceContext,
): { valid: boolean; invalidSteps: string[] } {
  const invalidSteps: string[] = [];
  const elements = evidence.elements || evidence.page?.elements || [];
  const selectors = new Set(elements.map((el) => el.selector));

  const pagePath = evidence.pagePath || (evidence.page ? ("path" in evidence.page ? evidence.page.path : "") : "");
  const pageHeadings = evidence.page && "headings" in evidence.page ? evidence.page.headings : [];
  const visibleTextList = evidence.visibleText || [
    ...pageHeadings,
    evidence.page?.title || "",
    ...elements.map((el) => el.text || ""),
  ].filter(Boolean);

  for (const [idx, rawStep] of steps.entries()) {
    const step = rawStep.trim();
    if (step.startsWith("goto ")) {
      const path = step.slice("goto ".length).trim();
      if (!path.startsWith("/")) {
        invalidSteps.push(`Step ${idx + 1}: goto path must start with "/"`);
      } else if (pagePath && path !== pagePath) {
        invalidSteps.push(`Step ${idx + 1}: goto path "${path}" does not match page "${pagePath}"`);
      }
      continue;
    }

    if (step.startsWith("click ")) {
      const selector = step.slice("click ".length).trim();
      if (!selectors.has(selector)) {
        invalidSteps.push(`Step ${idx + 1}: click selector "${selector}" was not found in crawler evidence`);
      }
      continue;
    }

    if (step.startsWith("fill ")) {
      const rest = step.slice("fill ".length);
      const sep = rest.indexOf("|");
      if (sep === -1) {
        invalidSteps.push(`Step ${idx + 1}: fill step is missing delimiter ("|")`);
        continue;
      }
      const selector = rest.slice(0, sep).trim();
      if (!selectors.has(selector)) {
        invalidSteps.push(`Step ${idx + 1}: fill selector "${selector}" was not found in crawler evidence`);
      }
      continue;
    }

    if (step.startsWith("expect text ")) {
      const text = step.slice("expect text ".length).trim();
      if (!text) {
        invalidSteps.push(`Step ${idx + 1}: expect text is empty`);
        continue;
      }
      const lowerText = text.toLowerCase();
      const appNameLower = (evidence.appName || "StockFlow").toLowerCase();
      if (lowerText === "stockflow" || lowerText === appNameLower) {
        invalidSteps.push(`Step ${idx + 1}: generic app name assertion "${text}" is not allowed`);
        continue;
      }
      if (visibleTextList.length > 0 && !visibleTextList.some((vt) => vt.toLowerCase().includes(lowerText))) {
        invalidSteps.push(`Step ${idx + 1}: expect text "${text}" is not present in visible page text`);
      }
      continue;
    }

    invalidSteps.push(`Step ${idx + 1}: unsupported step format "${step}"`);
  }

  return {
    valid: invalidSteps.length === 0,
    invalidSteps,
  };
}

/**
 * Assigns stable unique candidate IDs to raw candidate test cases.
 */
function assignStableCandidateIds(
  rawCandidates: ReviewBatchInput["candidates"],
): CandidateTestCase[] {
  return rawCandidates.map((c) => {
    const candidateId = `cand_${crypto.randomUUID()}`;
    const category = (["positive", "negative", "boundary", "edge_case"].includes(c.category || "")
      ? c.category
      : "positive") as "positive" | "negative" | "boundary" | "edge_case";
    const priority = (["critical", "high", "medium", "low"].includes(c.priority || "")
      ? c.priority
      : "medium") as "critical" | "high" | "medium" | "low";

    return candidateTestCaseSchema.parse({
      candidate_id: candidateId,
      title: c.title,
      description: c.description || "",
      steps: c.steps,
      expected_result: c.expected_result,
      category,
      priority,
      scenario_id: c.scenario_id,
      functionality_id: c.functionality_id,
      preconditions: c.preconditions,
      test_data: c.test_data,
      original_steps: [...c.steps],
    });
  });
}

/**
 * Builds the Groq review prompt with strict anti-hallucination mandate and structured evidence.
 */
function buildGroqReviewPrompt(
  candidates: CandidateTestCase[],
  evidence: EvidenceContext,
): { systemInstruction: string; userPrompt: string } {
  const systemInstruction = `You are a Senior QA Automation Auditor reviewing candidate test cases generated by an AI assistant.
Your responsibility is to strictly audit each test case against provided application evidence.

AUDIT CRITERIA:
1. Evidence Verification: Test steps MUST interact ONLY with selectors and text documented in the provided evidence.
2. Grammar and Syntax: Browser steps must use ONLY:
   - "goto /path"
   - "click <css selector>"
   - "fill <css selector> | <value>"
   - "expect text <specific visible text>"
3. Assertion Strength: Reject vague assertions ("submitted without errors", generic app names like "${evidence.appName || "StockFlow"}"). Require specific state assertions.
4. Completeness & Gaps: Identify missing negative, boundary, or edge-case tests.
5. Anti-Hallucination Mandate: Do NOT invent application features, selectors, or behaviors that are not supported by the evidence. Any proposed missing scenario MUST include an evidence_anchor.
6. Evidence Support Mandate: Test case assertions MUST be supported by observed destination state or transitions. An action cannot be assumed to succeed if observed transition outcome is unverified or error. A redirect alone does NOT prove login. Observed positive transitions do NOT prove negative or edge behavior.

RETURN FORMAT:
You MUST respond with valid JSON matching this schema:
{
  "candidate_reviews": [
    {
      "candidate_id": "<must match the exact candidate_id provided>",
      "verdict": "approved" | "needs_correction" | "redundant" | "unsupported",
      "issues": ["string description of issues found"],
      "reason": "explanation of review judgment",
      "confidence": 0.0 to 1.0,
      "corrected_title": "optional improved title",
      "corrected_steps": ["optional corrected steps using ONLY evidence selectors"],
      "corrected_expected_result": "optional improved assertion",
      "corrected_category": "positive" | "negative" | "boundary" | "edge_case",
      "corrected_priority": "critical" | "high" | "medium" | "low"
    }
  ],
  "missing_scenarios": [
    {
      "title": "description of missing scenario",
      "category": "negative" | "boundary" | "edge_case",
      "priority": "critical" | "high" | "medium" | "low",
      "evidence_anchor": "exact selector or text from evidence this is based on",
      "reason": "why this scenario is necessary"
    }
  ],
  "summary": "brief summary of review findings"
}`;

  let evidenceSection = "";
  if (evidence.source === "crawler_dom") {
    const elements = (evidence.elements || evidence.page?.elements || []).map((el) => ({
      tag: el.tag,
      selector: el.selector,
      text: (el.text || "").slice(0, 80),
      type: el.type,
      name: el.name,
      placeholder: el.placeholder,
    }));
    const pageHeadings = evidence.page && "headings" in evidence.page ? evidence.page.headings : [];
    evidenceSection = `SOURCE: Crawled DOM Evidence
Feature/Page: ${evidence.functionalityName || evidence.pagePath || "Application Page"}
Path: ${evidence.pagePath || ""}
Available Page Elements:
${JSON.stringify(elements, null, 2)}
Visible Page Headings/Texts:
${JSON.stringify(evidence.visibleText || pageHeadings, null, 2)}`;

    if (evidence.transitions && evidence.transitions.length > 0) {
      const sanitizedTransitions = evidence.transitions.slice(0, 10).map((t) => ({
        action_type: t.action_type,
        trigger_selector: t.trigger_selector,
        source_path: t.source_path,
        destination_path: t.destination_path,
        navigation_scope: t.navigation_scope,
        auth_state: t.auth_state_at_observation,
        outcome_status: t.outcome_status,
        expected_intent: t.expected_intent,
        transition_data: t.transition_data,
      }));
      evidenceSection += `\n\nObserved State Transition Evidence:\n${JSON.stringify(sanitizedTransitions, null, 2)}`;
    }
  } else {
    evidenceSection = `SOURCE: Requirements Specification Document
Requirements Text:
${(evidence.requirementText || "").slice(0, 6000)}`;
  }

  const candidatePayload = candidates.map((c) => ({
    candidate_id: c.candidate_id,
    title: c.title,
    description: c.description,
    category: c.category,
    priority: c.priority,
    steps: c.steps,
    expected_result: c.expected_result,
    scenario_id: c.scenario_id,
  }));

  const userPrompt = `Audit the following candidate test cases against the verified evidence:

<APPLICATION_EVIDENCE>
${redactSecrets(evidenceSection)}
</APPLICATION_EVIDENCE>

<CANDIDATE_TEST_CASES>
${JSON.stringify(candidatePayload, null, 2)}
</CANDIDATE_TEST_CASES>

Provide your review in structured JSON format.`;

  return { systemInstruction, userPrompt };
}

/**
 * Reviews a batch of candidate test cases using Groq independent reviewer.
 * Enforces strict budget reservations, evidence validation, stable ID mapping,
 * and graceful fallback to primary candidates on review errors.
 */
export async function reviewCandidateBatch(
  input: ReviewBatchInput,
): Promise<ReviewedCandidateResult[]> {
  const { projectId, evidence, actorId } = input;

  // 1. Assign stable unique candidate IDs
  const candidates = assignStableCandidateIds(input.candidates);
  if (candidates.length === 0) {
    return [];
  }

  // 2. Safeguard 1: Pre-audit original Gemini-generated test steps against crawler evidence
  const preAuditMap = new Map<string, { valid: boolean; invalidSteps: string[] }>();
  if (evidence.source === "crawler_dom") {
    for (const c of candidates) {
      const audit = validateStepsAgainstDomEvidence(c.steps, evidence);
      preAuditMap.set(c.candidate_id, audit);
    }
  }

  // 2b. Safeguard 2: Semantic Evidence Validation against empirical state transitions
  const semanticValidationMap = new Map<string, SemanticValidation>();
  for (const c of candidates) {
    const sem = validateCandidateSemanticEvidence(c, evidence, evidence.transitions || []);
    semanticValidationMap.set(c.candidate_id, sem);
  }

  // 3. Check project AI configuration to verify two_stage_review_enabled
  const config = await getDecryptedProjectAiConfig(projectId);
  const twoStageEnabled = Boolean(config?.twoStageReviewEnabled);

  // If two-stage review is not enabled, mark as skipped and return Gemini candidates
  if (!twoStageEnabled) {
    return candidates.map((c) => {
      const audit = preAuditMap.get(c.candidate_id);
      const sem = semanticValidationMap.get(c.candidate_id);
      return {
        candidate_id: c.candidate_id,
        title: c.title,
        description: c.description,
        steps: c.steps,
        expected_result: c.expected_result,
        category: c.category,
        priority: c.priority,
        scenario_id: c.scenario_id,
        functionality_id: c.functionality_id,
        preconditions: c.preconditions,
        test_data: c.test_data,
        ai_review_metadata: {
          review_status: "skipped",
          reviewer_provider: "groq",
          reviewer_model: config?.reviewModel || "openai/gpt-oss-120b",
          reviewed_at: new Date().toISOString(),
          verdict: "skipped",
          issues: audit?.invalidSteps || [],
          reason: "Two-stage AI review is not enabled for this project",
          corrections_applied: false,
          evidence_validation: audit
            ? {
                source: evidence.source,
                valid: audit.valid,
                invalid_steps: audit.invalidSteps,
                unsupported_suggestions: [],
              }
            : undefined,
          semantic_validation: sem,
        },
      };
    });
  }

  // 4. Resolve Groq reviewer API key
  const reviewerApiKey = config?.reviewerApiKey || process.env.GROQ_API_KEY || env.GROQ_API_KEY;
  const reviewModel = config?.reviewModel || "openai/gpt-oss-120b";

  if (!reviewerApiKey) {
    // If no Groq API key is configured, fallback safely to primary output with 'incomplete' status
    return candidates.map((c) => {
      const audit = preAuditMap.get(c.candidate_id);
      const sem = semanticValidationMap.get(c.candidate_id);
      return {
        candidate_id: c.candidate_id,
        title: c.title,
        description: c.description,
        steps: c.steps,
        expected_result: c.expected_result,
        category: c.category,
        priority: c.priority,
        scenario_id: c.scenario_id,
        functionality_id: c.functionality_id,
        preconditions: c.preconditions,
        test_data: c.test_data,
        ai_review_metadata: {
          review_status: "incomplete",
          reviewer_provider: "groq",
          reviewer_model: reviewModel,
          reviewed_at: new Date().toISOString(),
          verdict: "skipped",
          issues: audit?.invalidSteps || [],
          reason: "Groq reviewer API key is not configured",
          review_error: "Missing Groq credentials",
          corrections_applied: false,
          fallback_to_primary: true,
          evidence_validation: audit
            ? {
                source: evidence.source,
                valid: audit.valid,
                invalid_steps: audit.invalidSteps,
                unsupported_suggestions: [],
              }
            : undefined,
          semantic_validation: sem
            ? {
                ...sem,
                support_level: "review_incomplete",
              }
            : undefined,
        },
      };
    });
  }

  // 5. Build prompt and calculate budget reservation
  const { systemInstruction, userPrompt } = buildGroqReviewPrompt(candidates, evidence);
  const fullPromptLength = systemInstruction.length + userPrompt.length;
  // Conservative token estimation: (chars / 4) * 1.25 margin + 4096 max output tokens
  const estimatedPromptTokens = Math.ceil((fullPromptLength / 4) * 1.25);
  const maxOutputTokens = 4096;
  const estimatedTokens = Math.min(estimatedPromptTokens + maxOutputTokens, 12000);
  const estimatedCostUsd = calculateEstimatedCostUsd(reviewModel, estimatedTokens, 0, "groq");

  // Reserve budget
  const reservation = await reserveAiBudget(projectId, {
    estimatedTokens,
    estimatedCostUsd,
    feature: "two_stage_review",
    actorId,
  });

  const heartbeat = startReservationHeartbeat(reservation.id, reservation.ownerToken, 45000, 300);

  let groqReview: GroqReviewOutput | null = null;
  let groqError: string | undefined;

  try {
    const groqClient = new Groq({
      apiKey: reviewerApiKey,
      timeout: 60000,
    });

    const t0 = Date.now();
    const chatCompletion = await groqClient.chat.completions.create({
      model: reviewModel,
      messages: [
        { role: "system", content: systemInstruction },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      max_tokens: maxOutputTokens,
      temperature: 0.1,
    });

    const durationMs = Date.now() - t0;
    const responseContent = chatCompletion.choices[0]?.message?.content || "";
    const promptTokens = chatCompletion.usage?.prompt_tokens ?? estimatedPromptTokens;
    const completionTokens = chatCompletion.usage?.completion_tokens ?? Math.ceil(responseContent.length / 4);
    const actualCostUsd = calculateEstimatedCostUsd(reviewModel, promptTokens, completionTokens, "groq");

    // Reconcile budget
    await reconcileAiBudgetReservation(
      reservation.id,
      {
        promptTokens,
        completionTokens,
        estimatedCostUsd: actualCostUsd,
        model: reviewModel,
        provider: "groq",
        feature: "two_stage_review",
        durationMs,
        createdBy: actorId,
      },
      reservation.ownerToken,
    );

    // Validate structured response
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(responseContent);
    } catch {
      throw new Error("Groq returned invalid JSON in review response");
    }

    const validated = groqReviewOutputSchema.safeParse(parsedRaw);
    if (!validated.success) {
      throw new Error(`Groq review output schema validation failed: ${validated.error.issues.map((i) => i.message).join(", ")}`);
    }

    groqReview = validated.data;
  } catch (err) {
    const rawError = err instanceof Error ? err.message : String(err);
    groqError = redactSecrets(rawError);
    if (isConfirmedProviderFailure(err)) {
      await releaseAiBudgetReservation(reservation.id, reservation.ownerToken);
    } else {
      await markReservationUncertain(reservation.id, groqError, reservation.ownerToken);
    }
  } finally {
    heartbeat.stop();
  }

  // 6. Handle Groq failure / timeout fallback
  if (!groqReview) {
    return candidates.map((c) => {
      const audit = preAuditMap.get(c.candidate_id);
      const sem = semanticValidationMap.get(c.candidate_id);
      return {
        candidate_id: c.candidate_id,
        title: c.title,
        description: c.description,
        steps: c.steps,
        expected_result: c.expected_result,
        category: c.category,
        priority: c.priority,
        scenario_id: c.scenario_id,
        functionality_id: c.functionality_id,
        preconditions: c.preconditions,
        test_data: c.test_data,
        ai_review_metadata: {
          review_status: "incomplete",
          reviewer_provider: "groq",
          reviewer_model: reviewModel,
          reviewed_at: new Date().toISOString(),
          verdict: "error",
          issues: audit?.invalidSteps || [],
          reason: "Independent Groq review failed or timed out",
          review_error: groqError || "Unknown Groq error",
          corrections_applied: false,
          fallback_to_primary: true,
          evidence_validation: audit
            ? {
                source: evidence.source,
                valid: audit.valid,
                invalid_steps: audit.invalidSteps,
                unsupported_suggestions: [],
              }
            : undefined,
          semantic_validation: sem
            ? {
                ...sem,
                support_level: "review_incomplete",
              }
            : undefined,
        },
      };
    });
  }

  // 7. Process Groq review and apply evidence-supported corrections
  const reviewMap = new Map<string, GroqReviewOutput["candidate_reviews"][number]>();
  for (const cr of groqReview.candidate_reviews) {
    reviewMap.set(cr.candidate_id, cr);
  }

  // Audit missing scenarios from Groq: filter out unanchored hallucinations
  const unsupportedSuggestions: string[] = [];
  for (const ms of groqReview.missing_scenarios) {
    if (evidence.source === "crawler_dom") {
      const elements = evidence.elements || evidence.page?.elements || [];
      const anchorExists = elements.some(
        (el) => el.selector === ms.evidence_anchor || (el.text && el.text.includes(ms.evidence_anchor)),
      );
      if (!anchorExists) {
        unsupportedSuggestions.push(
          `Groq suggested missing scenario "${ms.title}" but evidence anchor "${ms.evidence_anchor}" was not found in crawler evidence`,
        );
      }
    } else {
      const reqText = evidence.requirementText || "";
      if (!reqText.includes(ms.evidence_anchor)) {
        unsupportedSuggestions.push(
          `Groq suggested missing scenario "${ms.title}" but evidence anchor "${ms.evidence_anchor}" was not found in requirements text`,
        );
      }
    }
  }

  const results: ReviewedCandidateResult[] = [];

  for (const c of candidates) {
    const cr = reviewMap.get(c.candidate_id);
    const preAudit = preAuditMap.get(c.candidate_id);

    if (!cr) {
      // Groq omitted this candidate from review response
      const sem = semanticValidationMap.get(c.candidate_id);
      results.push({
        candidate_id: c.candidate_id,
        title: c.title,
        description: c.description,
        steps: c.steps,
        expected_result: c.expected_result,
        category: c.category,
        priority: c.priority,
        scenario_id: c.scenario_id,
        functionality_id: c.functionality_id,
        preconditions: c.preconditions,
        test_data: c.test_data,
        ai_review_metadata: {
          review_status: "incomplete",
          reviewer_provider: "groq",
          reviewer_model: reviewModel,
          reviewed_at: new Date().toISOString(),
          verdict: "error",
          issues: ["Omitted from reviewer output"],
          reason: "Reviewer omitted this candidate from its response",
          corrections_applied: false,
          fallback_to_primary: true,
          evidence_validation: preAudit
            ? {
                source: evidence.source,
                valid: preAudit.valid,
                invalid_steps: preAudit.invalidSteps,
                unsupported_suggestions: unsupportedSuggestions,
              }
            : undefined,
          semantic_validation: sem
            ? {
                ...sem,
                support_level: "review_incomplete",
              }
            : undefined,
        },
      });
      continue;
    }

    // Check if Groq proposed corrections
    let finalTitle = c.title;
    let finalSteps = c.steps;
    let finalExpectedResult = c.expected_result;
    let finalCategory = c.category;
    let finalPriority = c.priority;
    let correctionsApplied = false;
    let correctionRejectionReason: string | undefined;

    if (cr.verdict === "needs_correction" && cr.corrected_steps && cr.corrected_steps.length > 0) {
      if (evidence.source === "crawler_dom") {
        // Validate Groq's corrected steps against crawler DOM evidence
        const correctionAudit = validateStepsAgainstDomEvidence(cr.corrected_steps, evidence);
        if (correctionAudit.valid) {
          finalTitle = cr.corrected_title || c.title;
          finalSteps = cr.corrected_steps;
          finalExpectedResult = cr.corrected_expected_result || c.expected_result;
          if (cr.corrected_category) finalCategory = cr.corrected_category;
          if (cr.corrected_priority) finalPriority = cr.corrected_priority;
          correctionsApplied = true;
        } else {
          correctionRejectionReason = `Groq corrections rejected: ${correctionAudit.invalidSteps.join("; ")}`;
        }
      } else {
        // For requirements doc, apply corrections
        finalTitle = cr.corrected_title || c.title;
        finalSteps = cr.corrected_steps;
        finalExpectedResult = cr.corrected_expected_result || c.expected_result;
        if (cr.corrected_category) finalCategory = cr.corrected_category;
        if (cr.corrected_priority) finalPriority = cr.corrected_priority;
        correctionsApplied = true;
      }
    }

    const issues = [...cr.issues];
    if (correctionRejectionReason) {
      issues.push(correctionRejectionReason);
    }
    if (preAudit && !preAudit.valid) {
      issues.push(...preAudit.invalidSteps);
    }

    let finalSem = semanticValidationMap.get(c.candidate_id);
    if (correctionsApplied) {
      finalSem = validateCandidateSemanticEvidence(
        {
          ...c,
          title: finalTitle,
          steps: finalSteps,
          expected_result: finalExpectedResult,
          category: finalCategory,
          priority: finalPriority,
        },
        evidence,
        evidence.transitions || []
      );
    }
    if (cr.verdict === "unsupported" && finalSem) {
      finalSem = {
        ...finalSem,
        support_level: "unsupported",
      };
    }

    results.push({
      candidate_id: c.candidate_id,
      title: finalTitle,
      description: c.description,
      steps: finalSteps,
      expected_result: finalExpectedResult,
      category: finalCategory,
      priority: finalPriority,
      scenario_id: c.scenario_id,
      functionality_id: c.functionality_id,
      preconditions: c.preconditions,
      test_data: c.test_data,
      ai_review_metadata: {
        review_status: "reviewed",
        reviewer_provider: "groq",
        reviewer_model: reviewModel,
        reviewed_at: new Date().toISOString(),
        verdict: cr.verdict,
        issues,
        reason: cr.reason,
        confidence: cr.confidence,
        corrections_applied: correctionsApplied,
        original_candidate: correctionsApplied
          ? {
              title: c.title,
              steps: c.steps,
              expected_result: c.expected_result,
            }
          : undefined,
        evidence_validation: {
          source: evidence.source,
          valid: preAudit ? preAudit.valid : true,
          invalid_steps: preAudit ? preAudit.invalidSteps : [],
          unsupported_suggestions: unsupportedSuggestions,
        },
        semantic_validation: finalSem,
      },
    });
  }

  return results;
}
