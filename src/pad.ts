import { parse, parseExpressionAt } from "acorn";

const ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyz";

function randomString(length: number, alphabet: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export const newId = () => randomString(8, ID_ALPHABET);
export const newEditKey = () => randomString(32, ID_ALPHABET);
export const newLinkKey = () => randomString(24, ID_ALPHABET);

export async function hashKey(key: string | BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", typeof key === "string" ? new TextEncoder().encode(key) : key);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return (match?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";
}

// Sandboxed pages have an opaque origin, so localStorage throws; fall back to memory.
const STORAGE_SHIM = `<script>(function(){try{localStorage.getItem("x")}catch(e){["localStorage","sessionStorage"].forEach(function(n){var m=new Map();Object.defineProperty(window,n,{value:{getItem:function(k){return m.has(k)?m.get(k):null},setItem:function(k,v){m.set(k,String(v))},removeItem:function(k){m.delete(k)},clear:function(){m.clear()},key:function(i){return Array.from(m.keys())[i]??null},get length(){return m.size}}})})}})()</script>`;

// Zero-specificity defaults so a pad is never broken on a phone, while its own CSS always wins.
const BASE_CSS = `<style>:where(*,*::before,*::after){box-sizing:border-box}:where(html){-webkit-text-size-adjust:100%}:where(body){overflow-wrap:break-word}:where(img,video){max-width:100%;height:auto}:where(svg,canvas,iframe){max-width:100%}:where(pre){overflow-x:auto}</style>`;
const VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1">`;

const hasViewport = (html: string) => /<meta[^>]+name=["']?viewport/i.test(html);

// Insert after <head>, else wrap in a new <head> after <html>, else after the doctype, else prefix.
function injectIntoHead(html: string, snippet: string): string {
  const head = html.match(/<head[^>]*>/i);
  if (head) return html.replace(head[0], head[0] + snippet);
  const root = html.match(/<html[^>]*>/i);
  if (root) return html.replace(root[0], `${root[0]}<head>${snippet}</head>`);
  const doctype = html.match(/<!doctype[^>]*>/i);
  return doctype ? html.replace(doctype[0], doctype[0] + snippet) : snippet + html;
}

export const escapeAttr = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const plainText = (html: string) => decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

// What a link preview says under the title: the pad's own description, else the first paragraph, at the top of the page.
export function extractDescription(html: string): string {
  const meta = html.match(/<meta[^>]+name=["']description["'][^>]*>/i)?.[0].match(/content=["']([^"']*)["']/i)?.[1];
  const paragraph = html.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  const text = meta ? decodeEntities(meta).trim() : paragraph ? plainText(paragraph) : "";
  return text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text;
}

// A tab icon and a link preview card; each tag the pad sets itself is left to the pad.
function brandTags(html: string, image: string, describe: boolean): string {
  const icon = /<link[^>]+rel=["'][^"']*icon/i.test(html) ? "" : `<link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
  const description = describe ? extractDescription(html) : "";
  const tags: [string, string][] = [
    ["og:site_name", "Scrawl"],
    ["og:type", "website"],
    ["og:title", extractTitle(html)],
    ["og:description", description],
    ["og:image", image],
    ["twitter:card", "summary_large_image"],
  ];
  const preview = tags
    .filter(([name, value]) => value && !new RegExp(`(?:property|name)=["']${name}["']`, "i").test(html))
    .map(([name, value]) => `<meta ${name.startsWith("og:") ? "property" : "name"}="${name}" content="${escapeAttr(value)}">`)
    .join("");
  return icon + preview;
}

// A quiet link back home at the end of the page, in the flow so it never covers the pad; all:initial shields it from pad CSS,
// and padding instead of margin so it cannot leak past the body background.
const FONT = "font:500 14px/1.2 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif";
export const scrawlLogo = (px: number) =>
  `<svg viewBox="0 0 64 64" width="${px}" height="${px}" aria-hidden="true" style="all:initial;width:${px}px;height:${px}px;flex:none"><path d="M0 18A18 18 0 0 1 18 0A46 46 0 0 1 64 46A18 18 0 0 1 46 64A46 46 0 0 1 0 18Z" fill="#e2531f"/><path d="M17 40C25 25 33 51 47 24" fill="none" stroke="#fff" stroke-width="5.5" stroke-linecap="round"/></svg>`;
// link is an extra footer link, such as a series pad's past editions.
const madeWith = (home: string, padId?: string, link?: { label: string; href: string }) =>
  `<div data-scrawl-footer style="all:initial;display:flex;flex-wrap:wrap;justify-content:center;align-items:center;gap:8px 14px;color:inherit;padding:40px 16px 24px">` +
  `<a href="${home}/?ref=pad" target="_blank" rel="noopener" style="all:initial;box-sizing:border-box;display:flex;max-width:100%;align-items:center;gap:6px;padding:6px 12px 6px 8px;border-radius:999px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);color:inherit;opacity:.6;${FONT};cursor:pointer;text-decoration:none;white-space:nowrap">${scrawlLogo(16)}<span style="all:unset">Made with Scrawl · make your own</span></a>` +
  (link ? footerLink(link.href, link.label, "_self") : "") +
  (padId ? footerLink(`${home}/report?pad=${padId}`, "Report", "_blank") : "") +
  `</div>`;

const footerLink = (href: string, label: string, target: string) =>
  `<a href="${escapeAttr(href)}" target="${target}" rel="noopener" style="all:initial;color:inherit;opacity:.45;${FONT};cursor:pointer;text-decoration:underline;text-underline-offset:3px">${label}</a>`;

// The pad's data as an inline JSON script; < is escaped so the document cannot close the tag.
const dataScript = (data: string) => `<script type="application/json" id="scrawl-data">${data.replace(/</g, "\\u003c")}</script>`;

function appendToBody(html: string, snippet: string): string {
  const end = html.search(/<\/body>(?![\s\S]*<\/body>)/i);
  return end >= 0 ? html.slice(0, end) + snippet + html.slice(end) : html + snippet;
}

// image is the link preview picture, the Scrawl card by default; describe is false for private pads, whose previews show no content.
type PadContext = { origin: string; home?: string; isolated?: boolean; padId?: string; image?: string; describe?: boolean; data?: string | null; link?: { label: string; href: string } };

// An isolated pad has its own origin, so real localStorage works and needs no shim.
export function preparePad(html: string, { origin, home = origin, isolated = false, padId, image = `${origin}/og.png`, describe = true, data, link }: PadContext): string {
  const head = injectIntoHead(html, (hasViewport(html) ? "" : VIEWPORT) + brandTags(html, image, describe) + BASE_CSS + (isolated ? "" : STORAGE_SHIM) + (data ? dataScript(data) : ""));
  return appendToBody(head, madeWith(home, padId, link));
}

// "fix" breaks the page for readers; "advice" is a quality hint the agent may skip.
export type Issue = { code: string; message: string; level: "fix" | "advice" };

export function lintPad(html: string, cdnAllowlist: string): Issue[] {
  const issues: Issue[] = [];
  const add = (code: string, message: string, level: Issue["level"] = "fix") => issues.push({ code, message, level });
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const styleAttrs = [...html.matchAll(/\bstyle=["']([^"']*)["']/gi)].map((m) => m[1]).join("\n");
  const ownCss = styleBlocks + "\n" + styleAttrs;

  if (/\bEDIT\b/.test(html)) add("edit-left", "Leftover EDIT placeholder text: replace it with real content or delete that part.");
  if (!/<title[^>]*>\s*\S/i.test(html)) add("no-title", "No <title>: add one, it names the pad.");
  if (!/<h1[\s>]/i.test(html)) add("no-h1", "No <h1>: add one headline that states the takeaway.", "advice");
  if (!hasViewport(html)) add("no-viewport", "No viewport meta tag: Scrawl added one, but add it yourself so the page is mobile friendly.", "advice");
  const hero = html.match(/<header[^>]*class=["'][^"']*\bhero\b[^"']*["'][^>]*>([\s\S]*?)<\/header>/i);
  if (hero && [...hero[1].matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].some((m) => m[1].replace(/<[^>]+>/g, "").trim().length > 260)) {
    add("long-hero", "The hero text is long (over about 40 words): keep it to one or two short sentences and move the detail into a callout or the page body.", "advice");
  }
  if (/<img\b(?![^>]*\balt=)[^>]*>/i.test(html)) add("img-alt", 'Image without alt text: add alt="..." describing it, or alt="" if it is decoration.', "advice");

  const allowed = new Set(cdnAllowlist.split(/\s+/).filter(Boolean));
  const blocked = new Set<string>();
  // Only scripts are held to the allowlist: stylesheets and fonts may come from any https host.
  for (const [, url] of html.matchAll(/<script\b[^>]*?\bsrc=["'](https?:\/\/[^"']+)["']/gi)) {
    const host = new URL(url).host;
    if (!allowed.has(host)) blocked.add(host);
  }
  if (blocked.size) add("cdn-blocked", `Scripts blocked by the CSP, will not load: ${[...blocked].join(", ")}. Scripts may come from: ${[...allowed].join(", ")}.`);
  if (/<(?:script|link|img)\b[^>]*?(?:src|href)=["'](?!https?:|data:|#|mailto:|\/(?:scrawl\.js|favicon\.svg|apple-touch-icon\.png|og\.png)["'])[^"']+["']/i.test(html.replace(/<a\b[^>]*>/gi, ""))) {
    add("relative-file", "Relative file reference (src/href to a local file) will not load: pads are a single file. Inline it, or send image files with the pad (see Images in the guide).");
  }
  const fakeImages = /<img\b[^>]*\bsrc=["']https?:\/\/(?:[\w-]+\.)*(?:placeholder\.com|placehold\.co|placehold\.it|picsum\.photos|example\.com|source\.unsplash\.com|dummyimage\.com)\//i;
  if (fakeImages.test(html)) add("placeholder-image", "Placeholder or made-up image URL: use a real image URL you found, or upload your own file (see Images in the guide), or remove the image.");
  if (/tile\.openstreetmap\.org/i.test(html)) add("osm-tiles", "tile.openstreetmap.org blocks map tiles on pads: copy the OpenFreeMap map from the map recipe.");
  if (/<form\b[^>]*\baction=/i.test(html)) add("form-action", "Forms cannot submit to a server from a pad: handle submit with JavaScript.");
  if ([...ownCss.matchAll(/(?<![-\w])width:\s*(\d{3,4})px/gi)].some(([, n]) => Number(n) > 480)) {
    add("fixed-width", "Fixed width over 480px will overflow phones: use max-width or percentages.");
  }
  const classes = [...html.matchAll(/\bclass=["']([^"']*)["']/gi)].map((m) => m[1]).join(" ");
  const paletteClass = /(?:^|\s)(?:bg|text|border|from|via|to|ring|fill|stroke)-(?:\[#|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|white|black)\b)/;
  // A page that declares its color scheme chose its colors on purpose; a page with its own design (no Scrawl stack) only gets advice.
  const ownScheme = /prefers-color-scheme|color-scheme\s*:|<meta[^>]+name=["']?color-scheme/i.test(html);
  if (!ownScheme && (/#[0-9a-f]{3,8}\b|rgba?\(/i.test(ownCss) || (paletteClass.test(classes) && !/\bdark:/.test(classes)))) {
    add(
      "fixed-colors",
      "Fixed colors will not follow dark mode: use theme classes (bg-base-100, text-primary, text-success, opacity-70) instead of hex codes or Tailwind colors like text-blue-500. A page with its own design can declare color-scheme instead.",
      /<script[^>]+src=["']\/scrawl\.js["']/i.test(html) ? "fix" : "advice",
    );
  }
  if ([...ownCss.matchAll(/font-size:\s*(\d*\.?\d+)(px|rem|em)/gi)].some(([, n, unit]) => (unit === "px" ? Number(n) < 12 : Number(n) < 0.75))) {
    add("tiny-text", "Text under 12px is hard to read on a phone: use 14px (0.875rem) or larger.");
  }
  return issues;
}

// allow-same-origin only on a pad's own subdomain: that origin holds nothing but this pad.
const ALPINE_ATTR = /^(?:x-(?!data$|cloak$|ignore$)|@|:)/;
// Attributes whose value is a name, a selector or modifiers, not JavaScript.
const ALPINE_NOT_CODE = /^x-(?:ref|cloak|ignore|teleport|transition|mask)\b/;
const ALPINE_STATEMENTS = /^(?:@|x-on:|x-init$|x-effect$)/;

const decodeEntities = (v: string) =>
  v.replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// The JavaScript in one Alpine attribute, ready for the parser, or undefined when it holds no code.
function alpineCode(name: string, value: string): { code: string; statements: boolean } | undefined {
  if (!ALPINE_ATTR.test(name) && name !== "x-data") return undefined;
  if (ALPINE_NOT_CODE.test(name) || !value.trim()) return undefined;
  if (name === "x-for") return { code: `(${value.split(/\s+(?:in|of)\s+/).pop()})`, statements: false };
  return ALPINE_STATEMENTS.test(name) ? { code: value, statements: true } : { code: `(${value})`, statements: false };
}

// Alpine only reads data inside the x-data element, so a directive outside every x-data silently renders nothing;
// and a directive that is not valid JavaScript (often a quoting mistake) breaks with only a console error.
export async function alpineIssues(html: string): Promise<Issue[]> {
  if (!/\bx-data\b/.test(html)) return [];
  let depth = 0;
  let orphan: string | undefined;
  const broken = new Set<string>();
  await new HTMLRewriter()
    .on("*", {
      element(el) {
        const attrs = [...(el.attributes as unknown as Iterable<[string, string]>)];
        for (const [name, raw] of attrs) {
          const js = alpineCode(name, decodeEntities(raw));
          if (!js || broken.size >= 3) continue;
          try {
            if (js.statements) parse(js.code, { ecmaVersion: "latest", allowReturnOutsideFunction: true });
            else parseExpressionAt(js.code, 0, { ecmaVersion: "latest" });
          } catch (err) {
            broken.add(`${name}="${raw.slice(0, 50)}" (${(err as Error).message.replace(/ \(\d+:\d+\)$/, "")})`);
          }
        }
        if (el.hasAttribute("x-data")) {
          // A void element has no end tag and onEndTag throws; it cannot wrap anything anyway.
          try {
            el.onEndTag(() => void depth--);
            depth++;
          } catch {}
          return;
        }
        if (depth === 0 && !orphan) orphan = attrs.map(([name]) => name).find((name) => ALPINE_ATTR.test(name));
      },
    })
    .transform(new Response(html))
    .text();
  const issues: Issue[] = [];
  if (orphan) issues.push({ code: "alpine-scope", level: "fix", message: `Alpine attribute ${orphan} is outside every x-data element, so it shows nothing: put x-data on one element that wraps everything using its data, such as <main>.` });
  if (broken.size) issues.push({ code: "alpine-syntax", level: "fix", message: `Alpine code that is not valid JavaScript, so that part shows nothing: ${[...broken].join("; ")}. Check the quotes: in an attribute written with double quotes use single quotes inside, and never write \\".` });
  return issues;
}

export function padHeaders(cdnAllowlist: string, isolated = false): Record<string, string> {
  const cdns = cdnAllowlist.split(/\s+/).filter(Boolean).map((h) => `https://${h}`).join(" ");
  const csp = [
    `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals${isolated ? " allow-same-origin" : ""}`,
    "default-src 'none'",
    `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${cdns}`,
    "style-src 'self' 'unsafe-inline' https:",
    "font-src data: https:",
    // 'self' for the pad's favicon and images when Scrawl is served over plain http.
    "img-src 'self' data: blob: https:",
    "media-src data: blob: https:",
    "worker-src blob:",
    "connect-src https:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
  };
}
