import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { deleteExpired } from "../src/index";

const call = (path: string, init?: RequestInit) => exports.default.fetch(new Request(`https://scrawl.test${path}`, init));
let nextIp = 0;
// A fresh client IP per call, so tests do not eat each other's publish limit.
const publish = (html: string, headers: Record<string, string> = { "content-type": "text/html" }) =>
  call("/api/publish", { method: "POST", body: html, headers: { "cf-connecting-ip": `10.0.0.${++nextIp}`, ...headers } });

describe("publish and serve", () => {
  it("publishes raw html and serves it back with security headers and the shim", async () => {
    const res = await publish("<html><head><title>Hello pad</title></head><body>hi</body></html>");
    expect(res.status).toBe(201);
    const { id, url, edit_key } = await res.json<{ id: string; url: string; edit_key: string }>();
    expect(url).toBe(`https://scrawl.test/p/${id}`);
    expect(edit_key).toHaveLength(32);

    const page = await call(`/p/${id}`);
    expect(page.status).toBe(200);
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("sandbox allow-scripts");
    expect(csp).toContain("allow-popups-to-escape-sandbox");
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https:");
    expect(csp).toContain("font-src data: https:");
    expect(csp).toContain("img-src 'self' data: blob: https:");
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    const body = await page.text();
    expect(body).toContain("<body>hi<div ");
    expect(body).toContain("localStorage");
  });

  it("accepts a JSON body with an explicit title", async () => {
    const res = await publish(JSON.stringify({ html: "<p>x</p>", title: "T" }), { "content-type": "application/json" });
    expect(res.status).toBe(201);
  });

  it("rejects empty, malformed and oversized pads", async () => {
    expect((await publish("   ")).status).toBe(400);
    expect((await publish("{}", { "content-type": "application/json" })).status).toBe(400);
    expect((await publish("x".repeat(1_000_001))).status).toBe(413);
  });

  it("refuses password fields on publish and update", async () => {
    const res = await publish('<title>t</title><form><input type="password" name="p"></form>');
    expect(res.status).toBe(422);
    expect((await res.json<{ error: string }>()).error).toContain("passwords");
    const { id, edit_key } = await (await publish("<title>t</title>")).json<{ id: string; edit_key: string }>();
    const put = await call(`/api/pads/${id}`, { method: "PUT", body: "<input type=password>", headers: { "x-edit-key": edit_key } });
    expect(put.status).toBe(422);
  });

  it("returns JSON errors with a stable code", async () => {
    expect(await (await publish("   ")).json()).toEqual({ error: "empty pad", code: "empty_pad" });
    const put = await call("/api/pads/nope", { method: "PUT", body: "<p>x</p>", headers: { "x-edit-key": "k" } });
    expect(await put.json()).toEqual({ error: "not found", code: "not_found" });
  });

  it("returns 404 for an unknown pad", async () => {
    expect((await call("/p/nope")).status).toBe(404);
  });
});

describe("pad subdomains", () => {
  const at = (url: string, init?: RequestInit) => exports.default.fetch(new Request(url, init));
  const publishOn = async (html: string) =>
    (await at("https://scrawls.dev/api/publish", { method: "POST", body: html, headers: { "content-type": "text/html", "cf-connecting-ip": `10.9.0.${++nextIp}` } })).json<{ id: string; url: string; edit_key: string }>();

  it("gives each pad its own origin on the pad domain, with real storage", async () => {
    const { id, url } = await publishOn("<title>t</title><h1>own origin</h1>");
    expect(url).toBe(`https://${id}.scrawls.dev/`);
    const page = await at(url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("allow-same-origin");
    const body = await page.text();
    expect(body).toContain("own origin");
    expect(body).not.toContain("Object.defineProperty(window");
    expect(body).toMatch(new RegExp(`og:image" content="https://${id}\\.scrawls\\.dev/i/og\\.jpg\\?v=\\d+"`));
  });

  it("links every pad back to the home page, once, at the end of the body", async () => {
    const { url } = await publishOn("<title>t</title><body><h1>x</h1></body>");
    const body = await (await at(url)).text();
    expect(body.match(/Made with Scrawl/g)).toHaveLength(1);
    expect(body).toContain('href="https://scrawls.dev/?ref=pad"');
    expect(body.indexOf("Made with Scrawl")).toBeLessThan(body.lastIndexOf("</body>"));
    expect(body.indexOf("Made with Scrawl")).toBeGreaterThan(body.indexOf("<h1>"));
  });

  it("serves only the pad and shared files on a pad subdomain", async () => {
    const { id } = await publishOn("<title>t</title>");
    expect((await at(`https://${id}.scrawls.dev/scrawl.js`)).status).toBe(200);
    expect((await at(`https://${id}.scrawls.dev/guide.md`)).status).toBe(404);
    expect((await at(`https://${id}.scrawls.dev/api/publish`, { method: "POST", body: "x" })).status).toBe(404);
    expect((await at("https://zzzzzzzz.scrawls.dev/")).status).toBe(404);
  });

  it("redirects old /p links on the pad domain and keeps them elsewhere", async () => {
    const { id } = await publishOn("<title>t</title>");
    const old = await at(`https://scrawls.dev/p/${id}`, { redirect: "manual" });
    expect(old.status).toBe(301);
    expect(old.headers.get("location")).toBe(`https://${id}.scrawls.dev/`);
    const elsewhere = await call(`/p/${id}`);
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.headers.get("content-security-policy")).not.toContain("allow-same-origin");
  });
});

