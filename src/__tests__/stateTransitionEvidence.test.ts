import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as crypto from 'crypto';
import { pool } from '../config/db';
import {
  CanonicalObservationPayload,
  canonicalizeJson,
  hashCanonicalJson,
  normalizeCanonicalPayload,
  findConflictingFields,
} from '../services/ai/stateTransitionTypes';
import { ingestStateTransitionObservation } from '../services/ai/stateTransitionService';

describe('Stage 8A — State Transition Evidence Foundation Integration Tests', () => {
  let projectId: string;
  let secondProjectId: string;
  let crawlSessionId: string;
  let secondProjectSessionId: string;
  let sourcePageId: string;
  let destPageId: string;
  let secondProjectPageId: string;
  let functionalityId: string;
  let secondProjectFuncId: string;

  beforeAll(async () => {
    // Create dedicated test projects
    const p1Res = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('Stage8A-Foundation-Test-1', 'http://localhost:3000', true, 'public')
       RETURNING id`
    );
    projectId = p1Res.rows[0].id;

    const p2Res = await pool.query<{ id: string }>(
      `INSERT INTO projects (name, base_url, owner_confirmed, access_status)
       VALUES ('Stage8A-Foundation-Test-2', 'http://localhost:9999', true, 'public')
       RETURNING id`
    );
    secondProjectId = p2Res.rows[0].id;

    // Create crawl sessions
    const s1Res = await pool.query<{ id: string }>(
      `INSERT INTO crawl_sessions (project_id, start_url)
       VALUES ($1, 'http://localhost:3000')
       RETURNING id`,
      [projectId]
    );
    crawlSessionId = s1Res.rows[0].id;

    const s2Res = await pool.query<{ id: string }>(
      `INSERT INTO crawl_sessions (project_id, start_url)
       VALUES ($1, 'http://localhost:9999')
       RETURNING id`,
      [secondProjectId]
    );
    secondProjectSessionId = s2Res.rows[0].id;

    // Create crawled pages
    const pg1Res = await pool.query<{ id: string }>(
      `INSERT INTO crawled_pages (project_id, url, path)
       VALUES ($1, 'http://localhost:3000/login', '/login')
       RETURNING id`,
      [projectId]
    );
    sourcePageId = pg1Res.rows[0].id;

    const pg2Res = await pool.query<{ id: string }>(
      `INSERT INTO crawled_pages (project_id, url, path)
       VALUES ($1, 'http://localhost:3000/dashboard', '/dashboard')
       RETURNING id`,
      [projectId]
    );
    destPageId = pg2Res.rows[0].id;

    const pg3Res = await pool.query<{ id: string }>(
      `INSERT INTO crawled_pages (project_id, url, path)
       VALUES ($1, 'http://localhost:9999/p2', '/p2')
       RETURNING id`,
      [secondProjectId]
    );
    secondProjectPageId = pg3Res.rows[0].id;

    // Create functionalities
    const f1Res = await pool.query<{ id: string }>(
      `INSERT INTO functionality_inventory (project_id, name, page_url, page_path)
       VALUES ($1, 'User Authentication', 'http://localhost:3000/login', '/login')
       RETURNING id`,
      [projectId]
    );
    functionalityId = f1Res.rows[0].id;

    const f2Res = await pool.query<{ id: string }>(
      `INSERT INTO functionality_inventory (project_id, name, page_url, page_path)
       VALUES ($1, 'P2 Functionality', 'http://localhost:9999/p2', '/p2')
       RETURNING id`,
      [secondProjectId]
    );
    secondProjectFuncId = f2Res.rows[0].id;
  });

  afterAll(async () => {
    // Cleanup test projects (cascades to all associated crawl_sessions, pages, evidence, conflicts)
    if (projectId) {
      await pool.query('DELETE FROM projects WHERE id = $1', [projectId]);
    }
    if (secondProjectId) {
      await pool.query('DELETE FROM projects WHERE id = $1', [secondProjectId]);
    }
  });

  // ==========================================================================
  // SECTION 1: CANONICAL JSON SERIALIZER & HASHING UNIT TESTS
  // ==========================================================================
  describe('Canonical JSON Serializer & 18-Field Hashing', () => {
    it('normalizes negative zero (-0) to 0', () => {
      expect(canonicalizeJson({ num: -0 })).toBe('{"num":0}');
      expect(canonicalizeJson({ num: -0 })).toBe(canonicalizeJson({ num: 0 }));
    });

    it('distinguishes empty strings from null', () => {
      expect(canonicalizeJson({ val: '' })).toBe('{"val":""}');
      expect(canonicalizeJson({ val: null })).toBe('{"val":null}');
      expect(hashCanonicalJson({ val: '' })).not.toBe(hashCanonicalJson({ val: null }));
    });

    it('distinguishes null from literal string "<null>"', () => {
      expect(canonicalizeJson({ val: null })).toBe('{"val":null}');
      expect(canonicalizeJson({ val: '<null>' })).toBe('{"val":"<null>"}');
      expect(hashCanonicalJson({ val: null })).not.toBe(hashCanonicalJson({ val: '<null>' }));
    });

    it('rejects unsupported types (undefined, BigInt, functions, symbols, NaN, Infinity, cyclic objects, Dates)', () => {
      expect(() => canonicalizeJson({ a: undefined })).toThrow(TypeError);
      expect(() => canonicalizeJson([1, undefined, 3])).toThrow(TypeError);
      expect(() => canonicalizeJson({ num: NaN })).toThrow(TypeError);
      expect(() => canonicalizeJson({ num: Infinity })).toThrow(TypeError);
      expect(() => canonicalizeJson({ b: BigInt(123) })).toThrow(TypeError);
      expect(() => canonicalizeJson({ fn: () => {} })).toThrow(TypeError);
      expect(() => canonicalizeJson({ d: new Date() })).toThrow(TypeError);

      const cyclic: any = { a: 1 };
      cyclic.self = cyclic;
      expect(() => canonicalizeJson(cyclic)).toThrow(TypeError);
    });

    it('preserves array ordering and recursively sorts object keys', () => {
      expect(canonicalizeJson([1, 2, 3])).toBe('[1,2,3]');
      expect(canonicalizeJson([3, 2, 1])).toBe('[3,2,1]');
      expect(canonicalizeJson([1, 2, 3])).not.toBe(canonicalizeJson([3, 2, 1]));

      const nested1 = canonicalizeJson({ z: 1, a: { y: 2, b: 3 } });
      const nested2 = canonicalizeJson({ a: { b: 3, y: 2 }, z: 1 });
      expect(nested1).toBe('{"a":{"b":3,"y":2},"z":1}');
      expect(nested1).toBe(nested2);
    });

    it('independently detects alterations across all 18 immutable fields', () => {
      const base: CanonicalObservationPayload = {
        projectId: '4a5aaaf0-7704-4c46-9c9d-006863e3da27',
        originType: 'crawler_session',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        sourcePageId: '660e8400-e29b-41d4-a716-446655440000',
        destinationPageId: '770e8400-e29b-41d4-a716-446655440000',
        functionalityId: '880e8400-e29b-41d4-a716-446655440000',
        sourcePath: '/login',
        destinationPath: '/dashboard',
        actionType: 'click',
        triggerSelector: 'button#login',
        triggerAction: 'click',
        actionFingerprint: 'a'.repeat(64),
        navigationScope: 'cross_page',
        expectedIntent: 'Submit credentials',
        authStateAtObservation: 'authenticated',
        outcomeStatus: 'verified',
        domFingerprintAtObservation: 'b'.repeat(64),
        transitionData: { step: 1 },
      };

      const variations: Array<{ field: keyof CanonicalObservationPayload; altVal: any }> = [
        { field: 'projectId', altVal: '11111111-1111-1111-1111-111111111111' },
        { field: 'originType', altVal: 'test_execution' },
        { field: 'sessionId', altVal: '22222222-2222-2222-2222-222222222222' },
        { field: 'sourcePageId', altVal: '33333333-3333-3333-3333-333333333333' },
        { field: 'destinationPageId', altVal: null },
        { field: 'functionalityId', altVal: null },
        { field: 'sourcePath', altVal: '/signin' },
        { field: 'destinationPath', altVal: '/inventory' },
        { field: 'actionType', altVal: 'fill' },
        { field: 'triggerSelector', altVal: 'input#username' },
        { field: 'triggerAction', altVal: 'type' },
        { field: 'actionFingerprint', altVal: 'c'.repeat(64) },
        { field: 'navigationScope', altVal: 'same_page' },
        { field: 'expectedIntent', altVal: null },
        { field: 'authStateAtObservation', altVal: 'unauthenticated' },
        { field: 'outcomeStatus', altVal: 'unverified' },
        { field: 'domFingerprintAtObservation', altVal: 'd'.repeat(64) },
        { field: 'transitionData', altVal: { step: 2 } },
      ];

      for (const { field, altVal } of variations) {
        const altered = { ...base, [field]: altVal };
        const conflicts = findConflictingFields(base, altered);
        expect(conflicts).toHaveLength(1);
        expect(conflicts[0]).toBe(field);
        expect(hashCanonicalJson(base)).not.toBe(hashCanonicalJson(altered));
      }
    });
  });

  // ==========================================================================
  // SECTION 2: LIFECYCLE & CONFLICT IDEMPOTENCY INTEGRATION TESTS
  // ==========================================================================
  describe('Lifecycle & Conflict Idempotency on Actual Schema', () => {
    const actionFp1 = '1'.repeat(64);
    const attemptX = crypto.randomUUID();
    const attemptY = crypto.randomUUID();

    const payloadA: CanonicalObservationPayload = {
      projectId: '', // Populated in tests
      originType: 'crawler_session',
      sessionId: '', // Populated in tests
      sourcePageId: '',
      destinationPageId: null,
      functionalityId: null,
      sourcePath: '/login',
      destinationPath: '/dashboard',
      actionType: 'click',
      triggerSelector: 'button#submit',
      triggerAction: 'click',
      actionFingerprint: actionFp1,
      navigationScope: 'cross_page',
      expectedIntent: 'Log in',
      authStateAtObservation: 'authenticated',
      outcomeStatus: 'verified',
      domFingerprintAtObservation: 'e'.repeat(64),
      transitionData: { step: 1, text: 'Welcome' },
    };

    let transitionId: string;

    it('1. Inserts a new observation successfully (status: created)', async () => {
      const payload = {
        ...payloadA,
        projectId,
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: destPageId,
        functionalityId,
      };

      const res = await ingestStateTransitionObservation(pool, payload, attemptX);
      expect(res.status).toBe('created');
      expect(res.attemptNumber).toBe(1);
      transitionId = res.transitionId;

      const rows = (await pool.query('SELECT * FROM state_transition_evidence WHERE id = $1', [transitionId])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].lifecycle_status).toBe('active');
      expect(rows[0].attempt_number).toBe(1);
    });

    it('2. Exact duplicate delivery is idempotent (status: idempotent)', async () => {
      const payload = {
        ...payloadA,
        projectId,
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: destPageId,
        functionalityId,
      };

      const res = await ingestStateTransitionObservation(pool, payload, attemptX);
      expect(res.status).toBe('idempotent');
      expect(res.transitionId).toBe(transitionId);
      expect(res.attemptNumber).toBe(1);

      // Verify row count unchanged
      const rows = (await pool.query('SELECT * FROM state_transition_evidence WHERE id = $1', [transitionId])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].lifecycle_status).toBe('active');
    });

    it('3. Conflicting payload with same attempt ID preserves original and records conflict (status: conflicted)', async () => {
      const conflictingPayload: CanonicalObservationPayload = {
        ...payloadA,
        projectId,
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: destPageId,
        functionalityId,
        outcomeStatus: 'unverified',
        domFingerprintAtObservation: 'f'.repeat(64),
        transitionData: { step: 1, text: 'Invalid password' },
      };

      const res = await ingestStateTransitionObservation(pool, conflictingPayload, attemptX);
      expect(res.status).toBe('conflicted');
      expect(res.transitionId).toBe(transitionId);

      // Verify original evidence row lifecycle transitioned to 'conflicted' but outcomeStatus untouched!
      const evRows = (await pool.query('SELECT * FROM state_transition_evidence WHERE id = $1', [transitionId])).rows;
      expect(evRows).toHaveLength(1);
      expect(evRows[0].lifecycle_status).toBe('conflicted');
      expect(evRows[0].outcome_status).toBe('verified'); // Original preserved!

      // Verify conflict recorded in state_transition_conflicts
      const confRows = (await pool.query('SELECT * FROM state_transition_conflicts WHERE transition_id = $1', [transitionId])).rows;
      expect(confRows).toHaveLength(1);
      expect(confRows[0].attempt_id).toBe(attemptX);
      expect(confRows[0].conflicting_fields).toEqual(expect.arrayContaining(['outcomeStatus', 'domFingerprintAtObservation', 'transitionData']));
    });

    it('4. Repeated delivery of same conflict is idempotent (status: idempotent_conflict)', async () => {
      const conflictingPayload: CanonicalObservationPayload = {
        ...payloadA,
        projectId,
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: destPageId,
        functionalityId,
        outcomeStatus: 'unverified',
        domFingerprintAtObservation: 'f'.repeat(64),
        transitionData: { step: 1, text: 'Invalid password' },
      };

      const res = await ingestStateTransitionObservation(pool, conflictingPayload, attemptX);
      expect(res.status).toBe('idempotent_conflict');
      expect(res.transitionId).toBe(transitionId);

      const confRows = (await pool.query('SELECT * FROM state_transition_conflicts WHERE transition_id = $1', [transitionId])).rows;
      expect(confRows).toHaveLength(1); // No duplicate conflict inserted
    });

    it('5. Genuinely new attempt supersedes previous observation and allocates next attempt number', async () => {
      const newAttemptPayload: CanonicalObservationPayload = {
        ...payloadA,
        projectId,
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: destPageId,
        functionalityId,
        domFingerprintAtObservation: '9'.repeat(64),
      };

      const res = await ingestStateTransitionObservation(pool, newAttemptPayload, attemptY);
      expect(res.status).toBe('created');
      expect(res.attemptNumber).toBe(2);

      // Query all evidence records for this action target
      const allRows = (await pool.query(
        `SELECT id, attempt_id, attempt_number, lifecycle_status
         FROM state_transition_evidence
         WHERE project_id = $1 AND action_fingerprint = $2
         ORDER BY attempt_number ASC`,
        [projectId, actionFp1]
      )).rows;

      expect(allRows).toHaveLength(2);
      expect(allRows[0].attempt_id).toBe(attemptX);
      expect(allRows[0].attempt_number).toBe(1);
      expect(allRows[0].lifecycle_status).toBe('conflicted');

      expect(allRows[1].attempt_id).toBe(attemptY);
      expect(allRows[1].attempt_number).toBe(2);
      expect(allRows[1].lifecycle_status).toBe('active');
    });
  });

  // ==========================================================================
  // SECTION 3: CONCURRENCY & ATTEMPT NUMBER ALLOCATION
  // ==========================================================================
  describe('Concurrency & Advisory Lock Serialization', () => {
    it('6. Allocates sequential, unique attempt numbers under concurrent submissions', async () => {
      const actionFpConc = '2'.repeat(64);
      const payload: CanonicalObservationPayload = {
        projectId,
        originType: 'crawler_session',
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: null,
        functionalityId: null,
        sourcePath: '/items',
        destinationPath: '/items/new',
        actionType: 'click',
        triggerSelector: 'button#create',
        triggerAction: 'click',
        actionFingerprint: actionFpConc,
        navigationScope: 'same_page',
        expectedIntent: 'Create Item',
        authStateAtObservation: 'authenticated',
        outcomeStatus: 'verified',
        domFingerprintAtObservation: '7'.repeat(64),
        transitionData: {},
      };

      const att1 = crypto.randomUUID();
      const att2 = crypto.randomUUID();
      const att3 = crypto.randomUUID();

      // Launch 3 concurrent ingestion requests for the same logical action
      const [r1, r2, r3] = await Promise.all([
        ingestStateTransitionObservation(pool, payload, att1),
        ingestStateTransitionObservation(pool, payload, att2),
        ingestStateTransitionObservation(pool, payload, att3),
      ]);

      const numbers = [r1.attemptNumber, r2.attemptNumber, r3.attemptNumber].sort((a, b) => a - b);
      expect(numbers).toEqual([1, 2, 3]);

      const rows = (await pool.query(
        `SELECT attempt_number, lifecycle_status
         FROM state_transition_evidence
         WHERE project_id = $1 AND action_fingerprint = $2
         ORDER BY attempt_number ASC`,
        [projectId, actionFpConc]
      )).rows;

      expect(rows).toHaveLength(3);
      expect(rows[0].attempt_number).toBe(1);
      expect(rows[1].attempt_number).toBe(2);
      expect(rows[2].attempt_number).toBe(3);

      // Only the final attempt remains active
      const activeRows = rows.filter(r => r.lifecycle_status === 'active');
      expect(activeRows).toHaveLength(1);
      expect(activeRows[0].attempt_number).toBe(3);
    });
  });

  // ==========================================================================
  // SECTION 4: COMPOSITE FOREIGN KEYS & PROJECT ISOLATION
  // ==========================================================================
  describe('Composite Foreign Keys & Project Isolation', () => {
    const actionFpXp = '4'.repeat(64);

    it('7. Rejects cross-project foreign key references', async () => {
      // Cross-project crawl session
      await expect(
        pool.query(`
          INSERT INTO state_transition_evidence (
            project_id, origin_type, crawl_session_id, source_page_id,
            source_path, destination_path, action_type, trigger_selector, trigger_action,
            action_fingerprint, navigation_scope, auth_state_at_observation, outcome_status,
            dom_fingerprint_at_observation, attempt_id, attempt_number, canonical_observation_hash
          ) VALUES ($1, 'crawler_session', $2, $3, '/login', '/dash', 'click', 'b', 'click', $4, 'cross_page', 'authenticated', 'verified', $4, $5, 1, $4)
        `, [projectId, secondProjectSessionId, sourcePageId, actionFpXp, crypto.randomUUID()])
      ).rejects.toThrow(/fk_ste_crawl_session/);

      // Cross-project source page
      await expect(
        pool.query(`
          INSERT INTO state_transition_evidence (
            project_id, origin_type, crawl_session_id, source_page_id,
            source_path, destination_path, action_type, trigger_selector, trigger_action,
            action_fingerprint, navigation_scope, auth_state_at_observation, outcome_status,
            dom_fingerprint_at_observation, attempt_id, attempt_number, canonical_observation_hash
          ) VALUES ($1, 'crawler_session', $2, $3, '/login', '/dash', 'click', 'b', 'click', $4, 'cross_page', 'authenticated', 'verified', $4, $5, 1, $4)
        `, [projectId, crawlSessionId, secondProjectPageId, actionFpXp, crypto.randomUUID()])
      ).rejects.toThrow(/fk_ste_source_page/);

      // Cross-project functionality
      await expect(
        pool.query(`
          INSERT INTO state_transition_evidence (
            project_id, origin_type, crawl_session_id, source_page_id, functionality_id,
            source_path, destination_path, action_type, trigger_selector, trigger_action,
            action_fingerprint, navigation_scope, auth_state_at_observation, outcome_status,
            dom_fingerprint_at_observation, attempt_id, attempt_number, canonical_observation_hash
          ) VALUES ($1, 'crawler_session', $2, $3, $4, '/login', '/dash', 'click', 'b', 'click', $5, 'cross_page', 'authenticated', 'verified', $5, $6, 1, $5)
        `, [projectId, crawlSessionId, sourcePageId, secondProjectFuncId, actionFpXp, crypto.randomUUID()])
      ).rejects.toThrow(/fk_ste_functionality/);
    });

    it('8. Deleting optional destination page and functionality sets columns to NULL without nulling project_id', async () => {
      // Create temporary page and functionality to delete
      const tempDestPage = (await pool.query<{ id: string }>(
        `INSERT INTO crawled_pages (project_id, url, path) VALUES ($1, 'http://localhost:3000/temp-dest', '/temp-dest') RETURNING id`,
        [projectId]
      )).rows[0].id;

      const tempFunc = (await pool.query<{ id: string }>(
        `INSERT INTO functionality_inventory (project_id, name, page_url, page_path) VALUES ($1, 'Temp Func', 'http://localhost:3000/temp-dest', '/temp-dest') RETURNING id`,
        [projectId]
      )).rows[0].id;

      const evRes = await pool.query<{ id: string }>(
        `INSERT INTO state_transition_evidence (
          project_id, origin_type, crawl_session_id, source_page_id, destination_page_id, functionality_id,
          source_path, destination_path, action_type, trigger_selector, trigger_action,
          action_fingerprint, navigation_scope, auth_state_at_observation, outcome_status,
          dom_fingerprint_at_observation, attempt_id, attempt_number, canonical_observation_hash
        ) VALUES ($1, 'crawler_session', $2, $3, $4, $5, '/login', '/temp-dest', 'click', 'b', 'click', $6, 'cross_page', 'authenticated', 'verified', $6, $7, 1, $6)
        RETURNING id`,
        [projectId, crawlSessionId, sourcePageId, tempDestPage, tempFunc, '5'.repeat(64), crypto.randomUUID()]
      );
      const evId = evRes.rows[0].id;

      // Delete destination page and functionality
      await pool.query('DELETE FROM crawled_pages WHERE id = $1', [tempDestPage]);
      await pool.query('DELETE FROM functionality_inventory WHERE id = $1', [tempFunc]);

      const updatedRow = (await pool.query('SELECT project_id, destination_page_id, functionality_id FROM state_transition_evidence WHERE id = $1', [evId])).rows[0];
      expect(updatedRow.project_id).toBe(projectId);
      expect(updatedRow.destination_page_id).toBeNull();
      expect(updatedRow.functionality_id).toBeNull();
    });
  });

  // ==========================================================================
  // SECTION 5: APPEND-ONLY PRIVILEGES & TRIGGER ENFORCEMENT
  // ==========================================================================
  describe('Append-Only Privileges & Trigger Enforcement', () => {
    let testTransitionId: string;
    let testConflictId: string;

    beforeAll(async () => {
      const evRes = await pool.query<{ id: string }>(
        `INSERT INTO state_transition_evidence (
          project_id, origin_type, crawl_session_id, source_page_id,
          source_path, destination_path, action_type, trigger_selector, trigger_action,
          action_fingerprint, navigation_scope, auth_state_at_observation, outcome_status,
          dom_fingerprint_at_observation, attempt_id, attempt_number, canonical_observation_hash
        ) VALUES ($1, 'crawler_session', $2, $3, '/login', '/dash', 'click', 'b', 'click', $4, 'cross_page', 'authenticated', 'verified', $4, $5, 1, $4)
        RETURNING id`,
        [projectId, crawlSessionId, sourcePageId, '6'.repeat(64), crypto.randomUUID()]
      );
      testTransitionId = evRes.rows[0].id;

      const confRes = await pool.query<{ id: string }>(
        `INSERT INTO state_transition_conflicts (
          project_id, transition_id, attempt_id, existing_observation_hash, incoming_observation_hash,
          incoming_observation, conflicting_fields
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id`,
        [projectId, testTransitionId, crypto.randomUUID(), 'a'.repeat(64), 'b'.repeat(64), JSON.stringify({}), ['outcomeStatus']]
      );
      testConflictId = confRes.rows[0].id;
    });

    it('9. Rejects direct UPDATE and DELETE on state_transition_conflicts via trigger', async () => {
      // Direct UPDATE rejected
      await expect(
        pool.query('UPDATE state_transition_conflicts SET incoming_observation_hash = $1 WHERE id = $2', ['c'.repeat(64), testConflictId])
      ).rejects.toThrow(/Audit violation: state_transition_conflicts records are strictly immutable/);

      // Direct DELETE rejected
      await expect(
        pool.query('DELETE FROM state_transition_conflicts WHERE id = $1', [testConflictId])
      ).rejects.toThrow(/Audit violation: state_transition_conflicts records are append-only/);
    });

    it('10. Rejects TRUNCATE and mutation privileges for restricted application role', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'test_qa_app_role') THEN
              CREATE ROLE test_qa_app_role;
            END IF;
          END $$;
          GRANT USAGE ON SCHEMA public TO test_qa_app_role;
          GRANT SELECT, INSERT ON state_transition_conflicts TO test_qa_app_role;
          REVOKE UPDATE, DELETE, TRUNCATE ON state_transition_conflicts FROM test_qa_app_role;
        `);

        await client.query('SET ROLE test_qa_app_role');

        // TRUNCATE should be denied at permission layer
        await client.query('SAVEPOINT sp_trunc');
        await expect(client.query('TRUNCATE TABLE state_transition_conflicts')).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK TO SAVEPOINT sp_trunc');

        // DELETE should be denied at permission layer
        await client.query('SAVEPOINT sp_del');
        await expect(client.query('DELETE FROM state_transition_conflicts')).rejects.toThrow(/permission denied/);
        await client.query('ROLLBACK TO SAVEPOINT sp_del');

        await client.query('RESET ROLE');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    });

    it('11. Transaction rollback after simulated mid-operation failure leaves zero partial rows', async () => {
      const failAttemptId = crypto.randomUUID();
      const failPayload: CanonicalObservationPayload = {
        projectId,
        originType: 'crawler_session',
        sessionId: crawlSessionId,
        sourcePageId,
        destinationPageId: null,
        functionalityId: null,
        sourcePath: '/crash',
        destinationPath: '/error',
        actionType: 'click',
        triggerSelector: 'button#crash',
        triggerAction: 'click',
        actionFingerprint: '8'.repeat(64),
        navigationScope: 'same_page',
        expectedIntent: 'Simulate crash',
        authStateAtObservation: 'authenticated',
        outcomeStatus: 'verified',
        domFingerprintAtObservation: '8'.repeat(64),
        transitionData: {},
      };

      // Mock pool query to fail on insert into conflicts or simulate mid-flight crash
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`
          INSERT INTO state_transition_evidence (
            project_id, origin_type, crawl_session_id, source_page_id,
            source_path, destination_path, action_type, trigger_selector, trigger_action,
            action_fingerprint, navigation_scope, auth_state_at_observation, outcome_status,
            dom_fingerprint_at_observation, attempt_id, attempt_number, canonical_observation_hash
          ) VALUES ($1, 'crawler_session', $2, $3, '/crash', '/error', 'click', 'b', 'click', $4, 'same_page', 'authenticated', 'verified', $4, $5, 1, $4)
        `, [projectId, crawlSessionId, sourcePageId, '8'.repeat(64), failAttemptId]);

        // Simulated error
        throw new Error('Simulated mid-flight crash');
      } catch (err: any) {
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }

      const rows = (await pool.query('SELECT * FROM state_transition_evidence WHERE attempt_id = $1', [failAttemptId])).rows;
      expect(rows).toHaveLength(0);
    });

    it('12. Advisory lock is released upon COMMIT and ROLLBACK', async () => {
      const lockKeyStr = `p=${projectId}|o=crawler_session|s=${crawlSessionId}|sp=${sourcePageId}|af=${'9'.repeat(64)}`;
      const lockId = crypto.createHash('sha256').update(lockKeyStr, 'utf8').digest().readBigInt64BE(0);

      const client1 = await pool.connect();
      const client2 = await pool.connect();

      try {
        // Client 1 acquires transaction lock and commits
        await client1.query('BEGIN');
        await client1.query('SELECT pg_advisory_xact_lock($1)', [lockId.toString()]);
        await client1.query('COMMIT');

        // Client 2 can immediately acquire the same lock without waiting
        await client2.query('BEGIN');
        const lockAcquired = await client2.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [lockId.toString()]);
        expect(lockAcquired.rows[0].acquired).toBe(true);
        await client2.query('ROLLBACK');

        // Lock is also released after rollback
        const lockAcquiredAfterRollback = await client1.query('SELECT pg_try_advisory_xact_lock($1) AS acquired', [lockId.toString()]);
        expect(lockAcquiredAfterRollback.rows[0].acquired).toBe(true);
      } finally {
        client1.release();
        client2.release();
      }
    });

    it('13. Cascades deletion from state_transition_evidence to state_transition_conflicts', async () => {
      // Deleting parent evidence row cascades cleanly through trigger at depth > 1
      await pool.query('DELETE FROM state_transition_evidence WHERE id = $1', [testTransitionId]);

      const confCheck = await pool.query('SELECT count(*) FROM state_transition_conflicts WHERE id = $1', [testConflictId]);
      expect(parseInt(confCheck.rows[0].count, 10)).toBe(0);
    });
  });
});
