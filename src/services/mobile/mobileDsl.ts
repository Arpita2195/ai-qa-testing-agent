import { z } from "zod";
import { type MobileLocator, type MobileLocatorStrategy } from "./types";

/**
 * Whitelist of permitted Mobile DSL action prefixes.
 */
export const ALLOWED_MOBILE_ACTIONS = [
  "app launch",
  "app close",
  "tap",
  "click",
  "type",
  "fill",
  "clear",
  "scroll",
  "swipe",
  "expect visible",
  "expect not visible",
  "expect text",
  "wait",
  "press",
  "background",
  "screenshot",
  "permission grant",
] as const;

export type MobileActionName = (typeof ALLOWED_MOBILE_ACTIONS)[number];

export interface ParsedMobileStep {
  originalText: string;
  action: MobileActionName;
  selector?: string;
  locator?: MobileLocator;
  value?: string;
  scrollDirection?: "up" | "down" | "left" | "right";
  swipeCoords?: { startX: number; startY: number; endX: number; endY: number; durationMs?: number };
  pressKey?: "back" | "home" | "enter";
  appPackage?: string;
  appActivity?: string;
  waitMs?: number;
  backgroundSec?: number;
}

export interface MobileDslValidationResult {
  valid: boolean;
  errors: string[];
  parsedSteps?: ParsedMobileStep[];
}

/**
 * Parses a selector string into an Appium W3C locator.
 *
 * Supported formats:
 * - "id:<resId>" -> using: "id", value: "<resId>"
 * - "accessibility id:<id>" or "~<id>" -> using: "accessibility id", value: "<id>"
 * - "text:<string>" -> using: "-android uiautomator", value: `new UiSelector().text("${text}")`
 * - "uiautomator:<expression>" -> using: "-android uiautomator", value: "<expression>"
 * - "xpath:<xpath>" -> using: "xpath", value: "<xpath>"
 * - "android:id/<id>" -> using: "id", value: "android:id/<id>"
 */
