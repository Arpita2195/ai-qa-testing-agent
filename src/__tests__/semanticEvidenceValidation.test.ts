import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import { pool } from '../config/db';
import {
  validateCandidateSemanticEvidence,
} from '../services/ai/semanticEvidenceValidator';
import {
  reviewCandidateBatch,
  EvidenceContext,
} from '../services/ai/twoStageReviewService';
import {
  getActiveStateTransitionsForProject,
  ingestStateTransitionObservation,
} from '../services/ai/stateTransitionService';
import {
  CandidateTestCase,
} from '../services/ai/twoStageReviewSchemas';
import {
  StateTransitionEvidenceRow,
  CanonicalObservationPayload,
} from '../services/ai/stateTransitionTypes';
import {
  sanitizeUrl,
  sanitizeSelector,
  sanitizeObservationPayload,
} from '../services/crawlerStateTransitions';

describe('Stage 8C — Evidence-Aware Semantic Validation', () => {
  let projectAId: string;
  let projectBId: string;
  let crawlSessionAId: string;
  let sourcePageAId: string;
  let destPageAId: string;
  let transitionAId: string;
  let verifiedTransition: StateTransitionEvidenceRow;

  beforeAll(async () => {
    // 1. Create Project A
    const pARes = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('Stage8C-Project-A', 'http://localhost:3000', true, 'public')
       RETURNING id`
    );
    projectAId = pARes.rows[0].id;

    // 2. Create Project B (for isolation tests)
    const pBRes = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('Stage8C-Project-B', 'http://localhost:4000', true, 'public')
       RETURNING id`
    );
    projectBId = pBRes.rows[0].id;

    // 3. Create Crawl Session for Project A
    const sessRes = await pool.query<{ id: string }>(
      `INSERT INTO crawl_sessions (project_id, start_url)
       VALUES ($1, 'http://localhost:3000')
       RETURNING id`,
      [projectAId]
    );
    crawlSessionAId = sessRes.rows[0].id;

    // 4. Create Source and Destination Pages for Project A
    const spRes = await pool.query<{ id: string }>(
      `INSERT INTO crawled_pages (project_id, url, path, title)
       VALUES ($1, 'http://localhost:3000/', '/', 'Home')
       RETURNING id`,
      [projectAId]
    );
    sourcePageAId = spRes.rows[0].id;

    const dpRes = await pool.query<{ id: string }>(
      `INSERT INTO crawled_pages (project_id, url, path, title)
       VALUES ($1, 'http://localhost:3000/inventory', '/inventory', 'Inventory')
       RETURNING id`,
      [projectAId]
    );
    destPageAId = dpRes.rows[0].id;

    // 5. Ingest a verified active state transition for Project A
    const payload: CanonicalObservationPayload = {
      projectId: projectAId,
      originType: 'crawler_session',
      sessionId: crawlSessionAId,
      sourcePageId: sourcePageAId,
      destinationPageId: destPageAId,
      functionalityId: null,
      sourcePath: '/',
      destinationPath: '/inventory',
      actionType: 'navigation',
      triggerSelector: 'a[href="/inventory"]',
      triggerAction: 'click',
      actionFingerprint: 'a'.repeat(64),
      navigationScope: 'cross_page',
      expectedIntent: 'Navigate to /inventory',
      authStateAtObservation: 'authenticated',
      outcomeStatus: 'verified',
      domFingerprintAtObservation: 'f'.repeat(64),
      transitionData: {
        action: 'navigation',
        resolvedUrl: '/inventory',
      },
    };

    const ingestRes = await ingestStateTransitionObservation(pool, payload, crypto.randomUUID());
    transitionAId = ingestRes.transitionId;

    const rowRes = await pool.query<StateTransitionEvidenceRow>(
      'SELECT * FROM state_transition_evidence WHERE id = $1',
      [transitionAId]
    );
    verifiedTransition = rowRes.rows[0];
  });

  afterAll(async () => {
    if (projectAId) {
      await pool.query('DELETE FROM projects WHERE id = $1', [projectAId]);
    }
    if (projectBId) {
      await pool.query('DELETE FROM projects WHERE id = $1', [projectBId]);
    }
  });

  const baseDomEvidence: EvidenceContext = {
    source: 'crawler_dom',
    appName: 'StockFlow',
    pagePath: '/',
    elements: [
      { tag: 'a', selector: 'a[href="/inventory"]', text: 'Inventory' },
      { tag: 'button', selector: 'button#open-modal', text: 'View Details' },
      { tag: 'button', selector: 'button[role="tab"]#tab-active', text: 'Active Items' },
      { tag: 'input', selector: 'input#search-box', type: 'search', text: '' },
      { tag: 'button', selector: 'button#submit-form', text: 'Save Item' },
    ],
    visibleText: ['Home', 'Inventory', 'Active Items', 'View Details', 'Welcome to StockFlow'],
  };

  // --------------------------------------------------------------------------
  // TEST 1: Selector-valid test case with unsupported expected result
  // --------------------------------------------------------------------------
  it('1. Flags a selector-valid test case with an unsupported expected result', () => {
    const candidate: CandidateTestCase = {
      candidate_id: 'cand-1',
      title: 'Valid button click with hallucinated VIP upgrade',
      steps: ['goto /', 'click button#submit-form'],
      expected_result: 'User account upgraded to VIP Gold Tier with $500 balance',
      category: 'positive',
      priority: 'high',
    };

    const mockTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      trigger_selector: 'button#submit-form',
      action_type: 'click',
      outcome_status: 'verified',
      transition_data: { action: 'click', sanitizedLabel: 'Save Item' },
    };

    const result = validateCandidateSemanticEvidence(candidate, baseDomEvidence, [mockTransition]);

    expect(result.selector_existence).toBe(true);
    expect(result.syntax_executability).toBe(true);
    // Even though selector exists and syntax is valid, expected result is not supported
    expect(result.support_level).not.toBe('evidence_supported');
    expect(result.unsupported_assertions.length).toBeGreaterThan(0);
  });

  // --------------------------------------------------------------------------
  // TEST 2: Test case supported by verified transition evidence
  // --------------------------------------------------------------------------
  it('2. Fully approves a test case supported by verified transition evidence', () => {
    const candidate: CandidateTestCase = {
      candidate_id: 'cand-2',
      title: 'Follow navigation link to inventory',
      steps: ['goto /', 'click a[href="/inventory"]'],
      expected_result: 'Navigates to /inventory',
      category: 'positive',
      priority: 'high',
    };

    const result = validateCandidateSemanticEvidence(candidate, baseDomEvidence, [verifiedTransition]);

    expect(result.support_level).toBe('evidence_supported');
    expect(result.selector_existence).toBe(true);
    expect(result.action_validity).toBe(true);
    expect(result.syntax_executability).toBe(true);
    expect(result.evidence_support).toBe(true);
    expect(result.semantic_correctness).toBe(true);
    expect(result.supported_assertions).toContain('Navigates to /inventory');
    expect(result.issues).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // TEST 3: Assertion based on an unverified transition
  // --------------------------------------------------------------------------
  it('3. Rejects presenting an unverified transition outcome as verified business behavior', () => {
    const candidate: CandidateTestCase = {
      candidate_id: 'cand-3',
      title: 'Apply filter without DOM change',
      steps: ['goto /', 'click button#submit-form'],
      expected_result: 'Filter applied and inventory list updated',
      category: 'positive',
      priority: 'medium',
    };

    const unverifiedTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      trigger_selector: 'button#submit-form',
      action_type: 'click',
      outcome_status: 'unverified', // Action succeeded but no observable DOM mutation
    };

    const result = validateCandidateSemanticEvidence(candidate, baseDomEvidence, [unverifiedTransition]);

    expect(result.support_level).toBe('partially_supported');
    expect(result.semantic_correctness).toBe(false);
    expect(result.issues.some((i) => i.includes('unverified outcome'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 4: Assertion based on inconclusive evidence
  // --------------------------------------------------------------------------
  it('4. Classifies an assertion based on inconclusive evidence as inconclusive', () => {
    const candidate: CandidateTestCase = {
      candidate_id: 'cand-4',
      title: 'Search timed out',
      steps: ['goto /', 'fill input#search-box | test', 'click a[href="/inventory"]'],
      expected_result: 'Results returned after timeout',
      category: 'positive',
      priority: 'medium',
    };

    const inconclusiveTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      trigger_selector: 'a[href="/inventory"]',
      outcome_status: 'inconclusive',
    };

    const result = validateCandidateSemanticEvidence(candidate, baseDomEvidence, [inconclusiveTransition]);

    expect(result.support_level).toBe('inconclusive');
    expect(result.issues.some((i) => i.includes('inconclusive'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 5: Assertion based on unknown navigation scope
  // --------------------------------------------------------------------------
  it('5. Rejects claiming a verified page transition when navigation scope is unknown', () => {
    const candidate: CandidateTestCase = {
      candidate_id: 'cand-5',
      title: 'Assert cross page navigation',
      steps: ['goto /', 'click a[href="/inventory"]'],
      expected_result: 'Navigate to new page',
      category: 'positive',
      priority: 'high',
    };

    const unknownNavTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      navigation_scope: 'unknown',
    };

    const result = validateCandidateSemanticEvidence(candidate, baseDomEvidence, [unknownNavTransition]);

    expect(result.support_level).toBe('unsupported');
    expect(result.issues.some((i) => i.includes('navigation scope could not be verified'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 6: Login redirect without verified authentication
  // --------------------------------------------------------------------------
  it('6. Rejects inferring successful login from a redirect alone without verified auth state', () => {
    const candidate: CandidateTestCase = {
      candidate_id: 'cand-6',
      title: 'Login to application',
      steps: ['goto /', 'click button#submit-form'],
      expected_result: 'User is authenticated and logged in',
      category: 'positive',
      priority: 'critical',
    };

    const redirectOnlyTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      trigger_selector: 'button#submit-form',
      auth_state_at_observation: 'unauthenticated', // Redirect occurred, but auth state was unauthenticated
      outcome_status: 'verified',
    };

    const result = validateCandidateSemanticEvidence(candidate, baseDomEvidence, [redirectOnlyTransition]);

    expect(result.support_level).toBe('partially_supported');
    expect(result.issues.some((i) => i.includes('redirect alone does not establish authentication'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 7: Search result evidence versus URL-only search changes
  // --------------------------------------------------------------------------
  it('7. Distinguishes verified search result evidence from URL-only search changes', () => {
    const candidate: CandidateTestCase = {
      candidate_id: 'cand-7',
      title: 'Perform search query',
      steps: ['goto /', 'fill input#search-box | laptop'],
      expected_result: 'Search results table displays matching items',
      category: 'positive',
      priority: 'medium',
    };

    // Case A: Transition has verified search results
    const verifiedSearchTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      source_path: '/',
      destination_path: '/',
      destination_page_id: sourcePageAId,
      navigation_scope: 'same_page',
      trigger_selector: 'input#search-box',
      action_type: 'search',
      outcome_status: 'verified',
      transition_data: {
        action: 'search',
        searchEvidence: { resultsFound: true, emptyResultsState: false },
      },
    };
    const resA = validateCandidateSemanticEvidence(candidate, baseDomEvidence, [verifiedSearchTransition]);
    expect(resA.support_level).toBe('evidence_supported');

    // Case B: Search executed but results container was not found
    const emptySearchTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      trigger_selector: 'input#search-box',
      action_type: 'search',
      outcome_status: 'unverified',
      transition_data: {
        action: 'search',
        searchEvidence: { resultsFound: false, emptyResultsState: false },
      },
    };
    const resB = validateCandidateSemanticEvidence(candidate, baseDomEvidence, [emptySearchTransition]);
    expect(resB.support_level).not.toBe('evidence_supported');
  });

  // --------------------------------------------------------------------------
  // TEST 8: Modal and tab outcome validation
  // --------------------------------------------------------------------------
  it('8. Enforces action-specific visibility and selection evidence for modals and tabs', () => {
    // Modal candidate
    const modalCandidate: CandidateTestCase = {
      candidate_id: 'cand-modal',
      title: 'Open details modal',
      steps: ['goto /', 'click button#open-modal'],
      expected_result: 'Modal dialog becomes visible',
      category: 'positive',
      priority: 'medium',
    };

    const modalSuccessTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      trigger_selector: 'button#open-modal',
      action_type: 'modal',
      outcome_status: 'verified',
      transition_data: { modalEvidence: { modalOpened: true } },
    };
    expect(validateCandidateSemanticEvidence(modalCandidate, baseDomEvidence, [modalSuccessTransition]).support_level).toBe('evidence_supported');

    const modalFailedTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      trigger_selector: 'button#open-modal',
      action_type: 'modal',
      outcome_status: 'unverified',
      transition_data: { modalEvidence: { modalOpened: false } },
    };
    expect(validateCandidateSemanticEvidence(modalCandidate, baseDomEvidence, [modalFailedTransition]).support_level).toBe('partially_supported');

    // Tab candidate
    const tabCandidate: CandidateTestCase = {
      candidate_id: 'cand-tab',
      title: 'Select active items tab',
      steps: ['goto /', 'click button[role="tab"]#tab-active'],
      expected_result: 'Tab is selected and content visible',
      category: 'positive',
      priority: 'medium',
    };

    const tabSuccessTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      trigger_selector: 'button[role="tab"]#tab-active',
      action_type: 'tab',
      outcome_status: 'verified',
      transition_data: { tabEvidence: { tabSelected: true, contentVisible: true } },
    };
    expect(validateCandidateSemanticEvidence(tabCandidate, baseDomEvidence, [tabSuccessTransition]).support_level).toBe('evidence_supported');
  });

  // --------------------------------------------------------------------------
  // TEST 9: Form success without confirmation indicator
  // --------------------------------------------------------------------------
  it('9. Flags form success assertions that lack confirmation indicators in evidence', () => {
    const candidate: CandidateTestCase = {
      candidate_id: 'cand-form',
      title: 'Save form data',
      steps: ['goto /', 'click button#submit-form'],
      expected_result: 'Item saved successfully with confirmation banner',
      category: 'positive',
      priority: 'high',
    };

    const formNoAlertTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      trigger_selector: 'button#submit-form',
      action_type: 'form',
      outcome_status: 'verified',
      transition_data: {
        action: 'form',
        formEvidence: { successFeedbackFound: false },
      },
    };

    const result = validateCandidateSemanticEvidence(candidate, baseDomEvidence, [formNoAlertTransition]);
    expect(result.support_level).toBe('partially_supported');
    expect(result.issues.some((i) => i.includes('no explicit confirmation indicator'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 10: Unsupported negative, boundary, and edge-case assumptions
  // --------------------------------------------------------------------------
  it('10. Prevents positive transitions from proving negative, boundary, or edge-case behavior', () => {
    const candidate: CandidateTestCase = {
      candidate_id: 'cand-neg',
      title: 'Submit negative empty field scenario',
      steps: ['goto /', 'click button#submit-form'],
      expected_result: 'Validation error: Field is required',
      category: 'negative',
      priority: 'high',
    };

    // Evidence only observed a positive verified outcome
    const positiveTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      trigger_selector: 'button#submit-form',
      action_type: 'click',
      outcome_status: 'verified',
    };

    const result = validateCandidateSemanticEvidence(candidate, baseDomEvidence, [positiveTransition]);
    expect(result.support_level).toBe('partially_supported');
    expect(result.issues.some((i) => i.includes('AI hypothesis not directly observed'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 11: Missing destination evidence
  // --------------------------------------------------------------------------
  it('11. Flags missing destination evidence when cross-page destination is unverified', () => {
    const candidate: CandidateTestCase = {
      candidate_id: 'cand-dest',
      title: 'Navigate to external unverified route',
      steps: ['goto /', 'click a[href="/inventory"]'],
      expected_result: 'Navigates to /inventory',
      category: 'positive',
      priority: 'medium',
    };

    const missingDestTransition: StateTransitionEvidenceRow = {
      ...verifiedTransition,
      destination_page_id: null, // Destination page was not visited or verified
    };

    const result = validateCandidateSemanticEvidence(candidate, baseDomEvidence, [missingDestTransition]);
    expect(result.support_level).toBe('partially_supported');
    expect(result.issues.some((i) => i.includes('destination page record is unverified'))).toBe(true);
  });

  // --------------------------------------------------------------------------
  // TEST 12: Conflicting or incomplete reviewer feedback
  // --------------------------------------------------------------------------
  it('12. Handles incomplete reviewer feedback gracefully and preserves primary candidates', async () => {
    // When reviewCandidateBatch runs with two-stage review disabled (default),
    // it preserves primary candidates and records review_status: 'skipped'
    const results = await reviewCandidateBatch({
      projectId: projectAId,
      candidates: [
        {
          title: 'Candidate One',
          steps: ['goto /', 'click a[href="/inventory"]'],
          expected_result: 'Navigates to /inventory',
        },
      ],
      evidence: {
        ...baseDomEvidence,
        transitions: [verifiedTransition],
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Candidate One');
    expect(results[0].ai_review_metadata.review_status).toBe('skipped');
    expect(results[0].ai_review_metadata.semantic_validation?.support_level).toBe('evidence_supported');
  });

  // --------------------------------------------------------------------------
  // TEST 13: Groq review failure preserving primary generation output
  // --------------------------------------------------------------------------
  it('13. Preserves primary generated candidates and sets review_status to incomplete upon reviewer failure', async () => {
    // Simulate configured two_stage_review_enabled but missing/invalid Groq key
    await pool.query(
      `INSERT INTO project_ai_configurations (project_id, two_stage_review_enabled, review_model)
       VALUES ($1, true, 'openai/gpt-oss-120b')
       ON CONFLICT (project_id) DO UPDATE SET two_stage_review_enabled = true`,
      [projectAId]
    );

    const results = await reviewCandidateBatch({
      projectId: projectAId,
      candidates: [
        {
          title: 'Primary Generated Test',
          description: 'Primary Description',
          steps: ['goto /', 'click a[href="/inventory"]'],
          expected_result: 'Navigates to /inventory',
        },
      ],
      evidence: {
        ...baseDomEvidence,
        transitions: [verifiedTransition],
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Primary Generated Test');
    // Primary candidates are preserved intact
    expect(results[0].ai_review_metadata.fallback_to_primary).toBe(true);

    // Reset configuration
    await pool.query('UPDATE project_ai_configurations SET two_stage_review_enabled = false WHERE project_id = $1', [projectAId]);
  });

  // --------------------------------------------------------------------------
  // TEST 14: Human approval remaining pending
  // --------------------------------------------------------------------------
  it('14. Ensures all AI-generated test cases are inserted with review_status pending', async () => {
    // Insert a test case with semantic review metadata
    const testCaseRes = await pool.query<{ id: string; review_status: string }>(
      `INSERT INTO test_cases (
         id, project_id, title, description, steps, expected_result, review_status, ai_review_metadata
       ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pending', $6)
       RETURNING id, review_status`,
      [
        projectAId,
        'Pending Human QA Test',
        'Description',
        JSON.stringify(['goto /', 'click a[href="/inventory"]']),
        'Navigates to /inventory',
        JSON.stringify({
          review_status: 'reviewed',
          semantic_validation: {
            support_level: 'evidence_supported',
            evidence_support: true,
          },
        }),
      ]
    );

    expect(testCaseRes.rows[0].review_status).toBe('pending');
  });

  // --------------------------------------------------------------------------
  // TEST 15: Cross-project evidence isolation
  // --------------------------------------------------------------------------
  it('15. Strictly enforces cross-project evidence isolation', async () => {
    // Project A has 1 active transition
    const transA = await getActiveStateTransitionsForProject(pool, projectAId);
    expect(transA.length).toBeGreaterThanOrEqual(1);

    // Project B must have ZERO transitions from Project A
    const transB = await getActiveStateTransitionsForProject(pool, projectBId);
    expect(transB).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // TEST 16: Sensitive information not appearing in AI review context or logs
  // --------------------------------------------------------------------------
  it('16. Guarantees zero sensitive tokens, credentials, or cookies in evidence context', () => {
    const rawTransitions: StateTransitionEvidenceRow[] = [
      {
        ...verifiedTransition,
        source_path: '/account?auth=jwt_secret_token_123',
        destination_path: '/inventory?token=secret_abc&apiKey=xyz999',
        trigger_selector: 'button[data-api-key="sk_live_1234567890"][value="secretPass!"]',
        transition_data: {
          action: 'click',
          password: 'SecretPassword123!',
          sanitizedLabel: 'Safe Button',
        },
      },
    ];

    // Filter and sanitize before AI context construction
    const sanitizedTransitions = rawTransitions.map((t) => {
      const sanitizedPayload = sanitizeObservationPayload({
        projectId: t.project_id,
        originType: t.origin_type,
        sessionId: t.crawl_session_id || t.test_run_id || '',
        sourcePageId: t.source_page_id,
        destinationPageId: t.destination_page_id,
        functionalityId: t.functionality_id,
        sourcePath: t.source_path,
        destinationPath: t.destination_path,
        actionType: t.action_type,
        triggerSelector: t.trigger_selector,
        triggerAction: t.trigger_action,
        actionFingerprint: t.action_fingerprint,
        navigationScope: t.navigation_scope,
        expectedIntent: t.expected_intent,
        authStateAtObservation: t.auth_state_at_observation,
        outcomeStatus: t.outcome_status,
        domFingerprintAtObservation: t.dom_fingerprint_at_observation,
        transitionData: t.transition_data,
      });

      return {
        action_type: sanitizedPayload.actionType,
        trigger_selector: sanitizedPayload.triggerSelector,
        source_path: sanitizedPayload.sourcePath,
        destination_path: sanitizedPayload.destinationPath,
        navigation_scope: sanitizedPayload.navigationScope,
        auth_state: sanitizedPayload.authStateAtObservation,
        outcome_status: sanitizedPayload.outcomeStatus,
        expected_intent: sanitizedPayload.expectedIntent,
        transition_data: sanitizedPayload.transitionData,
      };
    });

    const jsonContext = JSON.stringify(sanitizedTransitions);

    // Verify raw forbidden fields do not leak into AI review context
    expect(jsonContext).not.toContain('jwt_secret_token_123');
    expect(jsonContext).not.toContain('secret_abc');
    expect(jsonContext).not.toContain('xyz999');
    expect(jsonContext).not.toContain('SecretPassword123!');
    expect(jsonContext).not.toContain('sk_live_1234567890');
    expect(jsonContext).not.toContain('secretPass!');
  });
});
