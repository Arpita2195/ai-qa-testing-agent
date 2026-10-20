import { describe, expect, it } from "vitest";
import { resolveStepPlaceholders, redactSecrets } from "../services/runner";
import { buildRunReport } from "../services/runReport";
import type { RunEvidence } from "../types/evidence";

describe("Placeholder resolution and redaction", () => {
  it("resolves APP_USERNAME and APP_PASSWORD at runtime while keeping saved steps intact", () => {
    const savedStep = "fill #username | {{APP_USERNAME}}";
    const credentials = {
      username: "real_user_name",
      password: "real_password_123",
    };

    const resolved = resolveStepPlaceholders(savedStep, credentials);
    expect(resolved).toBe("fill #username | real_user_name");
    // Saved step must remain unchanged
    expect(savedStep).toBe("fill #username | {{APP_USERNAME}}");

    const passStep = "fill #pass | {{APP_PASSWORD}}";
    const resolvedPass = resolveStepPlaceholders(passStep, credentials);
    expect(resolvedPass).toBe("fill #pass | real_password_123");
    expect(passStep).toBe("fill #pass | {{APP_PASSWORD}}");
  });

  it("resolves legacy STOCKFLOW_TEST_EMAIL and STOCKFLOW_TEST_PASSWORD correctly", () => {
    const savedEmailStep = "fill input[name='email'] | {{STOCKFLOW_TEST_EMAIL}}";
    const savedPassStep = "fill input[name='password'] | {{STOCKFLOW_TEST_PASSWORD}}";

    const resolvedEmail = resolveStepPlaceholders(savedEmailStep, {
      email: "stockflow_user@example.com",
      password: "stockflow_secret_password",
    });
    expect(resolvedEmail).toBe("fill input[name='email'] | stockflow_user@example.com");

    const resolvedPass = resolveStepPlaceholders(savedPassStep, {
      email: "stockflow_user@example.com",
      password: "stockflow_secret_password",
    });
    expect(resolvedPass).toBe("fill input[name='password'] | stockflow_secret_password");
  });

  it("redacts credentials from error messages and text logs", () => {
    const credentials = {
      username: "sensitive_user_account",
      password: "super_secret_password_xyz",
    };

    const rawError =
      "Error during fill for user sensitive_user_account with password super_secret_password_xyz";
    const redacted = redactSecrets(rawError, credentials);

    expect(redacted).not.toContain("sensitive_user_account");
    expect(redacted).not.toContain("super_secret_password_xyz");
    expect(redacted).toContain("[hidden]");
  });

  it("scrubs cookies, authorization headers, and storageState from run reports and evidence", () => {
    const rawEvidence: RunEvidence = {
      url: "https://example.com/app",
      console: [],
      pageErrors: [],
      failedRequests: [],
      httpErrors: [
        {
          method: "GET",
          url: "https://example.com/api?token=secret123",
          status: 401,
          headers: {
            "set-cookie": "session_id=ultra_secret_cookie_token_999; Secure; HttpOnly",
            authorization: "Bearer secret_bearer_token_xyz",
            "x-api-key": "secret_api_key_abc",
          },
        },
      ],
      tracePath: null,
      screenshotPath: null,
    };

    const report = buildRunReport(
      {
        runId: "run-1",
        projectName: "Test App",
        baseUrl: "https://example.com",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        tests: [
          {
            id: "test-1",
            title: "Test with sensitive_password_abc",
            steps: ["goto /app"],
            status: "passed",
            duration_ms: 50,
            error_message: null,
            evidence: rawEvidence as any,
          },
        ],
      },
      { password: "sensitive_password_abc" },
    );

    const reportString = JSON.stringify(report);
    expect(reportString).not.toContain("ultra_secret_cookie_token_999");
    expect(reportString).not.toContain("secret_bearer_token_xyz");
    expect(reportString).not.toContain("secret_api_key_abc");
    expect(reportString).not.toContain("sensitive_password_abc");
    expect(reportString).toContain("[hidden]");
  });
});
