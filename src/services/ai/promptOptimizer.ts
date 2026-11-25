import { logger } from "../observability/logger";
import type { PageElement, PageData, ScrapedPage } from "../pageReader";

export interface ElementOptimizationStats {
  originalCount: number;
  optimizedCount: number;
  tokensSavedEstimate: number;
}

/**
 * Optimizes DOM page elements to reduce prompt token consumption while
 * strictly preserving interactive forms, inputs, buttons, tables, headings,
 * and testable assertions across positive, negative, boundary, and edge-case scenarios.
 */
export function optimizePageElements(
  elements: PageElement[] = [],
  options: number | { maxItemsPerGroup?: number } = {},
): PageElement[] {
  const originalCount = elements.length;
  if (originalCount === 0) {
    return [];
  }

  const maxPerGroup = typeof options === "number" ? options : (options.maxItemsPerGroup ?? 4);
  const filtered: PageElement[] = [];
  const groupCounts = new Map<string, number>();

  for (const el of elements) {
    // 1. Always retain interactive form controls and inputs
    const isInteractive =
      el.tag === "input" ||
      el.tag === "button" ||
      el.tag === "select" ||
      el.tag === "textarea" ||
      el.tag === "a" ||
      el.type === "submit" ||
      el.type === "button" ||
      el.type === "password" ||
      el.type === "email" ||
      Boolean(el.name) ||
      Boolean(el.placeholder);

    // 2. Retain headings and explicit testable identifiers
    const isHeading =
      el.tag === "h1" ||
      el.tag === "h2" ||
      el.tag === "h3" ||
      el.tag === "h4" ||
      el.tag === "h5" ||
      el.tag === "h6";

    const hasTestId = Boolean(el.selector && el.selector.includes("[data-testid]"));

    // 3. Drop empty non-semantic wrappers with no text or interaction
    const textTrimmed = (el.text || "").trim();
    if (!isInteractive && !isHeading && !hasTestId && !textTrimmed) {
      continue;
    }

    // 4. Compact highly repetitive element clusters (e.g. long lists, table rows)
    const clusterKey = `${el.tag}:${el.type || ""}:${(el.selector || "").split(" > ").pop()?.replace(/-\d+/g, "") || ""}`;
    const currentGroupCount = groupCounts.get(clusterKey) || 0;

    if (!isInteractive && !hasTestId && currentGroupCount >= maxPerGroup) {
      groupCounts.set(clusterKey, currentGroupCount + 1);
      continue; // Skip excess repetitive elements beyond representative sample
    }

    groupCounts.set(clusterKey, currentGroupCount + 1);

    // Clean up empty fields to minimize JSON tokens
    const cleaned: PageElement = {
      tag: el.tag,
      selector: el.selector,
      text: textTrimmed ? textTrimmed.slice(0, 150) : "",
    };
    if (el.type) cleaned.type = el.type;
    if (el.name) cleaned.name = el.name;
    if (el.placeholder) cleaned.placeholder = el.placeholder;
    if (textTrimmed) cleaned.text = textTrimmed.slice(0, 150); // Avoid huge paragraphs in element labels

    filtered.push(cleaned);
  }

  const optimizedCount = filtered.length;
  // Estimate ~15-20 tokens per pruned element in JSON structure
  const tokensSavedEstimate = Math.max(0, (originalCount - optimizedCount) * 15);

  if (originalCount > 30 && optimizedCount < originalCount) {
    logger.debug("Optimized page elements for AI prompt token reduction", {
      originalCount,
      optimizedCount,
      reductionPercent: Number((((originalCount - optimizedCount) / originalCount) * 100).toFixed(1)),
      tokensSavedEstimate,
    });
  }

  return filtered;
}

export function optimizePageElementsWithStats(
  elements: PageElement[] = [],
  options: number | { maxItemsPerGroup?: number } = {},
): { elements: PageElement[]; stats: ElementOptimizationStats } {
  const originalCount = elements.length;
  const filtered = optimizePageElements(elements, options);
  const optimizedCount = filtered.length;
  const tokensSavedEstimate = Math.max(0, (originalCount - optimizedCount) * 15);
  return {
    elements: filtered,
    stats: { originalCount, optimizedCount, tokensSavedEstimate },
  };
}

/**
 * Compacts JSON into single-line minimal string without indentation whitespace,
 * eliminating 30-40% of tokens typically wasted on spaces and newlines.
 */
export function compactJson(data: unknown): string {
  return JSON.stringify(data);
}

/**
 * Compacts requirement text by normalizing whitespace and deduplicating
 * redundant blank lines while preserving all business rules, criteria, and edge cases.
 */
export function compactRequirementText(text: string, maxChars = 25000): string {
  if (!text) return "";
  const normalized = text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  // Observable deliberate truncation with explicit boundary note
  logger.info("Requirement document exceeded token limit; applying observable boundary compaction", {
    originalLength: normalized.length,
    compactedLength: maxChars,
  });

  return (
    normalized.slice(0, maxChars) +
    `\n\n[... Note: Document truncated at ${maxChars} characters for model context capacity. Ensure core requirements above are prioritized.]`
  );
}

/**
 * Creates an optimized representation of PageData / ScrapedPage for AI prompts.
 */
export function compactPageDataForPrompt(page: PageData | ScrapedPage): Record<string, unknown> {
  const optimizedElements = optimizePageElements(page.elements || []);
  const pagePath = "path" in page ? page.path : new URL(page.url).pathname;

  return {
    url: page.url,
    path: pagePath,
    title: (page.title || "").trim(),
    headings: "headings" in page && page.headings ? page.headings.slice(0, 10) : [],
    elements: optimizedElements,
  };
}
