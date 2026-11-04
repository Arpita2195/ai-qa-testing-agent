# Security Architecture and Threat Model

This document outlines the security controls, threat mitigations, and compliance considerations for the AI QA Testing Agent across Tasks 1–5.

---

## 1. Threat Model & Mitigations Matrix

| Threat / Vulnerability | OWASP / CWE | Mitigation Strategy Implemented |
| :--- | :--- | :--- |
| **Broken Authentication** | A07:2021<br>CWE-287 | - Scrypt password hashing with OWASP-recommended memory/CPU costs.<br>- Cryptographically secure 256-bit random session tokens.<br>- Sessions hashed with SHA-256 at rest in the database.<br>- Constant-time verification preventing timing side channels. |
| **Session Hijacking & Fixation** | CWE-384<br>CWE-613 | - Session tokens regenerated on login.<br>- HTTP-only cookies prevent JavaScript access.<br>- SameSite=Lax and Secure attributes in production.<br>- Absolute expiration after 24 hours.<br>- Immediate server-side invalidation upon logout. |
| **Credential Brute-Force** | CWE-307 | - Sliding-window rate limiter on `POST /auth/login` (max 5 failures per 5 minutes per IP address) responding with HTTP 429. |
| **Cross-Site Request Forgery (CSRF)** | A01:2021<br>CWE-352 | - `SameSite=Lax` cookie configuration.<br>- Cryptographic CSRF token verification on all cookie-authenticated mutating endpoints (`POST`, `PUT`, `PATCH`, `DELETE`). |
| **Insecure Direct Object Reference (IDOR)** | A01:2021<br>CWE-639 | - Strict project-level membership isolation via `project_members`.<br>- Every resource route (runs, suites, endpoints, visual checks, evidence) resolves target `project_id` and invokes `assertProjectAccess`.<br>- Global Admin role bypasses; non-assigned users receive HTTP 403. |
| **Privilege Escalation** | CWE-269 | - Strict 4-tier role hierarchy (`admin > qa_manager > qa_engineer > viewer`).<br>- Role updates restricted to platform administrators.<br>- Viewer role cannot execute tests, approve baselines, or generate AI tests. |
| **Server-Side Request Forgery (SSRF)** | A10:2021<br>CWE-918 | - `urlGuard` service validates all outbound URLs.<br>- Blocks IPv4 loopback (`127.0.0.0/8`), private networks (`10/8`, `172.16/12`, `192.168/16`), link-local (`169.254.169.254`), and IPv6 equivalents.<br>- DNS pre-resolution and redirect chain validation prevents DNS rebinding attacks.<br>- Strict 10MB response limits and connection timeouts. |
| **Unauthorized Target Testing** | CWE-862 | - Mandatory ownership/authorization confirmation on project creation.<br>- API rejection on missing or false confirmation.<br>- Immutable audit record in `website_authorizations`. |
| **Credential Leakage in Frontend** | CWE-200<br>CWE-312 | - Removed client-side `VITE_API_KEY` dependency.<br>- Zero storage of plaintext passwords or tokens in `localStorage`.<br>- Sensitive credentials for testing stored using AES-256-GCM in backend `secretStore`. |
| **Log Injection & Secret Exposure** | CWE-532 | - `auditLogger` explicitly sanitizes all event payloads, redacting passwords, session tokens, and authorization headers. |

---

## 2. Cryptographic Standards

- **Password Storage:** Node.js native `crypto.scrypt` with parameters:
  - `cost (N)`: 16,384
  - `blockSize (r)`: 8
  - `parallelization (p)`: 1
  - `keyLength`: 64 bytes
  - `salt`: 16 random bytes per credential.
- **Session Tokens:**
  - In-flight: 32 cryptographically secure random bytes (`crypto.randomBytes(32)`).
  - At rest: SHA-256 hash (`crypto.createHash("sha256").update(token).digest("hex")`).
- **Test Target Credentials:** AES-256-GCM symmetric encryption using platform secret key (`APP_SECRET`).
- **Comparison Primitives:** All secret comparisons utilize `crypto.timingSafeEqual`.

---

## 3. Defense-in-Depth Authorization Model

Each protected endpoint executes a two-tier verification check:

```
                  Incoming Request
                         │
                         ▼
        ┌──────────────────────────────────┐
        │  Layer 1: Identity Authentication│
        │  - Validates session or API key  │
        └────────────────┬─────────────────┘
                         │ User Context (request.user)
                         ▼
        ┌──────────────────────────────────┐
        │  Layer 2: Project & Action RBAC  │
        │  - Checks project membership     │
        │  - Enforces minimum role rank    │
        └────────────────┬─────────────────┘
                         │ Allowed
                         ▼
        ┌──────────────────────────────────┐
        │       Route Business Logic       │
        └──────────────────────────────────┘
```

---

## 4. Operational Security Best Practices

1. **Production TLS Enforcement:**
   - Always run the Fastify backend behind a TLS-terminating reverse proxy (e.g., NGINX, Cloudflare) with `NODE_ENV=production`.
   - Ensure `secure: true` cookies are propagated.
2. **Secret Rotation:**
   - Change `PLATFORM_API_KEY` periodically.
   - Use secure environment variable managers (AWS Secrets Manager, HashiCorp Vault) rather than hardcoded `.env` files in production.
3. **Database Security:**
   - Run PostgreSQL with least-privilege database users.
   - Restrict database port access to internal application VPC/subnets.
