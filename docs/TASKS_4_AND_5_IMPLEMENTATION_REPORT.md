# Tasks 4 & 5 Implementation Report: Website Authorization, Authentication, and RBAC

**Project:** AI QA Testing Agent  
**Implemented Tasks:** Task 4 (Website Ownership & Authorization Confirmation) & Task 5 (User Authentication & Role-Based Access Control)  
**Execution Date:** November 2026  
**Engineering Discipline:** Senior Software Architect, Security Engineer, Full-Stack Developer  

---

## 1. Executive Summary

Tasks 4 and 5 were implemented together to provide a robust, defense-in-depth security foundation for the AI QA Testing Agent.

Prior to this implementation, the system operated using a single shared platform API key across all dashboard users and API clients, with no individual accountability, no project-level data isolation, and no legal confirmation before launching active automated scans against external web targets.

With Tasks 4 and 5 completed:
1. **Target Authorization:** All project creations now require an explicit, affirmative confirmation that the operator owns or possesses written authorization to scan the target URL. Authorizations are stored immutably in a dedicated table, associated with the user account, validated against SSRF attack vectors, and presented to users before testing begins.
2. **Multi-User Authentication:** A secure server-managed session architecture replaces client-side API keys in the dashboard. Passwords are hash-secured using memory-hard Scrypt (OWASP-aligned parameters), session tokens are hashed with SHA-256 at rest, cookies are configured with `HttpOnly`, `SameSite=Lax`, and `Secure` flags, CSRF tokens protect all state-changing operations, and login attempts are protected by sliding-window brute-force rate limiters.
3. **Four-Tiered RBAC & Project Membership:** An authorization model enforces `admin > qa_manager > qa_engineer > viewer`. Projects enforce membership isolation to prevent IDOR attacks. Backend routes independently verify that the caller is authenticated, assigned to the project, and authorized for the specific action.
4. **CI/CD Compatibility:** Automated test runners and pipeline integrations remain supported via restricted service credentials (`x-api-key`), without exposing keys to human dashboard users.

---

## 2. Modified and Created Files

### Database Migrations
- `database/migrations/010_auth_and_rbac.sql`: Created tables for `users`, `sessions`, `project_members`, `website_authorizations`, and `audit_logs`. Added confirmation metadata to `projects`. Seeded initial default admin.

### Core Backend Services
- `src/services/passwordService.ts`: Scrypt hashing (`N=16384, r=8, p=1, keylen=64`), random salt generation, and constant-time verification (`timingSafeEqual`).
- `src/services/auditLogger.ts`: Security event logging with sanitization and redaction of credentials.
- `src/services/authService.ts`: User authentication, session creation and token hashing (SHA-256), session invalidation, sliding-window rate limiting, and project access assertion (`assertProjectAccess`).
- `src/services/auth.ts`: Fastify authentication pre-handler supporting cookies, bearer tokens, and service keys; CSRF verification; role guard factories (`requireAuth`, `requirePlatformRole`, `requireProjectRole`).

### Backend API Routes
- `src/server.ts`: Configured Fastify CORS credentials, cookies plugin, and global error handling for `AccessDeniedError` (HTTP 403).
- `src/routes/auth.ts`: Authentication endpoints (`/auth/login`, `/auth/logout`, `/auth/me`, `/auth/register`), user management (`/users`, `/users/:id`), project team memberships (`/projects/:projectId/members`), and audit log inspection (`/audit-logs`).
- `src/routes/projects.ts`: Mandates `owner_confirmed === true`, records authorization declaration, assigns creator as `qa_manager`, and filters projects by membership.
- `src/routes/runs.ts`: Enforces `qa_engineer` for test execution, `viewer` for viewing results.
- `src/routes/apiRuns.ts`: Enforces `qa_engineer` for API test execution, `viewer` for viewing results.
- `src/routes/testCases.ts`: Enforces `qa_engineer` for test case creation, `qa_manager` for review/approval, `viewer` for inspection.
- `src/routes/suites.ts`: Enforces `qa_manager` for suite configuration, `qa_engineer` for suite execution, `viewer` for viewing.
- `src/routes/apiEndpoints.ts`: Enforces `qa_engineer` for creation/import, `qa_manager` for review/approval, `viewer` for inspection.
- `src/routes/visual.ts`: Enforces `qa_engineer` for visual test runs, `qa_manager` for baseline approval, `viewer` for viewing.
- `src/routes/bugReports.ts`: Enforces `qa_engineer` for bug status updates, `viewer` for reading, and isolates bug reports by project membership.
- `src/routes/generate.ts`: Enforces `qa_engineer` for autonomous discovery and AI test generation.
- `src/routes/regression.ts`: Enforces `viewer` role on regression analysis and run comparisons across assigned projects.
- `src/routes/runEvidence.ts`: Enforces `viewer` role on reports, screenshots, and trace evidence downloads.
- `src/routes/orchestrator.ts`: Enforces `qa_engineer` role for orchestrator test runs.

