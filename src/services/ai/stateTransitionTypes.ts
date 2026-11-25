import * as crypto from 'crypto';

/**
 * 18-Field Immutable Semantic Observation Payload.
 * Represents an observed application state transition captured during crawling or test execution.
 * Secrets, cookies, session tokens, and passwords are strictly excluded.
 */
export interface CanonicalObservationPayload {
  projectId: string;
  originType: 'crawler_session' | 'test_execution';
  sessionId: string;
  sourcePageId: string;
  destinationPageId: string | null;
  functionalityId: string | null;
  sourcePath: string;
  destinationPath: string;
  actionType: string;
  triggerSelector: string;
  triggerAction: string;
  actionFingerprint: string;
  navigationScope: 'same_page' | 'cross_page' | 'unknown';
  expectedIntent: string | null;
  authStateAtObservation: 'unauthenticated' | 'authenticated' | 'inconclusive';
  outcomeStatus: 'verified' | 'unverified' | 'inconclusive' | 'error';
  domFingerprintAtObservation: string;
  transitionData: Record<string, unknown>;
}

export interface StateTransitionEvidenceRow {
  id: string;
  project_id: string;
  origin_type: 'crawler_session' | 'test_execution';
  crawl_session_id: string | null;
  test_run_id: string | null;
  source_page_id: string;
  destination_page_id: string | null;
  functionality_id: string | null;
  source_path: string;
  destination_path: string;
  action_type: string;
  trigger_selector: string;
  trigger_action: string;
  action_fingerprint: string;
  navigation_scope: 'same_page' | 'cross_page' | 'unknown';
  expected_intent: string | null;
  auth_state_at_observation: 'unauthenticated' | 'authenticated' | 'inconclusive';
  outcome_status: 'verified' | 'unverified' | 'inconclusive' | 'error';
  dom_fingerprint_at_observation: string;
  transition_data: Record<string, unknown>;
  attempt_id: string;
  attempt_number: number;
  canonical_observation_hash: string;
  lifecycle_status: 'active' | 'conflicted' | 'superseded';
  created_at: Date;
}

export interface StateTransitionConflictRow {
  id: string;
  project_id: string;
  transition_id: string;
  attempt_id: string;
  existing_observation_hash: string;
  incoming_observation_hash: string;
  incoming_observation: Record<string, unknown>;
  conflicting_fields: string[];
  detected_at: Date;
}

export interface IngestionResult {
  transitionId: string;
  attemptNumber: number;
  status: 'created' | 'idempotent' | 'conflicted' | 'idempotent_conflict' | 'superseded';
}

/**
 * Hardened recursive canonical JSON serializer.
 * Enforces deterministic JSON serialization:
 * - Sorts object keys recursively.
 * - Preserves array ordering.
 * - Normalizes -0 to 0.
 * - Preserves meaningful empty strings without coercion.
 * - Rejects undefined, BigInt, functions, symbols, NaN, Infinity, cyclic objects, and Date instances.
 */
export function canonicalizeJson(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null) {
    return 'null';
  }

  if (value === undefined) {
    throw new TypeError('Canonical JSON serializer does not allow undefined');
  }
  if (typeof value === 'bigint') {
    throw new TypeError('Canonical JSON serializer does not allow BigInt');
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new TypeError(`Canonical JSON serializer does not allow ${typeof value}`);
  }

  if (typeof value === 'number') {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      throw new TypeError(`Canonical JSON serializer does not allow non-finite numbers: ${value}`);
    }
    // Normalize negative zero to positive zero
    if (Object.is(value, -0)) {
      return '0';
    }
    return JSON.stringify(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'object') {
    if (seen.has(value)) {
      throw new TypeError('Canonical JSON serializer detected cyclic object reference');
    }
    seen.add(value);

    // Reject non-plain objects to prevent ambiguous serialization
    if (value instanceof Date) {
      throw new TypeError('Canonical JSON serializer does not allow Date instances; use ISO 8601 string');
    }
    if (value instanceof RegExp || value instanceof Map || value instanceof Set) {
      throw new TypeError(`Canonical JSON serializer does not allow ${value.constructor.name} instances`);
    }

    if (Array.isArray(value)) {
      const elements: string[] = [];
      for (let i = 0; i < value.length; i++) {
        const item = value[i];
        if (item === undefined) {
          throw new TypeError(`Canonical JSON serializer does not allow undefined array element at index ${i}`);
        }
        elements.push(canonicalizeJson(item, seen));
      }
      seen.delete(value);
      return `[${elements.join(',')}]`;
    }

    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      throw new TypeError('Canonical JSON serializer only accepts plain objects');
    }

    const keys = Object.keys(value).sort();
    const entries: string[] = [];
    for (const key of keys) {
      const val = (value as Record<string, unknown>)[key];
      if (val === undefined) {
        throw new TypeError(`Canonical JSON serializer does not allow undefined object property: ${key}`);
      }
      entries.push(`${JSON.stringify(key)}:${canonicalizeJson(val, seen)}`);
    }
    seen.delete(value);
    return `{${entries.join(',')}}`;
  }

  throw new TypeError(`Unsupported type in canonical JSON serializer: ${typeof value}`);
}