describe("reports", () => {
  const report = (pad: string, reason: string, ip: string) =>
    call("/api/report", { method: "POST", body: JSON.stringify({ pad, reason, details: "x" }), headers: { "content-type": "application/json", "cf-connecting-ip": ip } });

  it("links each pad to the report page", async () => {
    const { id } = await (await publish("<title>t</title><body>x</body>")).json<{ id: string }>();
    expect(await (await call(`/p/${id}`)).text()).toContain(`href="https://scrawl.test/report?pad=${id}"`);
    expect(await (await call("/examples/dashboard")).text()).not.toContain("/report?pad=");
  });

  it("serves the report page", async () => {
    const page = await call("/report");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Report a page");
    expect(await (await call("/")).text()).toContain('href="/report"');
  });

  it("validates the reason and the pad", async () => {
    const { id } = await (await publish("<title>t</title>")).json<{ id: string }>();
    expect((await report(id, "boring", "9.0.0.1")).status).toBe(400);
    expect((await report("zzzzzzzz", "scam", "9.0.0.1")).status).toBe(404);
  });

  it("hides a pad once enough distinct readers report it, counting each reader once", async () => {
    const { id } = await (await publish("<title>t</title>")).json<{ id: string }>();
    expect((await report(id, "phishing", "9.0.1.1")).status).toBe(200);
    expect((await report(id, "phishing", "9.0.1.1")).status).toBe(200);
    await report(id, "scam", "9.0.1.2");
    expect((await call(`/p/${id}`)).status).toBe(200);
    await report(id, "phishing", "9.0.1.3");
    const hidden = await call(`/p/${id}`);
    expect(hidden.status).toBe(410);
    expect(await hidden.text()).toContain("removed");
  });
});

describe("private pads", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  type Published = { id: string; url: string; edit_key: string; private?: boolean };
  const publishPrivate = async (html: string) =>
    (await publish(JSON.stringify({ html, private: true }), { "content-type": "application/json" })).json<Published>();

  it("serves a private pad only with the key its url carries, and answers 404 like a missing pad otherwise", async () => {
    const { id, url, private: isPrivate } = await publishPrivate("<title>CVE</title><p>Secret details here</p>");
    expect(isPrivate).toBe(true);
    expect(url).toMatch(new RegExp(`^https://scrawl.test/p/${id}\\?k=[2-9a-z]{24}$`));
    const page = await call(new URL(url).pathname + new URL(url).search);
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("x-robots-tag")).toContain("noindex");
    const missing = await call("/p/zzzzzzzz");
    for (const res of [await call(`/p/${id}`), await call(`/p/${id}?k=wrong`)]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(await missing.clone().text());
    }
  });

  it("hides that an expired or taken-down private pad exists from readers without the key", async () => {
    const { id } = await publishPrivate("<title>t</title>");
    await env.DB.prepare("UPDATE pads SET expires_at = 0 WHERE id = ?").bind(id).run();
    expect((await call(`/p/${id}`)).status).toBe(404);
  });

  it("gives a private pad no preview picture and no description", async () => {
    const { id, url } = await publishPrivate("<title>t</title><p>Secret details here</p>");
    const body = await (await call(new URL(url).pathname + new URL(url).search)).text();
    expect(body).toContain('property="og:image" content="https://scrawl.test/og.png"');
    expect(body).not.toContain("og:description");
    expect((await call(`/p/${id}/i/og.jpg`)).status).toBe(404);
  });

  it("serves its images without the key, since their names cannot be guessed", async () => {
    const { id, edit_key } = await publishPrivate("<title>t</title>");
    const res = await call(`/api/pads/${id}/images`, { method: "POST", body: PNG, headers: { "x-edit-key": edit_key } });
    const { url } = await res.json<{ url: string }>();
    expect((await call(new URL(url).pathname)).status).toBe(200);
  });

  it("keeps the key through updates and refuses to switch a pad between private and public", async () => {
    const { id, url, edit_key } = await publishPrivate("<title>t</title>");
    const put = (body: string, type = "text/html") => call(`/api/pads/${id}`, { method: "PUT", body, headers: { "x-edit-key": edit_key, "content-type": type } });
    expect((await (await put("<p>v2</p>")).json<{ url: string }>()).url).toBe(url);
    expect((await (await put(JSON.stringify({ html: "<p>v3</p>", private: false }), "application/json")).json<{ code: string }>()).code).toBe("private_at_publish");
    const pub = await (await publish("<title>t</title>")).json<Published>();
    const res = await call(`/api/pads/${pub.id}?private=1`, { method: "PUT", body: "<p>x</p>", headers: { "x-edit-key": pub.edit_key } });
    expect(res.status).toBe(400);
    expect(pub.private).toBeUndefined();
  });

  it("takes ?private=1 with raw HTML, and keeps the key when redirecting to the pad subdomain", async () => {
    const res = await exports.default.fetch(
      new Request("https://scrawls.dev/api/publish?private=1", { method: "POST", body: "<title>t</title>", headers: { "content-type": "text/html", "cf-connecting-ip": `10.8.0.${++nextIp}` } }),
    );
    const { id, url } = await res.json<Published>();
    expect(url).toMatch(new RegExp(`^https://${id}\\.scrawls\\.dev/\\?k=[2-9a-z]{24}$`));
    expect((await exports.default.fetch(new Request(url))).status).toBe(200);
    expect((await exports.default.fetch(new Request(`https://${id}.scrawls.dev/`))).status).toBe(404);
    const old = await exports.default.fetch(new Request(`https://scrawls.dev/p/${id}${new URL(url).search}`, { redirect: "manual" }));
    expect(old.headers.get("location")).toBe(url);
  });
});

