import { Pool, PoolClient } from 'pg';
import * as crypto from 'crypto';
import {
  CanonicalObservationPayload,
  StateTransitionEvidenceRow,
  IngestionResult,
  normalizeCanonicalPayload,
  hashCanonicalJson,
  findConflictingFields,
  mapRowToCanonicalPayload,
} from './stateTransitionTypes';

/**
 * Internal ingestion routine.
 * NOT EXPORTED outside this module so callers cannot accidentally execute it outside a transaction.
 *
 * Guaranteed invariants:
 * - Operates under an exclusive 64-bit advisory transaction lock matching the logical action identity.
 * - Same attempt ID + identical observation: strictly idempotent (zero rows modified).
 * - Same attempt ID + conflicting observation: marks evidence row 'conflicted' while preserving original
 *   immutable observation fields untouched; appends conflicting observation snapshot into conflicts table.
 * - Genuinely new attempt ID: marks any previous active record 'superseded', allocates the next sequential
 *   attempt_number under the advisory lock, and inserts the new active evidence row.
 */
async function recordObservedStateTransitionInternal(
  client: PoolClient,
  rawPayload: CanonicalObservationPayload,
  attemptId: string,
  tableNames = { evidence: 'state_transition_evidence', conflicts: 'state_transition_conflicts' }
): Promise<IngestionResult> {
  const payload = normalizeCanonicalPayload(rawPayload);
  const incomingHash = hashCanonicalJson(payload);

  // 1. Acquire 64-bit advisory transaction lock for the complete logical identity
  // Logical identity: (project_id, origin_type, session_id, source_page_id, action_fingerprint)
  const lockKeyStr = `p=${payload.projectId}|o=${payload.originType}|s=${payload.sessionId}|sp=${payload.sourcePageId}|af=${payload.actionFingerprint}`;
  const lockId = crypto.createHash('sha256').update(lockKeyStr, 'utf8').digest().readBigInt64BE(0);
  await client.query('SELECT pg_advisory_xact_lock($1)', [lockId.toString()]);

  const sessionColumn = payload.originType === 'crawler_session' ? 'crawl_session_id' : 'test_run_id';
  const steTable = tableNames.evidence;
  const stcTable = tableNames.conflicts;

  // 2. PHASE 1: Check if an evidence record exists for THIS EXACT attempt_id
  // Searches regardless of lifecycle_status ('active', 'conflicted', 'superseded')
  const attemptRowRes = await client.query<StateTransitionEvidenceRow>(
    `SELECT * FROM ${steTable}
     WHERE project_id = $1 AND origin_type = $2 AND ${sessionColumn} = $3
       AND source_page_id = $4 AND action_fingerprint = $5 AND attempt_id = $6
     FOR UPDATE`,
    [payload.projectId, payload.originType, payload.sessionId, payload.sourcePageId, payload.actionFingerprint, attemptId]
  );

  if (attemptRowRes.rowCount && attemptRowRes.rowCount > 0) {
    const existingAttemptRow = attemptRowRes.rows[0];

    // Sub-case 1: Exactly matches original observation of this attempt -> Idempotent
    if (existingAttemptRow.canonical_observation_hash === incomingHash) {
      return {
        transitionId: existingAttemptRow.id,
        attemptNumber: existingAttemptRow.attempt_number,
        status: 'idempotent',
      };
    }

    // Sub-case 2: Differs from original observation -> Conflict!
    // Check if this specific conflicting observation hash was already recorded for this attempt
    const existingConflictRes = await client.query(
      `SELECT id FROM ${stcTable}
       WHERE transition_id = $1 AND attempt_id = $2 AND incoming_observation_hash = $3`,
      [existingAttemptRow.id, attemptId, incomingHash]
    );

    if (existingConflictRes.rowCount && existingConflictRes.rowCount > 0) {
      // Conflict already recorded -> idempotent conflict
      return {
        transitionId: existingAttemptRow.id,
        attemptNumber: existingAttemptRow.attempt_number,
        status: 'idempotent_conflict',
      };
    }

    // New distinct conflict for this attempt
    // Mark evidence record as 'conflicted' if currently active
    if (existingAttemptRow.lifecycle_status === 'active') {
      await client.query(
        `UPDATE ${steTable} SET lifecycle_status = 'conflicted' WHERE id = $1`,
        [existingAttemptRow.id]
      );
    }

    const existingPayload = mapRowToCanonicalPayload(existingAttemptRow);
    const conflictingFields = findConflictingFields(existingPayload, payload);

    await client.query(
      `INSERT INTO ${stcTable} (
        project_id, transition_id, attempt_id, existing_observation_hash, incoming_observation_hash,
        incoming_observation, conflicting_fields
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (transition_id, attempt_id, incoming_observation_hash) DO NOTHING`,
      [
        payload.projectId, existingAttemptRow.id, attemptId, existingAttemptRow.canonical_observation_hash,
        incomingHash, JSON.stringify(payload), conflictingFields
      ]
    );

    return {
      transitionId: existingAttemptRow.id,
      attemptNumber: existingAttemptRow.attempt_number,
      status: 'conflicted',
    };
  }

  // 3. PHASE 2: Genuinely new attempt_id
  // Allocate the next sequential attempt_number under the advisory lock
  const maxAttemptRes = await client.query<{ max_num: string | number }>(
    `SELECT COALESCE(MAX(attempt_number), 0) AS max_num FROM ${steTable}
     WHERE project_id = $1 AND origin_type = $2 AND ${sessionColumn} = $3
       AND source_page_id = $4 AND action_fingerprint = $5`,
    [payload.projectId, payload.originType, payload.sessionId, payload.sourcePageId, payload.actionFingerprint]
  );
  const nextAttemptNumber = parseInt(String(maxAttemptRes.rows[0].max_num), 10) + 1;

  // Supersede any existing 'active' record for this logical identity
  const supersedeRes = await client.query(
    `UPDATE ${steTable}
     SET lifecycle_status = 'superseded'
     WHERE project_id = $1 AND origin_type = $2 AND ${sessionColumn} = $3
       AND source_page_id = $4 AND action_fingerprint = $5 AND lifecycle_status = 'active'`,
    [payload.projectId, payload.originType, payload.sessionId, payload.sourcePageId, payload.actionFingerprint]
  );
  const isSuperseding = (supersedeRes.rowCount ?? 0) > 0;

  // Insert the new active evidence record
  const insertRes = await client.query<{ id: string }>(
    `INSERT INTO ${steTable} (
      project_id, origin_type, ${sessionColumn}, source_page_id, destination_page_id, functionality_id,
      source_path, destination_path, action_type, trigger_selector, trigger_action,
      action_fingerprint, navigation_scope, expected_intent, auth_state_at_observation,
      outcome_status, dom_fingerprint_at_observation, transition_data, attempt_id, attempt_number,
      canonical_observation_hash, lifecycle_status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, 'active')
    RETURNING id`,
    [
      payload.projectId, payload.originType, payload.sessionId, payload.sourcePageId, payload.destinationPageId, payload.functionalityId,
      payload.sourcePath, payload.destinationPath, payload.actionType, payload.triggerSelector, payload.triggerAction,
      payload.actionFingerprint, payload.navigationScope, payload.expectedIntent, payload.authStateAtObservation,
      payload.outcomeStatus, payload.domFingerprintAtObservation, JSON.stringify(payload.transitionData),
      attemptId, nextAttemptNumber, incomingHash
    ]
  );

  return {
    transitionId: insertRes.rows[0].id,
    attemptNumber: nextAttemptNumber,
    status: isSuperseding ? 'superseded' : 'created',
  };
}

