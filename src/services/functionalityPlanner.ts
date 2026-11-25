import { createHash, randomUUID } from "node:crypto";
import { pool } from "../config/db";
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
  const headings = "headings" in page ? page.headings : [];
  const elements = page.elements || [];

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

  // 2. Identify Search & Filtering Controls
  const searchInput = elements.find(
    (el) =>
      el.tag === "input" &&
      (/search|filter|find|query/i.test(`${el.name || ""} ${el.placeholder || ""} ${el.type || ""}`)),
  );
  const filterSelects = elements.filter((el) => el.tag === "select");
  if (searchInput || filterSelects.length > 0) {
    const searchFilterElements = [
      ...(searchInput ? [searchInput] : []),
      ...filterSelects,
      ...elements.filter(
        (el) => el.tag === "button" && /search|filter|apply|reset|clear/i.test(el.text || ""),
      ),
    ];
    functionalities.push({
      id: randomUUID(),
      projectId,
      name: `Search & Filtering on ${pagePath}`,
      category: "search_filter",
      pageUrl: page.url,
      pagePath,
      elements: searchFilterElements,
      interactionDetails: {
        inputSelectors: searchFilterElements.map((el) => el.selector),
        actionType: "search_filter",
        headings,
      },
      status: "discovered",
    });
  }

  // 3. Identify Data Entry / CRUD Forms (excluding password auth forms handled above)
  const textInputs = elements.filter(
    (el) =>
      (el.tag === "input" && !["password", "hidden"].includes(el.type || "")) ||
      el.tag === "textarea",
  );
  const submitButton = elements.find(
    (el) =>
      (el.tag === "button" || el.type === "submit") &&
      /save|create|add|new|submit|update|send/i.test(el.text || el.name || ""),
  );

  if (textInputs.length > 0 && submitButton && !passwordInput) {
    const formElements = [...textInputs, submitButton];
    functionalities.push({
      id: randomUUID(),
      projectId,
      name: `Data Submission Form on ${pagePath}`,
      category: "crud",
      pageUrl: page.url,
      pagePath,
      elements: formElements,
      interactionDetails: {
        submitSelector: submitButton.selector,
        inputSelectors: textInputs.map((el) => el.selector),
        actionType: "form_submission",
        headings,
      },
      status: "discovered",
    });
  }

  // 4. Identify Navigation & Tab Switching
  const navLinks = elements.filter(
    (el) =>
      (el.tag === "a" && el.href) ||
      (el.tag === "button" && /tab|nav|menu|page/i.test(`${el.selector} ${el.text}`)),
  );
  if (navLinks.length > 0) {
    functionalities.push({
      id: randomUUID(),
      projectId,
      name: `Navigation & Interactive Links on ${pagePath}`,
      category: "navigation",
      pageUrl: page.url,
      pagePath,
      elements: navLinks.slice(0, 15),
      interactionDetails: {
        actionType: "navigation",
        headings,
      },
      status: "discovered",
    });
  }

  // 5. Default General Page Functionality if no specific sub-features matched
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
      // Positive
      scenarios.push({
        scenarioId: generateScenarioId(func, "positive", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Standard search with matching query on ${func.pagePath}`,
        description: `Verify searching with a valid existing term returns relevant matching records.`,
        category: "positive",
        priority: "high",
        expectedBehavior: `Matching items are rendered in the results list.`,
        status: "planned",
      });

      // Negative
      scenarios.push({
        scenarioId: generateScenarioId(func, "negative", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Search with non-existent keyword on ${func.pagePath}`,
        description: `Verify searching for a non-existent item displays a friendly "no results found" message.`,
        category: "negative",
        priority: "medium",
        expectedBehavior: `Empty state or "No matching records" feedback is displayed.`,
        status: "planned",
      });

      // Boundary
      scenarios.push({
        scenarioId: generateScenarioId(func, "boundary", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Single-character search query boundary on ${func.pagePath}`,
        description: `Verify system handles single-character search or enforces minimum search length.`,
        category: "boundary",
        priority: "low",
        expectedBehavior: `System either filters results or informs user of minimum query length.`,
        status: "planned",
      });

      // Edge case
      scenarios.push({
        scenarioId: generateScenarioId(func, "edge_case", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Special characters in search query on ${func.pagePath}`,
        description: `Verify query containing punctuation, symbols, or quotes does not cause script errors or broken state.`,
        category: "edge_case",
        priority: "medium",
        expectedBehavior: `Search executes safely with sanitized input.`,
        status: "planned",
      });
      break;
    }

    case "crud": {
      // Positive
      scenarios.push({
        scenarioId: generateScenarioId(func, "positive", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Successful form submission with valid data on ${func.pagePath}`,
        description: `Verify all required form fields can be filled and submitted successfully with confirmation.`,
        category: "positive",
        priority: "critical",
        expectedBehavior: `Data is saved and success confirmation or updated state is rendered.`,
        status: "planned",
      });

      // Negative
      scenarios.push({
        scenarioId: generateScenarioId(func, "negative", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Missing required field validation on ${func.pagePath}`,
        description: `Verify submitting form without required inputs displays validation indicators and prevents submission.`,
        category: "negative",
        priority: "high",
        expectedBehavior: `Form submission is blocked and required fields are highlighted.`,
        status: "planned",
      });

      // Boundary
      scenarios.push({
        scenarioId: generateScenarioId(func, "boundary", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Input field character limit boundary on ${func.pagePath}`,
        description: `Verify entering boundary lengths (e.g. min/max characters) is handled correctly by form inputs.`,
        category: "boundary",
        priority: "medium",
        expectedBehavior: `Input respects field constraints without overflow or truncation errors.`,
        status: "planned",
      });

      // Edge case
      scenarios.push({
        scenarioId: generateScenarioId(func, "edge_case", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Unicode and special character inputs on ${func.pagePath}`,
        description: `Verify form inputs accept and sanitize accented characters, emoji, and symbols.`,
        category: "edge_case",
        priority: "low",
        expectedBehavior: `Values are stored and redisplayed correctly without encoding corruption.`,
        status: "planned",
      });
      break;
    }

    case "navigation": {
      // Positive
      scenarios.push({
        scenarioId: generateScenarioId(func, "positive", 1),
        functionalityId: func.id,
        projectId: func.projectId,
        title: `Primary navigation route traversal on ${func.pagePath}`,
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
        title: `Active navigation state indicator on ${func.pagePath}`,
        description: `Verify active navigation item reflects current page location.`,
        category: "negative",
        priority: "medium",
        expectedBehavior: `Current nav link has active CSS class or aria-current attribute.`,
        status: "planned",
      });
      break;
    }

    default: {
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

