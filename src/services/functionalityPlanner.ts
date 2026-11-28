import { createHash, randomUUID } from "node:crypto";
import { pool } from "../config/db";
import { isInfrastructureOrCdnPath, isErrorPageContent } from "./urlGuard";
import type { PageElement, PageData, ScrapedPage, SiteData } from "./pageReader";

export interface DiscoveredFunctionality {
  id: string;
  projectId: string;
  name: string;
  category: "authentication" | "crud" | "search_filter" | "navigation" | "data_display" | "general";
  pageUrl: string;
  pagePath: string;
  elements: PageElement[];
  interactionDetails: {
    formSelector?: string;
    submitSelector?: string;
    inputSelectors?: string[];
    actionType?: string;
    headings?: string[];
    actionButtons?: Array<{ text: string; selector: string }>;
    tabs?: Array<{ text: string; selector: string }>;
    columnHeaders?: string[];
    tableSelector?: string;
  };
  status: "discovered" | "in_progress" | "completed" | "failed";
}

export interface PlannedScenario {
  id?: string;
  scenarioId: string;
  functionalityId: string;
  projectId: string;
  title: string;
  description: string;
  category: "positive" | "negative" | "boundary" | "edge_case";
  priority: "critical" | "high" | "medium" | "low";
  expectedBehavior: string;
  status: "planned" | "generated" | "failed" | "skipped";
}

export interface CoverageReport {
  projectId: string;
  totalFunctionalities: number;
  totalScenariosPlanned: number;
  totalScenariosGenerated: number;
  totalScenariosMissing: number;
  overallCoveragePercent: number;
  byCategory: {
    positive: { planned: number; generated: number; percent: number };
    negative: { planned: number; generated: number; percent: number };
    boundary: { planned: number; generated: number; percent: number };
    edge_case: { planned: number; generated: number; percent: number };
  };
}

/**
 * Normalizes a title or path into a concise URL-safe slug for backward compatibility and human readability.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 20)
    .toUpperCase() || "FUNC";
}

/**
 * Normalizes a URL page path into a concise alphanumeric slug for scenario identification.
 * E.g., "/" -> "ROOT", "/inventory" -> "INVENTORY", "/items/101" -> "ITEMS-101", "/inventory?page=2" -> "INVENTORY-P2"
 */
export function slugifyPagePath(path: string): string {
  const cleanPath = (path || "/").trim();
  if (cleanPath === "" || cleanPath === "/") return "ROOT";
  return cleanPath
    .replace(/^\/+|\/+$/g, "")
    .replace(/[?=&]+/g, "-")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .toUpperCase()
    .slice(0, 24) || "PAGE";
}

/**
 * Generates a deterministic, collision-resistant scenario ID.
 * Incorporates:
 * - Functional category code (AUTH, SEARCH, FORM, NAV, VIEW, GEN)
 * - Normalized page path slug (ROOT, LOGIN, INVENTORY, ITEMS-101, etc.)
 * - 8-character deterministic hex hash of the full stable functionality signature (path + category + name)
 * - Scenario category code (POS, NEG, BND, EDG)
 * - 2-digit scenario index (01, 02, etc.)
 *
 * Example: SCEN-NAV-ROOT-E5C19A02-POS-01
 * Max length is ~38-45 characters, strictly respecting Migration 017's VARCHAR(100) limit.
 */
export function generateScenarioId(
  func: DiscoveredFunctionality,
  scenarioCategory: "positive" | "negative" | "boundary" | "edge_case" | "POS" | "NEG" | "BND" | "EDG",
  index: number,
): string {
  const catCodeMap: Record<string, string> = {
    positive: "POS",
    negative: "NEG",
    boundary: "BND",
    edge_case: "EDG",
    POS: "POS",
    NEG: "NEG",
    BND: "BND",
    EDG: "EDG",
  };
  const catCode = catCodeMap[scenarioCategory] || "POS";

  const funcCategoryMap: Record<string, string> = {
    authentication: "AUTH",
    search_filter: "SEARCH",
    crud: "FORM",
    navigation: "NAV",
    data_display: "VIEW",
    general: "GEN",
  };
  const funcCatCode = funcCategoryMap[func.category] || "GEN";
  const pathSlug = slugifyPagePath(func.pagePath);

  // Compute a deterministic 8-char hex hash of the stable functionality signature
  const signatureInput = `${(func.pagePath || "/").trim().toLowerCase()}|${func.category || "general"}|${(func.name || "").trim().toLowerCase()}`;
  const sigHash = createHash("sha256").update(signatureInput).digest("hex").slice(0, 8).toUpperCase();

  const indexStr = String(index).padStart(2, "0");
  return `SCEN-${funcCatCode}-${pathSlug}-${sigHash}-${catCode}-${indexStr}`;
}

/**
 * Discovers distinct functionalities from a scraped page's DOM elements and structure.
 */
