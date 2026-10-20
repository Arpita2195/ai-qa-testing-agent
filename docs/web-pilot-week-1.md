# StockFlow web pilot — Week 1

## Decision and scope

- **Pilot application:** StockFlow, `https://stockflow-vert-two.vercel.app`
- **Environment:** owner-confirmed test deployment; not a client or live business system.
- **Coverage:** one application and these five priority workflows:
  1. Sign in and reach the main dashboard.
  2. View inventory; search or filter for a product.
  3. Add a product using valid details and verify it appears in inventory.
  4. View orders and open an order's details.
  5. Submit the add-product form with required fields empty and verify validation errors.
- **Test identity:** a dedicated StockFlow test account will be created by the owner. Its credentials belong in the ignored root `.env`, never source control, test fixtures, logs, or generated reports.

## Architecture

The existing project skeleton is retained:

- Fastify exposes the authenticated platform API and stores projects, cases, runs, results, and evidence metadata in PostgreSQL.
- Playwright Chromium performs browser actions and explicit assertions. Only those assertions determine pass/fail.
- Approved test cases are executed by the web runner; AI-generated cases remain pending until a human approves them. AI failure analysis explains recorded failures and cannot alter their status.
- Screenshots and traces are evidence attached to failures. Browser console errors, failed requests, and unexpected HTTP responses are recorded as diagnostics, not substituted for a test assertion.
- The React dashboard is the operator surface for review, execution, history, and evidence.
- CI runs deterministic build and unit tests. It does not use the StockFlow account or invoke the live pilot site.

The current runner has a deliberately small step vocabulary (`goto`, `click`, `fill`, `expect text`). Week 2 will extend it for stable role/label locators, form assertions, browser diagnostics, traces, and report generation. Workflow-specific tests must assert observable outcomes and avoid relying on AI-generated expectations without approval.

## Test safety and data handling

- Use only the dedicated test account and test deployment.
- Do not use real customer, payment, or production data.
- Create uniquely identifiable test products and define cleanup/retention before the first product-creation run.
- The empty-required-fields workflow must not create a product.
- Keep credentials in the ignored root `.env`; never put them in `dashboard/.env`, because Vite variables are exposed to browser clients.
- Avoid logging request headers, passwords, session cookies, or credential-bearing URLs.
- The current dashboard's `VITE_API_KEY` is also visible to browser clients and must not be treated as a secret. Keep the dashboard restricted to trusted local use until a server-side session/proxy replaces that shared browser key.

## Local configuration

Copy the StockFlow settings from `.env.example` into the ignored root `.env` after creating the test account:

```dotenv
STOCKFLOW_BASE_URL=https://stockflow-vert-two.vercel.app
STOCKFLOW_TEST_EMAIL=your-test-account-email
STOCKFLOW_TEST_PASSWORD=your-test-account-password
```

These names are reserved in the backend environment schema for the next implementation step. The web runner does not yet consume them.

## Week 1 exit criteria

- Pilot application, test environment, and five priority workflows are agreed.
- Architecture and pass/fail ownership are documented.
- Existing backend, database migration system, Playwright setup, and dashboard skeleton are available.
- A dedicated test account is created and configured locally before authenticated browser automation begins.
- Test product naming and cleanup/retention are agreed before running the create-product workflow.

## Next milestone

Week 2 implements the first end-to-end browser workflows and evidence capture: page load, sign-in, inventory search, safe product-form validation, screenshots/traces, browser diagnostics, and readable HTML/JSON run reports. Product creation remains gated on an agreed cleanup strategy.
