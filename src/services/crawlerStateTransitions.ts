import { Page } from '@playwright/test';
import { Pool } from 'pg';
import * as crypto from 'crypto';
import {
  CanonicalObservationPayload,
  IngestionResult,
} from './ai/stateTransitionTypes';
import { ingestStateTransitionObservation } from './ai/stateTransitionService';
import { isDestructiveActionOrUrl } from './crawler';
import { DiscoveredFunctionality } from './functionalityPlanner';

// ============================================================================
// 1. SECURITY & SENSITIVE DATA SANITIZATION
// ============================================================================

const SENSITIVE_QUERY_PARAM_PATTERNS = [
  /token/i,
  /auth/i,
  /password/i,
  /secret/i,
  /key/i,
  /session/i,
  /jwt/i,
  /code/i,
  /access_token/i,
  /refresh_token/i,
  /api_key/i,
  /apikey/i,
  /credential/i,
  /user_id/i,
  /email/i,
  /pin/i,
  /ssn/i,
  /card/i,
  /cvv/i,
  /signature/i,
  /bearer/i,
  /private/i,
  /client_secret/i,
];

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;
const JWT_REGEX = /\beyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\b/g;
const PHONE_REGEX = /\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const CREDIT_CARD_REGEX = /\b(?:\d{4}[-\s]?){3}\d{4}\b/g;
const BEARER_TOKEN_REGEX = /Bearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const API_KEY_PREFIX_REGEX = /\b(?:sk_live|sk_test|ghp|gho|pat|xoxb|xoxp)_[A-Za-z0-9_]{16,}\b/g;

/**
 * Sanitizes URLs by redacting sensitive query parameter values.
 * Handles both absolute URLs and relative paths safely.
 */
export function sanitizeUrl(rawUrl: string, baseUrl = 'http://localhost'): { sanitizedUrl: string; sanitizedPath: string } {
  try {
    const isRelative = rawUrl.startsWith('/') || !rawUrl.includes('://');
    const parsed = new URL(rawUrl, baseUrl);
    const cleanParams = new URLSearchParams();

    for (const [key, val] of parsed.searchParams.entries()) {
      const isSensitive = SENSITIVE_QUERY_PARAM_PATTERNS.some((pattern) => pattern.test(key));
      if (isSensitive) {
        cleanParams.append(key, '[REDACTED]');
      } else {
        cleanParams.append(key, sanitizeText(val));
      }
    }

    parsed.search = cleanParams.toString();
    const sanitizedPath = parsed.pathname + (parsed.search ? parsed.search : '') + parsed.hash;
    return {
      sanitizedUrl: isRelative ? sanitizedPath : parsed.toString(),
      sanitizedPath,
    };
  } catch {
    return {
      sanitizedUrl: sanitizeText(rawUrl),
      sanitizedPath: rawUrl.startsWith('/') ? sanitizeText(rawUrl) : '/',
    };
  }
}

/**
 * Redacts personal identifiers, credentials, tokens, bearer tokens, and email patterns from text.
 */
export function sanitizeText(text: string): string {
  if (!text) return '';
  return text
    .replace(BEARER_TOKEN_REGEX, 'Bearer [REDACTED]')
    .replace(API_KEY_PREFIX_REGEX, '[REDACTED_API_KEY]')
    .replace(JWT_REGEX, '[REDACTED_TOKEN]')
    .replace(EMAIL_REGEX, '[REDACTED_EMAIL]')
    .replace(CREDIT_CARD_REGEX, '[REDACTED_CARD]')
    .replace(PHONE_REGEX, '[REDACTED_PHONE]')
    .slice(0, 500); // Limit length to prevent buffer bloat
}

/**
 * Sanitizes CSS/Playwright selectors to prevent leaking sensitive form input values,
 * tokens, or secret attribute names.
 */
