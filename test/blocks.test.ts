import { describe, expect, it } from "vitest";
import { parsePage, renderPage, type Page } from "../src/blocks";
import { alpineIssues, extractDescription, extractTitle, lintPad } from "../src/pad";

const every: unknown = {
  title: "Pick the Framework 13",
  kicker: "Laptops · Nov 2026",
  summary: "Best screen and battery for the price.",
  sources: "[Vendor sites](https://example.org), 12 Nov 2026",
  blocks: [
    { type: "text", title: "Why", markdown: "Short **reason**.\n\n- one\n- two" },
    { type: "callout", tone: "warning", text: "Prices change *weekly*." },
    { type: "stats", items: [{ label: "Price", value: "$999", note: "base model" }, { label: "Battery", value: 11 }] },
    { type: "chart", title: "Battery hours", kind: "bar", labels: ["A", "B"], series: [{ name: "Hours", values: [11, 9] }] },
    { type: "table", columns: ["Model", "Weight"], rows: [["A", 1.3], ["B", 1.4]] },
    { type: "compare", items: [{ name: "A", pick: true, price: "$999", pros: ["light"], cons: ["glossy"], url: "https://a.example" }, { name: "B", price: "$899" }] },
    { type: "ranking", unit: " h", items: [{ label: "B", value: 9 }, { label: "A", value: 11 }] },
    { type: "checklist", items: ["Check stock", "Order"] },
    { type: "steps", items: [{ title: "Order", time: "Day 1" }, { title: "Arrives", text: "About a week" }] },
    { type: "faq", items: [{ q: "Warranty?", a: "Two years." }] },
    { type: "image", src: "photo.jpg", alt: "The laptop", caption: "Silver" },
    { type: "links", items: [{ label: "Store", url: "https://a.example/store" }] },
  ],
};

describe("pages as data", () => {
  it("renders every block into a page that passes the lint and the Alpine check", async () => {
    const page = parsePage(every) as Page;
    expect(typeof page).toBe("object");
    const html = renderPage(page);
    expect(extractTitle(html)).toBe("Pick the Framework 13");
    expect(extractDescription(html)).toBe("Best screen and battery for the price.");
    expect(html).toContain('<script src="/scrawl.js"></script>');
    expect(html).toContain("chart.umd.min.js");
    expect(html).toContain("<strong>reason</strong>");
    expect(html).toContain("max-w-5xl");
    const fixes = [...lintPad(html, "cdn.jsdelivr.net"), ...(await alpineIssues(html))].filter((i) => i.level === "fix" && i.code !== "relative-file");
    expect(fixes).toEqual([]);
  });

  it("works out ranking bars as shares of the biggest value, biggest first", () => {
    const html = renderPage(parsePage({ title: "t", blocks: [{ type: "ranking", items: [{ label: "small", value: 25 }, { label: "big", value: 100 }] }] }) as Page);
    expect(html.indexOf("big")).toBeLessThan(html.indexOf("small"));
    expect(html).toContain('value="100"');
    expect(html).toContain('value="25"');
  });

  it("escapes text, so a title cannot break the page", () => {
    const html = renderPage(parsePage({ title: '<script>x</script>"', blocks: [{ type: "table", columns: ["a<b"], rows: [["</td>"]] }] }) as Page);
    expect(html).not.toContain("<script>x");
    expect(html).toContain("&lt;/td&gt;");
  });

  it("says Source once, even when the agent wrote it", () => {
    expect(renderPage(parsePage({ title: "t", sources: "Sources: vendor sites", blocks: [{ type: "text", markdown: "hi" }] }) as Page)).toContain("Source: vendor sites</footer>");
  });

  it("uses the narrow reading width when no block needs room", () => {
    expect(renderPage(parsePage({ title: "t", blocks: [{ type: "text", markdown: "hi" }] }) as Page)).toContain("max-w-3xl");
  });

  it("lists every problem with where it is, in one answer", () => {
    const errors = parsePage({
      title: "t",
      subtitle: "not a field",
      blocks: [
        { type: "table", columns: ["a", "b"], rows: [["1"]] },
        { type: "chart", labels: ["x", "y"], series: [{ name: "s", values: [1] }] },
        { type: "nope" },
      ],
    }) as string;
    expect(typeof errors).toBe("string");
    expect(errors).toContain("subtitle");
    expect(errors).toContain("blocks.2");
    // Shape errors are reported before the cross-field checks run, so fix those first and check again.
    const second = parsePage({ title: "t", blocks: [{ type: "table", columns: ["a", "b"], rows: [["1"]] }, { type: "chart", labels: ["x", "y"], series: [{ name: "s", values: [1] }] }] }) as string;
    expect(second).toContain("blocks.0.rows.0: has 1 cells, the table has 2 columns");
    expect(second).toContain("blocks.1.series.0.values: has 1 values, the chart has 2 labels");
  });
});
