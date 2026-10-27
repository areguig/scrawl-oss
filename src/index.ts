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

// Every API error is JSON with a stable code, so an agent can tell it from a proxy or firewall page.
const fail = (status: number, code: string, error: string) => Response.json({ error, code }, { status });

type PadBody = { html: string; title?: string; ttlDays?: number; images: Map<string, Uint8Array<ArrayBuffer>> };
type PadFields = { html: unknown; title?: unknown; expires_in_days?: unknown; images: Map<string, Uint8Array<ArrayBuffer>> };

const BAD_JSON = 'JSON body must be {"html": string, "title"?: string, "expires_in_days"?: number, "images"?: {"<file name>": "<base64>"}}';
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0));

// A pad comes as raw HTML, as JSON, or as a multipart form whose file parts are the images the page refers to by file name.
async function readFields(req: Request): Promise<PadFields | Response> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => undefined);
    if (!form) return fail(400, "bad_form", "send a multipart form with an html field");
    const images = new Map<string, Uint8Array<ArrayBuffer>>();
    let html: unknown = form.get("html");
    for (const [name, value] of form) {
      if (typeof value === "string") continue;
      if (name === "html") html = await value.text();
      else images.set(value.name || name, new Uint8Array(await value.arrayBuffer()));
    }
    return { html, title: form.get("title") ?? undefined, expires_in_days: form.get("expires_in_days") ?? undefined, images };
  }
  const raw = await req.text();
  if (!type.includes("application/json")) return { html: raw, images: new Map() };
  try {
    const body = JSON.parse(raw) as Omit<PadFields, "images"> & { images?: Record<string, string> };
    return { ...body, images: new Map(Object.entries(body.images ?? {}).map(([name, data]) => [name, fromBase64(data)])) };
  } catch {
    return fail(400, "bad_json", BAD_JSON);
  }
}