export function parseSelector(raw: string): MobileLocator {
  const trimmed = raw.trim();

  if (trimmed.startsWith("id:")) {
    return { using: "id", value: trimmed.slice(3).trim() };
  }
  if (trimmed.startsWith("accessibility id:")) {
    return { using: "accessibility id", value: trimmed.slice("accessibility id:".length).trim() };
  }
  if (trimmed.startsWith("~")) {
    return { using: "accessibility id", value: trimmed.slice(1).trim() };
  }
  if (trimmed.startsWith("text:")) {
    const textVal = trimmed.slice(5).trim();
    // Escape quotes in text
    const escaped = textVal.replace(/"/g, '\\"');
    return {
      using: "-android uiautomator",
      value: `new UiSelector().textContains("${escaped}")`,
    };
  }
  if (trimmed.startsWith("uiautomator:")) {
    return { using: "-android uiautomator", value: trimmed.slice("uiautomator:".length).trim() };
  }
  if (trimmed.startsWith("xpath:")) {
    return { using: "xpath", value: trimmed.slice("xpath:".length).trim() };
  }
  if (trimmed.startsWith("//") || trimmed.startsWith("/hierarchy")) {
    return { using: "xpath", value: trimmed };
  }
  if (trimmed.includes(":id/")) {
    return { using: "id", value: trimmed };
  }

  // Default: check if starts with new UiSelector()
  if (trimmed.startsWith("new UiSelector()")) {
    return { using: "-android uiautomator", value: trimmed };
  }

  // Fallback to text matching or id
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return { using: "id", value: trimmed };
  }

  // Treat generic string as visible text selector
  const escaped = trimmed.replace(/"/g, '\\"');
  return {
    using: "-android uiautomator",
    value: `new UiSelector().textContains("${escaped}")`,
  };
}

/**
 * Validates a selector for dangerous injection attacks.
 */
function validateSafeSelector(selector: string): string | null {
  if (!selector || selector.trim().length === 0) {
    return "Selector cannot be empty.";
  }

  // Disallow any attempt to break out or execute arbitrary scripts
  const dangerousPatterns = [
    /<script/i,
    /javascript:/i,
    /\b(eval|exec|spawn|process|require|import|child_process)\b/i,
    /\b(cmd|powershell|bash|sh)\b/i,
    /[;`$]/,
    /&&/,
  ];

  for (const pattern of dangerousPatterns) {
    if (pattern.test(selector)) {
      return `Security violation: Selector contains forbidden pattern "${pattern.toString()}".`;
    }
  }

  return null;
}

/**
 * Validates app package format (e.g. "com.example.app").
 */
export function validateAppPackage(pkg: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(pkg.trim());
}

/**
 * Validates an entire list of Mobile DSL step strings.
 * Enforces strict whitelist grammar, parameter delimiters, and anti-code injection.
 */
export function validateMobileDsl(steps: string[]): MobileDslValidationResult {
  const errors: string[] = [];
  const parsedSteps: ParsedMobileStep[] = [];

  if (!steps || !Array.isArray(steps) || steps.length === 0) {
    return { valid: false, errors: ["Mobile test must contain at least one step."] };
  }

  for (let i = 0; i < steps.length; i++) {
    const raw = steps[i];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      errors.push(`Step ${i + 1}: Empty step.`);
      continue;
    }

    const step = raw.trim();

    // 1. General Security Inspection: Reject arbitrary code, shell commands, dangerous tokens
    if (
      /\b(eval|process|require|import|exec|spawn|fs\.|global\.|child_process)\b/i.test(step) ||
      /\b(rm\s+-rf|curl|wget|bash|sh|powershell|cmd\.exe|adb\s+shell)\b/i.test(step) ||
      /<script|javascript:/i.test(step) ||
      /&&|\|\||[;`$]/.test(step.replace(/\{\{[A-Za-z0-9_]+\}\}/g, "")) // allow placeholders and single & or single |
    ) {
      errors.push(`Step ${i + 1}: Security violation: forbidden executable code or shell expression detected.`);
      continue;
    }

    // 2. Action Whitelist Matching
    const matchedAction = ALLOWED_MOBILE_ACTIONS.find(
      (action) => step === action || step.startsWith(`${action} `),
    );

    if (!matchedAction) {
      errors.push(
        `Step ${i + 1}: Unknown or forbidden mobile action "${step}". Permitted actions: ${ALLOWED_MOBILE_ACTIONS.join(", ")}`,
      );
      continue;
    }

    const rest = step.slice(matchedAction.length).trim();
    const parsed: ParsedMobileStep = { originalText: step, action: matchedAction };

    // 3. Grammar rules per action
    switch (matchedAction) {
      case "app launch": {
        if (!rest) {
          errors.push(`Step ${i + 1}: "app launch" requires a package name (e.g. "app launch com.example.app").`);
        } else {
          const parts = rest.split(/\s+/);
          const pkg = parts[0];
          if (!validateAppPackage(pkg)) {
            errors.push(`Step ${i + 1}: Invalid Android package name "${pkg}". Must be format com.company.app.`);
          }
          parsed.appPackage = pkg;
          if (parts[1]) parsed.appActivity = parts[1];
        }
        break;
      }

      case "app close": {
        if (rest) {
          parsed.appPackage = rest;
        }
        break;
      }

      case "tap":
      case "click": {
        if (!rest) {
          errors.push(`Step ${i + 1}: "${matchedAction}" requires an element selector.`);
        } else {
          const secErr = validateSafeSelector(rest);
          if (secErr) errors.push(`Step ${i + 1}: ${secErr}`);
          else {
            parsed.selector = rest;
            parsed.locator = parseSelector(rest);
          }
        }
        break;
      }

      case "type":
      case "fill": {
        if (!rest.includes("|")) {
          errors.push(`Step ${i + 1}: "${matchedAction}" requires delimiter "|" format: ${matchedAction} <selector> | <text>`);
        } else {
          const [sel, ...valParts] = rest.split("|");
          const selector = sel.trim();
          const value = valParts.join("|").trim();
          const secErr = validateSafeSelector(selector);
          if (secErr) errors.push(`Step ${i + 1}: ${secErr}`);
          else {
            parsed.selector = selector;
            parsed.locator = parseSelector(selector);
            parsed.value = value;
          }
        }
        break;
      }

      case "clear": {
        if (!rest) {
          errors.push(`Step ${i + 1}: "clear" requires an element selector.`);
        } else {
          const secErr = validateSafeSelector(rest);
          if (secErr) errors.push(`Step ${i + 1}: ${secErr}`);
          else {
            parsed.selector = rest;
            parsed.locator = parseSelector(rest);
          }
        }
        break;
      }

      case "scroll": {
        const dir = rest.toLowerCase();
        if (!["up", "down", "left", "right"].includes(dir)) {
          errors.push(`Step ${i + 1}: "scroll" direction must be one of: up, down, left, right.`);
        } else {
          parsed.scrollDirection = dir as "up" | "down" | "left" | "right";
        }
        break;
      }

      case "swipe": {
        const parts = rest.split(/\s+/).map(Number);
        if (parts.length < 4 || parts.slice(0, 4).some(isNaN)) {
          errors.push(`Step ${i + 1}: "swipe" requires 4 coordinates: swipe <startX> <startY> <endX> <endY> [durationMs]`);
        } else {
          parsed.swipeCoords = {
            startX: parts[0],
            startY: parts[1],
            endX: parts[2],
            endY: parts[3],
            durationMs: parts[4] && !isNaN(parts[4]) ? parts[4] : 600,
          };
        }
        break;
      }

      case "expect visible":
      case "expect not visible": {
        if (!rest) {
          errors.push(`Step ${i + 1}: "${matchedAction}" requires an element selector.`);
        } else {
          const secErr = validateSafeSelector(rest);
          if (secErr) errors.push(`Step ${i + 1}: ${secErr}`);
          else {
            parsed.selector = rest;
            parsed.locator = parseSelector(rest);
          }
        }
        break;
      }

      case "expect text": {
        if (rest.includes("|")) {
          const [sel, ...txtParts] = rest.split("|");
          const selector = sel.trim();
          const expected = txtParts.join("|").trim();
          const secErr = validateSafeSelector(selector);
          if (secErr) errors.push(`Step ${i + 1}: ${secErr}`);
          else {
            parsed.selector = selector;
            parsed.locator = parseSelector(selector);
            parsed.value = expected;
          }
        } else if (rest) {
          // Assert text appears on screen
          parsed.value = rest;
          parsed.locator = {
            using: "-android uiautomator",
            value: `new UiSelector().textContains("${rest.replace(/"/g, '\\"')}")`,
          };
        } else {
          errors.push(`Step ${i + 1}: "expect text" requires expected text.`);
        }
        break;
      }

      case "wait": {
        const ms = parseInt(rest, 10);
        if (isNaN(ms) || ms < 0 || ms > 30000) {
          errors.push(`Step ${i + 1}: "wait" requires milliseconds between 0 and 30000.`);
        } else {
          parsed.waitMs = ms;
        }
        break;
      }

      case "press": {
        const key = rest.toLowerCase();
        if (!["back", "home", "enter"].includes(key)) {
          errors.push(`Step ${i + 1}: "press" key must be one of: back, home, enter.`);
        } else {
          parsed.pressKey = key as "back" | "home" | "enter";
        }
        break;
      }

      case "background": {
        const sec = parseInt(rest, 10);
        if (isNaN(sec) || sec < 1 || sec > 60) {
          errors.push(`Step ${i + 1}: "background" requires duration between 1 and 60 seconds.`);
        } else {
          parsed.backgroundSec = sec;
        }
        break;
      }

      case "screenshot": {
        // No extra arguments required
        break;
      }

      case "permission grant": {
        if (!rest) {
          errors.push(`Step ${i + 1}: "permission grant" requires permission name.`);
        } else {
          parsed.value = rest;
        }
        break;
      }
    }

    parsedSteps.push(parsed);
  }

  return {
    valid: errors.length === 0,
    errors,
    parsedSteps: errors.length === 0 ? parsedSteps : undefined,
  };
}