/**
 * Computes deterministic SHA-256 hash of canonicalized JSON.
 */
export function hashCanonicalJson(value: unknown): string {
  const jsonStr = canonicalizeJson(value);
  return crypto.createHash('sha256').update(jsonStr, 'utf8').digest('hex');
}

/**
 * Normalizes canonical payload fields.
 * - UUIDs and hexadecimal fingerprints are strictly lowercased.
 * - Selectors, paths, and visible labels are preserved exactly.
 * - Empty strings remain empty strings.
 */
export function normalizeCanonicalPayload(raw: CanonicalObservationPayload): CanonicalObservationPayload {
  return {
    projectId: raw.projectId.toLowerCase(),
    originType: raw.originType,
    sessionId: raw.sessionId.toLowerCase(),
    sourcePageId: raw.sourcePageId.toLowerCase(),
    destinationPageId: raw.destinationPageId ? raw.destinationPageId.toLowerCase() : null,
    functionalityId: raw.functionalityId ? raw.functionalityId.toLowerCase() : null,
    sourcePath: raw.sourcePath,
    destinationPath: raw.destinationPath,
    actionType: raw.actionType,
    triggerSelector: raw.triggerSelector,
    triggerAction: raw.triggerAction,
    actionFingerprint: raw.actionFingerprint.toLowerCase(),
    navigationScope: raw.navigationScope,
    expectedIntent: raw.expectedIntent ?? null,
    authStateAtObservation: raw.authStateAtObservation,
    outcomeStatus: raw.outcomeStatus,
    domFingerprintAtObservation: raw.domFingerprintAtObservation.toLowerCase(),
    transitionData: raw.transitionData ?? {},
  };
}

/**
 * Compares all 18 immutable fields between two canonical observations.
 * Returns an array of detected conflicting field names.
 */
export function findConflictingFields(
  existing: CanonicalObservationPayload,
  incoming: CanonicalObservationPayload
): string[] {
  const conflicts: string[] = [];

  if (existing.projectId !== incoming.projectId) conflicts.push('projectId');
  if (existing.originType !== incoming.originType) conflicts.push('originType');
  if (existing.sessionId !== incoming.sessionId) conflicts.push('sessionId');
  if (existing.sourcePageId !== incoming.sourcePageId) conflicts.push('sourcePageId');
  if (existing.destinationPageId !== incoming.destinationPageId) conflicts.push('destinationPageId');
  if (existing.functionalityId !== incoming.functionalityId) conflicts.push('functionalityId');
  if (existing.sourcePath !== incoming.sourcePath) conflicts.push('sourcePath');
  if (existing.destinationPath !== incoming.destinationPath) conflicts.push('destinationPath');
  if (existing.actionType !== incoming.actionType) conflicts.push('actionType');
  if (existing.triggerSelector !== incoming.triggerSelector) conflicts.push('triggerSelector');
  if (existing.triggerAction !== incoming.triggerAction) conflicts.push('triggerAction');
  if (existing.actionFingerprint !== incoming.actionFingerprint) conflicts.push('actionFingerprint');
  if (existing.navigationScope !== incoming.navigationScope) conflicts.push('navigationScope');
  if (existing.expectedIntent !== incoming.expectedIntent) conflicts.push('expectedIntent');
  if (existing.authStateAtObservation !== incoming.authStateAtObservation) conflicts.push('authStateAtObservation');
  if (existing.outcomeStatus !== incoming.outcomeStatus) conflicts.push('outcomeStatus');
  if (existing.domFingerprintAtObservation !== incoming.domFingerprintAtObservation) conflicts.push('domFingerprintAtObservation');

  if (canonicalizeJson(existing.transitionData) !== canonicalizeJson(incoming.transitionData)) {
    conflicts.push('transitionData');
  }

  return conflicts;
}

/**
 * Maps a database row from state_transition_evidence to a CanonicalObservationPayload.
 */
export function mapRowToCanonicalPayload(row: StateTransitionEvidenceRow): CanonicalObservationPayload {
  const sessionId = row.origin_type === 'crawler_session' ? row.crawl_session_id : row.test_run_id;
  if (!sessionId) {
    throw new Error(`Data integrity violation: row ${row.id} has origin_type ${row.origin_type} with null session ID`);
  }

  return normalizeCanonicalPayload({
    projectId: row.project_id,
    originType: row.origin_type,
    sessionId: sessionId,
    sourcePageId: row.source_page_id,
    destinationPageId: row.destination_page_id ?? null,
    functionalityId: row.functionality_id ?? null,
    sourcePath: row.source_path,
    destinationPath: row.destination_path,
    actionType: row.action_type,
    triggerSelector: row.trigger_selector,
    triggerAction: row.trigger_action,
    actionFingerprint: row.action_fingerprint,
    navigationScope: row.navigation_scope,
    expectedIntent: row.expected_intent ?? null,
    authStateAtObservation: row.auth_state_at_observation,
    outcomeStatus: row.outcome_status,
    domFingerprintAtObservation: row.dom_fingerprint_at_observation,
    transitionData: row.transition_data ?? {},
  });
}
