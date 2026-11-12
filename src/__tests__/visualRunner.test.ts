import { beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";

const visualMocks = vi.hoisted(() => ({
  launch: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
  goto: vi.fn(),
  screenshot: vi.fn(),
  setViewportSize: vi.fn(),
  close: vi.fn(),
  setupAuthenticatedBrowser: vi.fn(),
  assertTargetUrlAllowed: vi.fn(),
  attachUrlGuardToPage: vi.fn(),
}));

vi.mock("@playwright/test", () => ({
  chromium: { launch: visualMocks.launch },
}));

vi.mock("../services/storage/storageService", () => ({
  storageService: {
    upload: visualMocks.upload,
    download: visualMocks.download,
  },
}));

vi.mock("../services/urlGuard", () => ({
  assertTargetUrlAllowed: visualMocks.assertTargetUrlAllowed,
  attachUrlGuardToPage: visualMocks.attachUrlGuardToPage,
}));

vi.mock("../services/appAuth", () => ({
  setupAuthenticatedBrowser: visualMocks.setupAuthenticatedBrowser,
}));

import { comparePngBuffers, createBaselineResult, runVisualCheck } from "../services/visualRunner";

const baseUrl = "https://example.test";
const navigationSelector =
  "nav a, nav button, aside a, aside button, [role='navigation'] a, [role='navigation'] button, [role='menuitem']";

function createPage(initialPage: string, navigationPages: string[] = []) {
  const state = {
    url: baseUrl,
    title: initialPage,
    heading: initialPage,
    mainText: `${initialPage} content`,
  };
  const pageRoutes = new Map(
    navigationPages.map((name) => [
      name,
      {
        url: `${baseUrl}/${name.toLowerCase().replace(/ /g, "-")}`,
        title: name,
        heading: name,
        mainText: `${name} page content`,
      },
    ]),
  );
  const navItems = navigationPages.map((label) => ({ label, href: `/${label.toLowerCase().replace(/ /g, "-")}` }));
  const locator = (selector: string) => ({
    waitFor: vi.fn().mockResolvedValue(undefined),
    innerText: vi.fn(async () => state.mainText),
    count: vi.fn(async () => selector.startsWith("main,") ? 1 : 0),
    evaluateAll: vi.fn(async () => {
      if (selector === navigationSelector || selector === "a, button, [role='link'], [role='menuitem']") {
        return navItems.map((item, index) => ({
          index,
          label: item.label,
          innerText: item.label,
          getAttribute: (attribute: string) => attribute === "href" ? item.href : null,
          getClientRects: () => [1],
        }));
      }
      if (selector === "h1, h2, [role='heading']") return [state.heading];
      if (selector === "main, [role='main']") return [state.mainText];
      return [];
    }),
    first() {
      return this;
    },
    nth(index: number) {
      return {
        click: vi.fn(async () => {
          const route = pageRoutes.get(navItems[index]?.label);
          if (route) Object.assign(state, route);
        }),
        waitFor: vi.fn().mockResolvedValue(undefined),
      };
    },
  });
  return {
    state,
    page: {
      url: () => state.url,
      title: async () => state.title,
      locator,
      goto: async (url: string, options: unknown) => {
        await visualMocks.goto(url, options);
        state.url = url;
      },
      screenshot: visualMocks.screenshot,
      setViewportSize: visualMocks.setViewportSize,
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function png(width: number, height: number, color: [number, number, number, number]): Buffer {
  const image = new PNG({ width, height });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = color[0];
    image.data[index + 1] = color[1];
    image.data[index + 2] = color[2];
    image.data[index + 3] = color[3];
  }
  return PNG.sync.write(image);
}

describe("visual comparison", () => {
  let activePage: ReturnType<typeof createPage>;

  beforeEach(() => {
    vi.clearAllMocks();
    visualMocks.assertTargetUrlAllowed.mockResolvedValue(undefined);
    visualMocks.attachUrlGuardToPage.mockImplementation(() => undefined);
    visualMocks.setViewportSize.mockResolvedValue(undefined);
    visualMocks.upload.mockResolvedValue({ key: "visual/test.png", sizeBytes: 16, provider: "local", location: "" });
    visualMocks.close.mockResolvedValue(undefined);
    visualMocks.screenshot.mockImplementation(async () => Buffer.from(activePage.state.heading));
    activePage = createPage("Check");
    visualMocks.setupAuthenticatedBrowser.mockImplementation(async () => ({
      context: { close: vi.fn() },
      page: activePage.page,
      isLoggedIn: true,
      loginSteps: [],
      usedSession: true,
    }));
    visualMocks.launch.mockResolvedValue({
      newContext: vi.fn(async () => ({ newPage: async () => activePage.page })),
      close: visualMocks.close,
    });
  });

  it("passes identical images", () => {
    const image = png(4, 4, [0, 0, 0, 255]);
    expect(comparePngBuffers(image, image, 0.01).status).toBe("passed");
  });

  it("fails when differing pixels exceed the threshold", () => {
    const dark = png(4, 4, [0, 0, 0, 255]);
    const light = png(4, 4, [255, 255, 255, 255]);
    expect(comparePngBuffers(dark, light, 0.01)).toMatchObject({ status: "failed", diffRatio: 1 });
  });

  it("fails with a clear image-size mismatch", () => {
    const result = comparePngBuffers(png(4, 4, [0, 0, 0, 255]), png(2, 4, [0, 0, 0, 255]), 0.5);
    expect(result.status).toBe("failed");
    expect(result.errorMessage).toContain("Image size mismatch");
  });

  it("returns a pending baseline result when none exists", () => {
    expect(createBaselineResult("artifacts/visual.png")).toMatchObject({
      status: "baseline_created",
      baselinePath: "artifacts/visual.png",
      baselineStatus: "pending",
    });
  });

  it("does not save a screenshot when the requested page cannot be reached", async () => {
    visualMocks.goto.mockRejectedValue(new Error("Navigation timeout"));

    const result = await runVisualCheck(
      baseUrl,
      "project-id",
      { id: "check-id", name: "Check", path: "/check", viewport_width: 1280, viewport_height: 720, threshold: 0.01 },
      null,
    );

    expect(visualMocks.setupAuthenticatedBrowser).toHaveBeenCalledWith(
      expect.anything(),
      "project-id",
      baseUrl,
    );
    expect(visualMocks.setViewportSize).toHaveBeenCalledWith({ width: 1280, height: 720 });
    expect(result.status).toBe("failed");
    expect(result.screenshotPath).toBeNull();
    expect(result.errorMessage).toContain("Navigation timeout");
    expect(visualMocks.upload).not.toHaveBeenCalled();
  });

  it("loads visual baselines from artifact storage for comparisons", async () => {
    const screenshot = png(4, 4, [0, 0, 0, 255]);
    visualMocks.screenshot.mockResolvedValue(screenshot);
    visualMocks.goto.mockResolvedValue(undefined);
    visualMocks.download.mockResolvedValue({ buffer: screenshot, contentType: "image/png" });

    const result = await runVisualCheck(
      baseUrl,
      "project-id",
      { id: "check-id", name: "Check", path: "/check", viewport_width: 1280, viewport_height: 720, threshold: 0.01 },
      { id: "baseline-id", image_path: "visual/approved.png" },
    );

    expect(result.status).toBe("passed");
    expect(visualMocks.download).toHaveBeenCalledWith("visual/approved.png");
  });

  it.each(["AI Chat", "Dashboard", "User Management"])(
    "navigates to and captures the requested %s page",
    async (pageName) => {
      activePage = createPage("Welcome", ["AI Chat", "Dashboard", "User Management"]);
      visualMocks.screenshot.mockImplementation(async () => Buffer.from(activePage.state.heading));

      const result = await runVisualCheck(
        baseUrl,
        "project-id",
        { id: pageName.toLowerCase().replace(/ /g, "-"), name: pageName, path: "/", viewport_width: 1280, viewport_height: 720, threshold: 0.01 },
        null,
      );

      expect(result.status).toBe("baseline_created");
      expect(activePage.state.heading).toBe(pageName);
      expect(visualMocks.upload).toHaveBeenCalledWith(
        result.screenshotPath,
        Buffer.from(pageName),
        "image/png",
      );
    },
  );

  it("reports an unavailable page without saving a screenshot", async () => {
    activePage = createPage("Welcome", ["AI Chat"]);

    const result = await runVisualCheck(
      baseUrl,
      "project-id",
      { id: "missing-page", name: "Products", path: "/", viewport_width: 1280, viewport_height: 720, threshold: 0.01 },
      null,
    );

    expect(result.status).toBe("failed");
    expect(result.screenshotPath).toBeNull();
    expect(result.errorMessage).toContain('Requested page "Products" was not found');
    expect(result.errorMessage).toContain("AI Chat");
    expect(visualMocks.upload).not.toHaveBeenCalled();
  });

  it("captures the login page without applying the saved login session", async () => {
    activePage = createPage("Sign In");

    const result = await runVisualCheck(
      baseUrl,
      "project-id",
      { id: "login", name: "Login", path: "/", viewport_width: 1280, viewport_height: 720, threshold: 0.01 },
      null,
    );

    expect(result.status).toBe("baseline_created");
    expect(visualMocks.setupAuthenticatedBrowser).not.toHaveBeenCalled();
    expect(visualMocks.upload).toHaveBeenCalledWith(
      result.screenshotPath,
      Buffer.from("Sign In"),
      "image/png",
    );
  });
});