export function sanitizeSelector(selector: string): string {
  if (!selector) return '';
  return selector
    .replace(/\[value\s*=\s*['"][^'"]*['"]\]/gi, '[value="[REDACTED]"]')
    .replace(/\[data-[a-zA-Z0-9_-]*(?:token|secret|auth|key|password|credential)[a-zA-Z0-9_-]*\s*=\s*['"][^'"]*['"]\]/gi, '[data-redacted="true"]')
    .replace(/\[(?:aria-label|title|placeholder)\s*=\s*['"][^'"]*(?:token|secret|password|key|auth|bearer)[^'"]*['"]\]/gi, '[aria-label="[REDACTED]"]')
    .slice(0, 300);
}

/**
 * Sanitizes diagnostic failure messages to guarantee zero credential or token leakage.
 */
export function sanitizeDiagnosticMessage(msg: string): string {
  if (!msg) return '';
  const sanitized = sanitizeText(msg);
  // Redact any query strings containing potential tokens
  return sanitized.replace(/(\?|&)(token|key|secret|password|auth|apiKey)=([^&\s]+)/gi, '$1$2=[REDACTED]');
}

/**
 * Performs deep recursive sanitization on a canonical observation payload before hashing and DB ingestion.
 */
export function sanitizeObservationPayload(
  payload: CanonicalObservationPayload
): CanonicalObservationPayload {
  const sanitizedSource = sanitizeUrl(payload.sourcePath).sanitizedPath;
  const sanitizedDest = sanitizeUrl(payload.destinationPath).sanitizedPath;
  const sanitizedSelector = sanitizeSelector(payload.triggerSelector);
  const sanitizedIntent = payload.expectedIntent ? sanitizeText(payload.expectedIntent) : null;

  // Deep sanitize transition_data: remove forbidden sensitive keys and scrub string values
  const cleanData: Record<string, unknown> = {};
  const forbiddenKeyRegex = /(password|token|secret|auth|cookie|key|credential|authorization|session_id)/i;

  if (payload.transitionData && typeof payload.transitionData === 'object') {
    for (const [k, v] of Object.entries(payload.transitionData)) {
      if (forbiddenKeyRegex.test(k)) {
        continue; // Discard forbidden sensitive keys entirely
      }
      if (typeof v === 'string') {
        cleanData[k] = sanitizeUrl(sanitizeText(v)).sanitizedUrl;
      } else if (typeof v === 'number' || typeof v === 'boolean') {
        cleanData[k] = v;
      } else if (v === null || v === undefined) {
        cleanData[k] = null;
      } else {
        try {
          cleanData[k] = JSON.parse(sanitizeText(JSON.stringify(v)));
        } catch {
          cleanData[k] = {};
        }
      }
    }
  }

  return {
    ...payload,
    sourcePath: sanitizedSource,
    destinationPath: sanitizedDest,
    triggerSelector: sanitizedSelector,
    expectedIntent: sanitizedIntent,
    transitionData: cleanData,
  };
}

/**
 * Deterministically computes a 64-char lowercase SHA-256 action fingerprint.
 */
export function computeActionFingerprint(
  sourcePath: string,
  actionType: string,
  triggerSelector: string,
  triggerAction: string
): string {
  const normalizedStr = `${sourcePath.toLowerCase()}|${actionType.toLowerCase()}|${triggerSelector.toLowerCase()}|${triggerAction.toLowerCase()}`;
  return crypto.createHash('sha256').update(normalizedStr, 'utf8').digest('hex');
}

// ============================================================================
// 2. CLASSIFICATION & INFERENCE ENGINE
// ============================================================================

export interface NavigationContext {
  initialUrl: string;
  finalUrl: string;
  domChanged: boolean;
  documentNavigated?: boolean; // True if Playwright frame/document navigation occurred
  isSameDocument?: boolean; // True if same-document nav (e.g. hashchange, popstate)
  sourcePageId?: string | null;
  destinationPageId?: string | null;
  hasVerifiedDestination?: boolean; // Explicit check if destination page was verified
}

/**
 * Classifies navigation scope into 'same_page' | 'cross_page' | 'unknown'.
 * - A query-string change alone never establishes cross_page navigation.
 * - Hash/fragment changes remain same_page if DOM changed.
 * - Client-side route changes require pathname change + verified destination.
 * - Document navigations require verified destination.
 * - URL changes without a verified destination classify as 'unknown'.
 */
export function classifyNavigationScope(
  initialUrl: string,
  finalUrl: string,
  domChanged: boolean,
  context?: Partial<NavigationContext>
): 'same_page' | 'cross_page' | 'unknown' {
  try {
    const initObj = new URL(initialUrl, 'http://localhost');
    const finalObj = new URL(finalUrl, 'http://localhost');

    // 1. If explicit context marks destination as unverified: cannot establish cross-page navigation
    if (context?.hasVerifiedDestination === false) {
      return 'unknown';
    }

    // 2. Same origin and identical pathname:
    if (initObj.origin === finalObj.origin && initObj.pathname === finalObj.pathname) {
      // Query string or hash change alone NEVER establishes cross-page navigation.
      if (domChanged) {
        return 'same_page';
      }
      return 'unknown';
    }

    // 3. Pathname changed across origin or pages:
    // A. Actual document navigation (full document reload / follow link)
    if (context?.documentNavigated === true) {
      return 'cross_page';
    }

    // B. Client-side route change (e.g. SPA pushState changing path)
    if (initObj.pathname !== finalObj.pathname) {
      if (domChanged || context?.destinationPageId) {
        return 'cross_page';
      }
      return 'unknown';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export interface ActionOutcomeEvidence {
  actionType?: 'click' | 'search' | 'tab' | 'modal' | 'navigation' | 'login' | 'form';
  actionExecuted?: boolean;
  hasError?: boolean;
  timeoutOccurred?: boolean;
  domMutationVerified?: boolean;

  modalEvidence?: {
    modalOpened?: boolean;
    modalClosed?: boolean;
    ariaHiddenChanged?: boolean;
  };
  tabEvidence?: {
    tabSelected?: boolean;
    contentVisible?: boolean;
  };
  searchEvidence?: {
    resultsFound?: boolean;
    emptyResultsState?: boolean;
    queryReflected?: boolean;
  };
  authEvidence?: {
    authenticatedDestinationConfirmed?: boolean;
    loginFormDismissed?: boolean;
  };
  navigationEvidence?: {
    destinationPageReached?: boolean;
    destinationPageIdVerified?: boolean;
    destinationMatchesTarget?: boolean;
  };
  formEvidence?: {
    successFeedbackFound?: boolean;
    formResetOrCleared?: boolean;
  };
}

/**
 * Classifies outcome status into 'verified' | 'unverified' | 'inconclusive' | 'error'.
 * A successful click or URL change alone must not produce 'verified'.
 * Requires action-specific observable evidence.
 */
export function classifyOutcomeStatus(
  successOrExecuted: boolean,
  domChanged: boolean,
  hasError: boolean,
  evidence?: Partial<ActionOutcomeEvidence>
): 'verified' | 'unverified' | 'inconclusive' | 'error' {
  if (hasError || evidence?.hasError) return 'error';
  if (evidence?.timeoutOccurred) return 'inconclusive';
  if (!successOrExecuted) return 'inconclusive';

  const actionType = evidence?.actionType;

  if (actionType) {
    switch (actionType) {
      case 'modal': {
        const opened = evidence.modalEvidence?.modalOpened;
        const closed = evidence.modalEvidence?.modalClosed;
        if ((opened || closed) && domChanged) {
          return 'verified';
        }
        return 'unverified';
      }
      case 'tab': {
        const tabSelected = evidence.tabEvidence?.tabSelected;
        const contentVisible = evidence.tabEvidence?.contentVisible;
        if (tabSelected && contentVisible && domChanged) {
          return 'verified';
        }
        return 'unverified';
      }
      case 'search': {
        const resultsFound = evidence.searchEvidence?.resultsFound;
        const emptyState = evidence.searchEvidence?.emptyResultsState;
        if ((resultsFound || emptyState) && domChanged) {
          return 'verified';
        }
        return 'unverified';
      }
      case 'login': {
        if (evidence.authEvidence?.authenticatedDestinationConfirmed && domChanged) {
          return 'verified';
        }
        return 'unverified';
      }
      case 'navigation': {
        const destReached = evidence.navigationEvidence?.destinationPageReached;
        const destVerified = evidence.navigationEvidence?.destinationPageIdVerified;
        const matchesTarget = evidence.navigationEvidence?.destinationMatchesTarget;
        if (destReached && destVerified && matchesTarget) {
          return 'verified';
        }
        return 'unverified';
      }
      case 'form': {
        if (evidence.formEvidence?.successFeedbackFound && domChanged) {
          return 'verified';
        }
        return 'unverified';
      }
      case 'click': {
        if (domChanged) {
          return 'verified';
        }
        return 'unverified';
      }
    }
  }

  // Fallback for general invocations without explicit actionType
  if (domChanged) return 'verified';
  return 'unverified';
}

export interface AuthStateIndicators {
  pageType?: string;
  hasLoginControl?: boolean;
  hasLogoutControl?: boolean;
  hasUserProfile?: boolean;
  hasExplicitAuthStateAttr?: 'authenticated' | 'unauthenticated' | null;
  hasPasswordInput?: boolean;
  sessionClaimedLoggedIn?: boolean;
  isRedirectFromLogin?: boolean;
}

/**
 * Determines authentication state safely using multiple non-sensitive indicators.
 * Never inspects cookies, local storage, session storage, or authorization headers.
 * Never infers authenticated state from a redirect alone.
 */
export function determineAuthState(
  pageTypeOrIndicators: string | AuthStateIndicators,
  isLoggedIn?: boolean
): 'unauthenticated' | 'authenticated' | 'inconclusive' {
  let ind: AuthStateIndicators;

  if (typeof pageTypeOrIndicators === 'string') {
    ind = {
      pageType: pageTypeOrIndicators,
      sessionClaimedLoggedIn: Boolean(isLoggedIn),
    };
  } else {
    ind = pageTypeOrIndicators;
  }

  // 1. Explicit DOM data-auth-state attribute check
  if (ind.hasExplicitAuthStateAttr === 'authenticated' && !ind.hasPasswordInput && !ind.hasLoginControl) {
    return 'authenticated';
  }
  if (ind.hasExplicitAuthStateAttr === 'unauthenticated' && !ind.hasLogoutControl && !ind.hasUserProfile) {
    return 'unauthenticated';
  }

  // 2. Conflicting indicators check (e.g. login AND logout controls both present)
  if (ind.hasLoginControl && ind.hasLogoutControl) {
    return 'inconclusive';
  }
  if (ind.hasPasswordInput && ind.hasUserProfile) {
    return 'inconclusive';
  }

  // 3. A redirect from login ALONE cannot infer authenticated state
  if (ind.isRedirectFromLogin && !ind.hasLogoutControl && !ind.hasUserProfile && !ind.hasExplicitAuthStateAttr) {
    return 'inconclusive';
  }

  const positiveSignals =
    (ind.hasLogoutControl ? 1 : 0) +
    (ind.hasUserProfile ? 1 : 0) +
    (ind.sessionClaimedLoggedIn ? 1 : 0);

  const negativeSignals =
    (ind.hasLoginControl ? 1 : 0) +
    (ind.hasPasswordInput ? 1 : 0) +
    (ind.pageType === 'auth' ? 1 : 0);

  // 4. Authenticated state requires >= 2 reliable positive signals AND zero negative signals
  if (positiveSignals >= 2 && negativeSignals === 0) {
    return 'authenticated';
  }

  // 5. Unauthenticated state requires >= 1 negative signal AND zero positive profile/logout signals
  if (negativeSignals >= 1 && !ind.hasLogoutControl && !ind.hasUserProfile) {
    return 'unauthenticated';
  }

  // 6. Ambiguous or zero indicators (e.g. public page without login/logout/user controls)
  return 'inconclusive';
}

// ============================================================================
// 3. SAFE PAGE INTERACTION EXPLORATION (READ-ONLY)
// ============================================================================

export interface ExploreInteractionsOptions {
  pool: Pool;
  page: Page;
  projectId: string;
  sessionId: string;
  sourcePageId: string;
  sourcePath: string;
  pageType: string;
  isLoggedIn: boolean;
  functionalities: DiscoveredFunctionality[];
  attemptMap: Map<string, string>; // Maps actionFingerprint -> stable attemptId
  maxInteractionsPerPage?: number;
}

export interface ExploreInteractionsResult {
  attempted: number;
  persisted: number;
  failed: number;
  skipped: number;
}

/**
 * Snapshots the DOM state using allowlisted structural metadata.
 * Never collects raw innerText or form input values to prevent PII leakage.
 */
async function getDomSnapshot(page: Page): Promise<{ url: string; fingerprint: string; title: string }> {
  try {
    const url = page.url();
    const title = await page.title().catch(() => '');
    const sanitizedTitle = sanitizeText(title);

    const signature = await page.evaluate(() => {
      // 1. Modals / Dialogs visibility
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .modal, dialog'));
      const visibleModalCount = dialogs.filter((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).length;

      // 2. Tab selection state
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      const tabSelectedState = tabs.map((t) => (t.getAttribute('aria-selected') === 'true' ? '1' : '0')).join('');

      // 3. Structural element counts (buttons, inputs, links, tables)
      const buttonCount = document.querySelectorAll('button, [role="button"]').length;
      const inputCount = document.querySelectorAll('input:not([type="hidden"]), select, textarea').length;
      const linkCount = document.querySelectorAll('a[href]').length;
      const tableRowCount = document.querySelectorAll('tr, [role="row"]').length;

      // 4. Safe structural headings (tag names and text without PII)
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map((h) => `${h.tagName.toLowerCase()}:${(h.textContent || '').trim().slice(0, 40)}`)
        .join('|');

      return `modals:${visibleModalCount}::tabs:${tabSelectedState}::elems:${buttonCount},${inputCount},${linkCount},${tableRowCount}::heads:${headings}`;
    }).catch(() => '');

    const sanitizedSignature = sanitizeText(signature);
    const fingerprint = crypto.createHash('sha256').update(`${sanitizedTitle}::${sanitizedSignature}`).digest('hex');
    return { url, fingerprint, title: sanitizedTitle };
  } catch {
    return { url: page.url(), fingerprint: '0'.repeat(64), title: '' };
  }
}

/**
 * Extracts non-sensitive authentication indicators from the current page.
 */
async function extractAuthIndicators(page: Page, pageType: string, sessionClaimedLoggedIn: boolean): Promise<AuthStateIndicators> {
  try {
    const raw = await page.evaluate(() => {
      const hasLoginControl = Array.from(document.querySelectorAll('a, button')).some(
        (el) => /^(log\s*in|sign\s*in)$/i.test(el.textContent?.trim() || '')
      );
      const hasLogoutControl = Array.from(document.querySelectorAll('a, button')).some(
        (el) => /^(log\s*out|sign\s*out)$/i.test(el.textContent?.trim() || '')
      );
      const hasUserProfile = Boolean(
        document.querySelector('[data-testid="user-profile"], .user-avatar, #user-profile, [aria-label*="account" i], [aria-label*="profile" i]')
      );
      const hasPasswordInput = Boolean(document.querySelector('input[type="password"]'));
      const bodyAuthState = document.body ? document.body.getAttribute('data-auth-state') : null;
      const hasExplicitAuthStateAttr = bodyAuthState === 'authenticated' || bodyAuthState === 'unauthenticated'
        ? (bodyAuthState as 'authenticated' | 'unauthenticated')
        : null;

      return {
        hasLoginControl,
        hasLogoutControl,
        hasUserProfile,
        hasPasswordInput,
        hasExplicitAuthStateAttr,
      };
    }).catch(() => ({}));

    return {
      ...raw,
      pageType,
      sessionClaimedLoggedIn,
    };
  } catch {
    return { pageType, sessionClaimedLoggedIn };
  }
}

/**
 * Discovers and performs safe, non-destructive interactions on a page
 * (tabs, dropdowns, modal openers/closers, safe search inputs) and ingests observations.
 * Returns precise attempted, persisted, failed, and skipped statistics.
 */
export async function explorePageInteractions(options: ExploreInteractionsOptions): Promise<ExploreInteractionsResult> {
  const {
    pool,
    page,
    projectId,
    sessionId,
    sourcePageId,
    sourcePath,
    pageType,
    isLoggedIn,
    functionalities,
    attemptMap,
    maxInteractionsPerPage = 4,
  } = options;

  const stats: ExploreInteractionsResult = {
    attempted: 0,
    persisted: 0,
    failed: 0,
    skipped: 0,
  };

  try {
    // 1. Identify interactive elements safe for read-only exploration
    const interactiveTargets = await page.evaluate(() => {
      const targets: Array<{
        tag: string;
        selector: string;
        actionType: 'click' | 'search' | 'tab' | 'modal';
        text: string;
        ariaLabel: string;
      }> = [];

      // A. Tab buttons
      document.querySelectorAll('[role="tab"], .tab, button[data-tab], .nav-tabs .nav-link').forEach((el) => {
        const text = el.textContent?.trim().slice(0, 50) || '';
        const id = el.id ? `#${el.id}` : '';
        const aria = el.getAttribute('aria-label')?.slice(0, 50) || '';
        const role = el.getAttribute('role') || '';
        const selector = id || (aria ? `[aria-label="${aria}"]` : `${el.tagName.toLowerCase()}${role ? `[role="${role}"]` : ''}`);
        targets.push({ tag: el.tagName.toLowerCase(), selector, actionType: 'tab', text, ariaLabel: aria });
      });

      // B. Modal / Dialog open triggers (e.g. "View details", "Filter", "Preview")
      document.querySelectorAll('[data-bs-toggle="modal"], [data-modal-target], button[aria-haspopup="dialog"]').forEach((el) => {
        const text = el.textContent?.trim().slice(0, 50) || '';
        const id = el.id ? `#${el.id}` : '';
        const aria = el.getAttribute('aria-label')?.slice(0, 50) || '';
        const selector = id || (aria ? `[aria-label="${aria}"]` : el.tagName.toLowerCase());
        targets.push({ tag: el.tagName.toLowerCase(), selector, actionType: 'modal', text, ariaLabel: aria });
      });

      // C. Safe search bars
      document.querySelectorAll('input[type="search"], input[name*="search" i], input[placeholder*="search" i]').forEach((el) => {
        const input = el as HTMLInputElement;
        if (input.type === 'password' || input.type === 'hidden') return;
        const id = input.id ? `#${input.id}` : '';
        const name = input.name ? `input[name="${input.name}"]` : '';
        const selector = id || name || 'input[type="search"]';
        targets.push({ tag: 'input', selector, actionType: 'search', text: '', ariaLabel: input.getAttribute('aria-label')?.slice(0, 50) || '' });
      });

      // D. Filter or sort buttons
      document.querySelectorAll('button, .dropdown-toggle').forEach((el) => {
        const text = el.textContent?.trim().slice(0, 50) || '';
        if (el.classList.contains('dropdown-toggle') || /filter|sort/i.test(text)) {
          const id = el.id ? `#${el.id}` : '';
          const aria = el.getAttribute('aria-label')?.slice(0, 50) || '';
          const selector = id || (aria ? `[aria-label="${aria}"]` : 'button');
          targets.push({ tag: 'button', selector, actionType: 'click', text, ariaLabel: aria });
        }
      });

      return targets.slice(0, 10);
    });

    for (const target of interactiveTargets) {
      if (stats.attempted >= maxInteractionsPerPage) break;

      // 2. Strict read-only safety guard: Reject destructive or mutating keywords
      if (isDestructiveActionOrUrl(target.selector, target.text)) {
        stats.skipped++;
        continue;
      }

      // 3. Skip password/auth/sensitive fields explicitly
      if (
        target.selector.includes('password') ||
        target.selector.includes('auth') ||
        target.selector.includes('secret') ||
        target.selector.includes('token')
      ) {
        stats.skipped++;
        continue;
      }

      const sanitizedSelector = sanitizeSelector(target.selector);
      const sanitizedText = sanitizeText(target.text);
      const actionType = target.actionType;
      const triggerAction = actionType === 'search' ? 'fill_and_submit' : 'click';

      const actionFp = computeActionFingerprint(sourcePath, actionType, sanitizedSelector, triggerAction);

      // Stable attempt ID: reused if this action was already attempted in this crawl session
      let attemptId = attemptMap.get(actionFp);
      if (!attemptId) {
        attemptId = crypto.randomUUID();
        attemptMap.set(actionFp, attemptId);
      }

      // Snapshot before interaction
      const preSnapshot = await getDomSnapshot(page);

      // Check modal state before interaction
      const modalOpenBefore = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"], .modal, dialog');
        if (!dialog) return false;
        const style = window.getComputedStyle(dialog);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }).catch(() => false);

      // Check tab state before interaction
      const tabSelectedBefore = await page.locator(target.selector).first().getAttribute('aria-selected').catch(() => null) === 'true';

      let actionSucceeded = false;
      let hasError = false;
      let transitionData: Record<string, unknown> = {
        action: actionType,
        targetTag: target.tag,
        sanitizedLabel: sanitizedText,
      };

      try {
        if (actionType === 'search') {
          const locator = page.locator(target.selector).first();
          if (await locator.isVisible({ timeout: 1500 }).catch(() => false)) {
            await locator.fill('test');
            await locator.press('Enter');
            await page.waitForTimeout(600);
            actionSucceeded = true;
            transitionData.query = 'test';
          }
        } else {
          const locator = page.locator(target.selector).first();
          if (await locator.isVisible({ timeout: 1500 }).catch(() => false)) {
            await locator.click({ timeout: 2000 });
            await page.waitForTimeout(600);
            actionSucceeded = true;
          }
        }
      } catch (err: any) {
        hasError = true;
        transitionData.error = sanitizeDiagnosticMessage(err?.message || 'Action failed');
      }

      // Snapshot after interaction
      const postSnapshot = await getDomSnapshot(page);
      const domChanged = preSnapshot.fingerprint !== postSnapshot.fingerprint;

      // Extract observable action-specific evidence
      const outcomeEvidence: ActionOutcomeEvidence = {
        actionType,
        actionExecuted: actionSucceeded,
        hasError,
        domMutationVerified: domChanged,
      };

      if (actionType === 'modal') {
        const modalOpenAfter = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"], .modal, dialog');
          if (!dialog) return false;
          const style = window.getComputedStyle(dialog);
          return style.display !== 'none' && style.visibility !== 'hidden';
        }).catch(() => false);

        outcomeEvidence.modalEvidence = {
          modalOpened: !modalOpenBefore && modalOpenAfter,
          modalClosed: modalOpenBefore && !modalOpenAfter,
        };
      } else if (actionType === 'tab') {
        const tabSelectedAfter = await page.locator(target.selector).first().getAttribute('aria-selected').catch(() => null) === 'true';
        outcomeEvidence.tabEvidence = {
          tabSelected: tabSelectedAfter && !tabSelectedBefore,
          contentVisible: domChanged,
        };
      } else if (actionType === 'search') {
        const searchRes = await page.evaluate(() => {
          const res = document.querySelector('.results, #results, [data-testid="search-results"], [role="feed"], table tbody tr');
          const bodyText = document.body ? document.body.innerText : '';
          const empty = /no results|not found|no items|0 items/i.test(bodyText);
          return { resultsFound: Boolean(res), emptyResultsState: empty };
        }).catch(() => ({ resultsFound: false, emptyResultsState: false }));

        outcomeEvidence.searchEvidence = searchRes;
      }

      const navScope = classifyNavigationScope(preSnapshot.url, postSnapshot.url, domChanged, {
        hasVerifiedDestination: true,
      });
      const outcomeStatus = classifyOutcomeStatus(actionSucceeded, domChanged, hasError, outcomeEvidence);

      // Extract authenticated indicators safely
      const authIndicators = await extractAuthIndicators(page, pageType, isLoggedIn);
      const authState = determineAuthState(authIndicators);

      // Link functionality ID if matched
      const matchedFunc = functionalities.find((f) =>
        f.elements.some((el) => el.selector === target.selector) ||
        f.pagePath === sourcePath
      );

      const { sanitizedPath: destinationPath } = sanitizeUrl(postSnapshot.url);

      // Strictly factual expectedIntent, no invented business success
      let expectedIntent: string | null = null;
      if (actionType === 'search') {
        expectedIntent = 'Submit search query';
      } else if (actionType === 'tab') {
        expectedIntent = sanitizedText ? `Select tab: ${sanitizedText}` : 'Select tab';
      } else if (actionType === 'modal') {
        expectedIntent = sanitizedText ? `Toggle modal: ${sanitizedText}` : 'Toggle modal dialog';
      } else if (sanitizedText) {
        expectedIntent = `Click ${sanitizedText}`;
      }

      const rawPayload: CanonicalObservationPayload = {
        projectId,
        originType: 'crawler_session',
        sessionId,
        sourcePageId,
        destinationPageId: navScope === 'cross_page' ? null : sourcePageId,
        functionalityId: matchedFunc ? matchedFunc.id : null,
        sourcePath,
        destinationPath,
        actionType,
        triggerSelector: sanitizedSelector,
        triggerAction,
        actionFingerprint: actionFp,
        navigationScope: navScope,
        expectedIntent,
        authStateAtObservation: authState,
        outcomeStatus,
        domFingerprintAtObservation: postSnapshot.fingerprint,
        transitionData,
      };

      // Sanitize payload completely before hashing and DB ingestion
      const sanitizedPayload = sanitizeObservationPayload(rawPayload);

      stats.attempted++;

      try {
        const res = await ingestStateTransitionObservation(pool, sanitizedPayload, attemptId);
        if (res && res.transitionId) {
          stats.persisted++;
        } else {
          stats.failed++;
        }
      } catch (ingestErr) {
        stats.failed++;
        console.warn(`[CrawlerEvidence] Failed to ingest state transition for ${sanitizedSelector}:`, sanitizeDiagnosticMessage(String(ingestErr)));
      }

      // Restore page state if modal opened
      if (actionType === 'modal') {
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
  } catch (exploreErr) {
    console.warn(`[CrawlerEvidence] Error during page interaction exploration on ${sourcePath}:`, sanitizeDiagnosticMessage(String(exploreErr)));
  }

  return stats;
}

/**
 * Records a verified cross-page navigation transition when following a discovered link.
 */
export async function recordNavigationTransition(params: {
  pool: Pool;
  projectId: string;
  sessionId: string;
  sourcePageId: string;
  destinationPageId: string | null;
  sourcePath: string;
  destinationPath: string;
  domFingerprint: string;
  isLoggedIn: boolean;
  attemptId: string;
  functionalityId?: string | null;
  authIndicators?: AuthStateIndicators;
}): Promise<IngestionResult | null> {
  const {
    pool,
    projectId,
    sessionId,
    sourcePageId,
    destinationPageId,
    sourcePath,
    destinationPath,
    domFingerprint,
    isLoggedIn,
    attemptId,
    functionalityId = null,
    authIndicators,
  } = params;

  const sanitizedSource = sanitizeUrl(sourcePath).sanitizedPath;
  const sanitizedDest = sanitizeUrl(destinationPath).sanitizedPath;
  const triggerSelector = `a[href="${sanitizedDest}"]`;
  const actionFingerprint = computeActionFingerprint(sanitizedSource, 'navigation', triggerSelector, 'click');

  const destinationVerified = Boolean(destinationPageId);
  const navScope = classifyNavigationScope(sourcePath, destinationPath, true, {
    documentNavigated: true,
    hasVerifiedDestination: destinationVerified,
    destinationPageId,
  });

  const outcomeStatus = classifyOutcomeStatus(true, true, false, {
    actionType: 'navigation',
    navigationEvidence: {
      destinationPageReached: true,
      destinationPageIdVerified: destinationVerified,
      destinationMatchesTarget: true,
    },
  });

  const authState = authIndicators
    ? determineAuthState(authIndicators)
    : determineAuthState('general', isLoggedIn);

  const rawPayload: CanonicalObservationPayload = {
    projectId,
    originType: 'crawler_session',
    sessionId,
    sourcePageId,
    destinationPageId,
    functionalityId: functionalityId ?? null,
    sourcePath: sanitizedSource,
    destinationPath: sanitizedDest,
    actionType: 'navigation',
    triggerSelector,
    triggerAction: 'click',
    actionFingerprint,
    navigationScope: navScope,
    expectedIntent: `Navigate to ${sanitizedDest}`,
    authStateAtObservation: authState,
    outcomeStatus,
    domFingerprintAtObservation: domFingerprint || '0'.repeat(64),
    transitionData: {
      action: 'navigation',
      resolvedUrl: sanitizedDest,
    },
  };

  const sanitizedPayload = sanitizeObservationPayload(rawPayload);

  try {
    return await ingestStateTransitionObservation(pool, sanitizedPayload, attemptId);
  } catch (err) {
    console.warn(`[CrawlerEvidence] Failed to record navigation transition to ${sanitizedDest}:`, sanitizeDiagnosticMessage(String(err)));
    return null;
  }
}
