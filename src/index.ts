import { Hono, type Context } from "hono";
import { deleteImageObjects, IMAGE_NAME, imageHeaders, imageTypeOf } from "./images";
import { alpineIssues, extractTitle, hashKey, lintPad, newEditKey, newId, padHeaders, preparePad, type Issue } from "./pad";

type Bindings = {
  ASSETS: Fetcher;
  DB: D1Database;
  PUBLISH_LIMIT: string;
  PUBLISH_WINDOW_SECONDS: string;
  MAX_PAD_BYTES: string;
  CDN_ALLOWLIST: string;
  PAD_DOMAIN: string;
  REPORT_HIDE_THRESHOLD: string;
  PAD_TTL_DAYS: string;
  PAD_MAX_TTL_DAYS: string;
  IMAGES: R2Bucket;
  IMAGE_MAX_BYTES: string;
  IMAGE_MAX_PER_PAD: string;
};

const DAY_MS = 86_400_000;

const app = new Hono<{ Bindings: Bindings }>();

// Cloudflare redirects /x.html to /x; follow it here so agents that do not follow redirects still get the file.
async function fetchAsset(c: Context<{ Bindings: Bindings }>, path = c.req.path): Promise<Response> {
  const url = new URL(path, c.req.url);
  const asset = await c.env.ASSETS.fetch(new Request(url));
  const location = asset.headers.get("location");
  if (asset.status >= 300 && asset.status < 400 && location) {
    return c.env.ASSETS.fetch(new Request(new URL(location, url)));
  }
  return asset;
}

// Setup instructions and skill files are static assets with the base URL filled in.
async function servePublicText(c: Context<{ Bindings: Bindings }>) {
  const asset = await fetchAsset(c);
  if (!asset.ok) return asset;
  const text = (await asset.text()).replaceAll("{{BASE_URL}}", new URL(c.req.url).origin);
  return new Response(text, { headers: { "content-type": asset.headers.get("content-type") ?? "text/plain" } });
}

// Counts only, never pad content: which warnings agents trigger most, so the recipes and guide can be fixed there.
async function logStats(c: Context<{ Bindings: Bindings }>, event: string, issues: Issue[]) {
  const day = new Date().toISOString().slice(0, 10);
  const stmt = c.env.DB.prepare("INSERT INTO lint_stats (day, code, n) VALUES (?, ?, 1) ON CONFLICT (day, code) DO UPDATE SET n = n + 1");
  await c.env.DB.batch([event, ...issues.map((i) => i.code)].map((code) => stmt.bind(day, code)));
}

async function lint(c: Context<{ Bindings: Bindings }>, html: string): Promise<Issue[]> {
  return [...lintPad(html, c.env.CDN_ALLOWLIST), ...(await alpineIssues(html))];
}

const messages = (issues: Issue[], level: Issue["level"]) => issues.filter((i) => i.level === level).map((i) => i.message);
const lintReply = (issues: Issue[]) => ({ warnings: messages(issues, "fix"), advice: messages(issues, "advice") });

type PadBody = { html: string; title?: string; ttlDays?: number };

// expires_in_days comes from the JSON body, or from the query string when the body is raw HTML.
async function readHtml(req: Request, maxBytes: number, maxTtlDays: number): Promise<PadBody | Response> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return Response.json({ error: "pad too large" }, { status: 413 });
  const raw = await req.text();
  if (new TextEncoder().encode(raw).length > maxBytes) return Response.json({ error: "pad too large" }, { status: 413 });
  let html = raw;
  let title: string | undefined;
  let ttl: unknown = new URL(req.url).searchParams.get("expires_in_days") ?? undefined;
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      const body = JSON.parse(raw) as { html?: unknown; title?: unknown; expires_in_days?: unknown };
      if (typeof body.html !== "string") throw new Error();
      html = body.html;
      if (typeof body.title === "string") title = body.title.slice(0, 120);
      ttl = body.expires_in_days ?? ttl;
    } catch {
      return Response.json({ error: 'JSON body must be {"html": string, "title"?: string, "expires_in_days"?: number}' }, { status: 400 });
    }
  }
  const ttlDays = ttl === undefined ? undefined : Number(ttl);
  if (ttlDays !== undefined && !(Number.isInteger(ttlDays) && ttlDays >= 1 && ttlDays <= maxTtlDays)) {
    return Response.json({ error: `expires_in_days must be a whole number from 1 to ${maxTtlDays}` }, { status: 400 });
  }
  if (!html.trim()) return Response.json({ error: "empty pad" }, { status: 400 });
  // Pads are public and anonymous: a password field is the shape of a phishing page.
  if (/<input\b[^>]*\btype\s*=\s*["']?password/i.test(html)) {
    return Response.json({ error: "Pads cannot ask for passwords. Remove the password field." }, { status: 422 });
  }
  return { html, title, ttlDays };
}