### Frontend Dashboard
- `dashboard/src/App.css`: Added styles for login cards, role pills, legal authorization callouts, audit tables, and topbar user info.
- `dashboard/src/App.tsx`:
  - Removed client-side `VITE_API_KEY` dependencies.
  - Implemented `AuthProvider`, `useAuth()`, and session check against `/auth/me`.
  - Added `LoginPage` with form controls and default credential hint.
  - Added `UserManagementPage` for platform admins with user creation, role editing, and audit trail view.
  - Added `ProjectTeamTab` to manage project membership assignments directly from project details.
  - Added confirmation checkbox and legal declaration to project creation modals (`TestNewAppBox` and `ProjectsPage`).
  - Added authorization confirmation notice banner to project views before testing.
  - Configured `credentials: "include"` and `x-csrf-token` header injection for all mutating requests.
- `dashboard/.env.example`: Removed `VITE_API_KEY` reference and clarified session cookie architecture.

### Automated Tests
- `src/__tests__/projectAuthorization.test.ts`: 6 comprehensive tests for Task 4 (creation with confirmation, missing confirmation, false confirmation, SSRF protection, direct API bypass prevention, persistence).
- `src/__tests__/authenticationAndRbac.test.ts`: 15 comprehensive tests for Task 5 (Scrypt password hashing, login success/failure, session expiration/invalidation, rate limiting, RBAC permissions across all 4 roles, project-level IDOR prevention, CSRF validation, audit logging).

### Documentation
- `docs/AUTHENTICATION_AND_RBAC.md`: Complete authentication and RBAC architectural reference.
- `docs/WEBSITE_AUTHORIZATION.md`: Website ownership declaration and target authorization specifications.
- `docs/SECURITY.md`: Security architecture, threat model, and mitigation controls.
- `docs/TASKS_4_AND_5_IMPLEMENTATION_REPORT.md`: This report.

---

## 3. Database Migrations Applied

**Migration:** `database/migrations/010_auth_and_rbac.sql`

```sql
-- 1. Users Table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(50) NOT NULL DEFAULT 'qa_engineer',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. Sessions Table (Hashed Tokens at Rest)
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    last_active TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. Project Memberships Table (Project-Level RBAC)
CREATE TABLE project_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'qa_engineer',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CONSTRAINT uk_project_member UNIQUE (project_id, user_id)
);

-- 4. Website Authorizations Table
CREATE TABLE website_authorizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_url TEXT NOT NULL,
    confirmed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    declaration_text TEXT NOT NULL,
    ip_address VARCHAR(45),
    CONSTRAINT uk_website_auth_project UNIQUE (project_id)
);

-- 5. Audit Logs Table
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    outcome VARCHAR(20) NOT NULL,
    ip_address VARCHAR(45),
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 6. Project Schema Additions
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_confirmed_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL;
```

---

## 4. Authentication Architecture Details

1. **Credentials:** Users log in with email and password via `POST /auth/login`.
2. **Password Verification:** The saved password hash is parsed for salt, cost parameters, and derived key. The candidate password is evaluated with `crypto.scrypt` and compared via `crypto.timingSafeEqual`.
3. **Session Issuance:** A 32-byte cryptographically random session token is generated. Its SHA-256 digest is stored in `sessions.token_hash`. The plain token is returned to the client as an `HttpOnly`, `SameSite=Lax` cookie named `qa_session`.
4. **CSRF Token:** The session token also acts as the cryptographic CSRF token for the frontend application. On state-changing HTTP operations (`POST`, `PUT`, `PATCH`, `DELETE`), the backend Fastify hook checks that the `x-csrf-token` header matches the active session token.
5. **Session Revocation:** On `POST /auth/logout`, the server deletes the session row from `sessions` and sets the `qa_session` cookie expiration to Unix epoch.
6. **Rate Limiting:** A sliding window records failed attempts per IP. Reaching 5 failures within 5 minutes blocks subsequent attempts with HTTP 429.

---

## 5. RBAC & Project Membership Implementation

### Roles Defined
1. `admin`: Global system administrator. Has platform-wide access, can manage users, modify roles, and access all projects automatically.
2. `qa_manager`: Project administrator. Can create projects, invite and manage team members, manage test suites, review/approve tests and API endpoints, and approve visual baselines.
3. `qa_engineer`: Active test engineer. Can discover applications, generate AI test cases, execute test runs (Web, API, Visual, Suites), and confirm/dismiss bug reports. Cannot review/approve tests or manage team members.
4. `viewer`: Read-only stakeholder. Can inspect projects, test cases, test runs, evidence files, regression reports, and bug reports. Cannot create, modify, or execute tests.

### Project Membership Enforcement (`assertProjectAccess`)
Every route operating on project resources checks:
```ts
export async function assertProjectAccess(
  userId: string,
  userPlatformRole: string,
  projectId: string,
  minRole: "admin" | "qa_manager" | "qa_engineer" | "viewer" = "viewer"
): Promise<{ role: string }>
```
- Admins bypass project membership checks.
- Non-admins must have an active record in `project_members`.
- The user's role rank must be greater than or equal to the required minimum role rank.
- Violations raise `AccessDeniedError` (HTTP 403).

