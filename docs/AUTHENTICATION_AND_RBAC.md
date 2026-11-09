# Authentication and Role-Based Access Control (RBAC)

This document details the multi-user authentication architecture, session management, role hierarchy, project-level access controls, and audit logging implemented in Task 5 for the AI QA Testing Agent.

---

## 1. Authentication Architecture

The platform has transitioned from a shared static API key to an enterprise-grade multi-user authentication system with server-managed sessions, while preserving backward compatibility for CI/CD automation runners.

```
       +-------------------------------------------------------------+
       |                     Client (Dashboard / API)                |
       +-------------------------------------------------------------+
               |                                             |
   (Interactive Sessions)                             (CI/CD Pipeline)
   Cookie: qa_session=<token>                         Header: x-api-key=<key>
   Header: x-csrf-token=<token>                              |
               |                                             |
               v                                             v
       +-------------------------------------------------------------+
       |                  Fastify Auth Hook (auth.ts)                |
       +-------------------------------------------------------------+
               |                                             |
        [Session Check]                              [Service Key Check]
               |                                             |
               v                                             v
  Hash token (SHA-256)                         Constant-time compare with
  Lookup in `sessions` table                    PLATFORM_API_KEY env
  Validate expiration & user active                          |
               |                                             |
               +----------------------+----------------------+
                                      |
                                      v
                      request.user = { id, email, role }
                                      |
                                      v
                      +-------------------------------+
                      |   Project Authorization Check |
                      |    (assertProjectAccess)      |
                      +-------------------------------+
```

### Password Security & Hashing
- **Algorithm:** Node.js native `crypto.scrypt` (memory-hard, resistant to GPU/ASIC brute-force attacks).
- **OWASP-Aligned Cost Parameters:**
  - `N` (CPU/memory cost): `16384`
  - `r` (block size): `8`
  - `p` (parallelization): `1`
  - `keylen` (output length): `64 bytes`
  - `salt`: 16 cryptographically secure random bytes generated per password.
- **Storage Format:** `scrypt$N=16384,r=8,p=1$<salt_hex>$<derived_key_hex>`
- **Verification:** Timing-safe comparison using `crypto.timingSafeEqual` to eliminate timing side-channel attacks.

### Server-Managed Sessions
- **Session Identifier:** 32 cryptographically secure random bytes (64-character hexadecimal string).
- **Storage Security:** Tokens are hashed with SHA-256 before being stored in the `sessions` table (`token_hash`). If the database is compromised, active session tokens cannot be read directly.
- **Session Duration:** 24 hours (`SESSION_TTL_HOURS = 24`), stored in `expires_at`.
- **Revocation:** Explicit invalidation on logout removes the session row immediately from the database.

### Cookie Security & SameSite
- Cookie Name: `qa_session`
- `httpOnly: true` — Inaccessible to client-side JavaScript, preventing session theft via Cross-Site Scripting (XSS).
- `sameSite: "lax"` — Balances security with usability, mitigating Cross-Site Request Forgery (CSRF).
- `Secure` is enabled by default when `NODE_ENV=production` and can be forced on in other environments with `COOKIE_SECURE=true`. Local HTTP development leaves it off by default. Production can disable it only with the explicit, temporary `COOKIE_ALLOW_INSECURE_HTTP=true` override; do not use that setting for normal AWS operation.
- `path: "/"`

For AWS deployments, set `NODE_ENV=production`, `COOKIE_SECURE=true`, and `COOKIE_ALLOW_INSECURE_HTTP=false`. If HTTPS has not yet been enabled and HTTP login testing is unavoidable, temporarily set `COOKIE_ALLOW_INSECURE_HTTP=true`; the backend logs a security warning. Revert it to `false` as soon as HTTPS is available.

### CSRF Protection
For cookie-authenticated requests modifying state (`POST`, `PUT`, `PATCH`, `DELETE`):
- The client receives a CSRF token upon successful login or `/auth/me` session check.
- The client must include this token in the `x-csrf-token` header.
- The server validates that the header matches the active session token before executing the route handler.

### Rate Limiting & Brute-Force Protection
- Monitored on `POST /auth/login`.
- Window: 5 minutes.
- Threshold: 5 failed attempts per client IP address.
- Response: HTTP 429 (`Too many failed login attempts. Please try again in 5 minutes.`).

### CI/CD and Automation Compatibility
- The `x-api-key` header remains supported exclusively for automated testing pipelines and CI/CD service runners.
- Service keys bypass human session cookies and execute with `admin` platform privileges.
- Client-side code in the dashboard no longer depends on or exposes `VITE_API_KEY`.

---

## 2. Role-Based Access Control (RBAC)