const PAD_ASSETS = new Set(["/scrawl.js", "/favicon.svg", "/apple-touch-icon.png", "/og.png"]);
const padIdOfHost = (host: string, padDomain: string) => {
  if (!padDomain) return undefined;
  const label = host.endsWith(`.${padDomain}`) ? host.slice(0, -padDomain.length - 1) : "";
  return /^[2-9a-z]{8}$/.test(label) ? label : undefined;
};

// With PAD_DOMAIN set (and a wildcard DNS record), each pad gets its own subdomain; without it, pads live under /p/<id>.
const onPadDomain = (c: Context<{ Bindings: Bindings }>) => !!c.env.PAD_DOMAIN && new URL(c.req.url).host === c.env.PAD_DOMAIN;
const publicOrigin = (c: Context<{ Bindings: Bindings }>) => new URL(c.req.url).origin;

// Cloudflare sets cf-connecting-ip; behind another reverse proxy the client is the first X-Forwarded-For entry.
const clientIp = (c: Context<{ Bindings: Bindings }>) =>
  c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? c.req.header("x-real-ip") ?? "unknown";

function padUrl(c: Context<{ Bindings: Bindings }>, id: string): string {
  return onPadDomain(c) ? `https://${id}.${c.env.PAD_DOMAIN}/` : `${publicOrigin(c)}/p/${id}`;
}

const padImageUrl = (c: Context<{ Bindings: Bindings }>, id: string, name: string) =>
  onPadDomain(c) ? `https://${id}.${c.env.PAD_DOMAIN}/i/${name}` : `${publicOrigin(c)}/p/${id}/i/${name}`;

// A pad and its images are served only while it exists, has not expired and was not taken down.
async function livePad(c: Context<{ Bindings: Bindings }>, id: string): Promise<{ html: string } | Response> {
  const row = await c.env.DB.prepare("SELECT html, hidden_at, expires_at FROM pads WHERE id = ?")
    .bind(id)
    .first<{ html: string; hidden_at: number | null; expires_at: number }>();
  if (!row) return c.text("Pad not found", 404);
  // The daily cleanup can lag a day behind, so an expired pad is never served.
  if (row.expires_at < Date.now()) return c.text("This page expired.", 410);
  if (row.hidden_at) return c.text("This pad was removed after reports from readers.", 410);
  return row;
}

async function servePad(c: Context<{ Bindings: Bindings }>, id: string, isolated: boolean) {
  const row = await livePad(c, id);
  if (row instanceof Response) return row;
  const home = isolated ? `https://${c.env.PAD_DOMAIN}` : publicOrigin(c);
  const html = preparePad(row.html, { origin: new URL(c.req.url).origin, home, isolated, padId: id });
  return new Response(html, { headers: padHeaders(c.env.CDN_ALLOWLIST, isolated) });
}

async function serveImage(c: Context<{ Bindings: Bindings }>, id: string, name: string) {
  if (!IMAGE_NAME.test(name)) return c.text("Not found", 404);
  const pad = await livePad(c, id);
  if (pad instanceof Response) return pad;
  const object = await c.env.IMAGES.get(`${id}/${name}`);
  if (!object) return c.text("Not found", 404);
  return new Response(object.body, { headers: imageHeaders(object.httpMetadata?.contentType ?? "application/octet-stream") });
}