/**
 * Public transaction wrapper.
 * Strictly owns connection acquisition, transaction boundary (BEGIN, COMMIT, ROLLBACK),
 * and client release.
 *
 * @param pool Database connection pool
 * @param rawPayload Canonical 18-field observation payload
 * @param attemptId UUID identifying this action execution attempt
 * @param tableNames Optional table names (defaults to actual Migration 024 tables)
 */
export async function ingestStateTransitionObservation(
  pool: Pool,
  rawPayload: CanonicalObservationPayload,
  attemptId: string,
  tableNames = { evidence: 'state_transition_evidence', conflicts: 'state_transition_conflicts' }
): Promise<IngestionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await recordObservedStateTransitionInternal(client, rawPayload, attemptId, tableNames);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Retrieves active, project-isolated state transition evidence rows for semantic validation.
 * Strictly filters by project_id and lifecycle_status = 'active'.
 * Optional filters for pagePath, sourcePageId, or functionalityId.
 */
export async function getActiveStateTransitionsForProject(
  pool: Pool,
  projectId: string,
  options?: {
    pagePath?: string;
    sourcePageId?: string;
    functionalityId?: string;
    limit?: number;
  }
): Promise<StateTransitionEvidenceRow[]> {
  const conditions: string[] = ['project_id = $1', "lifecycle_status = 'active'"];
  const params: unknown[] = [projectId];
  let paramIdx = 2;

  if (options?.sourcePageId) {
    conditions.push(`source_page_id = $${paramIdx++}`);
    params.push(options.sourcePageId);
  }

  if (options?.pagePath) {
    conditions.push(`source_path = $${paramIdx++}`);
    params.push(options.pagePath);
  }

  if (options?.functionalityId) {
    conditions.push(`functionality_id = $${paramIdx++}`);
    params.push(options.functionalityId);
  }

  const limitClause = options?.limit ? `LIMIT ${Number(options.limit)}` : 'LIMIT 100';

  const query = `
    SELECT * FROM state_transition_evidence
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at DESC
    ${limitClause}
  `;

  const res = await pool.query<StateTransitionEvidenceRow>(query, params);
  return res.rows;
}