describe("data and series", () => {
  type Published = { id: string; url: string; edit_key: string; series?: boolean };
  const publishJson = async (body: object) => (await publish(JSON.stringify(body), { "content-type": "application/json" })).json<Published>();
  const putData = (id: string, key: string, body: string) => call(`/api/pads/${id}/data`, { method: "PUT", body, headers: { "x-edit-key": key, "content-type": "application/json" } });
  const putPage = (id: string, key: string, html: string) => call(`/api/pads/${id}`, { method: "PUT", body: html, headers: { "x-edit-key": key } });
  const page = async (url: string) => (await call(new URL(url).pathname + new URL(url).search)).text();

  it("serves the pad's data inline, escaped so it cannot close the script", async () => {
    const { id, url, edit_key } = await publishJson({ html: "<title>t</title>" });
    expect(await page(url)).not.toContain("scrawl-data");
    const res = await putData(id, edit_key, JSON.stringify({ n: 3, note: "</script><b>x" }));
    expect(res.status).toBe(200);
    const body = await page(url);
    const json = body.match(/<script type="application\/json" id="scrawl-data">(.*?)<\/script>/)![1];
    expect(json).not.toContain("<");
    expect(JSON.parse(json)).toEqual({ n: 3, note: "</script><b>x" });
  });

  it("needs the edit key and valid JSON under the size cap, and bumps the preview version", async () => {
    const { id, edit_key } = await publishJson({ html: "<title>t</title>" });
    expect((await putData(id, "wrong", "{}")).status).toBe(403);
    expect((await (await putData(id, edit_key, "{nope")).json<{ code: string }>()).code).toBe("bad_data");
    expect((await putData(id, edit_key, JSON.stringify("x".repeat(256_001)))).status).toBe(413);
    const before = (await env.DB.prepare("SELECT updated_at FROM pads WHERE id = ?").bind(id).first<{ updated_at: number }>())!.updated_at;
    await new Promise((done) => setTimeout(done, 5));
    await putData(id, edit_key, "[1]");
    const after = (await env.DB.prepare("SELECT updated_at FROM pads WHERE id = ?").bind(id).first<{ updated_at: number }>())!.updated_at;
    expect(after).toBeGreaterThan(before);
  });

  it("keeps each replaced page of a series pad as an edition with the data it had, linked from the pad", async () => {
    const { id, url, edit_key, series } = await publishJson({ html: "<title>Week 1</title><p>one</p>", series: true });
    expect(series).toBe(true);
    await putData(id, edit_key, '{"week":1}');
    const res = await putPage(id, edit_key, "<title>Week 2</title><p>two</p>");
    const { archived } = await res.json<{ archived: string }>();
    expect(archived).toBe(`https://scrawl.test/p/${id}/e/1`);
    const old = await page(archived);
    expect(old).toContain("<p>one</p>");
    expect(old).toContain('{"week":1}');
    expect(old).toContain(`href="https://scrawl.test/p/${id}"`);
    expect(await page(url)).toContain(`href="https://scrawl.test/p/${id}/e"`);
    const list = await page(`${url}/e`);
    expect(list).toContain(`href="https://scrawl.test/p/${id}/e/1">Edition 1</a> · Week 1`);
    expect(list).toContain("Latest</a> · Week 2");
  });

  it("keeps only the last 30 editions, and deletes them with the pad", async () => {
    const { id, edit_key } = await publishJson({ html: "<title>t</title>", series: true });
    for (let i = 0; i < 32; i++) await putPage(id, edit_key, `<title>v${i}</title>`);
    const { n, low } = (await env.DB.prepare("SELECT COUNT(*) AS n, MIN(n) AS low FROM editions WHERE pad_id = ?").bind(id).first<{ n: number; low: number }>())!;
    expect([n, low]).toEqual([30, 3]);
    expect((await call(`/p/${id}/e/2`)).status).toBe(404);
    await call(`/api/pads/${id}`, { method: "DELETE", headers: { "x-edit-key": edit_key } });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM editions WHERE pad_id = ?").bind(id).first<{ n: number }>())!.n).toBe(0);
  });

  it("keeps no editions for other pads, and refuses to switch series on update", async () => {
    const { id, url, edit_key } = await publishJson({ html: "<title>t</title>" });
    const res = await putPage(id, edit_key, "<title>v2</title>");
    expect(await res.json()).not.toHaveProperty("archived");
    expect(await page(url)).not.toContain("Past editions");
    expect((await call(`/p/${id}/e`)).status).toBe(404);
    const flip = await call(`/api/pads/${id}?series=1`, { method: "PUT", body: "<p>x</p>", headers: { "x-edit-key": edit_key } });
    expect((await flip.json<{ code: string }>()).code).toBe("series_at_publish");
  });

  it("puts a private series pad's key on every edition link, and hides its editions without it", async () => {
    const { id, url, edit_key } = await publishJson({ html: "<title>t</title>", series: true, private: true });
    const key = new URL(url).search;
    const { archived } = await (await putPage(id, edit_key, "<title>v2</title>")).json<{ archived: string }>();
    expect(archived).toBe(`https://scrawl.test/p/${id}/e/1${key}`);
    expect((await call(`/p/${id}/e/1`)).status).toBe(404);
    expect((await call(`/p/${id}/e`)).status).toBe(404);
    expect(await page(`https://scrawl.test/p/${id}/e${key}`)).toContain(`/e/1${key}`);
  });

  it("serves editions on the pad subdomain", async () => {
    const at = (url: string, init?: RequestInit) => exports.default.fetch(new Request(url, init));
    const { id, edit_key } = await (
      await at("https://scrawls.dev/api/publish?series=1", { method: "POST", body: "<title>t</title><p>one</p>", headers: { "content-type": "text/html", "cf-connecting-ip": `10.7.0.${++nextIp}` } })
    ).json<Published>();
    const { archived } = await (await at(`https://scrawls.dev/api/pads/${id}`, { method: "PUT", body: "<p>two</p>", headers: { "x-edit-key": edit_key } })).json<{ archived: string }>();
    expect(archived).toBe(`https://${id}.scrawls.dev/e/1`);
    expect(await (await at(archived)).text()).toContain("<p>one</p>");
    expect((await at(`https://${id}.scrawls.dev/e`)).status).toBe(200);
  });

  it("cleans up the editions of pads deleted by hand", async () => {
    const { id, edit_key } = await publishJson({ html: "<title>t</title>", series: true });
    await putPage(id, edit_key, "<title>v2</title>");
    await env.DB.prepare("DELETE FROM pads WHERE id = ?").bind(id).run();
    await deleteExpired(env);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM editions WHERE pad_id = ?").bind(id).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("expiry", () => {
  const DAY = 86_400_000;
  const daysLeft = (iso: string) => Math.round((Date.parse(iso) - Date.now()) / DAY);

  it("keeps a pad 30 days by default, or what the agent asks up to a year", async () => {
    expect(daysLeft((await (await publish("<title>t</title>")).json<{ expires_at: string }>()).expires_at)).toBe(30);
    const asJson = await publish(JSON.stringify({ html: "<title>t</title>", expires_in_days: 90 }), { "content-type": "application/json" });
    expect(daysLeft((await asJson.json<{ expires_at: string }>()).expires_at)).toBe(90);
    const asQuery = await call("/api/publish?expires_in_days=365", { method: "POST", body: "<title>t</title>", headers: { "content-type": "text/html", "cf-connecting-ip": "10.7.0.1" } });
    expect(daysLeft((await asQuery.json<{ expires_at: string }>()).expires_at)).toBe(365);
    for (const bad of [0, 366, 1.5, "soon"]) {
      expect((await publish(JSON.stringify({ html: "<p>x</p>", expires_in_days: bad }), { "content-type": "application/json" })).status).toBe(400);
    }
  });

  it("restarts the lifetime on update, keeping the length asked before", async () => {
    const created = await publish(JSON.stringify({ html: "<title>t</title>", expires_in_days: 90 }), { "content-type": "application/json" });
    const { id, edit_key } = await created.json<{ id: string; edit_key: string }>();
    await env.DB.prepare("UPDATE pads SET expires_at = ? WHERE id = ?").bind(Date.now() + DAY, id).run();
    const put = await call(`/api/pads/${id}`, { method: "PUT", body: "<title>t2</title>", headers: { "x-edit-key": edit_key } });
    expect(daysLeft((await put.json<{ expires_at: string }>()).expires_at)).toBe(90);
  });

  it("stops serving an expired pad and the daily cleanup deletes it with its reports", async () => {
    const { id } = await (await publish("<title>old</title>")).json<{ id: string }>();
    const { id: fresh } = await (await publish("<title>fresh</title>")).json<{ id: string }>();
    await call("/api/report", { method: "POST", body: JSON.stringify({ pad: id, reason: "other" }), headers: { "content-type": "application/json", "cf-connecting-ip": "9.9.9.9" } });
    await env.DB.prepare("UPDATE pads SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, id).run();
    const expired = await call(`/p/${id}`);
    expect(expired.status).toBe(410);
    expect(await expired.text()).toContain("expired");
    await deleteExpired(env);
    expect(await env.DB.prepare("SELECT id FROM pads WHERE id = ?").bind(id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM reports WHERE pad_id = ?").bind(id).first()).toBeNull();
    expect((await call(`/p/${fresh}`)).status).toBe(200);
  });
});

describe("images", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const upload = (id: string, key: string, body: BodyInit, at = "https://scrawl.test") =>
    exports.default.fetch(new Request(`${at}/api/pads/${id}/images`, { method: "POST", body, headers: { "x-edit-key": key } }));
  const fresh = async () => (await (await publish("<title>t</title>")).json()) as { id: string; edit_key: string };

  it("stores an uploaded image and serves it from the pad with safe headers", async () => {
    const { id, edit_key } = await fresh();
    const res = await upload(id, edit_key, PNG);
    expect(res.status).toBe(201);
    const { url } = await res.json<{ url: string }>();
    expect(url).toMatch(new RegExp(`^https://scrawl.test/p/${id}/i/[2-9a-z]{8}\\.png$`));
    const img = await call(new URL(url).pathname);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
  });

  it("serves images from the pad subdomain on the pad domain", async () => {
    const created = await exports.default.fetch(new Request("https://scrawls.dev/api/publish", { method: "POST", body: "<title>t</title>", headers: { "content-type": "text/html", "cf-connecting-ip": "10.6.0.1" } }));
    const { id, edit_key } = await created.json<{ id: string; edit_key: string }>();
    const { url } = await (await upload(id, edit_key, PNG, "https://scrawls.dev")).json<{ url: string }>();
    expect(url).toMatch(new RegExp(`^https://${id}\\.scrawls\\.dev/i/[2-9a-z]{8}\\.png$`));
    expect((await exports.default.fetch(new Request(url))).status).toBe(200);
    expect((await exports.default.fetch(new Request(`https://${id}.scrawls.dev/i/nope0000.png`))).status).toBe(404);
  });

  it("refuses a wrong key, non-images, SVG and files over the size limit", async () => {
    const { id, edit_key } = await fresh();
    expect((await upload(id, "wrong", PNG)).status).toBe(403);
    expect((await upload(id, edit_key, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")).status).toBe(415);
    const big = new Uint8Array(2_000_001);
    big.set(PNG);
    expect((await upload(id, edit_key, big)).status).toBe(413);
  });

  it("caps the number of images per pad", async () => {
    const { id, edit_key } = await fresh();
    const nth = (i: number) => new Uint8Array([...PNG, i]);
    for (let i = 0; i < 20; i++) expect((await upload(id, edit_key, nth(i))).status).toBe(201);
    expect((await upload(id, edit_key, nth(20))).status).toBe(422);
  });

  it("stores the same file once per pad", async () => {
    const { id, edit_key } = await fresh();
    const first = await (await upload(id, edit_key, PNG)).json<{ url: string }>();
    const again = await (await upload(id, edit_key, PNG)).json<{ url: string }>();
    expect(again.url).toBe(first.url);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE pad_id = ?").bind(id).first<{ n: number }>())!.n).toBe(1);
  });

  it("takes images with the pad in a multipart form and points the page at them", async () => {
    const form = new FormData();
    form.append("html", new File(['<title>t</title><img src="photo.png" alt="p"><div style="background:url(\'photo.png\')"></div>'], "pad.html"));
    form.append("image", new File([PNG], "photo.png"));
    form.append("expires_in_days", "7");
    const res = await publish(form as unknown as string, {});
    expect(res.status).toBe(201);
    const { id, images, warnings, edit_key } = await res.json<{ id: string; images: Record<string, string>; warnings: string[]; edit_key: string }>();
    expect(images["photo.png"]).toMatch(new RegExp(`/p/${id}/i/[2-9a-z]{8}\\.png$`));
    expect(warnings).toEqual([]);
    const page = await (await call(`/p/${id}`)).text();
    expect(page).toContain(`src="${images["photo.png"]}"`);
    expect(page).toContain(`url('${images["photo.png"]}')`);
    expect((await call(new URL(images["photo.png"]).pathname)).status).toBe(200);

    const update = new FormData();
    update.append("html", '<title>t</title><img src="photo.png" alt="p">');
    update.append("image", new File([PNG], "photo.png"));
    const put = await call(`/api/pads/${id}`, { method: "PUT", body: update, headers: { "x-edit-key": edit_key } });
    expect((await put.json<{ images: Record<string, string> }>()).images["photo.png"]).toBe(images["photo.png"]);
  });

  it("takes base64 images in a JSON body and refuses files that are not images", async () => {
    const json = (images: Record<string, string>) => publish(JSON.stringify({ html: '<title>t</title><img src="a.png" alt="a">', images }), { "content-type": "application/json" });
    const ok = await json({ "a.png": btoa(String.fromCharCode(...PNG)) });
    expect(ok.status).toBe(201);
    expect(Object.keys((await ok.json<{ images: Record<string, string> }>()).images)).toEqual(["a.png"]);
    expect((await (await json({ "a.png": btoa("<svg/>") })).json<{ code: string }>()).code).toBe("image_type");
    expect((await (await json({ "a.png": "not base64!" })).json<{ code: string }>()).code).toBe("bad_json");
  });

  it("deletes images with their pad, and the daily cleanup catches pads deleted by hand", async () => {
    const a = await fresh();
    const { url: urlA } = await (await upload(a.id, a.edit_key, PNG)).json<{ url: string }>();
    await call(`/api/pads/${a.id}`, { method: "DELETE", headers: { "x-edit-key": a.edit_key } });
    expect(await env.IMAGES.get(`${a.id}/${urlA.split("/").pop()}`)).toBeNull();

    const b = await fresh();
    const { url: urlB } = await (await upload(b.id, b.edit_key, PNG)).json<{ url: string }>();
    await env.DB.prepare("DELETE FROM pads WHERE id = ?").bind(b.id).run();
    await deleteExpired(env);
    expect(await env.IMAGES.get(`${b.id}/${urlB.split("/").pop()}`)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM images WHERE pad_id = ?").bind(b.id).first()).toBeNull();
  });

  it("stops serving the images of a pad taken down after reports", async () => {
    const { id, edit_key } = await fresh();
    const { url } = await (await upload(id, edit_key, PNG)).json<{ url: string }>();
    await env.DB.prepare("UPDATE pads SET hidden_at = 1 WHERE id = ?").bind(id).run();
    expect((await call(new URL(url).pathname)).status).toBe(410);
  });
});

describe("pad brand tags", () => {
  const serve = async (html: string) => {
    const { id } = await (await publish(html)).json<{ id: string }>();
    return (await call(`/p/${id}`)).text();
  };

  it("adds a favicon and a link preview card with the pad title", async () => {
    const out = await serve('<html><head><title>My "pad" <3</title></head><body><h1>x</h1></body></html>');
    expect(out).toContain('rel="icon" type="image/svg+xml" href="/favicon.svg"');
    expect(out).toContain('property="og:title" content="My &quot;pad&quot; &lt;3"');
    expect(out).toContain('property="og:site_name" content="Scrawl"');
  });

  it("leaves a pad's own icon and preview tags alone, and still names Scrawl", async () => {
    const out = await serve('<html><head><title>t</title><link rel="icon" href="data:,"><meta property="og:title" content="Mine"></head></html>');
    expect(out).not.toContain("/favicon.svg");
    expect(out.match(/og:title/g)).toHaveLength(1);
    expect(out).toContain('property="og:site_name" content="Scrawl"');
    expect(out).toContain('property="og:image"');
  });

  it("previews each pad with its own picture, versioned by its last update", async () => {
    const { id, edit_key } = await (await publish("<title>t</title>")).json<{ id: string; edit_key: string }>();
    const { updated_at } = (await env.DB.prepare("SELECT updated_at FROM pads WHERE id = ?").bind(id).first<{ updated_at: number }>())!;
    const page = await (await call(`/p/${id}`)).text();
    expect(page).toContain(`property="og:image" content="https://scrawl.test/p/${id}/i/og.jpg?v=${updated_at}"`);

    // A picture taken for this version is served as it is, and the pad's upload limit does not count it.
    const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1, 2]);
    await env.IMAGES.put(`${id}/og.jpg`, JPEG, { customMetadata: { v: String(updated_at) } });
    await env.DB.prepare("INSERT INTO images (pad_id, name, bytes, created_at) VALUES (?, 'og.jpg', 5, 0)").bind(id).run();
    const img = await call(`/p/${id}/i/og.jpg?v=${updated_at}`);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);
    const { n } = (await env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE pad_id = ? AND name != 'og.jpg'").bind(id).first<{ n: number }>())!;
    expect(n).toBe(0);

    await call(`/api/pads/${id}`, { method: "DELETE", headers: { "x-edit-key": edit_key } });
    expect(await env.IMAGES.get(`${id}/og.jpg`)).toBeNull();
    expect((await call(`/p/${id}/i/og.jpg`)).status).toBe(404);
  });

  it("describes the pad with its meta description, else its first paragraph", async () => {
    expect(await serve('<title>t</title><meta name="description" content="Mine &amp; yours">')).toContain('property="og:description" content="Mine &amp; yours"');
    const out = await serve(`<title>t</title><h1>x</h1><p>First <b>bold</b>\n line.</p><p>second</p>`);
    expect(out).toContain('property="og:description" content="First bold line."');
    expect(await serve(`<title>t</title><p>${"word ".repeat(60)}</p>`)).toMatch(/og:description" content="(word ){39}word…"/);
    expect(await serve("<title>t</title><h1>x</h1>")).not.toContain("og:description");
  });
});

describe("mobile guarantee", () => {
  const serve = async (html: string) => {
    const { id } = await (await publish(html)).json<{ id: string }>();
    return (await call(`/p/${id}`)).text();
  };

  it("injects a viewport meta and base css when missing, but not twice", async () => {
    const bare = await serve("<html><head><title>t</title></head><body>x</body></html>");
    expect(bare).toContain('name="viewport"');
    expect(bare).toContain(":where(img,video)");
    const own = await serve('<html><head><meta name="viewport" content="width=device-width"><title>t</title></head></html>');
    expect(own.match(/name="viewport"/g)).toHaveLength(1);
  });

  it("keeps the doctype first so pads without <head> stay out of quirks mode", async () => {
    const out = await serve("<!doctype html><title>t</title><p>x</p>");
    expect(out.startsWith("<!doctype html>")).toBe(true);
    expect(out).toContain('name="viewport"');
    const withHtml = await serve("<!doctype html><html><body>x</body></html>");
    expect(withHtml).toMatch(/<html><head>.*viewport.*<\/head><body>/s);
  });
});

describe("publish warnings and hints", () => {
  const lint = async (html: string) => {
    const { warnings, advice } = await (await publish(html)).json<{ warnings: string[]; advice: string[] }>();
    return { warnings, advice };
  };
  const warn = async (html: string) => (await lint(html)).warnings;
  const advise = async (html: string) => (await lint(html)).advice;

  it("is silent for a clean pad", async () => {
    const html = '<!doctype html><meta name="viewport" content="width=device-width"><title>ok</title><h1>ok</h1><script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0"></script>';
    expect(await warn(html)).toEqual([]);
  });

  it("flags the problems a small model makes", async () => {
    const all = (await warn('<p>x</p><script src="https://evil.example/a.js"></script><script src="app.js"></script><form action="/go"></form><div style="width:900px"></div>')).join("\n");
    expect(all).toContain("No <title>");
    expect(all).toContain("evil.example");
    expect(all).toContain("Relative file reference");
    expect(all).toContain("Forms cannot submit");
    expect(all).toContain("Fixed width");
  });

  it("flags tiny text, and only advises on quality hints", async () => {
    const { warnings, advice } = await lint('<title>t</title><style>p{color:#fff;font-size:9px}</style><img src="https://example.com/a.png"><p>x</p>');
    expect(warnings.join()).toContain("Text under 12px");
    expect(advice.join("\n")).toContain("No <h1>");
    expect(advice.join("\n")).toContain("No viewport");
    expect(advice.join("\n")).toContain("Image without alt");
    expect(advice.join("\n")).toContain("Fixed colors");
  });

  it("does not flag fixed colors when the page declares its color scheme", async () => {
    const head = '<title>t</title><h1>t</h1><meta name="viewport" content="width=device-width">';
    expect(await lint(head + "<style>:root{color-scheme:dark}body{background:#0b0b0b}</style>")).toEqual({ warnings: [], advice: [] });
    expect(await lint(head + '<meta name="color-scheme" content="dark"><style>body{background:#0b0b0b}</style>')).toEqual({ warnings: [], advice: [] });
  });

  it("flags a hero text that is too long", async () => {
    const head = '<title>t</title><meta name="viewport" content="width=device-width"><h1>t</h1>';
    const long = "word ".repeat(70);
    expect((await advise(head + `<header class="hero"><h1>x</h1><p>${long}</p></header>`)).join()).toContain("hero text is long");
    expect((await advise(head + '<header class="hero"><p>Short and clear.</p></header>')).join()).not.toContain("hero text");
  });

  it("does not flag fixed colors when the page handles dark mode itself", async () => {
    const html = '<title>t</title><h1>t</h1><meta name="viewport" content="width=device-width"><style>p{color:#111}@media (prefers-color-scheme: dark){p{color:#eee}}</style><img src="https://upload.wikimedia.org/a.png" alt="">';
    expect(await warn(html)).toEqual([]);
  });

  it("flags leftover EDIT text", async () => {
    const head = '<meta name="viewport" content="width=device-width"><title>t</title>';
    expect((await warn(head + "<h2>EDIT: section</h2>")).join()).toContain("Leftover EDIT");
  });

  it("accepts the Scrawl stack script and its generated classes", async () => {
    const html = '<meta name="viewport" content="width=device-width"><title>t</title><script src="/scrawl.js"></script><h1 class="text-4xl md:text-5xl">t</h1><div class="card bg-base-100" x-data="{ n: 1 }">x</div>';
    expect(await warn(html)).toEqual([]);
  });

  it("flags Tailwind palette colors that ignore dark mode", async () => {
    const head = '<meta name="viewport" content="width=device-width"><title>t</title><h1>t</h1><script src="/scrawl.js"></script>';
    expect((await warn(head + '<p class="text-blue-500">x</p>')).join()).toContain("Fixed colors");
    expect((await warn(head + '<p class="bg-[#123456]">x</p>')).join()).toContain("Fixed colors");
    expect(await warn(head + '<p class="text-blue-600 dark:text-blue-300 text-primary">x</p>')).toEqual([]);
  });

  it("flags Alpine attributes outside every x-data", async () => {
    const head = '<meta name="viewport" content="width=device-width"><title>t</title><h1>t</h1><script src="/scrawl.js"></script>';
    const orphan = (await warn(head + `<section x-data='{ items: ["a"] }'><p x-text="items.length"></p></section><ul><template x-for="i in items"><li x-text="i"></li></template></ul>`)).join();
    expect(orphan).toContain("x-for is outside every x-data");
    expect(await warn(head + `<main x-data='{ items: ["a"], n: 1 }'><input x-model.number="n"><template x-for="i in items"><li x-text="i" :class="{ a: n }"></li></template><button @click="n++">+</button></main>`)).toEqual([]);
  });

  it("flags placeholder and made-up image hosts", async () => {
    const head = '<meta name="viewport" content="width=device-width"><title>t</title><h1>t</h1>';
    expect((await warn(head + '<img src="https://via.placeholder.com/300" alt="x">')).join()).toContain("Placeholder");
    expect((await warn(head + '<img src="https://source.unsplash.com/featured/?car" alt="x">')).join()).toContain("Placeholder");
    expect(await warn(head + '<img src="https://upload.wikimedia.org/a.jpg" alt="x">')).toEqual([]);
  });

  it("flags Alpine code that is not valid JavaScript, and accepts valid tricky cases", async () => {
    const head = '<meta name="viewport" content="width=device-width"><title>t</title><h1>t</h1><script src="/scrawl.js"></script>';
    const escaped = (await warn(head + `<main x-data="{ h: { a: 'A' } }"><b :aria-label=\\"h['a']+' on '+d["x"]"></b></main>`)).join();
    expect(escaped).toContain("not valid JavaScript");
    expect(escaped).toContain(":aria-label");
    const apostrophe = (await warn(head + `<main x-data='{ items: ["don't"] }'><p x-text="items.length"></p></main>`)).join();
    expect(apostrophe).toContain("not valid JavaScript");
    const valid = `<main x-data="{ n: 1, items: [&quot;a&quot;], go() { return this.n } }"><template x-for="(it, i) in items"><li x-text="it + i"></li></template><button @click="n++; go()">+</button><p x-ref="box" x-transition.opacity :class="{ 'font-bold': n > 1 }">x</p></main>`;
    expect(await warn(head + valid)).toEqual([]);
  });

  it("flags OpenStreetMap tiles, which are blocked for pads", async () => {
    const head = '<meta name="viewport" content="width=device-width"><title>t</title><h1>t</h1>';
    expect((await warn(head + '<script>L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png")</script>')).join()).toContain("OpenFreeMap");
  });

  it("holds scripts to the allowlist but lets stylesheets come from any https host", async () => {
    const head = '<meta name="viewport" content="width=device-width"><title>t</title><h1>t</h1>';
    expect(await warn(head + '<link rel="stylesheet" href="https://example.github.io/site.css">')).toEqual([]);
    expect((await warn(head + '<script src="https://example.github.io/app.js"></script>')).join()).toContain("Scripts blocked by the CSP");
  });

  it("does not flag normal links as relative files", async () => {
    const w = (await warn('<meta name="viewport" content="width=device-width"><title>t</title><a href="/other">x</a><a href="#top">y</a>')).join();
    expect(w).not.toContain("Relative");
  });

  it("returns ready-made update and delete instructions", async () => {
    const body = await (await publish("<title>t</title>")).json<{ id: string; edit_key: string; update: string; delete: string }>();
    expect(body.update).toContain(`PUT https://scrawl.test/api/pads/${body.id}`);
    expect(body.update).toContain(body.edit_key);
    expect(body.delete).toContain("DELETE");
  });
});

describe("warning stats", () => {
  it("counts published pads and warning codes without storing content", async () => {
    const read = async () => {
      const rows = (await env.DB.prepare("SELECT code, n FROM lint_stats").all<{ code: string; n: number }>()).results;
      return { rows, byCode: Object.fromEntries(rows.map((r) => [r.code, r.n])) as Record<string, number> };
    };
    const before = (await read()).byCode;
    await publish("<p>secret-content-xyz</p>");
    const { rows, byCode } = await read();
    expect(byCode.published - (before.published ?? 0)).toBe(1);
    expect(byCode["no-title"] - (before["no-title"] ?? 0)).toBe(1);
    expect(byCode["no-h1"] - (before["no-h1"] ?? 0)).toBe(1);
    expect(JSON.stringify(rows)).not.toContain("secret-content-xyz");
  });
});

describe("publish limit", () => {
  it("returns 429 after 20 pads from one ip, but not for another ip", async () => {
    const from = (ip: string) => publish("<p>x</p>", { "content-type": "text/html", "cf-connecting-ip": ip });
    for (let i = 0; i < 20; i++) expect((await from("1.1.1.1")).status).toBe(201);
    expect((await from("1.1.1.1")).status).toBe(429);
    expect((await from("2.2.2.2")).status).toBe(201);
  });
});

describe("update and delete", () => {
  async function fresh() {
    return (await (await publish("<p>v1</p>")).json()) as { id: string; edit_key: string };
  }

  it("updates with the right key only", async () => {
    const { id, edit_key } = await fresh();
    const put = (key?: string) =>
      call(`/api/pads/${id}`, { method: "PUT", body: "<p>v2</p>", headers: key ? { "x-edit-key": key } : {} });
    expect((await put()).status).toBe(403);
    expect((await (await put("wrong")).json<{ code: string }>()).code).toBe("bad_edit_key");
    expect((await put("wrong")).status).toBe(403);
    expect((await put(edit_key)).status).toBe(200);
    expect(await (await call(`/p/${id}`)).text()).toContain("v2");
  });

  it("deletes with the right key only", async () => {
    const { id, edit_key } = await fresh();
    const del = (key: string) => call(`/api/pads/${id}`, { method: "DELETE", headers: { "x-edit-key": key } });
    expect((await del("wrong")).status).toBe(403);
    expect((await del(edit_key)).status).toBe(204);
    expect((await call(`/p/${id}`)).status).toBe(404);
    expect((await del(edit_key)).status).toBe(404);
  });
});

const EXAMPLES = ["dashboard", "compare", "chart", "ranking", "itinerary", "quiz", "checklist", "faq", "calculator", "table", "diagram", "map"];

describe("examples", () => {
  it.each(EXAMPLES)("%s is served, linked from the homepage and lints clean", async (name) => {
    const res = await call(`/examples/${name}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    const published = await publish(html, { "content-type": "text/html", "cf-connecting-ip": `7.7.7.${EXAMPLES.indexOf(name) + 1}` });
    expect(published.status).toBe(201);
    expect((await published.json<{ warnings: string[] }>()).warnings).toEqual([]);
    expect(await (await call("/")).text()).toContain(`href="/examples/${name}"`);
  });
});

describe("check", () => {
  it("needs the edit key", async () => {
    const { id } = await (await publish("<title>t</title>")).json<{ id: string }>();
    expect((await call(`/api/pads/${id}/check`, { method: "POST", headers: { "x-edit-key": "wrong" } })).status).toBe(403);
  });
});

describe("mcp", () => {
  let id = 0;
  const rpc = async (method: string, params: object = {}) => {
    const res = await call("/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "cf-connecting-ip": `10.5.0.${++nextIp}` },
    });
    return (await res.json<{ result: any }>()).result;
  };
  const tool = async (name: string, args: object = {}) => {
    const { content, isError } = await rpc("tools/call", { name, arguments: args });
    return { body: JSON.parse(content[0].text), isError };
  };

  it("lists the pad tools and tells agents to read the guide first", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
    expect(init.instructions).toContain("get_guide");
    const names = (await rpc("tools/list")).tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(["get_guide", "get_recipe", "publish_pad", "update_pad", "update_data", "check_pad"]);
  });

  it("updates a pad's data", async () => {
    const { body } = await tool("publish_pad", { html: "<title>t</title>" });
    const res = await tool("update_data", { id: body.id, edit_key: body.edit_key, data: { a: 1 } });
    expect(res.isError).toBe(false);
    expect(await (await call(new URL(body.url).pathname)).text()).toContain('{"a":1}');
  });

  it("publishes and updates a pad through the HTTP API", async () => {
    const { body: pad } = await tool("publish_pad", { html: "<title>t</title><h1>v1</h1>", expires_in_days: 7 });
    expect(pad.url).toBe(`https://scrawl.test/p/${pad.id}`);
    const { body: updated } = await tool("update_pad", { id: pad.id, edit_key: pad.edit_key, html: "<title>t</title><h1>v2</h1>" });
    expect(updated.warnings).toEqual([]);
    expect(await (await call(`/p/${pad.id}`)).text()).toContain("v2");
    const refused = await tool("update_pad", { id: pad.id, edit_key: "wrong", html: "<p>x</p>" });
    expect(refused).toEqual({ body: { error: "bad edit key", code: "bad_edit_key" }, isError: true });
  });

  it("serves the guide and recipes", async () => {
    const guide = await rpc("tools/call", { name: "get_guide", arguments: {} });
    expect(guide.content[0].text).toContain("https://scrawl.test/api/publish");
    const recipe = await rpc("tools/call", { name: "get_recipe", arguments: { name: "chart" } });
    expect(recipe.content[0].text).toContain('<script src="/scrawl.js"></script>');
  });
});

describe("health", () => {
  it("answers ok when the database is up", async () => {
    const res = await call("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe("homepage and setup", () => {
  it("serves the homepage with absolute link preview urls", async () => {
    const res = await call("/");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Set up your agent");
    expect(html).toContain('content="https://scrawl.test/og.png"');
    expect(html).not.toContain("{{BASE_URL}}");
  });

  it("serves the brand assets", async () => {
    expect((await call("/favicon.svg")).status).toBe(200);
    expect((await call("/apple-touch-icon.png")).status).toBe(200);
    const og = await call("/og.png");
    expect(og.status).toBe(200);
    expect(og.headers.get("content-type")).toBe("image/png");
  });

  it("serves the guide and recipes dynamically with the base url", async () => {
    const guide = await (await call("/guide.md")).text();
    expect(guide).toContain("https://scrawl.test/api/publish");
    expect(guide).not.toContain("{{BASE_URL}}");
    expect(await (await call("/recipes/starter.html")).text()).toContain("viewport");
    expect(await (await call("/recipes/ranking.html")).text()).toContain('<script src="/scrawl.js"></script>');
    expect((await call("/recipes/nope.html")).status).toBe(404);
  });

  it("serves the examples through the pad security headers", async () => {
    const res = await call("/examples/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect(await res.text()).toContain("Support overview");
    expect((await call("/examples/dashboard.html")).status).toBe(200);
    expect((await call("/examples/nope")).status).toBe(404);
  });

  it("fills the base url into setup.md and the skill files", async () => {
    const setup = await (await call("/setup.md")).text();
    expect(setup).toContain("https://scrawl.test/skill/SKILL.md");
    expect(setup).not.toContain("{{BASE_URL}}");
    const skill = await (await call("/skill/SKILL.md")).text();
    expect(skill).toContain("https://scrawl.test");
    expect((await call("/skill/template.html")).status).toBe(404);
    expect((await call("/skill/missing.md")).status).toBe(404);
  });
});