---

## 6. Website Authorization Flow & SSRF Protections

1. **User Declaration:** Operator checks the confirmation checkbox in the UI, confirming ownership or authorized permission.
2. **Backend Enforcement:** `POST /projects` checks `req.body.owner_confirmed === true`. Missing, false, or omitted values return HTTP 400.
3. **Target URL Validation:** The URL is evaluated by `assertSafeUrl` / `validateTargetUrl` (`urlGuard`). Loopback, RFC1918 private subnets, cloud metadata services, and internal hostnames are blocked.
4. **Transaction Persistence:** The project, authorization record in `website_authorizations`, project membership, and audit log are committed atomically.
5. **Notice Display:** The project details page displays an authorization notice banner before testing begins.

---

## 7. Actual Verification and Test Results

### Automated Test Suite Execution
- **Command:** `npm test` (`vitest run src/__tests__`)
- **Total Test Files:** 19 passed (19/19)
- **Total Tests:** 141 passed (141/141)
- **Duration:** 7.28s

#### Key Security Test Suites
- **`src/__tests__/projectAuthorization.test.ts` (6/6 passed):**
  - Project creation succeeds with explicit confirmation.
  - Missing confirmation is rejected with HTTP 400.
  - False confirmation is rejected with HTTP 400.
  - Direct API request without confirmation is rejected.
  - Confirmation metadata and audit records are persisted in database.
  - Dangerous URLs (localhost/SSRF) are blocked during project creation.
- **`src/__tests__/authenticationAndRbac.test.ts` (15/15 passed):**
  - Scrypt password hashing & timing-safe verification.
  - Valid user login and session cookie delivery.
  - Invalid login rejection and credential protection.
  - Rate limiting on repeated invalid login attempts (HTTP 429).
  - Session invalidation on logout.
  - Admin global permissions and user listing.
  - QA Manager capabilities (approving test cases).
  - QA Engineer test execution permissions.
  - Viewer read-only restrictions (blocked from executing tests).
  - Project-level access isolation (IDOR protection, HTTP 403 for non-members).
  - Cross-project access restriction.
  - Privilege escalation prevention.
  - CSRF token validation on cookie requests.
  - Security audit log persistence.
- **`src/__tests__/auth.test.ts` (3/3 passed):**
  - Platform API key authentication backwards compatibility.
- **`src/__tests__/urlGuard.test.ts` (26/26 passed):**
  - Full SSRF protection suite.

### Build Verification
- **Backend Build (`npm run build` in root):** Clean compilation via `tsc` (Code 0).
- **Frontend Dashboard Build (`npm run build` in `dashboard/`):** Clean compilation via `tsc -b && vite build` (Code 0).

---

## 8. Incomplete Functionality, Limitations & Production Disclaimers

> [!CAUTION]
> **Production Readiness Assessment:**
> Passing tests and builds confirm structural correctness and security compliance under test conditions. However, the following limitations must be addressed before this system is deployed to high-risk production environments:

1. **User Declaration vs. Cryptographic Ownership Verification:**
   - The authorization confirmation is an affirmative legal declaration by the user. It does not perform active DNS challenge verification (e.g., DNS TXT records or `.well-known/qa-testing-challenge` tokens). For public multi-tenant SaaS environments, active cryptographic domain verification should be added.
2. **In-Memory Rate Limiting:**
   - The login rate limiter currently uses an in-memory sliding window. In multi-instance or auto-scaling container deployments, rate-limiting state must be backed by a centralized Redis cluster.
3. **Session Token Invalidation on Password Change:**
   - When a user's password or role is updated by an administrator, existing active sessions are not forcibly revoked across all client devices. A `token_version` or explicit session cascade should be implemented for high-security environments.
4. **Password Reset & Multi-Factor Authentication (MFA):**
   - Self-service password reset (via email token) and TOTP/WebAuthn multi-factor authentication are not implemented in Task 5 and should be scheduled for future releases.

---

## 9. Required Environment Variables

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `DATABASE_URL` | PostgreSQL connection string | `postgres://qa:qa@localhost:5432/ai_qa` |
| `PLATFORM_API_KEY` | Restricted service credential for CI/CD runners | `test-platform-api-key` |
| `APP_SECRET` | 32-byte hexadecimal key for encrypting stored credentials | *(Required in production)* |
| `SESSION_TTL_HOURS` | Lifetime of user sessions in hours | `24` |
| `NODE_ENV` | Environment mode (`production` enables `Secure` cookies) | `development` / `production` |
| `ALLOW_PRIVATE_TARGETS` | Allows testing localhost/private IPs (Dev only) | `false` (must be `false` in production) |

---

## 10. Summary of Completion

Tasks 4 and 5 are fully implemented, verified with comprehensive automated tests, and documented across the repository. Task 6 has not been started, in accordance with user instructions.