export function discoverPageFunctionalities(
  page: ScrapedPage | PageData,
  projectId: string,
): DiscoveredFunctionality[] {
  const functionalities: DiscoveredFunctionality[] = [];
  let pagePath = "path" in page && page.path ? page.path : "/";
  try {
    if (page.url) {
      const parsedUrl = new URL(page.url, "http://localhost");
      if (parsedUrl.search && !pagePath.includes("?")) {
        pagePath = parsedUrl.pathname + parsedUrl.search;
      } else if (!pagePath || pagePath === "/") {
        pagePath = parsedUrl.pathname + (parsedUrl.search || "");
      }
    }
  } catch {}

  // Exclude CDN/infrastructure routes (e.g. /cdn-cgi/*, /.well-known/*)
  if (isInfrastructureOrCdnPath(pagePath) || (page.url && isInfrastructureOrCdnPath(page.url))) {
    return [];
  }

  const headings = "headings" in page ? page.headings : [];
  const elements = page.elements || [];
  const pageTitle = "title" in page ? page.title : "";
  const pageText = "text" in page ? page.text : "";

  // Exclude error pages (e.g. 404 Not Found, 500 Internal Server Error)
  if (isErrorPageContent(pageTitle, headings, pageText)) {
    return [];
  }

  // 1. Identify Login / Authentication Functionality
  const passwordInput = elements.find((el) => el.tag === "input" && el.type === "password");
  if (passwordInput) {
    const authElements = elements.filter(
      (el) =>
        el.tag === "input" ||
        (el.tag === "button" && /log\s*in|sign\s*in|submit|continue/i.test(el.text || el.name || "")),
    );
    functionalities.push({
      id: randomUUID(),
      projectId,
      name: `User Authentication on ${pagePath}`,
      category: "authentication",
      pageUrl: page.url,
      pagePath,
      elements: authElements.length > 0 ? authElements : [passwordInput],
      interactionDetails: {
        submitSelector: elements.find(
          (el) => el.tag === "button" || el.type === "submit",
        )?.selector,
        inputSelectors: authElements.map((el) => el.selector),
        actionType: "login",
        headings,
      },
      status: "discovered",
    });
  }

  // Helper: check if element is inside global navigation layout
  const isLayoutElement = (el: PageElement) =>
    Boolean(el.selector && /(aside|app-sidebar|\.sidebar|header|app-header|\.navbar)/i.test(el.selector));

  // 2. Identify Action Controls & Operation Triggers (Buttons like "+ Create Setting", "Manual Trigger", "Process Due", "+ Create Quota")
  const actionButtons = elements.filter((el) => {
    if (el.tag !== "button" && el.type !== "button" && el.type !== "submit" && !el.selector?.includes('[role="button"]')) {
      return false;
    }
    const text = (el.text || "").trim();
    const sel = (el.selector || "").toLowerCase();
    if (/palette|theme|dark-mode|light-mode/i.test(sel)) return false;
    if (/^(close|x|dismiss)$/i.test(text)) return false;
    if (passwordInput && /log\s*in|sign\s*in/i.test(text)) return false;
    return text.length > 0 || el.type === "submit";
  });

  // Action buttons that are operational triggers or creation actions
  const operationalButtons = actionButtons.filter((el) => {
    const t = `${el.text} ${el.name || ""} ${el.selector || ""}`.toLowerCase();
    return (
      /create|trigger|process|run|execute|dispatch|sync|export|download|quota|setting/i.test(t) &&
      !/^(search|filter|apply\s*filters?|clear|reset)$/i.test(el.text.trim())
    );
  });

  // Text inputs on the page (excluding search inputs)
  const formInputs = elements.filter(
    (el) =>
      ((el.tag === "input" && !["password", "hidden"].includes(el.type || "")) || el.tag === "textarea") &&
      !/search|filter|find|query|key/i.test(`${el.name || ""} ${el.placeholder || ""} ${el.text || ""}`),
  );

  const formSubmitButton = actionButtons.find((el) =>
    /save|create|add|new|submit|update|send/i.test(`${el.text} ${el.name || ""}`) || el.type === "submit",
  );

  if (operationalButtons.length > 0 && !passwordInput) {
    const buttonLabels = operationalButtons.map((b) => b.text.slice(0, 30));
    const formElements = [...formInputs, ...operationalButtons];
    functionalities.push({
      id: randomUUID(),
      projectId,
      name: `Action Controls & Operations (${buttonLabels.slice(0, 3).join(", ")}) on ${pagePath}`,
      category: "crud",
      pageUrl: page.url,
      pagePath,
      elements: formElements.length > 0 ? formElements : operationalButtons,
      interactionDetails: {
        submitSelector: operationalButtons[0].selector,
        inputSelectors: formInputs.map((el) => el.selector),
        actionButtons: operationalButtons.map((b) => ({ text: b.text, selector: b.selector })),
        actionType: "action_controls",
        headings,
      },
      status: "discovered",
    });
  } else if (formInputs.length > 0 && formSubmitButton && !passwordInput) {
    const formElements = [...formInputs, formSubmitButton];
    functionalities.push({
      id: randomUUID(),
      projectId,
      name: `Data Submission Form on ${pagePath}`,
      category: "crud",
      pageUrl: page.url,
      pagePath,
      elements: formElements,
      interactionDetails: {
        submitSelector: formSubmitButton.selector,
        inputSelectors: formInputs.map((el) => el.selector),
        actionType: "form_submission",
        headings,
      },
      status: "discovered",
    });
  }

  // 3. Identify Search & Filtering Controls
  const searchInputs = elements.filter(
    (el) =>
      el.tag === "input" &&
      /search|filter|find|query|key/i.test(`${el.name || ""} ${el.placeholder || ""} ${el.text || ""} ${el.type || ""}`),
  );
  const filterSelects = elements.filter(
    (el) =>
      el.tag === "select" ||
      (el.tag !== "button" && el.tag !== "input" && (
        Boolean(el.options && el.options.length > 0) ||
        (el.selector && /dropdown|select|filter|module|plan/i.test(el.selector))
      )),
  );
  const filterButtons = actionButtons.filter((el) =>
    /search|filter|apply|reset|clear/i.test(el.text || ""),
  );

  if (searchInputs.length > 0 || filterSelects.length > 0 || filterButtons.length > 0) {
    const seen = new Set<string>();
    const searchFilterElements: PageElement[] = [];
    for (const el of [...searchInputs, ...filterSelects, ...filterButtons]) {
      const key = el.selector || `${el.tag}:${el.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        searchFilterElements.push(el);
      }
    }

    const filterLabels = [
      ...searchInputs.map((i) => i.placeholder || i.name || "Search"),
      ...filterSelects.map((s) => s.placeholder || s.name || s.text || "Filter"),
      ...filterButtons.map((b) => b.text),
    ].filter(Boolean);

    functionalities.push({
      id: randomUUID(),
      projectId,
      name: `Search & Filtering Controls (${filterLabels.slice(0, 3).join(", ") || "Filters"}) on ${pagePath}`,
      category: "search_filter",
      pageUrl: page.url,
      pagePath,
      elements: searchFilterElements,
      interactionDetails: {
        inputSelectors: [...searchInputs, ...filterSelects].map((el) => el.selector),
        submitSelector: filterButtons.find((b) => /apply|search|filter/i.test(b.text))?.selector,
        actionType: "search_filter",
        headings,
      },
      status: "discovered",
    });
  }

  // 4. Identify Tab View Navigation
  const tabElements = elements.filter(
    (el) =>
      (el.selector && /tab|p-tabview/i.test(el.selector)) ||
      (el.tag === "button" && /tab/i.test(el.selector || "")) ||
      (el.selector && /views\s*settings|pickwave/i.test(`${el.text} ${el.selector}`)),
  );
  if (tabElements.length > 1) {
    const tabLabels = tabElements.map((t) => t.text).filter(Boolean);
    functionalities.push({
      id: randomUUID(),
      projectId,
      name: `Tab View Controls (${tabLabels.slice(0, 3).join(", ")}) on ${pagePath}`,
      category: "navigation",
      pageUrl: page.url,
      pagePath,
      elements: tabElements,
      interactionDetails: {
        tabs: tabElements.map((t) => ({ text: t.text, selector: t.selector })),
        actionType: "tab_navigation",
        headings,
      },
      status: "discovered",
    });
  }

  // 5. Identify Data Records & Tables
  const tableElements = elements.filter(
    (el) => el.tag === "table" || (el.selector && /table|datatable|grid/i.test(el.selector)),
  );
  const thElements = elements.filter(
    (el) => el.tag === "th" || (el.selector && /header|column/i.test(el.selector)),
  );
  if (tableElements.length > 0 || thElements.length > 0) {
    const columnHeaders = thElements.map((th) => th.text).filter(Boolean);
    functionalities.push({
      id: randomUUID(),
      projectId,
      name: `Data Records Table${columnHeaders.length > 0 ? ` (${columnHeaders.slice(0, 4).join(", ")})` : ""} on ${pagePath}`,
      category: "data_display",
      pageUrl: page.url,
      pagePath,
      elements: [...tableElements, ...thElements],
      interactionDetails: {
        columnHeaders,
        tableSelector: tableElements[0]?.selector,
        actionType: "data_table",
        headings,
      },
      status: "discovered",
    });
  }

  // 6. Identify In-Page Navigation / Non-layout Links (or general navigation if on dashboard/landing)
  const navLinks = elements.filter(
    (el) =>
      (el.tag === "a" && el.href) ||
      (el.tag === "button" && /tab|nav|menu|page/i.test(`${el.selector} ${el.text}`)),
  );
  const inPageLinks = navLinks.filter((el) => !isLayoutElement(el));
  const linksToUse = inPageLinks.length > 0 ? inPageLinks : navLinks;

  // Only add Navigation functionality if tabElements weren't already found (or if explicit inPageLinks exist)
  if (linksToUse.length > 0 && tabElements.length <= 1 && functionalities.filter(f => f.category === "navigation").length === 0) {
    functionalities.push({
      id: randomUUID(),
      projectId,
      name: `Navigation & Interactive Links on ${pagePath}`,
      category: "navigation",
      pageUrl: page.url,
      pagePath,
      elements: linksToUse.slice(0, 15),
      interactionDetails: {
        actionType: "navigation",
        headings,
      },
      status: "discovered",
    });
  }

  // 7. Default General Page Functionality if no specific sub-features matched
  if (functionalities.length === 0) {
    functionalities.push({
      id: randomUUID(),
      projectId,
      name: `Content & View Verification on ${pagePath}`,
      category: "data_display",
      pageUrl: page.url,
      pagePath,
      elements: elements.slice(0, 20),
      interactionDetails: {
        actionType: "page_display",
        headings,
      },
      status: "discovered",
    });
  }

  return functionalities;
}

/**
 * Plans a scenario checklist covering positive, negative, boundary, and edge-case
 * test scenarios for a given functionality.
 */
export function planScenariosForFunctionality(
  func: DiscoveredFunctionality,
): PlannedScenario[] {
  const scenarios: PlannedScenario[] = [];
  const elements = func.elements || [];

  switch (func.category) {
    case "authentication": {
      // Positive
      scenarios.push({
        scenarioId: generateScenarioId(func, "positive", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Valid credentials authentication on ${func.pagePath}`,
        description: `Verify user can log in with valid credentials and transition to the authenticated view.`,
        category: "positive",
        priority: "critical",
        expectedBehavior: `User is successfully authenticated and redirected away from login or sees dashboard.`,
        status: "planned",
      });

      // Negative
      scenarios.push({
        scenarioId: generateScenarioId(func, "negative", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Invalid password rejection on ${func.pagePath}`,
        description: `Verify login attempt with wrong password displays appropriate error message and does not authenticate.`,
        category: "negative",
        priority: "high",
        expectedBehavior: `Error notification is displayed and password field remains available.`,
        status: "planned",
      });

      scenarios.push({
        scenarioId: generateScenarioId(func, "negative", 2),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Empty fields submission validation on ${func.pagePath}`,
        description: `Verify submitting empty username or password triggers required field validation.`,
        category: "negative",
        priority: "medium",
        expectedBehavior: `Validation alert or inline error prompts user to fill required fields.`,
        status: "planned",
      });

      // Boundary
      scenarios.push({
        scenarioId: generateScenarioId(func, "boundary", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Maximum input length threshold on ${func.pagePath}`,
        description: `Verify username and password fields gracefully handle maximum allowed character lengths without crashing.`,
        category: "boundary",
        priority: "medium",
        expectedBehavior: `Input is bounded or rejected cleanly without unhandled server exception.`,
        status: "planned",
      });

      // Edge case
      scenarios.push({
        scenarioId: generateScenarioId(func, "edge_case", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Whitespace handling in credentials on ${func.pagePath}`,
        description: `Verify handling of leading and trailing spaces in email/username field.`,
        category: "edge_case",
        priority: "low",
        expectedBehavior: `Spaces are trimmed appropriately or validated with clear error message.`,
        status: "planned",
      });
      break;
    }

    case "search_filter": {
      const searchEl = elements.find(
        (el) =>
          el.tag === "input" &&
          /search|filter|find|query|key/i.test(`${el.name || ""} ${el.placeholder || ""} ${el.text || ""}`),
      );
      const searchLabel = searchEl?.placeholder || searchEl?.name || "search";

      const selectEl = elements.find(
        (el) => el.tag === "select" || Boolean(el.options && el.options.length > 0) || (el.selector && /dropdown|select/i.test(el.selector)),
      );
      const selectLabel = selectEl?.placeholder || selectEl?.name || selectEl?.text || "filter";

      const applyBtn = elements.find(
        (el) => (el.tag === "button" || el.type === "button") && /apply|search|filter/i.test(el.text || ""),
      );
      const clearBtn = elements.find(
        (el) => (el.tag === "button" || el.type === "button") && /clear|reset/i.test(el.text || ""),
      );

      // Positive 1: Query Search
      scenarios.push({
        scenarioId: generateScenarioId(func, "positive", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Filter records by query using "${searchLabel}" input on ${func.pagePath}`,
        description: `Verify entering a query into "${searchLabel}" and triggering filter renders matching records.`,
        category: "positive",
        priority: "high",
        expectedBehavior: `Matching items are rendered in the results list.`,
        status: "planned",
      });

      // Positive 2: Dropdown Filter or Apply Button
      if (selectEl) {
        scenarios.push({
          scenarioId: generateScenarioId(func, "positive", 2),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Filter records by category using "${selectLabel}" dropdown on ${func.pagePath}`,
          description: `Verify selecting an option from "${selectLabel}" updates table rows accordingly.`,
          category: "positive",
          priority: "medium",
          expectedBehavior: `Filtered items matching the selected dropdown criteria are displayed.`,
          status: "planned",
        });
      } else if (applyBtn) {
        scenarios.push({
          scenarioId: generateScenarioId(func, "positive", 2),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Apply filter criteria using "${applyBtn.text}" button on ${func.pagePath}`,
          description: `Verify clicking "${applyBtn.text}" applies all active filter fields to the results.`,
          category: "positive",
          priority: "medium",
          expectedBehavior: `Table results refresh to reflect active filter parameters.`,
          status: "planned",
        });
      }

      // Negative: Non-existent term
      scenarios.push({
        scenarioId: generateScenarioId(func, "negative", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Search with non-existent keyword using "${searchLabel}" on ${func.pagePath}`,
        description: `Verify searching for a non-existent item displays a friendly "no results found" message or empty table state.`,
        category: "negative",
        priority: "medium",
        expectedBehavior: `Empty state or "No matching records" feedback is displayed cleanly.`,
        status: "planned",
      });

      // Boundary: Single character search
      scenarios.push({
        scenarioId: generateScenarioId(func, "boundary", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Single-character search query boundary in "${searchLabel}" on ${func.pagePath}`,
        description: `Verify system handles single-character search or enforces minimum search length gracefully.`,
        category: "boundary",
        priority: "low",
        expectedBehavior: `System either filters results or informs user of minimum query length without errors.`,
        status: "planned",
      });

      // Edge case: Reset filter or special characters
      if (clearBtn) {
        scenarios.push({
          scenarioId: generateScenarioId(func, "edge_case", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Reset filter criteria using "${clearBtn.text}" button on ${func.pagePath}`,
          description: `Verify clicking "${clearBtn.text}" clears the filter inputs and restores the default table view.`,
          category: "edge_case",
          priority: "medium",
          expectedBehavior: `Filter fields are reset and full record list is re-rendered.`,
          status: "planned",
        });
      } else {
        scenarios.push({
          scenarioId: generateScenarioId(func, "edge_case", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Special characters and quotes in "${searchLabel}" query on ${func.pagePath}`,
          description: `Verify query containing punctuation, symbols, or quotes does not cause script errors or broken state.`,
          category: "edge_case",
          priority: "medium",
          expectedBehavior: `Search executes safely with sanitized input.`,
          status: "planned",
        });
      }
      break;
    }

    case "crud": {
      const actionButtons = elements.filter(
        (el) =>
          (el.tag === "button" || el.type === "submit" || el.type === "button") &&
          Boolean(el.text) &&
          !/^(close|x|dismiss)$/i.test(el.text.trim()),
      );
      const textInputs = elements.filter(
        (el) =>
          (el.tag === "input" && !["password", "hidden"].includes(el.type || "")) ||
          el.tag === "textarea",
      );

      const primaryBtn = actionButtons[0];
      const primaryBtnText = primaryBtn?.text?.slice(0, 30) || "Submit";
      const primaryInput = textInputs[0];
      const primaryInputName = primaryInput?.placeholder || primaryInput?.name || primaryInput?.text || "input field";

      // Positive 1: Primary action button or form submission
      let posTitle = `Successful form submission with valid data on ${func.pagePath}`;
      let posDesc = `Verify all required form fields can be filled and submitted successfully with confirmation.`;
      if (/create|add|new/i.test(primaryBtnText)) {
        posTitle = `Click "${primaryBtnText}" button to open creation dialog on ${func.pagePath}`;
        posDesc = `Verify clicking "${primaryBtnText}" (${primaryBtn?.selector || "button"}) opens the creation modal or form.`;
      } else if (/trigger|process|run|execute|dispatch|sync/i.test(primaryBtnText)) {
        posTitle = `Execute operational process using "${primaryBtnText}" button on ${func.pagePath}`;
        posDesc = `Verify clicking "${primaryBtnText}" (${primaryBtn?.selector || "button"}) triggers the operational action cleanly.`;
      } else if (primaryBtn) {
        posTitle = `Submit action using "${primaryBtnText}" button on ${func.pagePath}`;
        posDesc = `Verify clicking "${primaryBtnText}" (${primaryBtn?.selector || "button"}) executes with proper feedback.`;
      }

      scenarios.push({
        scenarioId: generateScenarioId(func, "positive", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: posTitle,
        description: posDesc,
        category: "positive",
        priority: "critical",
        expectedBehavior: `Action completes successfully and confirmation or updated state is rendered.`,
        status: "planned",
      });

      // Positive 2: Secondary action trigger if multiple distinct action buttons exist (e.g. Manual Trigger vs Process Due)
      if (actionButtons.length > 1) {
        const secondBtn = actionButtons[1];
        const secondBtnText = secondBtn.text.slice(0, 30);
        scenarios.push({
          scenarioId: generateScenarioId(func, "positive", 2),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Execute action using "${secondBtnText}" button on ${func.pagePath}`,
          description: `Verify clicking "${secondBtnText}" (${secondBtn.selector}) executes without errors.`,
          category: "positive",
          priority: "high",
          expectedBehavior: `Action triggers as expected and displays relevant status confirmation.`,
          status: "planned",
        });
      }

      // Negative: Missing required fields or invalid input
      let negTitle = `Missing required field validation on ${func.pagePath}`;
      let negDesc = `Verify submitting form without required inputs displays validation indicators and prevents submission.`;
      if (textInputs.length > 0 && primaryBtn) {
        negTitle = `Missing required field validation on form submission via "${primaryBtnText}" on ${func.pagePath}`;
        negDesc = `Verify submitting without required fields shows validation highlights and blocks submission.`;
      } else if (primaryBtn) {
        negTitle = `Verify disabled or unauthorized state handling for "${primaryBtnText}" button on ${func.pagePath}`;
        negDesc = `Verify "${primaryBtnText}" button handles edge conditions or unauthorized states gracefully.`;
      }

      scenarios.push({
        scenarioId: generateScenarioId(func, "negative", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: negTitle,
        description: negDesc,
        category: "negative",
        priority: "high",
        expectedBehavior: `Form submission is blocked and required fields or error indicators are displayed.`,
        status: "planned",
      });

      // Boundary: Character limits or rapid clicks
      let bndTitle = `Input field character limit boundary on ${func.pagePath}`;
      let bndDesc = `Verify entering boundary lengths (e.g. min/max characters) is handled correctly by form inputs.`;
      if (textInputs.length > 0) {
        bndTitle = `Input field character limit boundary on "${primaryInputName}" on ${func.pagePath}`;
        bndDesc = `Verify entering boundary lengths into "${primaryInputName}" respects constraints without truncation.`;
      } else if (primaryBtn) {
        bndTitle = `Rapid click boundary test on "${primaryBtnText}" button on ${func.pagePath}`;
        bndDesc = `Verify rapid successive clicks on "${primaryBtnText}" do not cause duplicate requests or race conditions.`;
      }

      scenarios.push({
        scenarioId: generateScenarioId(func, "boundary", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: bndTitle,
        description: bndDesc,
        category: "boundary",
        priority: "medium",
        expectedBehavior: `Input respects field constraints without overflow or duplicate actions.`,
        status: "planned",
      });

      // Edge case: Special characters or interaction feedback
      let edgTitle = `Unicode and special character inputs on ${func.pagePath}`;
      let edgDesc = `Verify form inputs accept and sanitize accented characters, emoji, and symbols.`;
      if (textInputs.length > 0) {
        edgTitle = `Unicode and special character inputs in "${primaryInputName}" on ${func.pagePath}`;
        edgDesc = `Verify "${primaryInputName}" handles accented characters, symbols, and whitespace correctly.`;
      } else if (primaryBtn) {
        edgTitle = `Interaction feedback and state update after clicking "${primaryBtnText}" on ${func.pagePath}`;
        edgDesc = `Verify clicking "${primaryBtnText}" provides visible visual feedback or status confirmation.`;
      }

      scenarios.push({
        scenarioId: generateScenarioId(func, "edge_case", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: edgTitle,
        description: edgDesc,
        category: "edge_case",
        priority: "low",
        expectedBehavior: `Values are stored and redisplayed correctly or visual status feedback is shown.`,
        status: "planned",
      });
      break;
    }

    case "navigation": {
      const tabs = elements.filter(
        (el) =>
          (el.selector && /tab/i.test(el.selector)) ||
          el.tag === "li" ||
          (el.tag === "button" && /tab/i.test(el.selector || "")),
      );

      if (tabs.length > 0) {
        const tab1 = tabs[0];
        const tab1Text = tab1.text.slice(0, 30) || "First Tab";

        // Positive 1: Tab 1 view
        scenarios.push({
          scenarioId: generateScenarioId(func, "positive", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Switch to "${tab1Text}" tab on ${func.pagePath}`,
          description: `Verify clicking "${tab1Text}" tab activates its tab panel and displays the associated view.`,
          category: "positive",
          priority: "high",
          expectedBehavior: `Tab view switches and displays settings for ${tab1Text}.`,
          status: "planned",
        });

        // Positive 2: Tab 2 view if multiple tabs
        if (tabs.length > 1) {
          const tab2 = tabs[1];
          const tab2Text = tab2.text.slice(0, 30) || "Second Tab";
          scenarios.push({
            scenarioId: generateScenarioId(func, "positive", 2),
            functionalityId: func.id,
            projectId: func.projectId,
            title: `Switch to "${tab2Text}" tab on ${func.pagePath}`,
            description: `Verify switching between tabs updates active tab content dynamically.`,
            category: "positive",
            priority: "medium",
            expectedBehavior: `Active tab content updates to ${tab2Text}.`,
            status: "planned",
          });
        }

        // Negative: Active tab state indicator
        scenarios.push({
          scenarioId: generateScenarioId(func, "negative", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Active tab indicator state validation on ${func.pagePath}`,
          description: `Verify active tab has selected/active styling and ARIA selected attribute.`,
          category: "negative",
          priority: "medium",
          expectedBehavior: `Current tab displays active styling and proper aria-selected attribute.`,
          status: "planned",
        });

        // Boundary: Tab switching state retention
        scenarios.push({
          scenarioId: generateScenarioId(func, "boundary", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Tab switching state retention on ${func.pagePath}`,
          description: `Verify switching between tabs retains state without page reload or loss of context.`,
          category: "boundary",
          priority: "low",
          expectedBehavior: `Tabs toggle instantly without reloading the page or losing entered state.`,
          status: "planned",
        });

        // Edge case: Keyboard navigation
        scenarios.push({
          scenarioId: generateScenarioId(func, "edge_case", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Keyboard navigation and accessibility for tabs on ${func.pagePath}`,
          description: `Verify tabs can be focused and traversed using keyboard controls.`,
          category: "edge_case",
          priority: "low",
          expectedBehavior: `Focus moves to tab elements with outline and activates on Enter/Space.`,
          status: "planned",
        });
      } else {
        const linkEl = elements.find((el) => el.tag === "a" && el.text);
        const linkText = linkEl?.text?.slice(0, 30) || "navigation link";

        // Positive
        scenarios.push({
          scenarioId: generateScenarioId(func, "positive", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Primary navigation route traversal to "${linkText}" on ${func.pagePath}`,
          description: `Verify clicking navigation link loads destination page successfully without 404 or broken view.`,
          category: "positive",
          priority: "high",
          expectedBehavior: `Destination route loads with expected header and status.`,
          status: "planned",
        });

        // Negative / Edge
        scenarios.push({
          scenarioId: generateScenarioId(func, "negative", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Active navigation state indicator for "${linkText}" on ${func.pagePath}`,
          description: `Verify active navigation item reflects current page location.`,
          category: "negative",
          priority: "medium",
          expectedBehavior: `Current nav link has active CSS class or aria-current attribute.`,
          status: "planned",
        });
      }
      break;
    }

    default: {
      const ths = elements.filter((el) => el.tag === "th" || (el.selector && /header|column/i.test(el.selector)));
      const cols = ths.map((th) => th.text).filter(Boolean);

      if (cols.length > 0) {
        // Table display verification
        scenarios.push({
          scenarioId: generateScenarioId(func, "positive", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Verify data table renders columns (${cols.slice(0, 4).join(", ")}) on ${func.pagePath}`,
          description: `Verify the data table renders expected column headers (${cols.join(", ")}) and loaded rows.`,
          category: "positive",
          priority: "high",
          expectedBehavior: `Data table renders headers and rows cleanly.`,
          status: "planned",
        });

        scenarios.push({
          scenarioId: generateScenarioId(func, "negative", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Empty state and error handling in data table on ${func.pagePath}`,
          description: `Verify table renders clear empty state feedback if zero records are returned.`,
          category: "negative",
          priority: "medium",
          expectedBehavior: `Empty state or "No records found" indicator is rendered.`,
          status: "planned",
        });

        scenarios.push({
          scenarioId: generateScenarioId(func, "boundary", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Pagination and row display limits on ${func.pagePath}`,
          description: `Verify table pagination controls, page sizing, and boundary row counts render correctly.`,
          category: "boundary",
          priority: "low",
          expectedBehavior: `Pagination controls update table slice without errors.`,
          status: "planned",
        });

        scenarios.push({
          scenarioId: generateScenarioId(func, "edge_case", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `Table column sort order and responsive layout on ${func.pagePath}`,
          description: `Verify table column headers respond to sorting and adapt cleanly to container width.`,
          category: "edge_case",
          priority: "low",
          expectedBehavior: `Table headers and cells remain aligned and readable.`,
          status: "planned",
        });
      } else {
        const isStaticOrEmpty = elements.length === 0;
        const reviewTag = isStaticOrEmpty ? "[QA Review Required: Static View] " : "";
        // Positive
        scenarios.push({
          scenarioId: generateScenarioId(func, "positive", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `${reviewTag}Key page content display verification on ${func.pagePath}`,
          description: isStaticOrEmpty
            ? `Static view check: no interactive form inputs or buttons were detected on ${func.pagePath}. Verify page loads and main container is present.`
            : `Verify primary page headings, text content, and main container elements load properly.`,
          category: "positive",
          priority: "medium",
          expectedBehavior: `Page renders expected headings and visible content.`,
          status: "planned",
        });

        // Negative
        scenarios.push({
          scenarioId: generateScenarioId(func, "negative", 1),
          functionalityId: func.id,
          projectId: func.projectId,
          title: `${reviewTag}No error notifications on initial view of ${func.pagePath}`,
          description: `Verify page loads cleanly without unexpected error alerts or broken layout states.`,
          category: "negative",
          priority: "medium",
          expectedBehavior: `No error banners, console exceptions, or 500 error alerts are present.`,
          status: "planned",
        });
      }
      break;
    }
  }

  return scenarios;
}

/**
 * Saves discovered functionalities and their planned scenarios to the database.
 */
export async function persistFunctionalitiesAndScenarios(
  projectId: string,
  functionalities: DiscoveredFunctionality[],
  scenarios: PlannedScenario[],
): Promise<{ savedFunctionalities: number; savedScenarios: number }> {
  let savedFunctionalities = 0;
  let savedScenarios = 0;

  for (const func of functionalities) {
    const res = await pool.query(
      `INSERT INTO functionality_inventory
         (id, project_id, name, category, page_url, page_path, elements, interaction_details, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name,
           elements = EXCLUDED.elements,
           interaction_details = EXCLUDED.interaction_details,
           updated_at = NOW()
       RETURNING id`,
      [
        func.id,
        projectId,
        func.name,
        func.category,
        func.pageUrl,
        func.pagePath,
        JSON.stringify(func.elements),
        JSON.stringify(func.interactionDetails),
        func.status,
      ],
    );
    if ((res.rowCount ?? 0) > 0) savedFunctionalities++;
  }

  for (const scen of scenarios) {
    const res = await pool.query(
      `INSERT INTO scenario_checklists
         (project_id, functionality_id, scenario_id, title, description, category, priority, expected_behavior, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (project_id, scenario_id) DO UPDATE
       SET functionality_id = EXCLUDED.functionality_id,
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           category = EXCLUDED.category,
           priority = EXCLUDED.priority,
           expected_behavior = EXCLUDED.expected_behavior,
           updated_at = NOW()
       RETURNING id`,
      [
        projectId,
        scen.functionalityId,
        scen.scenarioId,
        scen.title,
        scen.description,
        scen.category,
        scen.priority,
        scen.expectedBehavior,
        scen.status,
      ],
    );
    if ((res.rowCount ?? 0) > 0) savedScenarios++;
  }

  return { savedFunctionalities, savedScenarios };
}

/**
 * Retrieves all discovered functionalities for a project.
 */
export async function getProjectFunctionalities(
  projectId: string,
): Promise<DiscoveredFunctionality[]> {
  const res = await pool.query(
    `SELECT id, project_id AS "projectId", name, category, page_url AS "pageUrl",
            page_path AS "pagePath", elements, interaction_details AS "interactionDetails", status
     FROM functionality_inventory
     WHERE project_id = $1
     ORDER BY created_at ASC`,
    [projectId],
  );
  return res.rows;
}

/**
 * Retrieves planned scenarios for a project, optionally filtered by functionality or status.
 */
export async function getProjectScenarios(
  projectId: string,
  options: { functionalityId?: string; status?: string } = {},
): Promise<PlannedScenario[]> {
  let query = `
    SELECT id, project_id AS "projectId", functionality_id AS "functionalityId",
           scenario_id AS "scenarioId", title, description, category, priority,
           expected_behavior AS "expectedBehavior", status
    FROM scenario_checklists
    WHERE project_id = $1
  `;
  const params: unknown[] = [projectId];

  if (options.functionalityId) {
    params.push(options.functionalityId);
    query += ` AND functionality_id = $${params.length}`;
  }
  if (options.status) {
    params.push(options.status);
    query += ` AND status = $${params.length}`;
  }

  query += ` ORDER BY created_at ASC`;
  const res = await pool.query(query, params);
  return res.rows;
}

/**
 * Calculates deterministic coverage statistics comparing planned vs generated scenarios.
 */
export async function calculateCoverage(projectId: string): Promise<CoverageReport> {
  const funcsRes = await pool.query(
    `SELECT COUNT(*)::int AS total FROM functionality_inventory WHERE project_id = $1`,
    [projectId],
  );
  const totalFunctionalities = funcsRes.rows[0]?.total || 0;

  const scenariosRes = await pool.query<{
    category: "positive" | "negative" | "boundary" | "edge_case";
    status: "planned" | "generated" | "failed" | "skipped";
    count: number;
  }>(
    `SELECT sc.category,
            CASE WHEN sc.status = 'generated' AND tc.id IS NOT NULL THEN 'generated'
                 WHEN sc.status = 'failed' THEN 'failed'
                 WHEN sc.status = 'skipped' THEN 'skipped'
                 ELSE 'planned'
            END AS status,
            COUNT(*)::int AS count
     FROM scenario_checklists sc
     LEFT JOIN test_cases tc ON sc.test_case_id = tc.id
     WHERE sc.project_id = $1
     GROUP BY sc.category,
              CASE WHEN sc.status = 'generated' AND tc.id IS NOT NULL THEN 'generated'
                   WHEN sc.status = 'failed' THEN 'failed'
                   WHEN sc.status = 'skipped' THEN 'skipped'
                   ELSE 'planned'
              END`,
    [projectId],
  );

  const categories = ["positive", "negative", "boundary", "edge_case"] as const;
  const byCategory: CoverageReport["byCategory"] = {
    positive: { planned: 0, generated: 0, percent: 0 },
    negative: { planned: 0, generated: 0, percent: 0 },
    boundary: { planned: 0, generated: 0, percent: 0 },
    edge_case: { planned: 0, generated: 0, percent: 0 },
  };

  let totalScenariosPlanned = 0;
  let totalScenariosGenerated = 0;

  for (const row of scenariosRes.rows) {
    const cat = row.category;
    if (byCategory[cat]) {
      byCategory[cat].planned += row.count;
      totalScenariosPlanned += row.count;
      if (row.status === "generated") {
        byCategory[cat].generated += row.count;
        totalScenariosGenerated += row.count;
      }
    }
  }

  for (const cat of categories) {
    const planned = byCategory[cat].planned;
    const gen = byCategory[cat].generated;
    byCategory[cat].percent = planned > 0 ? Number(((gen / planned) * 100).toFixed(1)) : 0;
  }

  const overallCoveragePercent =
    totalScenariosPlanned > 0
      ? Number(((totalScenariosGenerated / totalScenariosPlanned) * 100).toFixed(1))
      : 0;

  return {
    projectId,
    totalFunctionalities,
    totalScenariosPlanned,
    totalScenariosGenerated,
    totalScenariosMissing: Math.max(0, totalScenariosPlanned - totalScenariosGenerated),
    overallCoveragePercent,
    byCategory,
  };
}