async function deletePadImages(env: Bindings, padIds: string[]) {
  if (!padIds.length) return;
  const marks = padIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT pad_id, name FROM images WHERE pad_id IN (${marks})`).bind(...padIds).all<{ pad_id: string; name: string }>();
  await deleteImageObjects(env.IMAGES, rows.results.map((r) => `${r.pad_id}/${r.name}`));
  await env.DB.prepare(`DELETE FROM images WHERE pad_id IN (${marks})`).bind(...padIds).run();
}

// A pad subdomain serves only that pad and the few shared files a pad may reference.
app.use("*", async (c, next) => {
  const id = padIdOfHost(new URL(c.req.url).host, c.env.PAD_DOMAIN);
  if (!id) return next();
  if (c.req.path === "/") return servePad(c, id, true);
  if (c.req.path.startsWith("/i/")) return serveImage(c, id, c.req.path.slice(3));
  if (PAD_ASSETS.has(c.req.path)) return fetchAsset(c);
  return c.text("Not found", 404);
});

app.get("/", servePublicText);
app.get("/setup.md", servePublicText);
app.get("/skill/:file", servePublicText);
app.get("/guide.md", servePublicText);
app.get("/recipes/:file", servePublicText);

// Examples go through the same CSP and base styles as a real pad, so visitors see what a pad looks like.
app.get("/examples/:name", async (c) => {
  const asset = await fetchAsset(c, `/examples/${c.req.param("name").replace(/\.html$/, "")}.html`);
  if (!asset.ok) return c.text("Example not found", 404);
  return new Response(preparePad(await asset.text(), { origin: new URL(c.req.url).origin }), { headers: padHeaders(c.env.CDN_ALLOWLIST) });
});

app.post("/api/publish", async (c) => {
  const ipHash = await hashKey(clientIp(c));
  const since = Date.now() - Number(c.env.PUBLISH_WINDOW_SECONDS) * 1000;
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM pads WHERE ip_hash = ? AND created_at > ?")
    .bind(ipHash, since)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= Number(c.env.PUBLISH_LIMIT)) {
    return c.json({ error: "publish limit reached, try again later" }, 429);
  }
  const body = await readHtml(c.req.raw, Number(c.env.MAX_PAD_BYTES), Number(c.env.PAD_MAX_TTL_DAYS));
  if (body instanceof Response) return body;

  const id = newId();
  const editKey = newEditKey();
  const now = Date.now();
  const ttlDays = body.ttlDays ?? Number(c.env.PAD_TTL_DAYS);
  const expiresAt = now + ttlDays * DAY_MS;
  await c.env.DB.prepare(
    "INSERT INTO pads (id, title, html, edit_key_hash, ip_hash, created_at, updated_at, ttl_days, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, body.title ?? extractTitle(body.html), body.html, await hashKey(editKey), ipHash, now, now, ttlDays, expiresAt)
    .run();
  const origin = publicOrigin(c);
  const issues = await lint(c, body.html);
  await logStats(c, "published", issues);
  return c.json(
    {
      id,
      url: padUrl(c, id),
      edit_key: editKey,
      expires_at: new Date(expiresAt).toISOString(),
      ...lintReply(issues),
      update: `PUT ${origin}/api/pads/${id} with header x-edit-key: ${editKey} and the new HTML as the body (same link). Each update keeps the pad another ${ttlDays} days.`,
      delete: `DELETE ${origin}/api/pads/${id} with header x-edit-key: ${editKey}`,
    },
    201,
  );
});

async function authorised(c: { env: Bindings; req: { header(n: string): string | undefined } }, id: string) {
  const row = await c.env.DB.prepare("SELECT edit_key_hash FROM pads WHERE id = ?").bind(id).first<{ edit_key_hash: string }>();
  if (!row) return 404 as const;
  const key = c.req.header("x-edit-key");
  return key && (await hashKey(key)) === row.edit_key_hash ? true : (403 as const);
}

app.put("/api/pads/:id", async (c) => {
  const id = c.req.param("id");
  const auth = await authorised(c, id);
  if (auth !== true) return c.json({ error: auth === 404 ? "not found" : "bad edit key" }, auth);
  const body = await readHtml(c.req.raw, Number(c.env.MAX_PAD_BYTES), Number(c.env.PAD_MAX_TTL_DAYS));
  if (body instanceof Response) return body;
  // An update restarts the pad's lifetime, with the length it asked for before unless it asks again.
  const now = Date.now();
  const row = await c.env.DB.prepare("UPDATE pads SET html = ?, title = ?, updated_at = ?, ttl_days = COALESCE(?, ttl_days), expires_at = ? + COALESCE(?, ttl_days) * ? WHERE id = ? RETURNING expires_at")
    .bind(body.html, body.title ?? extractTitle(body.html), now, body.ttlDays ?? null, now, body.ttlDays ?? null, DAY_MS, id)
    .first<{ expires_at: number }>();
  const issues = await lint(c, body.html);
  await logStats(c, "updated", issues);
  return c.json({ id, url: padUrl(c, id), expires_at: new Date(row!.expires_at).toISOString(), ...lintReply(issues) });
});

app.delete("/api/pads/:id", async (c) => {
  const id = c.req.param("id");
  const auth = await authorised(c, id);
  if (auth !== true) return c.json({ error: auth === 404 ? "not found" : "bad edit key" }, auth);
  await c.env.DB.prepare("DELETE FROM pads WHERE id = ?").bind(id).run();
  await deletePadImages(c.env, [id]);
  return c.body(null, 204);
});

// The agent uploads an image file for its pad and puts the returned url in an <img src>.
app.post("/api/pads/:id/images", async (c) => {
  const id = c.req.param("id");
  const auth = await authorised(c, id);
  if (auth !== true) return c.json({ error: auth === 404 ? "not found" : "bad edit key" }, auth);
  const maxBytes = Number(c.env.IMAGE_MAX_BYTES);
  if (Number(c.req.header("content-length") ?? 0) > maxBytes) return c.json({ error: `image over ${maxBytes / 1_000_000} MB` }, 413);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length > maxBytes) return c.json({ error: `image over ${maxBytes / 1_000_000} MB` }, 413);
  const type = imageTypeOf(bytes);
  if (!type) return c.json({ error: "send the raw bytes of a JPEG, PNG, WebP or GIF file" }, 415);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE pad_id = ?").bind(id).first<{ n: number }>();
  if ((count?.n ?? 0) >= Number(c.env.IMAGE_MAX_PER_PAD)) return c.json({ error: `a pad holds at most ${c.env.IMAGE_MAX_PER_PAD} images` }, 422);
  const name = `${newId()}.${type.ext}`;
  await c.env.IMAGES.put(`${id}/${name}`, bytes, { httpMetadata: { contentType: type.contentType } });
  await c.env.DB.prepare("INSERT INTO images (pad_id, name, bytes, created_at) VALUES (?, ?, ?, ?)").bind(id, name, bytes.length, Date.now()).run();
  return c.json({ url: padImageUrl(c, id, name), bytes: bytes.length }, 201);
});

const REPORT_REASONS = new Set(["phishing", "scam", "malware", "illegal", "other"]);

// Readers flag a pad; enough distinct readers hide it until someone reviews it in D1.
app.post("/api/report", async (c) => {
  const body = await c.req.json<{ pad?: unknown; reason?: unknown; details?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const pad = typeof body.pad === "string" ? body.pad : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!REPORT_REASONS.has(reason)) return c.json({ error: `reason must be one of: ${[...REPORT_REASONS].join(", ")}` }, 400);
  if (!(await c.env.DB.prepare("SELECT 1 FROM pads WHERE id = ?").bind(pad).first())) return c.json({ error: "not found" }, 404);
  const details = typeof body.details === "string" ? body.details.slice(0, 1000) : null;
  const ipHash = await hashKey(clientIp(c));
  await c.env.DB.prepare("INSERT OR IGNORE INTO reports (pad_id, reason, details, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(pad, reason, details, ipHash, Date.now())
    .run();
  await c.env.DB.prepare("UPDATE pads SET hidden_at = ? WHERE id = ? AND hidden_at IS NULL AND (SELECT COUNT(*) FROM reports WHERE pad_id = ?) >= ?")
    .bind(Date.now(), pad, pad, Number(c.env.REPORT_HIDE_THRESHOLD))
    .run();
  return c.json({ ok: true });
});

app.get("/p/:id/i/:name", (c) => serveImage(c, c.req.param("id"), c.req.param("name")));

app.get("/p/:id", async (c) => {
  const id = c.req.param("id");
  if (onPadDomain(c) && /^[2-9a-z]{8}$/.test(id)) return c.redirect(padUrl(c, id), 301);
  return servePad(c, id, false);
});

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));

// Daily: delete expired pads, then the reports and images left without a pad (also those of pads deleted by hand).
export async function deleteExpired(env: Bindings, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pads WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM reports WHERE pad_id NOT IN (SELECT id FROM pads)"),
  ]);
  const orphans = await env.DB.prepare("SELECT DISTINCT pad_id FROM images WHERE pad_id NOT IN (SELECT id FROM pads)").all<{ pad_id: string }>();
  await deletePadImages(env, orphans.results.map((r) => r.pad_id));
}

export default {
  fetch: app.fetch,
  scheduled: (_controller, env, ctx) => ctx.waitUntil(deleteExpired(env)),
} satisfies ExportedHandler<Bindings>;
