// Opens a pad on a phone-sized screen in Cloudflare Browser Rendering and reports what a reader would hit.

const PHONE = { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const MIN_TEXT_PX = 12;
const MIN_TAP_PX = 24;

export type CheckReport = { url: string; width: number; problems: string[] };

// Runs inside the page, so it can only use what the browser has. The Scrawl footer is not the author's to fix.
function measure(minText: number, minTap: number) {
  const width = document.documentElement.clientWidth;
  const footer = document.querySelector("[data-scrawl-footer]");
  const shown = [...document.body.querySelectorAll<HTMLElement>("*")].filter((el) => {
    if (footer?.contains(el)) return false;
    const box = el.getBoundingClientRect();
    return box.width > 0 && box.height > 0 && getComputedStyle(el).visibility !== "hidden";
  });
  const name = (el: Element) => `<${el.tagName.toLowerCase()}> "${(el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40)}"`;
  const sample = (els: Element[], text: (el: Element) => string = name) => els.slice(0, 3).map(text).join(", ");
  const problems: string[] = [];

  if (document.documentElement.scrollWidth > width + 1) {
    // The innermost elements that stick out, not every ancestor around them.
    const wide = shown.filter((el) => el.getBoundingClientRect().right > width + 1 && ![...el.children].some((child) => child.getBoundingClientRect().right > width + 1));
    problems.push(`The page scrolls sideways on a ${width}px phone. Wider than the screen: ${sample(wide)}.`);
  }
  const small = shown.filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim()) && parseFloat(getComputedStyle(el).fontSize) < minText);
  if (small.length) problems.push(`${small.length} text elements under ${minText}px: ${sample(small, (el) => `${name(el)} at ${getComputedStyle(el).fontSize}`)}.`);
  const taps = shown.filter((el) => el.matches("a, button, select, summary, [role=button], input:not([type=checkbox]):not([type=radio])") && getComputedStyle(el).display !== "inline" && el.getBoundingClientRect().height < minTap);
  if (taps.length) problems.push(`${taps.length} buttons or links under ${minTap}px high, hard to tap: ${sample(taps)}.`);
  const broken = [...document.images].filter((img) => img.complete && img.naturalWidth === 0);
  if (broken.length) problems.push(`${broken.length} images do not load: ${broken.slice(0, 3).map((img) => img.src).join(", ")}.`);
  return { width, problems };
}

export async function checkPad(browserBinding: Fetcher, url: string, withScreenshot: boolean): Promise<CheckReport & { screenshot?: Uint8Array<ArrayBuffer> }> {
  // Loaded here so the Bun runtime, which has no browser, never imports it.
  const { default: puppeteer } = await import("@cloudflare/puppeteer");
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setViewport(PHONE);
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(`Script error: ${(err as Error).message}`));
    // Images that fail are reported by measure(), and the browser logs each failed load once more.
    page.on("console", (msg) => msg.type() === "error" && !msg.text().startsWith("Failed to load resource") && errors.push(`Console error: ${msg.text().trim()}`));
    page.on("requestfailed", (req) => req.resourceType() !== "image" && errors.push(`Could not load ${req.url()} (${req.failure()?.errorText ?? "failed"})`));
    await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
    // scrawl.js shows the page once Tailwind has styled it.
    await page.waitForFunction(() => !document.querySelector('script[src="/scrawl.js"]') || document.documentElement.classList.contains("scrawl-ready"), { timeout: 5_000 }).catch(() => {});
    const { width, problems } = await page.evaluate(measure, MIN_TEXT_PX, MIN_TAP_PX);
    const screenshot = withScreenshot ? ((await page.screenshot({ fullPage: true, type: "png" })) as Uint8Array<ArrayBuffer>) : undefined;
    return { url, width, problems: [...problems, ...[...new Set(errors)].slice(0, 5)], screenshot };
  } finally {
    await browser.close();
  }
}
