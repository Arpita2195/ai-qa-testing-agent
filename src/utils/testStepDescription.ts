function fieldNameFromSelector(selector: string): string | null {
  const attribute = selector.match(
    /(?:name|placeholder|aria-label|id|data-testid)\s*=\s*["']([^"']+)["']/i,
  );
  const id = selector.match(/#([\w-]+)/);
  const rawName = attribute?.[1] ?? id?.[1];
  if (rawName) {
    return rawName
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .trim()
      .toLowerCase();
  }
  return null;
}

function isPasswordLike(value: string): boolean {
  return (
    /password|passwd|secret/i.test(value) ||
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{10,}$/.test(value)
  );
}

function describeFill(selector: string, value: string): string {
  const fieldName = fieldNameFromSelector(selector);
  const combined = `${selector} ${fieldName ?? ""}`;

  if (/password|passwd|secret/i.test(combined) || isPasswordLike(value)) {
    return "Enter a test password in the password field.";
  }
  if (/STOCKFLOW_TEST_EMAIL|APP_USERNAME/i.test(value)) {
    return "Enter the saved test account email or username.";
  }
  if (/STOCKFLOW_TEST_PASSWORD|APP_PASSWORD/i.test(value)) {
    return "Enter the saved test account password.";
  }
  if (/email|e-mail/i.test(combined) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    return "Enter a test email address.";
  }
  if (/username|user name/i.test(combined)) {
    return "Enter a test username.";
  }
  if (/^(?:test|sample|qa)[\s_-]+[a-z][\w -]*$/i.test(value)) {
    return "Enter a sample name in the form.";
  }
  if (fieldName) {
    return `Enter the requested value in the ${fieldName} field.`;
  }
  return "Enter the requested test value in the form field.";
}

function describeSelectorAction(selector: string, verb: "click" | "visible" | "hidden"): string {
  const normalized = selector.toLowerCase();
  const fieldName = fieldNameFromSelector(selector);

  if (verb === "hidden" && /form.*label:nth-of-type\(\d+\).*input/i.test(selector)) {
    return "Confirm the sign-in form has closed.";
  }
  if (verb === "click" && /form.*button|button.*submit|type\s*=\s*["']submit/i.test(selector)) {
    return "Submit the form.";
  }
  if (/password|passwd/i.test(normalized)) {
    return verb === "hidden"
      ? "Confirm the sign-in form is no longer visible."
      : verb === "visible"
        ? "Confirm the password field is visible."
        : "Select the password field.";
  }
  if (verb === "click") {
    if (/sign.?in|log.?in/i.test(normalized)) return "Select the sign-in button.";
    if (/\ba\b|href/i.test(normalized)) return "Open the selected link.";
    if (/button/i.test(normalized)) return "Click the button.";
    return "Select the requested item.";
  }
  if (fieldName) {
    return verb === "hidden"
      ? `Confirm the ${fieldName} field is no longer visible.`
      : `Confirm the ${fieldName} field is visible.`;
  }
  if (/button/i.test(normalized)) {
    return verb === "hidden"
      ? "Confirm the button is no longer visible."
      : "Confirm the button is visible.";
  }
  return verb === "hidden"
    ? "Confirm the selected item is no longer visible."
    : "Confirm the selected item is visible.";
}

export function describeTestStep(step: string): string {
  const trimmed = step.trim();
  if (trimmed.startsWith("goto ")) {
    const path = trimmed.slice("goto ".length).trim();
    const pageName = path === "/" ? "home" : path.split(/[/?#]/).filter(Boolean).pop()?.replace(/[-_]+/g, " ") ?? "requested";
    return `Open the ${pageName} page.`;
  }

  if (trimmed.startsWith("fill ")) {
    const input = trimmed.slice("fill ".length);
    const separator = input.indexOf("|");
    if (separator < 0) return "Enter the requested value in the form.";
    return describeFill(input.slice(0, separator).trim(), input.slice(separator + 1).trim());
  }

  if (trimmed.startsWith("click ")) {
    return describeSelectorAction(trimmed.slice("click ".length).trim(), "click");
  }
  if (trimmed.startsWith("select ")) {
    const selector = trimmed.slice("select ".length).split("|", 1)[0].trim();
    const fieldName = fieldNameFromSelector(selector);
    return fieldName
      ? `Choose the requested option in the ${fieldName} field.`
      : "Choose the requested option in the form.";
  }
  if (trimmed.startsWith("expect not visible ")) {
    return describeSelectorAction(trimmed.slice("expect not visible ".length).trim(), "hidden");
  }
  if (trimmed.startsWith("expect visible ")) {
    return describeSelectorAction(trimmed.slice("expect visible ".length).trim(), "visible");
  }
  if (trimmed.startsWith("expect text ")) {
    const text = trimmed.slice("expect text ".length).trim();
    return `Confirm that “${text}” appears on the page.`;
  }
  if (trimmed.startsWith("expect invalid ")) {
    const fieldName = fieldNameFromSelector(trimmed.slice("expect invalid ".length).trim());
    return fieldName
      ? `Confirm the ${fieldName} field shows a validation error.`
      : "Confirm the form shows a validation error.";
  }
  if (trimmed.startsWith("wait ")) {
    return "Wait for the page to finish updating.";
  }
  if (trimmed === "wait for navigation" || trimmed.startsWith("wait for navigation ")) {
    return "Wait for the next page to open.";
  }
  return trimmed;
}

export function isSubmissionOnlyExpectedResult(expectedResult: string): boolean {
  return /form submission.*(?:triggered|submitted|completed).*(?:without errors|successfully)|submitted without errors/i
    .test(expectedResult);
}
