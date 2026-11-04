import { describe, expect, it } from "vitest";
import {
  describeTestStep,
  isSubmissionOnlyExpectedResult,
} from "../utils/testStepDescription";

describe("human-readable test steps", () => {
  it("describes navigation and page assertions", () => {
    expect(describeTestStep("goto /team")).toBe("Open the team page.");
    expect(describeTestStep("expect text Team members")).toBe(
      "Confirm that “Team members” appears on the page.",
    );
  });

  it("describes credential entry without exposing credential values", () => {
    expect(describeTestStep("fill #email | {{STOCKFLOW_TEST_EMAIL}}")).toBe(
      "Enter the saved test account email or username.",
    );
    expect(describeTestStep("fill #password | {{STOCKFLOW_TEST_PASSWORD}}")).toBe(
      "Enter a test password in the password field.",
    );
    expect(describeTestStep("fill input:nth-of-type(3) | Password123456789")).toBe(
      "Enter a test password in the password field.",
    );
  });

  it("converts form actions without showing selectors or typed values", () => {
    expect(describeTestStep('fill input[name="email"] | test@example.com')).toBe(
      "Enter a test email address.",
    );
    expect(describeTestStep("fill input:nth-of-type(1) | Test User")).toBe(
      "Enter a sample name in the form.",
    );
    expect(describeTestStep("click form:nth-of-type(1) > button:nth-of-type(1)")).toBe(
      "Submit the form.",
    );
    expect(describeTestStep("fill input:nth-of-type(1) | private value")).not.toContain(
      "private value",
    );
  });

  it("flags expectations that only say a form submitted", () => {
    expect(isSubmissionOnlyExpectedResult("The form submission is triggered without errors.")).toBe(true);
    expect(isSubmissionOnlyExpectedResult("The new member appears in the team list.")).toBe(false);
  });
});
