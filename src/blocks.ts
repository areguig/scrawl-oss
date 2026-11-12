// A page sent as data: Scrawl renders the blocks into the same markup the recipes use, so the agent writes no HTML.
import { marked } from "marked";
import { z } from "zod";
import { escapeAttr as esc } from "./pad";

const text = z.string().min(1);
const title = text.optional().describe("Heading shown above the block");
const markdown = text.describe("Markdown: paragraphs, **bold**, lists, [links](https://...)");
const cell = z.union([z.string(), z.number()]);

const block = <K extends string, T extends z.ZodRawShape>(type: K, shape: T) => z.strictObject({ type: z.literal(type), ...shape });

const blocks = [
  block("text", { title, markdown }),
  block("callout", { tone: z.enum(["info", "success", "warning", "error"]).default("info"), text: markdown }),
  block("stats", { title, items: z.array(z.strictObject({ label: text, value: cell, note: text.optional() })).min(1).max(6) }),
  block("chart", {
    title,
    kind: z.enum(["bar", "line", "pie", "doughnut"]).default("bar"),
    labels: z.array(cell).min(1),
    series: z.array(z.strictObject({ name: text, values: z.array(z.number()) })).min(1).max(6),
  }),
  block("table", { title, columns: z.array(text).min(1), rows: z.array(z.array(cell)).min(1) }),
  block("compare", {
    title,
    items: z
      .array(
        z.strictObject({
          name: text,
          pick: z.boolean().optional().describe("The recommended option"),
          badge: text.optional(),
          price: cell.optional(),
          note: text.optional(),
          pros: z.array(text).optional(),
          cons: z.array(text).optional(),
          url: z.url().optional(),
        }),
      )
      .min(2),
  }),
  block("ranking", { title, unit: z.string().optional(), items: z.array(z.strictObject({ label: text, value: z.number(), note: text.optional() })).min(1) }),
  block("checklist", { title, items: z.array(text).min(1) }),
  block("steps", { title, items: z.array(z.strictObject({ title: text, time: text.optional(), text: text.optional() })).min(1) }),
  block("faq", { title, items: z.array(z.strictObject({ q: text, a: markdown })).min(1) }),
  block("image", { src: text.describe("An https URL, or the file name of an image sent with the pad"), alt: z.string(), caption: text.optional() }),
  block("links", { title, items: z.array(z.strictObject({ label: text, url: z.url() })).min(1) }),
] as const;

const Block = z.discriminatedUnion("type", blocks);
type Block = z.infer<typeof Block>;

export const PageSchema = z
  .strictObject({
    title: text.describe("The headline: the main point or verdict"),
    kicker: text.optional().describe("Small line above the headline: topic, date"),
    summary: text.optional().describe("One or two sentences under the headline"),
    blocks: z.array(Block).min(1).max(60),
    sources: text.optional().describe('Footer line: where the facts come from and when, e.g. "Vendor sites, 12 Nov 2026"'),
  })
  .superRefine((page, ctx) =>
    page.blocks.forEach((b, i) => {
      if (b.type === "table") b.rows.forEach((r, j) => r.length !== b.columns.length && ctx.addIssue({ code: "custom", path: ["blocks", i, "rows", j], message: `has ${r.length} cells, the table has ${b.columns.length} columns` }));
      if (b.type === "chart") b.series.forEach((s, j) => s.values.length !== b.labels.length && ctx.addIssue({ code: "custom", path: ["blocks", i, "series", j, "values"], message: `has ${s.values.length} values, the chart has ${b.labels.length} labels` }));
    }),
  );
export type Page = z.infer<typeof PageSchema>;

// Every problem at once, with its path, so a small model fixes them in one retry.
export function parsePage(input: unknown): Page | string {
  const result = PageSchema.safeParse(input);
  return result.success ? result.data : result.error.issues.map((i) => `${i.path.join(".") || "page"}: ${i.message}`).join("; ");
}

