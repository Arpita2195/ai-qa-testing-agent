import { env } from "../config/env";
import { findLoginElements, readPage, savePageScreenshot, type PageData, type PageElement } from "../services/pageReader";
import { redactSecrets } from "../services/runner";

const apiUrl = "http://localhost:3000";
const headers = {
  "content-type": "application/json",
  "x-api-key": env.PLATFORM_API_KEY,
};

interface Project {
  id: string;
  name: string;
  base_url: string;
}

interface SavedCase {
  title: string;
  steps: string[];
  review_status: string;
}

async function api<T>(route: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${route}`, {
    ...init,
    headers: { ...headers, ...init?.headers },
  });
  if (!response.ok) throw new Error(`Platform API request failed (${response.status})`);
  return response.json() as Promise<T>;
}

function elementText(element: PageElement): string {
  return [element.text, element.name, element.placeholder].filter(Boolean).join(" ").toLowerCase();
}

function findLink(data: PageData, pattern: RegExp): PageElement | undefined {
  return data.elements.find((element) =>
    element.tag === "a" && pattern.test(`${elementText(element)} ${element.href ?? ""}`),
  );
}

function contentLine(data: PageData, excluded: string[] = []): string | undefined {
  return data.text.split(/\r?\n/).map((line) => line.trim()).find((line) =>
    line.length >= 3 &&
    !excluded.some((word) => line.toLowerCase().includes(word)) &&
    line.length <= 100,
  );
}

function formSubmit(data: PageData, pattern: RegExp): PageElement | undefined {
  return data.elements.find((element) =>
    ["button", "input"].includes(element.tag) &&
    (element.type === "submit" || pattern.test(elementText(element))),
  );
}

function inputValue(element: PageElement, index: number, productName: string): string {
  const details = `${element.name ?? ""} ${element.placeholder ?? ""}`.toLowerCase();
  if (/name|product/.test(details)) return productName;
  if (/sku|code/.test(details)) return `QA-${Date.now()}-${index}`;
  if (element.type === "number") return "1";
  if (element.type === "email") return `qa-${Date.now()}@example.invalid`;
  if (element.type === "url") return "https://example.invalid";
  if (element.type === "date") return "2030-01-01";
  return "QA pilot product";
}

async function reportLoginFailure(baseUrl: string, screenshotAlreadySaved = false): Promise<void> {
  if (!screenshotAlreadySaved) {
    try {
      await savePageScreenshot(baseUrl);
    } catch {
      console.error("Could not save a redacted login screenshot.");
    }
  }
  console.log("Login failed: check the test credentials in .env");
}

async function ensureProject(): Promise<Project> {
  const projects = await api<Project[]>("/projects");
  const existing = projects.find((project) => project.name === "StockFlow");
  if (existing) return existing;
  return api<Project>("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "StockFlow", base_url: env.STOCKFLOW_BASE_URL }),
  });
}

async function saveCase(projectId: string, title: string, steps: string[], expected: string): Promise<void> {
  const isReadOnly = !(/add\s+(?:a\s+new\s+)?product|creates?\s+data|edit|delete|update/i.test(title));
  await api(`/projects/${projectId}/test-cases`, {
    method: "POST",
    body: JSON.stringify({
      title,
      description: redactSecrets(expected),
      steps: steps.map((step) => redactSecrets(step)),
      expected_result: redactSecrets(expected),
      review_status: isReadOnly ? "approved" : "pending",
    }),
  });
}

export async function setupStockFlow(): Promise<void> {
  if (!env.STOCKFLOW_TEST_EMAIL || !env.STOCKFLOW_TEST_PASSWORD) {
    throw new Error("Missing STOCKFLOW_TEST_EMAIL or STOCKFLOW_TEST_PASSWORD in .env");
  }

  const project = await ensureProject();
  const currentCases = await api<SavedCase[]>(`/projects/${project.id}/test-cases`);
  const existingTitles = new Set(currentCases.map((testCase) => testCase.title));
  const discovered: Array<{ title: string; steps: string[]; expected: string }> = [];
  const missing: string[] = [];

  const login = await readPage(project.base_url);
  const loginElements = findLoginElements(login.elements);
  if (!loginElements) {
    await reportLoginFailure(project.base_url);
    return;
  }
  const { email, password, submit } = loginElements;

  const loginSteps = [
    `fill ${email.selector} | {{STOCKFLOW_TEST_EMAIL}}`,
    `fill ${password.selector} | {{STOCKFLOW_TEST_PASSWORD}}`,
    `click ${submit.selector}`,
  ];
  const authenticatedSteps = [...loginSteps, `expect not visible ${password.selector}`];
  let dashboard: PageData;
  try {
    dashboard = await readPage(project.base_url, authenticatedSteps);
  } catch {
    await reportLoginFailure(project.base_url);
    return;
  }
  if (dashboard.elements.some((element) => element.tag === "input" && element.type === "password")) {
    await reportLoginFailure(project.base_url);
    return;
  }

  const dashboardMarker = contentLine(dashboard, ["sign in", "log in", "password"]);
  if (!dashboardMarker) {
    missing.push("Dashboard: no visible text was available to assert after login.");
  } else {
    discovered.push({
      title: "Sign in and reach the dashboard",
      steps: [...authenticatedSteps, `expect text ${dashboardMarker}`],
      expected: `The dashboard displays "${dashboardMarker}".`,
    });
  }

  const inventoryLink = findLink(dashboard, /inventory|products/);
  const ordersLink = findLink(dashboard, /orders/);
  const inventorySteps = inventoryLink ? [...authenticatedSteps, `click ${inventoryLink.selector}`] : [];

  if (!inventoryLink) {
    missing.push("Inventory: no visible inventory or products navigation link was found.");
  } else {
    const inventory = await readPage(project.base_url, inventorySteps);
    const search = inventory.elements.find((element) =>
      element.tag === "input" &&
      /search|filter/.test(`${element.type ?? ""} ${elementText(element)}`),
    );
    const searchableLine = contentLine(inventory, ["inventory", "search", "filter"]);
    if (!search || !searchableLine) {
      missing.push("Inventory search: no visible search field or product text was found.");
    } else {
      discovered.push({
        title: "View inventory and search or filter",
        steps: [...inventorySteps, `fill ${search.selector} | ${searchableLine}`, `expect text ${searchableLine}`],
        expected: "Inventory search retains the matching visible product.",
      });
    }

    const addLink = findLink(inventory, /add product|new product|create product/);
    const addButton = addLink ?? formSubmit(inventory, /add product|new product|create product/);
    if (!addButton) {
      missing.push("Add product: no visible add/new product action was found on the inventory page.");
    } else {
      const formSteps = [...inventorySteps, `click ${addButton.selector}`];
      const form = await readPage(project.base_url, formSteps);
      const requiredFields = form.elements.filter((element) =>
        ["input", "select", "textarea"].includes(element.tag) && element.required && element.type !== "password",
      );
      const productField = requiredFields.find((element) => /product|name/.test(elementText(element)));
      const save = formSubmit(form, /add|save|create|submit/);
      if (!productField || !save) {
        missing.push("Add product: the required product-name field or a save action could not be discovered.");
      } else {
        const productName = `QA Pilot Product ${Date.now()}`;
        const validSteps = [...formSteps];
        requiredFields.forEach((field, index) => {
          if (field.tag === "select") {
            const option = field.options?.find((candidate) => candidate.value && candidate.text);
            if (option) validSteps.push(`select ${field.selector} | ${option.value}`);
          } else {
            validSteps.push(`fill ${field.selector} | ${inputValue(field, index, productName)}`);
          }
        });
        validSteps.push(`click ${save.selector}`, `expect text ${productName}`);
        discovered.push({
          title: "Add product (creates data, needs cleanup)",
          steps: validSteps,
          expected: `The product "${productName}" appears after saving.`,
        });

        const firstRequired = requiredFields[0];
        const validationBefore = form.text;
        const validation = await readPage(project.base_url, [...formSteps, `click ${save.selector}`]);
        const visibleError = validation.text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find((line) => line.length >= 3 && !validationBefore.includes(line));
        const validationSteps = [...formSteps, `click ${save.selector}`, `expect invalid ${firstRequired.selector}`];
        if (visibleError) validationSteps.push(`expect text ${visibleError}`);
        discovered.push({
          title: "Submit the add product form with empty required fields",
          steps: validationSteps,
          expected: visibleError
            ? `The form shows "${visibleError}" and the required field is invalid.`
            : "The required field is invalid and the form does not submit.",
        });
      }
    }
  }

  if (!ordersLink) {
    missing.push("Orders: no visible orders navigation link was found.");
  } else {
    const orderSteps = [...authenticatedSteps, `click ${ordersLink.selector}`];
    const orders = await readPage(project.base_url, orderSteps);
    const orderLink = orders.elements.find((element) =>
      element.tag === "a" && Boolean(element.href) && !/orders|create|new/.test(elementText(element)),
    );
    if (!orderLink) {
      missing.push("Orders: no visible order link with a destination was found.");
    } else {
      const details = await readPage(project.base_url, [...orderSteps, `click ${orderLink.selector}`]);
      const detailMarker = contentLine(details, ["orders", "back"]);
      if (!detailMarker) {
        missing.push("Order details: no visible detail text was found after opening an order.");
      } else {
        discovered.push({
          title: "View orders and open one order",
          steps: [...orderSteps, `click ${orderLink.selector}`, `expect text ${detailMarker}`],
          expected: `An order detail page displays "${detailMarker}".`,
        });
      }
    }
  }

  for (const testCase of discovered) {
    if (!existingTitles.has(testCase.title)) {
      await saveCase(project.id, testCase.title, testCase.steps, testCase.expected);
    }
  }
  const saved = await api<SavedCase[]>(`/projects/${project.id}/test-cases`);
  const selected = saved.filter((testCase) =>
    discovered.some((candidate) => candidate.title === testCase.title),
  );
  console.log(`StockFlow project ready: ${project.name}`);
  for (const testCase of selected) {
    console.log(`${testCase.title} | ${testCase.steps.length} steps | ${testCase.review_status}`);
  }
  for (const note of missing) console.log(`Skipped: ${note}`);
}

if (require.main === module) {
  void setupStockFlow().catch((error: unknown) => {
    console.error(`StockFlow setup failed: ${redactSecrets(error instanceof Error ? error.message : "Unexpected error")}`);
    process.exitCode = 1;
  });
}
