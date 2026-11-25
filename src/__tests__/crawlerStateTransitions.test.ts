import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from '@playwright/test';
import * as crypto from 'crypto';
import { pool } from '../config/db';
import {
  sanitizeUrl,
  sanitizeText,
  sanitizeSelector,
  sanitizeDiagnosticMessage,
  sanitizeObservationPayload,
  computeActionFingerprint,
  classifyNavigationScope,
  classifyOutcomeStatus,
  determineAuthState,
  explorePageInteractions,
  recordNavigationTransition,
} from '../services/crawlerStateTransitions';
import { crawlSite } from '../services/crawler';
import { CanonicalObservationPayload } from '../services/ai/stateTransitionTypes';

describe('Stage 8B — Autonomous Crawler State Transition Evidence Capture', () => {
  let server: http.Server;
  let baseUrl: string;
  let browser: Browser;
  let testProjectId: string;
  let crawlSessionId: string;
  let sourcePageId: string;
  let destPageId: string;

  beforeAll(async () => {
    // 1. Setup local HTTP fixture server with interactive elements (search, tabs, modal, links)
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const pathname = url.pathname;

      if (pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Home Page</title></head>
            <body>
              <h1>Welcome to StockFlow Fixture</h1>
              <nav>
                <a href="/inventory?ref=nav&token=secret_12345">Inventory Dashboard</a>
              </nav>
            </body>
          </html>
        `);
      }

      if (pathname === '/inventory') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end(`
          <!DOCTYPE html>
          <html>
            <head><title>Inventory Dashboard</title></head>
            <body data-auth-state="authenticated">
              <h1>Inventory</h1>
              <div data-testid="user-profile">User: Admin</div>
              <button id="logout-btn">Log Out</button>

              <!-- Search Bar -->
              <form id="search-form" onsubmit="event.preventDefault(); document.getElementById('results').innerText = 'Filtered: ' + document.getElementById('search-input').value;">
                <input id="search-input" type="search" placeholder="Search items..." />
                <button id="search-btn" type="submit">Search</button>
              </form>
              <div id="results" class="results">All Items (10)</div>

              <!-- Tabs -->
              <div class="tabs">
                <button role="tab" id="tab-active" aria-selected="true" onclick="document.getElementById('tab-archived').setAttribute('aria-selected', 'false'); this.setAttribute('aria-selected', 'true'); document.getElementById('tab-content').innerText = 'Active Content';">Active Items</button>
                <button role="tab" id="tab-archived" aria-selected="false" onclick="document.getElementById('tab-active').setAttribute('aria-selected', 'false'); this.setAttribute('aria-selected', 'true'); document.getElementById('tab-content').innerText = 'Archived Content';">Archived Items</button>
              </div>
              <div id="tab-content">Active Content</div>

              <!-- Modal Trigger -->
              <button data-modal-target="item-modal" id="open-modal-btn" onclick="document.getElementById('item-modal').style.display = 'block';">View Item Details</button>
              <div id="item-modal" role="dialog" style="display: none;">
                <h2>Item Details Modal</h2>
                <p>Confidential Part No: XYZ-999</p>
                <button id="close-modal-btn" onclick="document.getElementById('item-modal').style.display = 'none';">Close</button>
              </div>
            </body>
          </html>
        `);
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;

    browser = await chromium.launch({ headless: true });

    // 2. Database test fixtures
    const projRes = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('Stage8B-Crawler-Test', $1, true, 'public')
       RETURNING id`,
      [baseUrl]
    );
    testProjectId = projRes.rows[0].id;

    const sessRes = await pool.query<{ id: string }>(
      `INSERT INTO crawl_sessions (project_id, start_url)
       VALUES ($1, $2)
       RETURNING id`,
      [testProjectId, baseUrl]
    );
    crawlSessionId = sessRes.rows[0].id;

    const spRes = await pool.query<{ id: string }>(
      `INSERT INTO crawled_pages (project_id, url, path)
       VALUES ($1, $2, '/')
       RETURNING id`,
      [testProjectId, `${baseUrl}/`]
    );
    sourcePageId = spRes.rows[0].id;

    const dpRes = await pool.query<{ id: string }>(
      `INSERT INTO crawled_pages (project_id, url, path)
       VALUES ($1, $2, '/inventory')
       RETURNING id`,
      [testProjectId, `${baseUrl}/inventory`]
    );
    destPageId = dpRes.rows[0].id;
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await new Promise<void>((resolve) => server.close(() => resolve()));

    // Cleanup project and cascade all evidence
    if (testProjectId) {
      await pool.query('DELETE FROM projects WHERE id = $1', [testProjectId]);
    }
  });

  // ==========================================================================
  // SECTION 1: CORRECT NAVIGATION CLASSIFICATION
  // ==========================================================================
  describe('1. Navigation Scope Classification', () => {
    it('Search changing only query parameters classifies as same_page (never cross_page)', () => {
      // Query param change with DOM change -> same_page
      const scopeWithDom = classifyNavigationScope(
        'http://localhost/items',
        'http://localhost/items?search=shoes',
        true
      );
      expect(scopeWithDom).toBe('same_page');

      // Query param change without DOM change -> unknown
      const scopeWithoutDom = classifyNavigationScope(
        'http://localhost/items',
        'http://localhost/items?search=shoes',
        false
      );
      expect(scopeWithoutDom).toBe('unknown');
    });

    it('Hash/fragment changes classify as same_page (never cross_page)', () => {
      // Hash change on same page with DOM change -> same_page
      const scopeWithDom = classifyNavigationScope(
        'http://localhost/docs#overview',
        'http://localhost/docs#details',
        true
      );
      expect(scopeWithDom).toBe('same_page');

      // Hash change without DOM change -> unknown
      const scopeWithoutDom = classifyNavigationScope(
        'http://localhost/docs#overview',
        'http://localhost/docs#details',
        false
      );
      expect(scopeWithoutDom).toBe('unknown');
    });

    it('Client-side route changes classify as cross_page when destination is verified', () => {
      const scope = classifyNavigationScope(
        'http://localhost/app/dashboard',
        'http://localhost/app/reports',
        true,
        {
          documentNavigated: false,
          hasVerifiedDestination: true,
          destinationPageId: 'dest-page-uuid',
        }
      );
      expect(scope).toBe('cross_page');
    });

    it('Actual document navigation classifies as cross_page when destination is verified', () => {
      const scope = classifyNavigationScope(
        'http://localhost/home',
        'http://localhost/inventory',
        true,
        {
          documentNavigated: true,
          hasVerifiedDestination: true,
          destinationPageId: 'dest-page-uuid',
        }
      );
      expect(scope).toBe('cross_page');
    });

    it('URL changes without a verified destination classify as unknown', () => {
      const scope = classifyNavigationScope(
        'http://localhost/page1',
        'http://localhost/page2',
        true,
        {
          hasVerifiedDestination: false,
          destinationPageId: null,
        }
      );
      expect(scope).toBe('unknown');
    });
  });

  // ==========================================================================
  // SECTION 2: STRENGTHENED OUTCOME VERIFICATION
  // ==========================================================================
  describe('2. Strengthened Outcome Verification', () => {
    it('Modal: Verified only when visibility actually toggles; unverified otherwise', () => {
      // Clicked but modal did not open
      const unverified = classifyOutcomeStatus(true, false, false, {
        actionType: 'modal',
        modalEvidence: { modalOpened: false, modalClosed: false },
        domMutationVerified: false,
      });
      expect(unverified).toBe('unverified');

      // Clicked and modal became visible
      const verified = classifyOutcomeStatus(true, true, false, {
        actionType: 'modal',
        modalEvidence: { modalOpened: true },
        domMutationVerified: true,
      });
      expect(verified).toBe('verified');
    });

    it('Tab: Verified only when tab is selected and content visible; unverified otherwise', () => {
      // Tab clicked but aria-selected remained false
      const unverified = classifyOutcomeStatus(true, true, false, {
        actionType: 'tab',
        tabEvidence: { tabSelected: false, contentVisible: true },
        domMutationVerified: true,
      });
      expect(unverified).toBe('unverified');

      // Tab clicked, selected became true, content visible
      const verified = classifyOutcomeStatus(true, true, false, {
        actionType: 'tab',
        tabEvidence: { tabSelected: true, contentVisible: true },
        domMutationVerified: true,
      });
      expect(verified).toBe('verified');
    });

    it('Search: Verified only when results container or empty-state is verified; unverified otherwise', () => {
      // Search input submitted, but no results container or empty-state appeared
      const unverified = classifyOutcomeStatus(true, false, false, {
        actionType: 'search',
        searchEvidence: { resultsFound: false, emptyResultsState: false },
        domMutationVerified: false,
      });
      expect(unverified).toBe('unverified');

      // Search input submitted and results appeared
      const verifiedResults = classifyOutcomeStatus(true, true, false, {
        actionType: 'search',
        searchEvidence: { resultsFound: true, emptyResultsState: false },
        domMutationVerified: true,
      });
      expect(verifiedResults).toBe('verified');

      // Search input submitted and explicit empty-results state confirmed
      const verifiedEmpty = classifyOutcomeStatus(true, true, false, {
        actionType: 'search',
        searchEvidence: { resultsFound: false, emptyResultsState: true },
        domMutationVerified: true,
      });
      expect(verifiedEmpty).toBe('verified');
    });

    it('Login: Requires verified authenticated destination state, not merely redirect', () => {
      // Redirect occurred, but destination is not authenticated
      const redirectOnly = classifyOutcomeStatus(true, true, false, {
        actionType: 'login',
        authEvidence: { authenticatedDestinationConfirmed: false },
        domMutationVerified: true,
      });
      expect(redirectOnly).toBe('unverified');

      // Destination reached and authenticated state confirmed
      const authVerified = classifyOutcomeStatus(true, true, false, {
        actionType: 'login',
        authEvidence: { authenticatedDestinationConfirmed: true },
        domMutationVerified: true,
      });
      expect(authVerified).toBe('verified');
    });

    it('Form: Verified when safe success feedback is confirmed; unverified otherwise', () => {
      const unverified = classifyOutcomeStatus(true, false, false, {
        actionType: 'form',
        formEvidence: { successFeedbackFound: false },
        domMutationVerified: false,
      });
      expect(unverified).toBe('unverified');

      const verified = classifyOutcomeStatus(true, true, false, {
        actionType: 'form',
        formEvidence: { successFeedbackFound: true },
        domMutationVerified: true,
      });
      expect(verified).toBe('verified');
    });

    it('Inconclusive on timeout or unexecuted action; error on Playwright failure', () => {
      expect(classifyOutcomeStatus(false, false, false)).toBe('inconclusive');
      expect(classifyOutcomeStatus(true, true, false, { timeoutOccurred: true })).toBe('inconclusive');
      expect(classifyOutcomeStatus(false, false, true)).toBe('error');
    });
  });

  // ==========================================================================
  // SECTION 3: SENSITIVE DATA PROTECTION & INGESTION PAYLOAD SANITIZATION
  // ==========================================================================
  describe('3. Sensitive Data Protection & Sanitization', () => {
    it('Redacts sensitive URL parameters from query strings', () => {
      const sensitive = 'http://example.com/api?token=secret123&session_id=sess_456&auth=bearer_token&page=2&apiKey=xyz';
      const { sanitizedUrl, sanitizedPath } = sanitizeUrl(sensitive);

      expect(sanitizedUrl).toContain('token=%5BREDACTED%5D');
      expect(sanitizedUrl).toContain('session_id=%5BREDACTED%5D');
      expect(sanitizedUrl).toContain('auth=%5BREDACTED%5D');
      expect(sanitizedUrl).toContain('apiKey=%5BREDACTED%5D');
      expect(sanitizedUrl).toContain('page=2');
      expect(sanitizedUrl).not.toContain('secret123');
      expect(sanitizedUrl).not.toContain('sess_456');

      expect(sanitizedPath).toContain('page=2');
    });

    it('Excludes password and sensitive attribute values from selectors', () => {
      const selectorWithValue = 'input[name="password"][value="SuperSecretPassword123!"]';
      const sanitized = sanitizeSelector(selectorWithValue);
      expect(sanitized).toBe('input[name="password"][value="[REDACTED]"]');
      expect(sanitized).not.toContain('SuperSecretPassword123!');

      const selectorWithToken = 'div[data-token="jwt-header.payload.sig"]';
      const sanitizedToken = sanitizeSelector(selectorWithToken);
      expect(sanitizedToken).toBe('div[data-redacted="true"]');
      expect(sanitizedToken).not.toContain('jwt-header');
    });

    it('Redacts tokens, emails, phone numbers, and cards from text and labels', () => {
      const rawText = 'Contact alice@example.com at +1-555-123-4567 with card 4111 2222 3333 4444 and token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID and Bearer sk_live_998877665544332211';
      const sanitized = sanitizeText(rawText);

      expect(sanitized).toContain('[REDACTED_EMAIL]');
      expect(sanitized).toContain('[REDACTED_PHONE]');
      expect(sanitized).toContain('[REDACTED_CARD]');
      expect(sanitized).toContain('[REDACTED_TOKEN]');
      expect(sanitized).toContain('Bearer [REDACTED]');
      expect(sanitized).not.toContain('alice@example.com');
      expect(sanitized).not.toContain('4111 2222');
      expect(sanitized).not.toContain('sk_live_998877665544332211');
    });

    it('Sanitizes diagnostics messages so errors never leak tokens or query secrets', () => {
      const err = 'Failed navigating to http://localhost/dashboard?token=supersecret123&apiKey=key999: element not found';
      const clean = sanitizeDiagnosticMessage(err);
      expect(clean).toContain('token=[REDACTED]');
      expect(clean).toContain('apiKey=[REDACTED]');
      expect(clean).not.toContain('supersecret123');
      expect(clean).not.toContain('key999');
    });

    it('Synthetic secrets test: Inspects exact final ingestion payload and verifies zero secret leakage', () => {
      const rawPayload: CanonicalObservationPayload = {
        projectId: testProjectId,
        originType: 'crawler_session',
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: destPageId,
        functionalityId: null,
        sourcePath: '/account?auth=jwt_secret_token_12345',
        destinationPath: '/inventory?token=dest_secret_token_67890',
        actionType: 'click',
        triggerSelector: 'button[data-api-key="sk_live_secret1234567890"][value="secretPassword!"]',
        triggerAction: 'click',
        actionFingerprint: '0'.repeat(64),
        navigationScope: 'same_page',
        expectedIntent: 'Click secret action for alice@example.com with token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID',
        authStateAtObservation: 'authenticated',
        outcomeStatus: 'verified',
        domFingerprintAtObservation: '1'.repeat(64),
        transitionData: {
          action: 'click',
          password: 'UnsafePassword123', // Forbidden key
          token: 'UnsafeToken456',       // Forbidden key
          sanitizedLabel: 'Safe Label with sk_live_001122334455667788',
          resolvedUrl: 'http://localhost/page?client_secret=topsecret123',
        },
      };

      const sanitized = sanitizeObservationPayload(rawPayload);

      // Verify source and destination paths have redacted tokens
      expect(sanitized.sourcePath).toContain('auth=%5BREDACTED%5D');
      expect(sanitized.sourcePath).not.toContain('jwt_secret_token_12345');
      expect(sanitized.destinationPath).toContain('token=%5BREDACTED%5D');
      expect(sanitized.destinationPath).not.toContain('dest_secret_token_67890');

      // Verify trigger selector attribute values were redacted
      expect(sanitized.triggerSelector).toContain('[data-redacted="true"]');
      expect(sanitized.triggerSelector).toContain('[value="[REDACTED]"]');
      expect(sanitized.triggerSelector).not.toContain('sk_live_secret1234567890');
      expect(sanitized.triggerSelector).not.toContain('secretPassword!');

      // Verify expectedIntent redacted email and JWT token
      expect(sanitized.expectedIntent).toContain('[REDACTED_EMAIL]');
      expect(sanitized.expectedIntent).toContain('[REDACTED_TOKEN]');
      expect(sanitized.expectedIntent).not.toContain('alice@example.com');

      // Verify transitionData completely stripped forbidden keys
      expect(sanitized.transitionData).not.toHaveProperty('password');
      expect(sanitized.transitionData).not.toHaveProperty('token');
      expect(sanitized.transitionData.sanitizedLabel).toContain('[REDACTED_API_KEY]');
      expect(sanitized.transitionData.sanitizedLabel).not.toContain('sk_live_001122334455667788');
      expect(sanitized.transitionData.resolvedUrl).toContain('client_secret=%5BREDACTED%5D');
      expect(sanitized.transitionData.resolvedUrl).not.toContain('topsecret123');
    });

    it('Computes deterministic action fingerprint across identical targets', () => {
      const fp1 = computeActionFingerprint('/inventory', 'click', 'button#tab-active', 'click');
      const fp2 = computeActionFingerprint('/inventory', 'CLICK', 'BUTTON#tab-active', 'Click');
      expect(fp1).toBe(fp2);
      expect(fp1).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  // ==========================================================================
  // SECTION 4: AUTHENTICATION CLASSIFICATION
  // ==========================================================================
  describe('4. Authentication State Classification', () => {
    it('Multiple reliable positive indicators classify as authenticated', () => {
      const state = determineAuthState({
        hasLogoutControl: true,
        hasUserProfile: true,
        hasPasswordInput: false,
        hasLoginControl: false,
      });
      expect(state).toBe('authenticated');
    });

    it('Multiple reliable negative indicators classify as unauthenticated', () => {
      const state = determineAuthState({
        hasPasswordInput: true,
        hasLoginControl: true,
        hasLogoutControl: false,
        hasUserProfile: false,
      });
      expect(state).toBe('unauthenticated');
    });

    it('Ambiguous: Conflicting login and logout controls classify as inconclusive', () => {
      const state = determineAuthState({
        hasLoginControl: true,
        hasLogoutControl: true,
        hasUserProfile: false,
      });
      expect(state).toBe('inconclusive');
    });

    it('Ambiguous: Password input alongside user profile classifies as inconclusive', () => {
      const state = determineAuthState({
        hasPasswordInput: true,
        hasUserProfile: true,
      });
      expect(state).toBe('inconclusive');
    });

    it('Ambiguous: Redirect from login alone without profile or logout classifies as inconclusive', () => {
      const state = determineAuthState({
        isRedirectFromLogin: true,
        hasLogoutControl: false,
        hasUserProfile: false,
      });
      expect(state).toBe('inconclusive');
    });

    it('Ambiguous: Zero indicators on static/public page classify as inconclusive', () => {
      const state = determineAuthState({
        hasLoginControl: false,
        hasLogoutControl: false,
        hasUserProfile: false,
        hasPasswordInput: false,
        sessionClaimedLoggedIn: false,
      });
      expect(state).toBe('inconclusive');
    });
  });

  // ==========================================================================
  // SECTION 5: EVIDENCE CAPTURE FAILURE VISIBILITY & TRACKING
  // ==========================================================================
  describe('5. Evidence Capture Failure Visibility & Tracking', () => {
    it('Handles ingestion failure gracefully, tracks failed count, and never counts as persisted', async () => {
      const invalidProjectId = crypto.randomUUID();
      const res = await recordNavigationTransition({
        pool,
        projectId: invalidProjectId,
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: destPageId,
        sourcePath: '/',
        destinationPath: '/inventory',
        domFingerprint: 'd'.repeat(64),
        isLoggedIn: true,
        attemptId: crypto.randomUUID(),
      });

      // Must return null without throwing unhandled exceptions
      expect(res).toBeNull();
    });

    it('Tracks attempted, persisted, failed, and skipped statistics accurately in explorePageInteractions', async () => {
      const page = await browser.newPage();
      try {
        await page.goto(`${baseUrl}/inventory`);
        const attemptMap = new Map<string, string>();

        const stats = await explorePageInteractions({
          pool,
          page,
          projectId: testProjectId,
          sessionId: crawlSessionId,
          sourcePageId: destPageId,
          sourcePath: '/inventory',
          pageType: 'list_table',
          isLoggedIn: true,
          functionalities: [],
          attemptMap,
          maxInteractionsPerPage: 3,
        });

        expect(stats.attempted).toBeGreaterThanOrEqual(2);
        expect(stats.persisted).toBeGreaterThanOrEqual(2);
        expect(stats.failed).toBe(0);
      } finally {
        await page.close();
      }
    });
  });

  // ==========================================================================
  // SECTION 6: TRANSITION RECORDING & INGESTION INTEGRATION
  // ==========================================================================
  describe('6. Structured State Transition Capture Integration', () => {
    it('Records cross-page navigation transition evidence with verified outcome', async () => {
      const attemptId = crypto.randomUUID();
      const result = await recordNavigationTransition({
        pool,
        projectId: testProjectId,
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: destPageId,
        sourcePath: '/',
        destinationPath: '/inventory?token=secret123',
        domFingerprint: 'a'.repeat(64),
        isLoggedIn: true,
        attemptId,
      });

      expect(result).not.toBeNull();
      expect(result?.status).toBe('created');

      // Verify persisted row in database
      const rows = (await pool.query(
        'SELECT * FROM state_transition_evidence WHERE id = $1',
        [result?.transitionId]
      )).rows;

      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.action_type).toBe('navigation');
      expect(row.navigation_scope).toBe('cross_page');
      expect(row.outcome_status).toBe('verified');
      expect(row.source_page_id).toBe(sourcePageId);
      expect(row.destination_page_id).toBe(destPageId);
      expect(row.destination_path).toContain('token=%5BREDACTED%5D');
      expect(row.destination_path).not.toContain('secret123');
    });

    it('Stable attempt ID is idempotent; new attempt ID increments attempt number', async () => {
      const stableAttempt = crypto.randomUUID();

      // First submission of stable attempt
      const r1 = await recordNavigationTransition({
        pool,
        projectId: testProjectId,
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: destPageId,
        sourcePath: '/test-retry',
        destinationPath: '/test-retry-dest',
        domFingerprint: 'b'.repeat(64),
        isLoggedIn: true,
        attemptId: stableAttempt,
      });
      expect(r1?.status).toBe('created');
      expect(r1?.attemptNumber).toBe(1);

      // Retry of exact same attempt -> Idempotent
      const r2 = await recordNavigationTransition({
        pool,
        projectId: testProjectId,
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: destPageId,
        sourcePath: '/test-retry',
        destinationPath: '/test-retry-dest',
        domFingerprint: 'b'.repeat(64),
        isLoggedIn: true,
        attemptId: stableAttempt,
      });
      expect(r2?.status).toBe('idempotent');
      expect(r2?.transitionId).toBe(r1?.transitionId);
      expect(r2?.attemptNumber).toBe(1);

      // Genuinely new attempt ID -> Increments attempt number to 2
      const newAttempt = crypto.randomUUID();
      const r3 = await recordNavigationTransition({
        pool,
        projectId: testProjectId,
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: destPageId,
        sourcePath: '/test-retry',
        destinationPath: '/test-retry-dest',
        domFingerprint: 'c'.repeat(64),
        isLoggedIn: true,
        attemptId: newAttempt,
      });
      expect(r3?.status).toBe('superseded');
      expect(r3?.attemptNumber).toBe(2);
    });
  });

  // ==========================================================================
  // SECTION 7: END-TO-END CRAWLER INTEGRATION WITH TRANSITION CAPTURE
  // ==========================================================================
  describe('7. End-to-End Autonomous Crawler Execution & Completeness Reporting', () => {
    it('Crawls fixture end-to-end, discovering pages, ingesting transitions, and reporting evidence completeness', async () => {
      const result = await crawlSite(
        { id: testProjectId, base_url: baseUrl },
        { maxDepth: 2, maxPages: 5, readOnly: true }
      );

      expect(result.status).toBe('completed');
      expect(result.totalPagesCrawled).toBeGreaterThanOrEqual(2);

      // Verify evidenceStats completeness indicator
      expect(result.evidenceStats).toBeDefined();
      expect(result.evidenceStats?.attempted).toBeGreaterThanOrEqual(2);
      expect(result.evidenceStats?.persisted).toBeGreaterThanOrEqual(2);
      expect(result.evidenceStats?.failed).toBe(0);
      expect(result.evidenceStats?.completenessRate).toBe(1.0);

      // Verify that state transition evidence was created during the crawl
      const allEvidence = (await pool.query(
        `SELECT id, action_type, navigation_scope, outcome_status, source_path, destination_path
         FROM state_transition_evidence
         WHERE project_id = $1 AND crawl_session_id = $2`,
        [testProjectId, result.sessionId]
      )).rows;

      expect(allEvidence.length).toBeGreaterThanOrEqual(1);

      // Verify navigation transition from '/' to '/inventory' was recorded
      const navRecord = allEvidence.find((e) => e.action_type === 'navigation');
      expect(navRecord).toBeDefined();
      expect(navRecord.navigation_scope).toBe('cross_page');
      expect(navRecord.outcome_status).toBe('verified');
      expect(navRecord.source_path).toBe('/');
      expect(navRecord.destination_path).toContain('/inventory');
    });
  });
});