const md = (source: string) => `<div class="scrawl-md">${marked.parse(source, { async: false })}</div>`;
const mdInline = (source: string) => marked.parseInline(source, { async: false });
const h2 = (t?: string, cls = "text-2xl font-bold") => (t ? `<h2 class="${cls}">${esc(t)}</h2>` : "");
const card = (t: string | undefined, inner: string, body = "") => `<section class="card bg-base-100"><div class="card-body ${body}">${h2(t, "card-title")}${inner}</div></section>`;
const icon = (name: string, cls = "w-5 h-5 mt-0.5") => `<i data-lucide="${name}" class="${cls}"></i>`;
const plain = (v: string | number) => esc(String(v));

const TONE_ICON = { info: "info", success: "circle-check", warning: "triangle-alert", error: "circle-x" };

function renderBlock(b: Block, i: number): string {
  switch (b.type) {
    case "text":
      return `<section class="space-y-3 leading-relaxed">${h2(b.title)}${md(b.markdown)}</section>`;
    case "callout":
      return `<div role="alert" class="alert alert-${b.tone}">${icon(TONE_ICON[b.tone], "w-5 h-5")}<div class="scrawl-md">${mdInline(b.text)}</div></div>`;
    case "stats":
      return `<section class="space-y-3">${h2(b.title)}<div class="stats stats-vertical sm:stats-horizontal w-full bg-base-100 border border-base-300">${b.items
        .map((s) => `<div class="stat"><div class="stat-title">${esc(s.label)}</div><div class="stat-value">${plain(s.value)}</div>${s.note ? `<div class="stat-desc whitespace-normal">${esc(s.note)}</div>` : ""}</div>`)
        .join("")}</div></section>`;
    case "chart": {
      const spec = esc(JSON.stringify({ kind: b.kind, labels: b.labels, series: b.series }));
      return card(b.title, `<div class="relative h-72 md:h-96"><canvas data-chart="${spec}" role="img" aria-label="${esc(b.title ?? "Chart")}"></canvas></div>`);
    }
    case "table": {
      const numeric = b.columns.map((_, c) => b.rows.every((r) => typeof r[c] === "number"));
      const th = b.columns.map((c, k) => `<th${numeric[k] ? ' class="text-right"' : ""}>${esc(c)}</th>`).join("");
      const rows = b.rows.map((r) => `<tr class="hover">${r.map((v, k) => `<td${numeric[k] ? ' class="text-right"' : k === 0 ? ' class="font-medium"' : ""}>${plain(v)}</td>`).join("")}</tr>`).join("");
      return card(b.title, `<div class="overflow-x-auto"><table class="table"><thead><tr>${th}</tr></thead><tbody>${rows}</tbody></table></div>`);
    }
    case "compare": {
      const cols = Math.min(b.items.length, 3);
      // The recommended option leads, wherever the agent put it.
      const items = [...b.items].sort((x, y) => Number(!!y.pick) - Number(!!x.pick)).map((o) => {
        const badge = o.badge ?? (o.pick ? "Best pick" : undefined);
        const list = [...(o.pros ?? []).map((p) => `<li class="flex gap-2">${icon("check", "text-success w-5 h-5 mt-0.5 shrink-0")}<span>${esc(p)}</span></li>`), ...(o.cons ?? []).map((p) => `<li class="flex gap-2">${icon("x", "text-error w-5 h-5 mt-0.5 shrink-0")}<span>${esc(p)}</span></li>`)].join("");
        return `<article class="card bg-base-100${o.pick ? " border-2 border-primary" : ""}"><div class="card-body">` +
          `<div class="flex items-start justify-between gap-2"><h3 class="card-title text-2xl">${esc(o.name)}</h3>${badge ? `<span class="badge ${o.pick ? "badge-primary" : "badge-ghost"}">${esc(badge)}</span>` : ""}</div>` +
          (o.price !== undefined ? `<p class="text-3xl font-bold grow-0">${plain(o.price)}</p>` : "") +
          (o.note ? `<p class="text-sm opacity-70 grow-0">${esc(o.note)}</p>` : "") +
          (list ? `<ul class="space-y-2 mt-2">${list}</ul>` : "") +
          (o.url ? `<div class="card-actions mt-4"><a class="btn ${o.pick ? "btn-primary" : "btn-outline"} btn-sm" href="${esc(o.url)}" target="_blank" rel="noopener">Open</a></div>` : "") +
          `</div></article>`;
      });
      return `<section class="space-y-3">${h2(b.title)}<div class="grid gap-4 md:grid-cols-${cols}">${items.join("")}</div></section>`;
    }
    case "ranking": {
      // Bars are shares of the biggest value, worked out here so the agent never does the math.
      const sorted = [...b.items].sort((x, y) => y.value - x.value);
      const max = Math.max(...sorted.map((r) => Math.abs(r.value)), 1e-9);
      const rows = sorted.map((r) =>
        `<div><div class="flex justify-between gap-3 mb-1"><span class="font-medium">${esc(r.label)}</span><span class="font-semibold">${plain(r.value.toLocaleString("en-US"))}${esc(b.unit ?? "")}</span></div>` +
        `<progress class="progress progress-primary w-full" value="${Math.round((Math.abs(r.value) / max) * 100)}" max="100"></progress>${r.note ? `<p class="text-sm opacity-70 mt-1">${esc(r.note)}</p>` : ""}</div>`);
      return card(b.title, `<div class="space-y-4">${rows.join("")}</div>`, "gap-4");
    }
    case "checklist": {
      // Ticks are saved on the reader's device, under a key per block.
      const items = b.items.map((t, k) => `<li><label class="flex items-center gap-3 py-3 cursor-pointer"><input type="checkbox" class="checkbox checkbox-primary" value="${k}" x-model="done"><span class="flex-1" :class="done.includes('${k}') && 'line-through opacity-50'">${esc(t)}</span></label></li>`);
      return `<section class="card bg-base-100" x-data="{ done: $persist([]).as('checklist-${i}') }"><div class="card-body gap-4">${h2(b.title, "card-title")}` +
        `<div class="flex items-center justify-between gap-3"><p class="font-semibold" x-text="done.length + ' of ${b.items.length} done'">0 of ${b.items.length} done</p><button class="btn btn-ghost btn-sm" @click="done = []">Reset</button></div>` +
        `<progress class="progress progress-primary w-full" value="0" :value="done.length" max="${b.items.length}"></progress><ul class="divide-y divide-base-300">${items.join("")}</ul></div></section>`;
    }
    case "steps": {
      const items = b.items.map((s) =>
        `<li><div class="timeline-middle text-primary">${icon("circle-dot")}</div><div class="timeline-end mb-6 mt-0.5">` +
        (s.time ? `<p class="text-sm font-semibold text-primary">${esc(s.time)}</p>` : "") +
        `<p class="font-semibold">${esc(s.title)}</p>${s.text ? `<p class="opacity-70">${esc(s.text)}</p>` : ""}</div></li>`);
      return card(b.title, `<ul class="timeline timeline-vertical timeline-compact timeline-snap-icon">${items.join("")}</ul>`);
    }
    case "faq":
      return `<section class="space-y-3">${h2(b.title)}${b.items
        .map((f, k) => `<details${k === 0 ? " open" : ""} class="collapse collapse-plus bg-base-100 border border-base-300"><summary class="collapse-title text-lg font-medium">${esc(f.q)}</summary><div class="collapse-content">${md(f.a)}</div></details>`)
        .join("")}</section>`;
    case "image":
      return `<figure class="space-y-2"><img src="${esc(b.src)}" alt="${esc(b.alt)}" class="rounded-box w-full">${b.caption ? `<figcaption class="text-sm opacity-70">${esc(b.caption)}</figcaption>` : ""}</figure>`;
    case "links":
      return `<section class="space-y-3">${h2(b.title)}<div class="flex flex-wrap gap-2">${b.items.map((l) => `<a class="btn btn-outline btn-sm" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join("")}</div></section>`;
  }
}

// Markdown output has no classes, so it gets its spacing and theme colors here.
const MD_CSS = `<style>.scrawl-md>*+*{margin-top:.75em}.scrawl-md h1,.scrawl-md h2{font-size:1.5rem;font-weight:700}.scrawl-md h3{font-size:1.25rem;font-weight:600}.scrawl-md ul{list-style:disc;padding-left:1.5rem}.scrawl-md ol{list-style:decimal;padding-left:1.5rem}.scrawl-md li+li{margin-top:.25em}.scrawl-md a{color:oklch(var(--p));text-decoration:underline}.scrawl-md blockquote{border-left:4px solid oklch(var(--p));padding-left:1rem;opacity:.8}.scrawl-md code{font-family:ui-monospace,monospace;font-size:.9em;background:oklch(var(--b3));padding:0 .25em;border-radius:.25rem}.scrawl-md pre{background:oklch(var(--b3));padding:1rem;border-radius:.5rem;overflow-x:auto}.scrawl-md pre code{background:none;padding:0}.scrawl-md table{width:100%}.scrawl-md th,.scrawl-md td{padding:.25rem .5rem;border-bottom:1px solid oklch(var(--b3));text-align:left}</style>`;

const CHART_JS = `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>`;
// Draws every chart with theme colors, again when dark mode changes.
const CHART_SCRIPT = `<script>(function(){var charts=[];function draw(){var css=getComputedStyle(document.documentElement);var c=function(v,a){return "oklch("+css.getPropertyValue(v).trim()+(a?" / "+a:"")+")"};var palette=["--p","--s","--a","--in","--su","--er"].map(function(v){return c(v)});charts.forEach(function(ch){ch.destroy()});charts=[];document.querySelectorAll("canvas[data-chart]").forEach(function(el){var s=JSON.parse(el.dataset.chart);var round=s.kind==="pie"||s.kind==="doughnut";charts.push(new Chart(el,{type:s.kind,data:{labels:s.labels,datasets:s.series.map(function(d,i){var col=palette[i%palette.length];return{label:d.name,data:d.values,backgroundColor:round?s.labels.map(function(_,k){return palette[k%palette.length]}):col,borderColor:round?c("--b1"):col,borderRadius:6,tension:.3}})},options:{maintainAspectRatio:false,plugins:{legend:{display:round||s.series.length>1,labels:{color:c("--bc",.6)}}},scales:round?{}:{x:{ticks:{color:c("--bc",.6)},grid:{color:c("--bc",.1)}},y:{beginAtZero:true,ticks:{color:c("--bc",.6)},grid:{color:c("--bc",.1)}}}}}))})}draw();matchMedia("(prefers-color-scheme: dark)").addEventListener("change",draw)})()</script>`;

const WIDE = new Set<Block["type"]>(["chart", "table", "compare", "stats"]);

export function renderPage(page: Page): string {
  const types = new Set(page.blocks.map((b) => b.type));
  const width = [...types].some((t) => WIDE.has(t)) ? "max-w-5xl" : "max-w-3xl";
  const description = page.summary ? `<meta name="description" content="${esc(page.summary)}">` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)}</title>${description}
<script src="/scrawl.js"></script>${types.has("chart") ? CHART_JS : ""}${MD_CSS}
</head>
<body>
<main class="${width} mx-auto px-4 py-8 md:py-12 space-y-6">
<header>${page.kicker ? `<p class="text-sm font-semibold text-primary">${esc(page.kicker)}</p>` : ""}<h1 class="text-3xl md:text-5xl font-bold mt-1">${esc(page.title)}</h1>${page.summary ? `<p class="text-lg opacity-70 mt-3 max-w-2xl">${esc(page.summary)}</p>` : ""}</header>
${page.blocks.map(renderBlock).join("\n")}
${page.sources ? `<footer class="text-sm opacity-60">Source: ${mdInline(page.sources.replace(/^sources?\s*:\s*/i, ""))}</footer>` : ""}
</main>${types.has("chart") ? CHART_SCRIPT : ""}
</body>
</html>`;
}
