import { chromium } from "@playwright/test";

export interface PageElement {
  tag: string;
  text: string;
  selector: string;
}

export interface PageData {
  title: string;
  url: string;
  text: string;
  elements: PageElement[];
}

export async function readPage(url: string): Promise<PageData> {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    return await page.evaluate<PageData>(`(() => {
      function visible(element) {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.visibility !== "hidden" &&
          style.display !== "none" &&
          rect.width > 0 &&
          rect.height > 0
        );
      }

      function selectorFor(element) {
        if (element instanceof HTMLElement && element.id) {
          const idSelector = "#" + CSS.escape(element.id);
          if (document.querySelectorAll(idSelector).length === 1) {
            return idSelector;
          }
        }

        const parts = [];
        let current = element;
        while (current && current !== document.documentElement) {
          const tagName = current.tagName.toLowerCase();
          const siblings = current.parentElement
            ? Array.from(current.parentElement.children).filter(
                (sibling) => sibling.tagName === current.tagName,
              )
            : [];
          const index = siblings.indexOf(current) + 1;
          parts.unshift(tagName + ":nth-of-type(" + index + ")");
          current = current.parentElement;
        }

        return parts.join(" > ");
      }

      const elements = Array.from(
        document.querySelectorAll("a, button, input, form"),
      )
        .filter(visible)
        .slice(0, 40)
        .map((element) => {
          const tag = element.tagName.toLowerCase();
          const text =
            element.textContent?.trim() ||
            element.getAttribute("placeholder") ||
            element.getAttribute("name") ||
            "";
          return { tag, text, selector: selectorFor(element) };
        });

      return {
        title: document.title,
        url: window.location.href,
        text: (document.body?.innerText ?? "").trim().slice(0, 4000),
        elements,
      };
    })()`);
  } finally {
    await browser.close();
  }
}
