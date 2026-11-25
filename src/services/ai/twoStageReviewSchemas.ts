import { z } from "zod";

/**
 * Stable candidate test case passed from Gemini generation to Groq reviewer.
 */
export const candidateTestCaseSchema = z.object({
  candidate_id: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  steps: z.array(z.string()).min(1),
  expected_result: z.string().min(1),
  category: z.enum(["positive", "negative", "boundary", "edge_case"]).default("positive"),
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  scenario_id: z.string().optional(),
  functionality_id: z.string().optional(),
  preconditions: z.string().optional(),
  test_data: z.record(z.string(), z.unknown()).optional(),
  original_steps: z.array(z.string()).optional(),
});

export type CandidateTestCase = z.infer<typeof candidateTestCaseSchema>;

/**
 * Individual candidate review judgment from Groq.
 * Tolerant of null or omitted fields emitted by LLM outputs when no corrections are needed.
 */
export const groqCandidateReviewSchema = z.object({
  candidate_id: z.string().min(1),
  verdict: z.enum(["approved", "needs_correction", "redundant", "unsupported"]),
  issues: z.array(z.string()).nullish().transform((v) => v ?? []),
  reason: z.string().nullish().transform((v) => v ?? ""),
  confidence: z.number().min(0).max(1).nullish().transform((v) => v ?? 1),
  corrected_title: z.string().nullish().transform((v) => (v?.trim() ? v.trim() : undefined)),
  corrected_steps: z.array(z.string()).nullish().transform((v) => (v && v.length > 0 ? v : undefined)),
  corrected_expected_result: z.string().nullish().transform((v) => (v?.trim() ? v.trim() : undefined)),
  corrected_category: z
    .enum(["positive", "negative", "boundary", "edge_case"])
    .nullish()
    .transform((v) => v ?? undefined),
  corrected_priority: z
    .enum(["critical", "high", "medium", "low"])
    .nullish()
    .transform((v) => v ?? undefined),
});

export type GroqCandidateReview = z.infer<typeof groqCandidateReviewSchema>;

/**
 * Groq-suggested missing scenario.
 * Must include evidence_anchor linking to an actual page element or requirement text.
 */
export const groqMissingScenarioSchema = z.object({
  title: z.string().min(1),
  category: z
    .enum(["positive", "negative", "boundary", "edge_case"])
    .nullish()
    .transform((v) => v ?? "negative"),
  priority: z
    .enum(["critical", "high", "medium", "low"])
    .nullish()
    .transform((v) => v ?? "medium"),
  evidence_anchor: z.string().min(1),
  reason: z.string().nullish().transform((v) => v ?? ""),
});

export type GroqMissingScenario = z.infer<typeof groqMissingScenarioSchema>;

/**
 * Structured output schema returned by Groq review.
 */
export const groqReviewOutputSchema = z.object({
  candidate_reviews: z.array(groqCandidateReviewSchema),
  missing_scenarios: z.array(groqMissingScenarioSchema).nullish().transform((v) => v ?? []),
  summary: z.string().nullish().transform((v) => v ?? ""),
});

export type GroqReviewOutput = z.infer<typeof groqReviewOutputSchema>;

export const evidenceSupportLevelSchema = z.enum([
  "evidence_supported",
  "partially_supported",
  "unsupported",
  "inconclusive",
  "review_incomplete",
]);

export type EvidenceSupportLevel = z.infer<typeof evidenceSupportLevelSchema>;

export const semanticValidationSchema = z.object({
  support_level: evidenceSupportLevelSchema,
  selector_existence: z.boolean(),
  action_validity: z.boolean(),
  syntax_executability: z.boolean(),
  evidence_support: z.boolean(),
  semantic_correctness: z.boolean(),
  issues: z.array(z.string()).default([]),
  supported_assertions: z.array(z.string()).default([]),
  unsupported_assertions: z.array(z.string()).default([]),
  transition_id: z.string().nullable().optional(),
});

export type SemanticValidation = z.infer<typeof semanticValidationSchema>;

/**
 * AI review metadata attached to test_cases.ai_review_metadata.
 * Note: test_cases.review_status strictly tracks human QA status ('pending', 'approved', 'rejected').
 */
export const aiReviewMetadataSchema = z.object({
  review_status: z.enum(["reviewed", "incomplete", "skipped"]),
  reviewer_provider: z.literal("groq").default("groq"),
  reviewer_model: z.string().default("openai/gpt-oss-120b"),
  reviewed_at: z.string(),
  verdict: z.enum(["approved", "needs_correction", "redundant", "unsupported", "skipped", "error"]).optional(),
  issues: z.array(z.string()).default([]),
  reason: z.string().optional(),
  confidence: z.number().optional(),
  corrections_applied: z.boolean().default(false),
  original_candidate: z.object({
    title: z.string(),
    steps: z.array(z.string()),
    expected_result: z.string(),
  }).optional(),
  evidence_validation: z.object({
    source: z.enum(["crawler_dom", "requirements_doc"]),
    valid: z.boolean(),
    invalid_steps: z.array(z.string()).default([]),
    unsupported_suggestions: z.array(z.string()).default([]),
  }).optional(),
  semantic_validation: semanticValidationSchema.optional(),
  review_error: z.string().optional(),
  fallback_to_primary: z.boolean().optional(),
});

export type AIReviewMetadata = z.infer<typeof aiReviewMetadataSchema>;
