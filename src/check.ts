// Opens a pad in Cloudflare Browser Rendering: on a phone-sized screen to report what a reader would hit,
// or at link preview size to picture its top.
import type { Browser, Page, Viewport } from "@cloudflare/puppeteer";

const PHONE = { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const CARD = { width: 1200, height: 630, deviceScaleFactor: 1 };
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

// Runs inside the page: a Scrawl pill in the corner, so a shared link still says where the page lives.
function addBadge(logo: string, site: string) {
  const badge = document.createElement("div");
  badge.style.cssText =
    "all:initial;position:fixed;right:28px;bottom:28px;z-index:2147483647;display:flex;align-items:center;gap:10px;padding:10px 18px 10px 12px;border-radius:999px;" +
    "background:#141414;color:#f4f1ea;font:600 22px/1 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.35)";
  badge.innerHTML = `${logo}<span>${site}</span>`;
  document.body.appendChild(badge);
}

// The page once Tailwind has styled it; the caller closes the browser.
async function openPad(browserBinding: Fetcher, url: string, viewport: Viewport, beforeLoad: (page: Page) => unknown = () => {}): Promise<{ browser: Browser; page: Page }> {
  // Loaded here so the Bun runtime, which has no browser, never imports it.
  const { default: puppeteer } = await import("@cloudflare/puppeteer");
  const browser = await puppeteer.launch(browserBinding);
  try {
    const page = await browser.newPage();
    await page.setViewport(viewport);
    await beforeLoad(page);
    await page.goto(url, { waitUntil: "networkidle0", timeout: 20_000 });
    // scrawl.js shows the page once Tailwind has styled it.
    await page.waitForFunction(() => !document.querySelector('script[src="/scrawl.js"]') || document.documentElement.classList.contains("scrawl-ready"), { timeout: 5_000 }).catch(() => {});
    return { browser, page };
  } catch (err) {
    await browser.close();
    throw err;
  }
}

export async function checkPad(browserBinding: Fetcher, url: string, withScreenshot: boolean): Promise<CheckReport & { screenshot?: Uint8Array<ArrayBuffer> }> {
  const errors: string[] = [];
  const { browser, page } = await openPad(browserBinding, url, PHONE, (page) => {
    page.on("pageerror", (err) => errors.push(`Script error: ${(err as Error).message}`));
    // Images that fail are reported by measure(), and the browser logs each failed load once more.
    page.on("console", (msg) => msg.type() === "error" && !msg.text().startsWith("Failed to load resource") && errors.push(`Console error: ${msg.text().trim()}`));
    page.on("requestfailed", (req) => req.resourceType() !== "image" && errors.push(`Could not load ${req.url()} (${req.failure()?.errorText ?? "failed"})`));
  });
  try {
    const { width, problems } = await page.evaluate(measure, MIN_TEXT_PX, MIN_TAP_PX);
    const screenshot = withScreenshot ? ((await page.screenshot({ fullPage: true, type: "png" })) as Uint8Array<ArrayBuffer>) : undefined;
    return { url, width, problems: [...problems, ...[...new Set(errors)].slice(0, 5)], screenshot };
  } finally {
    await browser.close();
  }
}

// The top of the pad as a desktop reader first sees it, with motion settled, as a link preview image.
export async function capturePreview(browserBinding: Fetcher, url: string, logo: string, site: string): Promise<Uint8Array<ArrayBuffer>> {
  const { browser, page } = await openPad(browserBinding, url, CARD, (page) => page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]));
  try {
    await page.evaluate(addBadge, logo, site);
    return (await page.screenshot({ type: "jpeg", quality: 85 })) as Uint8Array<ArrayBuffer>;
  } finally {
    await browser.close();
  }
}
