import { StateTransitionEvidenceRow } from './stateTransitionTypes';
import {
  CandidateTestCase,
  SemanticValidation,
  EvidenceSupportLevel,
} from './twoStageReviewSchemas';
import { EvidenceContext } from './twoStageReviewService';

/**
 * Result of validating a candidate test case against empirical state transition evidence.
 */
export interface CandidateSemanticValidationResult {
  candidateId: string;
  supportLevel: EvidenceSupportLevel;
  validation: SemanticValidation;
}

/**
 * Distinguishes 6 distinct validation levels:
 * 1. Selector existence
 * 2. Action validity
 * 3. Syntax and executability
 * 4. Evidence support
 * 5. Semantic correctness
 * 6. Actual execution outcome (when execution evidence exists)
 *
 * Never treats one level as proof of another.
 */
export function validateCandidateSemanticEvidence(
  candidate: CandidateTestCase,
  evidence: EvidenceContext,
  transitions: StateTransitionEvidenceRow[] = []
): SemanticValidation {
  const issues: string[] = [];
  const supportedAssertions: string[] = [];
  const unsupportedAssertions: string[] = [];

  const elements = evidence.elements || evidence.page?.elements || [];
  const elementMap = new Map(elements.map((el) => [el.selector, el]));
  const pagePath = evidence.pagePath || (evidence.page && 'path' in evidence.page ? evidence.page.path : '');

  // --------------------------------------------------------------------------
  // LEVEL 1 & 3: Syntax, Executability, and Selector Existence
  // --------------------------------------------------------------------------
  let syntaxExecutability = true;
  let selectorExistence = true;
  let actionValidity = true;

  const interactedSelectors: string[] = [];
  let mainActionType: 'click' | 'search' | 'tab' | 'modal' | 'form' | 'navigation' | 'unknown' = 'unknown';

  for (const [idx, rawStep] of candidate.steps.entries()) {
    const step = rawStep.trim();

    if (step.startsWith('goto ')) {
      const path = step.slice('goto '.length).trim();
      if (!path.startsWith('/')) {
        syntaxExecutability = false;
        issues.push(`Step ${idx + 1}: goto path must start with "/"`);
      } else if (pagePath && path !== pagePath && !transitions.some((t) => t.destination_path === path)) {
        // Path is acceptable if it matches pagePath or is a recorded destination_path in evidence
        syntaxExecutability = false;
        issues.push(`Step ${idx + 1}: goto path "${path}" is not documented in page or transition evidence`);
      }
      continue;
    }

    if (step.startsWith('click ')) {
      const selector = step.slice('click '.length).trim();
      interactedSelectors.push(selector);
      if (!elementMap.has(selector)) {
        selectorExistence = false;
        issues.push(`Step ${idx + 1}: click selector "${selector}" does not exist in observed page elements`);
      } else {
        const el = elementMap.get(selector)!;
        if (el.tag === 'input' && (el.type === 'text' || el.type === 'search')) {
          actionValidity = false;
          issues.push(`Step ${idx + 1}: clicking text/search input "${selector}" without filling it is incomplete`);
        }
      }
      continue;
    }

    if (step.startsWith('fill ')) {
      const rest = step.slice('fill '.length);
      const sep = rest.indexOf('|');
      if (sep === -1) {
        syntaxExecutability = false;
        issues.push(`Step ${idx + 1}: fill step is missing delimiter ("|")`);
        continue;
      }
      const selector = rest.slice(0, sep).trim();
      interactedSelectors.push(selector);
      if (!elementMap.has(selector)) {
        selectorExistence = false;
        issues.push(`Step ${idx + 1}: fill selector "${selector}" does not exist in observed page elements`);
      } else {
        const el = elementMap.get(selector)!;
        if (el.tag !== 'input' && el.tag !== 'textarea' && el.tag !== 'select') {
          actionValidity = false;
          issues.push(`Step ${idx + 1}: cannot fill non-input element <${el.tag}> ("${selector}")`);
        }
      }
      continue;
    }

    if (step.startsWith('expect text ')) {
      const expectedText = step.slice('expect text '.length).trim();
      if (!expectedText) {
        syntaxExecutability = false;
        issues.push(`Step ${idx + 1}: expected text assertion is empty`);
      }
      continue;
    }

    syntaxExecutability = false;
    issues.push(`Step ${idx + 1}: unsupported step format "${step}"`);
  }

  // --------------------------------------------------------------------------
  // LEVEL 2 & 4: Action Validity and Transition Evidence Support
  // --------------------------------------------------------------------------
  // Find transition matching the candidate's primary interaction
  let matchedTransition: StateTransitionEvidenceRow | null = null;

  for (const selector of interactedSelectors) {
    const found = transitions.find(
      (t) => t.trigger_selector === selector || (pagePath && t.source_path === pagePath && t.trigger_selector.includes(selector))
    );
    if (found) {
      matchedTransition = found;
      break;
    }
  }

  // If no selector-specific match, check source_path
  if (!matchedTransition && pagePath) {
    matchedTransition = transitions.find((t) => t.source_path === pagePath) || null;
  }

  const evidenceSupport = Boolean(matchedTransition);

  // --------------------------------------------------------------------------
  // LEVEL 5: Semantic Correctness & Evidence Sufficiency Rules
  // --------------------------------------------------------------------------
  let semanticCorrectness = true;
  let supportLevel: EvidenceSupportLevel = 'evidence_supported';

  const expectedLower = candidate.expected_result.toLowerCase();
  const titleLower = candidate.title.toLowerCase();

  // Rule 1: Syntax or selector failure immediately marks unsupported
  if (!syntaxExecutability || !selectorExistence || !actionValidity) {
    semanticCorrectness = false;
    supportLevel = 'unsupported';
    unsupportedAssertions.push(candidate.expected_result);
    return {
      support_level: supportLevel,
      selector_existence: selectorExistence,
      action_validity: actionValidity,
      syntax_executability: syntaxExecutability,
      evidence_support: evidenceSupport,
      semantic_correctness: semanticCorrectness,
      issues,
      supported_assertions: supportedAssertions,
      unsupported_assertions: unsupportedAssertions,
      transition_id: matchedTransition?.id || null,
    };
  }

  // Rule 2: If no transition evidence exists at all for this action
  if (!matchedTransition) {
    // If requirement doc is the source, evidence may come from requirements, not DOM transitions
    if (evidence.source === 'requirements_doc') {
      supportedAssertions.push(candidate.expected_result);
      return {
        support_level: 'evidence_supported',
        selector_existence: true,
        action_validity: true,
        syntax_executability: true,
        evidence_support: false,
        semantic_correctness: true,
        issues: [],
        supported_assertions: supportedAssertions,
        unsupported_assertions: [],
        transition_id: null,
      };
    }

    issues.push('No empirical state transition evidence was recorded for this action target');
    unsupportedAssertions.push(candidate.expected_result);
    return {
      support_level: 'partially_supported',
      selector_existence: true,
      action_validity: true,
      syntax_executability: true,
      evidence_support: false,
      semantic_correctness: false,
      issues,
      supported_assertions: [],
      unsupported_assertions: unsupportedAssertions,
      transition_id: null,
    };
  }

  // Rule 3: Error outcomes must NOT support successful behavior assertions
  if (matchedTransition.outcome_status === 'error') {
    semanticCorrectness = false;
    supportLevel = 'unsupported';
    issues.push(`Observed transition failed with error: ${matchedTransition.transition_data?.error || 'Execution error'}`);
    unsupportedAssertions.push(candidate.expected_result);
    return {
      support_level: supportLevel,
      selector_existence: selectorExistence,
      action_validity: actionValidity,
      syntax_executability: syntaxExecutability,
      evidence_support: true,
      semantic_correctness: semanticCorrectness,
      issues,
      supported_assertions: supportedAssertions,
      unsupported_assertions: unsupportedAssertions,
      transition_id: matchedTransition.id,
    };
  }

  // Rule 4: Inconclusive outcomes must remain inconclusive
  if (matchedTransition.outcome_status === 'inconclusive') {
    semanticCorrectness = false;
    supportLevel = 'inconclusive';
    issues.push('Recorded transition outcome is inconclusive (timeout or incomplete observation)');
    unsupportedAssertions.push(candidate.expected_result);
    return {
      support_level: supportLevel,
      selector_existence: selectorExistence,
      action_validity: actionValidity,
      syntax_executability: syntaxExecutability,
      evidence_support: true,
      semantic_correctness: semanticCorrectness,
      issues,
      supported_assertions: supportedAssertions,
      unsupported_assertions: unsupportedAssertions,
      transition_id: matchedTransition.id,
    };
  }

  // Rule 5: Unverified outcomes must not be presented as verified business behavior
  if (matchedTransition.outcome_status === 'unverified') {
    semanticCorrectness = false;
    supportLevel = 'partially_supported';
    issues.push('Action executed in browser but produced no observable DOM change or state transition (unverified outcome)');
    unsupportedAssertions.push(candidate.expected_result);
    return {
      support_level: supportLevel,
      selector_existence: selectorExistence,
      action_validity: actionValidity,
      syntax_executability: syntaxExecutability,
      evidence_support: true,
      semantic_correctness: semanticCorrectness,
      issues,
      supported_assertions: supportedAssertions,
      unsupported_assertions: unsupportedAssertions,
      transition_id: matchedTransition.id,
    };
  }

  // Rule 6: Unknown navigation scope must not claim verified page transition
  const claimsNavigation =
    expectedLower.includes('navigate') ||
    expectedLower.includes('redirect') ||
    expectedLower.includes('load page') ||
    candidate.steps.some((s, idx) => idx > 0 && s.startsWith('goto '));

  if (claimsNavigation && matchedTransition.navigation_scope === 'unknown') {
    semanticCorrectness = false;
    supportLevel = 'unsupported';
    issues.push('Test asserts cross-page navigation, but transition navigation scope could not be verified (classified as unknown)');
    unsupportedAssertions.push(candidate.expected_result);
  }

  // Rule 7: Authentication redirect alone must not establish successful login
  const claimsAuthentication =
    titleLower.includes('login') ||
    titleLower.includes('sign in') ||
    expectedLower.includes('logged in') ||
    expectedLower.includes('authenticated');

  if (claimsAuthentication) {
    if (matchedTransition.auth_state_at_observation !== 'authenticated') {
      semanticCorrectness = false;
      supportLevel = 'partially_supported';
      issues.push(`Test asserts successful login, but observed auth state is "${matchedTransition.auth_state_at_observation}" (a redirect alone does not establish authentication)`);
      unsupportedAssertions.push(candidate.expected_result);
    } else {
      supportedAssertions.push('Verified authenticated state confirmed by user profile/logout controls');
    }
  }

  // Rule 8: Modal outcome validation
  const isModalTest = matchedTransition.action_type === 'modal' || /\bmodals?\b/i.test(titleLower) || /\bmodals?\b/i.test(expectedLower);
  if (isModalTest) {
    const modalEvidence = (matchedTransition.transition_data as any)?.modalEvidence || {};
    const modalOpened = modalEvidence.modalOpened === true || (matchedTransition.action_type === 'modal' && matchedTransition.outcome_status === 'verified');
    if (!modalOpened) {
      semanticCorrectness = false;
      supportLevel = 'partially_supported';
      issues.push('Test asserts modal visibility, but modal visibility transition was not confirmed in evidence');
      unsupportedAssertions.push(candidate.expected_result);
    } else {
      supportedAssertions.push('Verified modal dialog visibility transition');
    }
  }

  // Rule 9: Tab outcome validation
  const isTabTest = matchedTransition.action_type === 'tab' || /\btabs?\b/i.test(titleLower) || /\btabs?\b/i.test(expectedLower);
  if (isTabTest) {
    const tabEvidence = (matchedTransition.transition_data as any)?.tabEvidence || {};
    const tabVerified = tabEvidence.tabSelected === true || (matchedTransition.action_type === 'tab' && matchedTransition.outcome_status === 'verified');
    if (!tabVerified) {
      semanticCorrectness = false;
      supportLevel = 'partially_supported';
      issues.push('Test asserts tab selection, but aria-selected and panel visibility were not confirmed in evidence');
      unsupportedAssertions.push(candidate.expected_result);
    } else {
      supportedAssertions.push('Verified tab selection and content panel visibility');
    }
  }

  // Rule 10: Search outcome validation
  const isSearchTest = matchedTransition.action_type === 'search' || /\bsearch(?:es|ed|ing)?\b/i.test(titleLower) || /\bsearch(?:es|ed|ing)?\b/i.test(expectedLower);
  if (isSearchTest) {
    const searchEvidence = (matchedTransition.transition_data as any)?.searchEvidence || {};
    const searchVerified =
      searchEvidence.resultsFound === true ||
      searchEvidence.emptyResultsState === true ||
      (matchedTransition.action_type === 'search' && matchedTransition.outcome_status === 'verified');

    if (!searchVerified) {
      semanticCorrectness = false;
      supportLevel = 'partially_supported';
      issues.push('Test asserts search results, but neither results container nor verified empty state were observed');
      unsupportedAssertions.push(candidate.expected_result);
    } else {
      supportedAssertions.push('Verified search results or empty-state feedback container');
    }
  }

  // Rule 11: Form success assertions require observed success indicators
  const isFormSubmission =
    (expectedLower.includes('successfully') || expectedLower.includes('created') || expectedLower.includes('saved')) &&
    interactedSelectors.some((s) => s.includes('submit') || s.includes('save') || s.includes('btn') || s.includes('button'));

  if (isFormSubmission) {
    const formEvidence = (matchedTransition.transition_data as any)?.formEvidence || {};
    const hasSuccessIndicator = Boolean(formEvidence.successFeedbackFound);
    // If not recorded in formEvidence, check if outcome_status was verified and dom changed
    if (!hasSuccessIndicator && matchedTransition.action_type === 'form') {
      semanticCorrectness = false;
      supportLevel = 'partially_supported';
      issues.push('Test asserts successful form submission, but no explicit confirmation indicator or success alert was recorded');
      unsupportedAssertions.push(candidate.expected_result);
    }
  }

  // Rule 12: Missing destination evidence must not be filled by model assumptions
  if (matchedTransition.navigation_scope === 'cross_page' && !matchedTransition.destination_page_id) {
    semanticCorrectness = false;
    supportLevel = 'partially_supported';
    issues.push('Cross-page transition observed, but destination page record is unverified');
    unsupportedAssertions.push(candidate.expected_result);
  }

  // Rule 13: Negative, boundary, and edge scenarios are not proven by positive transitions alone
  const isNegativeOrEdge =
    candidate.category === 'negative' ||
    candidate.category === 'boundary' ||
    candidate.category === 'edge_case';

  if (isNegativeOrEdge && matchedTransition.outcome_status === 'verified') {
    // A positive verified transition does NOT prove negative/boundary/edge behavior
    supportLevel = 'partially_supported';
    issues.push(`Proposed ${candidate.category} scenario is an AI hypothesis not directly observed in empirical positive transition evidence`);
    unsupportedAssertions.push(`Hypothesized ${candidate.category} failure handling`);
  }

  // Rule 14: Expected result grounding check against destination state and transition data
  // A test case must not claim application behavior that is absent from observed evidence
  const allKnownEvidenceText = [
    evidence.appName || '',
    evidence.pagePath || '',
    pagePath || '',
    evidence.page?.title || '',
    ...(evidence.page && 'headings' in evidence.page ? evidence.page.headings : []),
    ...(evidence.visibleText || []),
    ...elements.map((el) => el.text || ''),
    evidence.requirementText || '',
    matchedTransition.destination_path,
    matchedTransition.source_path,
    matchedTransition.expected_intent || '',
    JSON.stringify(matchedTransition.transition_data || {}),
  ]
    .join(' ')
    .toLowerCase();

  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'and', 'or', 'in', 'on', 'with', 'for', 'of',
    'be', 'it', 'this', 'that', 'user', 'should', 'will', 'page', 'screen', 'displays', 'display',
    'shows', 'show', 'test', 'case', 'becomes', 'after', 'before', 'item', 'items'
  ]);

  const assertionTokens = expectedLower
    .split(/[^a-z0-9$]+/i)
    .filter((w) => w.length > 2 && !stopWords.has(w));

  const hasEvidenceOverlap =
    assertionTokens.length === 0 ||
    assertionTokens.some((tok) => allKnownEvidenceText.includes(tok));

  if (!hasEvidenceOverlap && matchedTransition) {
    semanticCorrectness = false;
    supportLevel = 'partially_supported';
    issues.push(`Expected result assertion "${candidate.expected_result}" is not supported by observed destination state or transition evidence`);
    unsupportedAssertions.push(candidate.expected_result);
  }

  if (semanticCorrectness && supportLevel === 'evidence_supported') {
    supportedAssertions.push(candidate.expected_result);
  }

  return {
    support_level: supportLevel,
    selector_existence: selectorExistence,
    action_validity: actionValidity,
    syntax_executability: syntaxExecutability,
    evidence_support: evidenceSupport,
    semantic_correctness: semanticCorrectness,
    issues,
    supported_assertions: supportedAssertions,
    unsupported_assertions: unsupportedAssertions,
    transition_id: matchedTransition.id,
  };
}
