// The self-hosted runtime end to end: same app, Bun adapters. Run with `bun test src/selfhost`.
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deleteExpired } from "../index";
import { createEnv, createHandler } from "./main";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
let nextIp = 0;

function instance(overrides: Record<string, string> = {}) {
  const env = createEnv(mkdtempSync(join(tmpdir(), "scrawl-")), overrides);
  const handle = createHandler(env);
  const call = (url: string, init: RequestInit = {}) => handle(new Request(url, init));
  const publish = (html: string, base = "http://pads.test") =>
    call(`${base}/api/publish`, { method: "POST", body: html, headers: { "content-type": "text/html", "x-forwarded-for": `10.1.0.${++nextIp}` } });
  return { env, call, publish };
}

describe("self-hosted Scrawl", () => {
  it("publishes, serves, updates and deletes a pad in path mode", async () => {
    const { call, publish } = instance();
    const res = await publish("<title>t</title><h1>hello</h1>");
    expect(res.status).toBe(201);
    const { id, url, edit_key } = (await res.json()) as { id: string; url: string; edit_key: string };
    expect(url).toBe(`http://pads.test/p/${id}`);
    const page = await call(url);
    expect(page.headers.get("content-security-policy")).toContain("sandbox");
    expect(await page.text()).toContain("Made with Scrawl");
    expect((await call(`http://pads.test/api/pads/${id}`, { method: "PUT", body: "<h1>v2</h1>", headers: { "x-edit-key": edit_key } })).status).toBe(200);
    expect(await (await call(url)).text()).toContain("v2");
    expect((await call(`http://pads.test/api/pads/${id}`, { method: "DELETE", headers: { "x-edit-key": edit_key } })).status).toBe(204);
    expect((await call(url)).status).toBe(404);
  });

  it("answers the health check", async () => {
    const { call } = instance();
    expect(await (await call("http://pads.test/health")).json()).toEqual({ ok: true });
  });

  it("gives each pad its own subdomain when PAD_DOMAIN is set", async () => {
    const { call, publish } = instance({ PAD_DOMAIN: "pads.test" });
    const { id, url } = (await (await publish("<title>t</title>")).json()) as { id: string; url: string };
    expect(url).toBe(`https://${id}.pads.test/`);
    const page = await call(url);
    expect(page.headers.get("content-security-policy")).toContain("allow-same-origin");
    expect((await call(`https://${id}.pads.test/scrawl.js`)).status).toBe(200);
  });

  it("uses the reader's https address behind a reverse proxy", async () => {
    const { call } = instance();
    const guide = await call("http://localhost:8787/guide.md", { headers: { "x-forwarded-proto": "https", "x-forwarded-host": "scrawl.example.org" } });
    expect(await guide.text()).toContain("https://scrawl.example.org/api/publish");
  });

  it("serves static files like Cloudflare assets, and nothing outside public/", async () => {
    const { call } = instance();
    expect((await call("http://pads.test/")).status).toBe(200);
    expect(await (await call("http://pads.test/report")).text()).toContain("Report a page");
    expect((await call("http://pads.test/recipes/map.html")).status).toBe(200);
    expect((await call("http://pads.test/%2e%2e/package.json")).status).toBe(404);
  });

  it("stores images on disk and removes them with the pad", async () => {
    const { env, call, publish } = instance();
    const { id, edit_key } = (await (await publish("<title>t</title>")).json()) as { id: string; edit_key: string };
    const up = await call(`http://pads.test/api/pads/${id}/images`, { method: "POST", body: PNG, headers: { "x-edit-key": edit_key } });
    const { url } = (await up.json()) as { url: string };
    const img = await call(url);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    await env.DB.prepare("DELETE FROM pads WHERE id = ?").bind(id).run();
    await deleteExpired(env as never);
    expect(await env.IMAGES.get(`${id}/${url.split("/").pop()}`)).toBeNull();
  });

  it("hides reported pads and expires old ones", async () => {
    const { env, call, publish } = instance({ REPORT_HIDE_THRESHOLD: "2" });
    const { id, url } = (await (await publish("<title>t</title>")).json()) as { id: string; url: string };
    for (const ip of ["9.0.0.1", "9.0.0.2"]) {
      await call("http://pads.test/api/report", { method: "POST", body: JSON.stringify({ pad: id, reason: "scam" }), headers: { "content-type": "application/json", "x-forwarded-for": ip } });
    }
    expect((await call(url)).status).toBe(410);
    const { id: old } = (await (await publish("<title>old</title>")).json()) as { id: string };
    await env.DB.prepare("UPDATE pads SET expires_at = 0 WHERE id = ?").bind(old).run();
    await deleteExpired(env as never);
    expect(await env.DB.prepare("SELECT id FROM pads WHERE id = ?").bind(old).first()).toBeNull();
  });

  it("limits publishing per client address from X-Forwarded-For", async () => {
    const { call } = instance({ PUBLISH_LIMIT: "2" });
    const from = (ip: string) => call("http://pads.test/api/publish", { method: "POST", body: "<p>x</p>", headers: { "x-forwarded-for": `${ip}, 10.0.0.1` } });
    expect((await from("8.8.8.8")).status).toBe(201);
    expect((await from("8.8.8.8")).status).toBe(201);
    expect((await from("8.8.8.8")).status).toBe(429);
    expect((await from("8.8.4.4")).status).toBe(201);
  });
});