// expires_in_days comes from the body, or from the query string when the body is raw HTML.
async function readPad(req: Request, env: Bindings): Promise<PadBody | Response> {
  const maxBytes = Number(env.MAX_PAD_BYTES);
  const maxRequest = maxBytes + Number(env.IMAGE_MAX_BYTES) * Number(env.IMAGE_MAX_PER_PAD) * 2;
  if (Number(req.headers.get("content-length") ?? 0) > maxRequest) return fail(413, "pad_too_large", "pad too large");
  const fields = await readFields(req);
  if (fields instanceof Response) return fields;
  const { html, images } = fields;
  if (typeof html !== "string") return fail(400, "bad_json", BAD_JSON);
  if (new TextEncoder().encode(html).length > maxBytes) return fail(413, "pad_too_large", "pad too large");
  const title = typeof fields.title === "string" ? fields.title.slice(0, 120) : undefined;
  const ttl = fields.expires_in_days ?? new URL(req.url).searchParams.get("expires_in_days") ?? undefined;
  const ttlDays = ttl === undefined ? undefined : Number(ttl);
  const maxTtlDays = Number(env.PAD_MAX_TTL_DAYS);
  if (ttlDays !== undefined && !(Number.isInteger(ttlDays) && ttlDays >= 1 && ttlDays <= maxTtlDays)) {
    return fail(400, "bad_expiry", `expires_in_days must be a whole number from 1 to ${maxTtlDays}`);
  }
  if (!html.trim()) return fail(400, "empty_pad", "empty pad");
  // Pads are public and anonymous: a password field is the shape of a phishing page.
  if (/<input\b[^>]*\btype\s*=\s*["']?password/i.test(html)) {
    return fail(422, "password_field", "Pads cannot ask for passwords. Remove the password field.");
  }
  return { html, title, ttlDays, images };
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

// For uptime monitors: up only when the database answers.
app.get("/health", async (c) => {
  await c.env.DB.prepare("SELECT 1").first();
  return c.json({ ok: true });
});

// Examples go through the same CSP and base styles as a real pad, so visitors see what a pad looks like.
app.get("/examples/:name", async (c) => {
  const asset = await fetchAsset(c, `/examples/${c.req.param("name").replace(/\.html$/, "")}.html`);
  if (!asset.ok) return c.text("Example not found", 404);
  return new Response(preparePad(await asset.text(), { origin: new URL(c.req.url).origin }), { headers: padHeaders(c.env.CDN_ALLOWLIST) });
});

// Known raster formats only; the same file sent again for the same pad is stored once.
async function storeImage(c: Context<{ Bindings: Bindings }>, id: string, bytes: Uint8Array<ArrayBuffer>): Promise<string | Response> {
  const maxBytes = Number(c.env.IMAGE_MAX_BYTES);
  if (bytes.length > maxBytes) return fail(413, "image_too_large", `image over ${maxBytes / 1_000_000} MB`);
  const type = imageTypeOf(bytes);
  if (!type) return fail(415, "image_type", "send the raw bytes of a JPEG, PNG, WebP or GIF file");
  const sha256 = await hashKey(bytes);
  const known = await c.env.DB.prepare("SELECT name FROM images WHERE pad_id = ? AND sha256 = ?").bind(id, sha256).first<{ name: string }>();
  if (known) return padImageUrl(c, id, known.name);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE pad_id = ?").bind(id).first<{ n: number }>();
  if ((count?.n ?? 0) >= Number(c.env.IMAGE_MAX_PER_PAD)) return fail(422, "image_limit", `a pad holds at most ${c.env.IMAGE_MAX_PER_PAD} images`);
  const name = `${newId()}.${type.ext}`;
  await c.env.IMAGES.put(`${id}/${name}`, bytes, { httpMetadata: { contentType: type.contentType } });
  await c.env.DB.prepare("INSERT INTO images (pad_id, name, bytes, created_at, sha256) VALUES (?, ?, ?, ?, ?)").bind(id, name, bytes.length, Date.now(), sha256).run();
  return padImageUrl(c, id, name);
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Stores the images sent with a pad and points the page's references to each file name (src="photo.jpg", url(photo.jpg)) at it.
async function attachImages(c: Context<{ Bindings: Bindings }>, id: string, body: PadBody): Promise<{ html: string; images: Record<string, string> } | Response> {
  let html = body.html;
  const images: Record<string, string> = {};
  for (const [name, bytes] of body.images) {
    const url = await storeImage(c, id, bytes);
    if (url instanceof Response) return url;
    images[name] = url;
    const file = escapeRegExp(name);
    html = html.replace(new RegExp(`(=\\s*["']?)(?:\\./)?${file}(?=["'\\s>])`, "g"), `$1${url}`).replace(new RegExp(`url\\((["']?)(?:\\./)?${file}\\1\\)`, "g"), `url($1${url}$1)`);
  }
  return { html, images };
}

app.post("/api/publish", async (c) => {
  const ipHash = await hashKey(clientIp(c));
  const since = Date.now() - Number(c.env.PUBLISH_WINDOW_SECONDS) * 1000;
  const recent = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM pads WHERE ip_hash = ? AND created_at > ?")
    .bind(ipHash, since)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= Number(c.env.PUBLISH_LIMIT)) {
    return fail(429, "publish_limit", "publish limit reached, try again later");
  }
  const body = await readPad(c.req.raw, c.env);
  if (body instanceof Response) return body;

  const id = newId();
  const attached = await attachImages(c, id, body);
  if (attached instanceof Response) return attached;
  const { html, images } = attached;
  const editKey = newEditKey();
  const now = Date.now();
  const ttlDays = body.ttlDays ?? Number(c.env.PAD_TTL_DAYS);
  const expiresAt = now + ttlDays * DAY_MS;
  await c.env.DB.prepare(
    "INSERT INTO pads (id, title, html, edit_key_hash, ip_hash, created_at, updated_at, ttl_days, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, body.title ?? extractTitle(html), html, await hashKey(editKey), ipHash, now, now, ttlDays, expiresAt)
    .run();
  const origin = publicOrigin(c);
  const issues = await lint(c, html);
  await logStats(c, "published", issues);
  return c.json(
    {
      id,
      url: padUrl(c, id),
      edit_key: editKey,
      expires_at: new Date(expiresAt).toISOString(),
      ...lintReply(issues),
      ...(body.images.size ? { images } : {}),
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

const authFailure = (status: 403 | 404) => (status === 404 ? fail(404, "not_found", "not found") : fail(403, "bad_edit_key", "bad edit key"));

app.put("/api/pads/:id", async (c) => {
  const id = c.req.param("id");
  const auth = await authorised(c, id);
  if (auth !== true) return authFailure(auth);
  const body = await readPad(c.req.raw, c.env);
  if (body instanceof Response) return body;
  const attached = await attachImages(c, id, body);
  if (attached instanceof Response) return attached;
  const { html, images } = attached;
  // An update restarts the pad's lifetime, with the length it asked for before unless it asks again.
  const now = Date.now();
  const row = await c.env.DB.prepare("UPDATE pads SET html = ?, title = ?, updated_at = ?, ttl_days = COALESCE(?, ttl_days), expires_at = ? + COALESCE(?, ttl_days) * ? WHERE id = ? RETURNING expires_at")
    .bind(html, body.title ?? extractTitle(html), now, body.ttlDays ?? null, now, body.ttlDays ?? null, DAY_MS, id)
    .first<{ expires_at: number }>();
  const issues = await lint(c, html);
  await logStats(c, "updated", issues);
  return c.json({ id, url: padUrl(c, id), expires_at: new Date(row!.expires_at).toISOString(), ...lintReply(issues), ...(body.images.size ? { images } : {}) });
});

app.delete("/api/pads/:id", async (c) => {
  const id = c.req.param("id");
  const auth = await authorised(c, id);
  if (auth !== true) return authFailure(auth);
  await c.env.DB.prepare("DELETE FROM pads WHERE id = ?").bind(id).run();
  await deletePadImages(c.env, [id]);
  return c.body(null, 204);
});

// The agent uploads an image file for its pad and puts the returned url in an <img src>.
app.post("/api/pads/:id/images", async (c) => {
  const id = c.req.param("id");
  const auth = await authorised(c, id);
  if (auth !== true) return authFailure(auth);
  const maxBytes = Number(c.env.IMAGE_MAX_BYTES);
  if (Number(c.req.header("content-length") ?? 0) > maxBytes) return fail(413, "image_too_large", `image over ${maxBytes / 1_000_000} MB`);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const url = await storeImage(c, id, bytes);
  if (url instanceof Response) return url;
  return c.json({ url, bytes: bytes.length }, 201);
});

const REPORT_REASONS = new Set(["phishing", "scam", "malware", "illegal", "other"]);

// Readers flag a pad; enough distinct readers hide it until someone reviews it in D1.
app.post("/api/report", async (c) => {
  const body = await c.req.json<{ pad?: unknown; reason?: unknown; details?: unknown }>().catch(() => ({}) as Record<string, unknown>);
  const pad = typeof body.pad === "string" ? body.pad : "";
  const reason = typeof body.reason === "string" ? body.reason : "";
  if (!REPORT_REASONS.has(reason)) return fail(400, "bad_reason", `reason must be one of: ${[...REPORT_REASONS].join(", ")}`);
  if (!(await c.env.DB.prepare("SELECT 1 FROM pads WHERE id = ?").bind(pad).first())) return fail(404, "not_found", "not found");
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
app.onError((err) => {
  console.error(err);
  return fail(500, "internal", "internal error, try again");
});

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
