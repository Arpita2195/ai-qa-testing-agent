import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { assertTargetUrlAllowed, attachUrlGuardToPage } from "./urlGuard";

export interface VisualCheck {
  id: string;
  path: string;
  viewport_width: number;
  viewport_height: number;
  threshold: number | string;
}

export interface VisualBaseline {
  id: string;
  image_path: string;
}

export interface VisualRunResult {
  status: "passed" | "failed" | "baseline_created";
  diffRatio: number | null;
  screenshotPath: string;
  diffPath: string | null;
  errorMessage: string | null;
  baselinePath: string | null;
  baselineStatus?: "pending";
}

export function createBaselineResult(screenshotPath: string): VisualRunResult {
  return {
    status: "baseline_created",
    diffRatio: null,
    screenshotPath,
    diffPath: null,
    errorMessage: null,
    baselinePath: screenshotPath,
    baselineStatus: "pending",
  };
}

export function comparePngBuffers(
  currentBuffer: Buffer,
  baselineBuffer: Buffer,
  threshold: number,
): { status: "passed" | "failed"; diffRatio: number; diffBuffer?: Buffer; errorMessage?: string } {
  const current = PNG.sync.read(currentBuffer);
  const baseline = PNG.sync.read(baselineBuffer);
  if (current.width !== baseline.width || current.height !== baseline.height) {
    return {
      status: "failed",
      diffRatio: 1,
      errorMessage: `Image size mismatch: current ${current.width}x${current.height}, baseline ${baseline.width}x${baseline.height}`,
    };
  }
  const diff = new PNG({ width: current.width, height: current.height });
  const differingPixels = pixelmatch(
    current.data,
    baseline.data,
    diff.data,
    current.width,
    current.height,
    { threshold: 0.1 },
  );
  const diffRatio = differingPixels / (current.width * current.height);
  return {
    status: diffRatio > threshold ? "failed" : "passed",
    diffRatio,
    diffBuffer: PNG.sync.write(diff),
  };
}

function resolveArtifactPath(imagePath: string): string {
  const filename = path.basename(imagePath);
  if (
    filename !== imagePath &&
    imagePath !== path.join("artifacts", filename) &&
    imagePath !== `artifacts/${filename}`
  ) {
    throw new Error("Baseline image path must be an artifact filename");
  }
  if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new Error("Baseline image path must be an artifact filename");
  }
  return path.resolve(__dirname, "../../artifacts", filename);
}

export async function runVisualCheck(
  baseUrl: string,
  check: VisualCheck,
  baseline: VisualBaseline | null,
): Promise<VisualRunResult> {
  const artifactsDirectory = path.resolve(__dirname, "../../artifacts");
  await mkdir(artifactsDirectory, { recursive: true });
  const screenshotName = `visual-${check.id}-${randomUUID()}.png`;
  const screenshotPath = path.join(artifactsDirectory, screenshotName);
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: { width: check.viewport_width, height: check.viewport_height },
    });
    const url = new URL(check.path, baseUrl);
    await assertTargetUrlAllowed(url.toString());
    attachUrlGuardToPage(page);
    await page.goto(url.toString(), { waitUntil: "load" });
    await page.screenshot({ path: screenshotPath, fullPage: true });
    const relativeScreenshotPath = path.join("artifacts", screenshotName);

    if (!baseline) {
      return createBaselineResult(relativeScreenshotPath);
    }

    let comparison: ReturnType<typeof comparePngBuffers>;
    try {
      const baselineBuffer = await readFile(resolveArtifactPath(baseline.image_path));
      const currentBuffer = await readFile(screenshotPath);
      comparison = comparePngBuffers(
        currentBuffer,
        baselineBuffer,
        Number(check.threshold),
      );
    } catch (error) {
      return {
        status: "failed",
        diffRatio: null,
        screenshotPath: relativeScreenshotPath,
        diffPath: null,
        errorMessage: `Visual comparison failed: ${error instanceof Error ? error.message : String(error)}`,
        baselinePath: null,
      };
    }

    let diffPath: string | null = null;
    if (comparison.diffBuffer) {
      const diffName = `visual-diff-${check.id}-${randomUUID()}.png`;
      await writeFile(path.join(artifactsDirectory, diffName), comparison.diffBuffer);
      diffPath = path.join("artifacts", diffName);
    }

    return {
      status: comparison.status,
      diffRatio: comparison.diffRatio,
      screenshotPath: relativeScreenshotPath,
      diffPath,
      errorMessage: comparison.errorMessage ?? null,
      baselinePath: null,
    };
  } finally {
    await browser.close();
  }
}
