# Website Ownership and Authorization Confirmation

This document explains the policies, database models, API requirements, and UI mechanisms for Task 4: Target Website Ownership and Authorization Confirmation in the AI QA Testing Agent.

---

## 1. Rationale and Legal Context

The AI QA Testing Agent autonomously crawls web interfaces, interacts with form controls, submits test payloads, calls discovered API endpoints, and captures visual screenshots. Executing automated testing against infrastructure without prior written permission is illegal under cybersecurity regulations (such as the CFAA in the United States and the Computer Misuse Act in the United Kingdom) and violates the terms of service of cloud and hosting providers.

Before any project can be created or tested, the system enforces an explicit confirmation step requiring the operator to attest to ownership or formal authorization.

---

## 2. Security Principle & Declaration Disclaimer

> [!IMPORTANT]
> **Declaration vs. Ownership Verification:**
> The authorization checkbox is a legally binding declaration by the authenticated user, **not** automated cryptographic or DNS proof of domain ownership. The system does not claim to independently verify ownership without domain DNS TXT records or well-known challenge tokens.

The platform relies on this declaration to:
1. Establish legal user accountability.
2. Bind the affirmative statement to the authenticated user ID and client IP.
3. Record an immutable audit entry in the database.
4. Prevent accidental or unauthorized testing through automated UI workflows or direct API scripts.

---

## 3. Data Model & Persistence

The authorization declaration is recorded upon project creation and stored across two database structures:

### `projects` Table Columns
- `owner_confirmed_at TIMESTAMP WITH TIME ZONE`: The exact timestamp when confirmation was recorded.
- `owner_confirmed_by UUID REFERENCES users(id)`: The user account that made the declaration.

### `website_authorizations` Table
```sql
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
```

### Immutability of Authorizations
- Authorization records cannot be edited, modified, or updated after creation.
- If a target URL or scope changes, a new project must be created with a fresh authorization confirmation.
- Deleting a project cascades and removes associated authorization records.

---

## 4. API Request Requirements & Validation

### Request Payload (`POST /projects`)
```json
{
  "name": "E-Commerce Web App",
  "base_url": "https://staging.example.com",
  "owner_confirmed": true,
  "declaration_text": "I confirm that I own this website or have explicit authorization from its owner to test it."
}
```

### Validation Rules
1. **Explicit Confirmation Check:**
   - If `owner_confirmed` is omitted, `null`, or `false`, the API rejects the request immediately with HTTP 400:
     ```json
     { "error": "Explicit website ownership or testing authorization confirmation is required." }
     ```
   - Direct API calls attempting to bypass the checkbox receive the same rejection.
2. **SSRF Target Validation (`urlGuard`):**
   - The `base_url` is evaluated by the SSRF defense layer (`assertSafeUrl` / `validateTargetUrl`).
   - Addresses resolving to loopback (`127.0.0.1`, `::1`), private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), link-local (`169.254.169.254`), internal hostnames (`localhost`, `*.internal`, `*.corp`), or non-HTTP protocols are rejected with HTTP 400.
3. **Transaction Binding:**
   - The project insertion, membership assignment (creator assigned as `qa_manager`), authorization record creation, and security audit log entry (`WEBSITE_AUTHORIZATION_CONFIRMED`) are executed in a single atomic database transaction.

---

## 5. User Interface Integration

1. **Project Creation Forms:**
   - Both the rapid discovery modal (`TestNewAppBox`) and the formal project modal (`ProjectsPage`) include:
     - Prominent legal notice: *"Automated testing executes simulated user interactions, crawls, and functional tests against the target domain. You must confirm that you own this website or have explicit authorization from its owner before scanning."*
     - Mandatory checkbox: *"I confirm that I own this website or have explicit authorization from its owner to test it."*
     - The submit button remains disabled until the URL is entered and the checkbox is checked.
2. **Project Detail Page Authorization Notice:**
   - At the top of every project view, an authorization notice banner is displayed before test operations:
     - For confirmed projects: `🛡️ Website Ownership & Authorization Declared: Confirmed on <timestamp> by user <userId>...`
     - For legacy projects created prior to migration: `⚠️ Authorization Notice: Legacy project record. Target: <url>. Ensure valid testing authorization is maintained.`