The system enforces four distinct roles arranged in a strict permission hierarchy:

```
[admin] (Level 4)
   │
   ▼
[qa_manager] (Level 3)
   │
   ▼
[qa_engineer] (Level 2)
   │
   ▼
[viewer] (Level 1)
```

| Capability | Admin | QA Manager | QA Engineer | Viewer |
| :--- | :---: | :---: | :---: | :---: |
| **System Administration** | | | | |
| Manage users (create, edit role, deactivate) | Yes | No | No | No |
| View system security audit logs | Yes | No | No | No |
| System settings & global integrations | Yes | No | No | No |
| **Project Management** | | | | |
| Create new projects | Yes | Yes | No | No |
| Delete projects | Yes | No | No | No |
| Manage project team members & roles | Yes | Yes | No | No |
| Access all projects globally | Yes | Assigned only | Assigned only | Assigned only |
| **Test Design & Discovery** | | | | |
| Discover app & generate AI test cases | Yes | Yes | Yes | No |
| Create manual test cases & API endpoints | Yes | Yes | Yes | No |
| Review & approve test cases / endpoints | Yes | Yes | No | No |
| Manage test suites | Yes | Yes | No | No |
| **Test Execution & Analysis** | | | | |
| Execute test runs (Web, API, Suites, Visual) | Yes | Yes | Yes | No |
| Review & accept visual regression baselines | Yes | Yes | No | No |
| Confirm or dismiss bug reports | Yes | Yes | Yes | No |
| **Reporting & Evidence** | | | | |
| View test runs, reports, and evidence assets | Yes | Yes | Yes | Yes |
| View visual diffs and regression comparisons | Yes | Yes | Yes | Yes |
| View project dashboards | Yes | Yes | Yes | Yes |

---

## 3. Project-Level Access Control (IDOR Prevention)

Except for platform Administrators (who hold global authority), users only have access to projects to which they have been explicitly assigned in the `project_members` table.

### Permission Enforcement Flow
1. **Authentication Hook:** Resolves the active user (`request.user`) from the session cookie or service key.
2. **Project Access Check (`assertProjectAccess`):**
   - If `user.role === "admin"`, access is immediately granted with administrative privileges.
   - Otherwise, the database query verifies membership:
     ```sql
     SELECT role FROM project_members
     WHERE project_id = $1 AND user_id = $2
     ```
   - If no membership record exists, an `AccessDeniedError` (HTTP 403) is raised: `"Access denied: You are not assigned to this project."`.
   - If membership exists, the user's project role is compared against the required minimum role:
     ```ts
     const ROLE_HIERARCHY = { viewer: 1, qa_engineer: 2, qa_manager: 3, admin: 4 };
     if (userRoleLevel < requiredRoleLevel) {
       throw new AccessDeniedError(`Access denied: Role ${minRole} or higher is required.`);
     }
     ```
3. **Indirect Resource Protection:**
   - Routes operating on secondary resources (e.g., `GET /runs/:runId`, `PATCH /test-cases/:id/review`, `GET /suites/:id`) look up the associated `project_id` and execute `assertProjectAccess` against that project, preventing Insecure Direct Object Reference (IDOR) attacks across projects.

---

## 4. User Management and Team Assignment

### User Management API (Admins Only)
- `POST /auth/register` — Create a new user account with initial role.
- `GET /users` — List all registered users (passwords and session hashes redacted).
- `PATCH /users/:id` — Update user role or toggle active/inactive status.

### Project Membership API (Admins & QA Managers)
- `GET /projects/:projectId/members` — List all team members assigned to the project.
- `POST /projects/:projectId/members` — Assign a user to the project with a specific project role (`qa_manager`, `qa_engineer`, or `viewer`).
- `DELETE /projects/:projectId/members/:userId` — Remove user from the project.

---

## 5. Security Audit Logging

Security-relevant actions are recorded in the `audit_logs` table:

```sql
CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
    outcome VARCHAR(20) NOT NULL, -- success, failure, denied
    ip_address VARCHAR(45),
    details JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
```

### Logged Events
- `LOGIN_SUCCESS` / `LOGIN_FAILURE` (tracks brute-force signals)
- `LOGOUT`
- `USER_CREATED` / `USER_ROLE_UPDATED` / `USER_STATUS_UPDATED`
- `PROJECT_CREATED`
- `WEBSITE_AUTHORIZATION_CONFIRMED`
- `PROJECT_MEMBER_ADDED` / `PROJECT_MEMBER_REMOVED`
- `UNAUTHORIZED_ACCESS_ATTEMPT` (records actor, project, action, and outcome)

*Sensitive fields such as passwords, session tokens, API keys, and authorization headers are strictly excluded and sanitized before audit persistence.*
