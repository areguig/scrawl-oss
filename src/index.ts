import { Hono, type Context } from "hono";
import { capturePreview, checkPad } from "./check";
import { handleMcp } from "./mcp";
import { deleteImageObjects, IMAGE_NAME, imageHeaders, imageTypeOf } from "./images";
import { alpineIssues, escapeAttr, extractTitle, hashKey, lintPad, newEditKey, newId, newLinkKey, padHeaders, preparePad, scrawlLogo, type Issue } from "./pad";

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
  // Cloudflare Browser Rendering; absent on Bun.
  BROWSER?: Fetcher;
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

type PadBody = { html: string; title?: string; ttlDays?: number; isPrivate?: boolean; series?: boolean; images: Map<string, Uint8Array<ArrayBuffer>> };
type PadFields = { html: unknown; title?: unknown; expires_in_days?: unknown; private?: unknown; series?: unknown; images: Map<string, Uint8Array<ArrayBuffer>> };

const BAD_JSON = 'JSON body must be {"html": string, "title"?: string, "expires_in_days"?: number, "private"?: boolean, "series"?: boolean, "images"?: {"<file name>": "<base64>"}}';
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
    return { html, title: form.get("title") ?? undefined, expires_in_days: form.get("expires_in_days") ?? undefined, private: form.get("private") ?? undefined, series: form.get("series") ?? undefined, images };
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

// expires_in_days, private and series come from the body, or from the query string when the body is raw HTML.
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
  const query = new URL(req.url).searchParams;
  const flag = (value: unknown) => (value === undefined || value === null ? undefined : value === true || value === "1" || value === "true");
  const isPrivate = flag(fields.private ?? query.get("private"));
  const series = flag(fields.series ?? query.get("series"));
  if (!html.trim()) return fail(400, "empty_pad", "empty pad");
  // Pads are public and anonymous: a password field is the shape of a phishing page.
  if (/<input\b[^>]*\btype\s*=\s*["']?password/i.test(html)) {
    return fail(422, "password_field", "Pads cannot ask for passwords. Remove the password field.");
  }
  return { html, title, ttlDays, isPrivate, series, images };
}

// The link preview picture is kept with the pad's images so it is deleted with them, under a name no upload can have.
const PREVIEW = "og.jpg";
const PAD_ASSETS = new Set(["/scrawl.js", "/favicon.svg", "/apple-touch-icon.png", "/og.png"]);
const padIdOfHost = (host: string, padDomain: string) => {
  if (!padDomain) return undefined;
  const label = host.endsWith(`.${padDomain}`) ? host.slice(0, -padDomain.length - 1) : "";
  return /^[2-9a-z]{8}$/.test(label) ? label : undefined;
};

// With PAD_DOMAIN set (and a wildcard DNS record), each pad gets its own subdomain; without it, pads live under /p/<id>.
const onPadDomain = (c: Context<{ Bindings: Bindings }>) => {
  const host = new URL(c.req.url).host;
  return !!c.env.PAD_DOMAIN && (host === c.env.PAD_DOMAIN || !!padIdOfHost(host, c.env.PAD_DOMAIN));
};
const publicOrigin = (c: Context<{ Bindings: Bindings }>) => new URL(c.req.url).origin;

// Cloudflare sets cf-connecting-ip; behind another reverse proxy the client is the first X-Forwarded-For entry.
const clientIp = (c: Context<{ Bindings: Bindings }>) =>
  c.req.header("cf-connecting-ip") ?? c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? c.req.header("x-real-ip") ?? "unknown";

// path is a page under the pad, such as e/3; a private pad's link carries its key, without which the pad does not exist.
function padUrl(c: Context<{ Bindings: Bindings }>, id: string, linkKey?: string | null, path = ""): string {
  const url = onPadDomain(c) ? `https://${id}.${c.env.PAD_DOMAIN}/${path}` : `${publicOrigin(c)}/p/${id}${path && `/${path}`}`;
  return linkKey ? `${url}?k=${encodeURIComponent(linkKey)}` : url;
}

const padImageUrl = (c: Context<{ Bindings: Bindings }>, id: string, name: string) => padUrl(c, id, null, `i/${name}`);

const sameKey = async (given: string | undefined, expected: string) => !!given && (await hashKey(given)) === (await hashKey(expected));

type LivePad = { title: string; html: string; data: string | null; series: number; updated_at: number; link_key: string | null };

// A pad and its images are served only while it exists, has not expired and was not taken down.
// Images skip the link key: their names are unguessable, and the page that embeds them already has it.
async function livePad(c: Context<{ Bindings: Bindings }>, id: string, checkLinkKey = true): Promise<LivePad | Response> {
  const row = await c.env.DB.prepare("SELECT title, html, data, series, updated_at, hidden_at, expires_at, link_key FROM pads WHERE id = ?")
    .bind(id)
    .first<LivePad & { hidden_at: number | null; expires_at: number }>();
  // A wrong link key looks like a missing pad, before any other answer could tell that it exists.
  if (!row || (checkLinkKey && row.link_key && !(await sameKey(c.req.query("k"), row.link_key)))) return c.text("Pad not found", 404);
  // The daily cleanup can lag a day behind, so an expired pad is never served.
  if (row.expires_at < Date.now()) return c.text("This page expired.", 410);
  if (row.hidden_at) return c.text("This pad was removed after reports from readers.", 410);
  return row;
}

async function servePad(c: Context<{ Bindings: Bindings }>, id: string, isolated: boolean) {
  const row = await livePad(c, id);
  if (row instanceof Response) return row;
  const home = isolated ? `https://${c.env.PAD_DOMAIN}` : publicOrigin(c);
  // Versioned by the update, so link previews cached by chat apps refresh when the pad changes; private pads get the Scrawl card.
  const image = row.link_key ? undefined : `${padImageUrl(c, id, PREVIEW)}?v=${row.updated_at}`;
  const link = row.series ? { label: "Past editions", href: padUrl(c, id, row.link_key, "e") } : undefined;
  const html = preparePad(row.html, { origin: new URL(c.req.url).origin, home, isolated, padId: id, image, describe: !row.link_key, data: row.data, link });
  return new Response(html, { headers: padHeaders(c.env.CDN_ALLOWLIST, isolated) });
}

const editionDate = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

// A series pad's past editions, newest first, each a link; Scrawl writes this page, so it shows no pad content but titles.
async function serveEditions(c: Context<{ Bindings: Bindings }>, id: string, isolated: boolean) {
  const pad = await livePad(c, id);
  if (pad instanceof Response) return pad;
  if (!pad.series) return c.text("Not found", 404);
  const rows = await c.env.DB.prepare("SELECT n, title, created_at FROM editions WHERE pad_id = ? ORDER BY n DESC").bind(id).all<{ n: number; title: string; created_at: number }>();
  const item = (href: string, label: string, title: string, at: number) =>
    `<li><a href="${escapeAttr(href)}">${label}</a> · ${escapeAttr(title)} <small>${editionDate(at)}</small></li>`;
  const items = [item(padUrl(c, id, pad.link_key), "Latest", pad.title, pad.updated_at), ...rows.results.map((e) => item(padUrl(c, id, pad.link_key, `e/${e.n}`), `Edition ${e.n}`, e.title, e.created_at))];
  const html = `<!doctype html><html><head><title>Past editions: ${escapeAttr(pad.title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:40rem;margin:0 auto;padding:24px 16px}small{opacity:.6}</style></head><body><h1>Past editions</h1><ul>${items.join("")}</ul></body></html>`;
  const home = isolated ? `https://${c.env.PAD_DOMAIN}` : publicOrigin(c);
  return new Response(preparePad(html, { origin: new URL(c.req.url).origin, home, isolated, padId: id, describe: false }), { headers: padHeaders(c.env.CDN_ALLOWLIST, isolated) });
}

// One past edition, with the data it had then, served like the pad itself.
async function serveEdition(c: Context<{ Bindings: Bindings }>, id: string, n: string, isolated: boolean) {
  const pad = await livePad(c, id);
  if (pad instanceof Response) return pad;
  const edition = /^\d+$/.test(n) && (await c.env.DB.prepare("SELECT html, data FROM editions WHERE pad_id = ? AND n = ?").bind(id, Number(n)).first<{ html: string; data: string | null }>());
  if (!edition) return c.text("Not found", 404);
  const home = isolated ? `https://${c.env.PAD_DOMAIN}` : publicOrigin(c);
  const link = { label: "Latest edition", href: padUrl(c, id, pad.link_key) };
  const html = preparePad(edition.html, { origin: new URL(c.req.url).origin, home, isolated, padId: id, describe: !pad.link_key, data: edition.data, link });
  return new Response(html, { headers: padHeaders(c.env.CDN_ALLOWLIST, isolated) });
}

async function serveImage(c: Context<{ Bindings: Bindings }>, id: string, name: string) {
  if (!IMAGE_NAME.test(name)) return c.text("Not found", 404);
  const pad = await livePad(c, id, false);
  if (pad instanceof Response) return pad;
  const object = await c.env.IMAGES.get(`${id}/${name}`);
  if (!object) return c.text("Not found", 404);
  return new Response(object.body, { headers: imageHeaders(object.httpMetadata?.contentType ?? "application/octet-stream") });
}

// The link preview picture: the top of the pad, taken when first asked for after each update.
async function servePreview(c: Context<{ Bindings: Bindings }>, id: string) {
  // The preview has a fixed name, so a private pad never gets one.
  const pad = await livePad(c, id, false);
  if (pad instanceof Response) return pad;
  if (pad.link_key) return c.text("Not found", 404);
  const key = `${id}/${PREVIEW}`;
  const stored = await c.env.IMAGES.get(key);
  if (stored?.customMetadata?.v === String(pad.updated_at)) return new Response(stored.body, { headers: imageHeaders("image/jpeg") });
  const site = c.env.PAD_DOMAIN || new URL(c.req.url).host;
  const shot = c.env.BROWSER && (await capturePreview(c.env.BROWSER, padUrl(c, id), scrawlLogo(28), site).catch((err) => void console.error(err)));
  if (shot) {
    await c.env.IMAGES.put(key, shot, { httpMetadata: { contentType: "image/jpeg" }, customMetadata: { v: String(pad.updated_at) } });
    await c.env.DB.prepare("INSERT OR REPLACE INTO images (pad_id, name, bytes, created_at) VALUES (?, ?, ?, ?)").bind(id, PREVIEW, shot.length, Date.now()).run();
    return new Response(shot, { headers: imageHeaders("image/jpeg") });
  }
  // No browser here, or none free: the last picture, else the Scrawl card, cached briefly so the next request tries again.
  const body = stored?.body ?? (await fetchAsset(c, "/og.png")).body;
  return new Response(body, { headers: { ...imageHeaders(stored ? "image/jpeg" : "image/png"), "cache-control": "public, max-age=300" } });
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
  if (c.req.path === `/i/${PREVIEW}`) return servePreview(c, id);
  if (c.req.path === "/e") return serveEditions(c, id, true);
  if (c.req.path.startsWith("/e/")) return serveEdition(c, id, c.req.path.slice(3), true);
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
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE pad_id = ? AND name != ?").bind(id, PREVIEW).first<{ n: number }>();
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
  const linkKey = body.isPrivate ? newLinkKey() : null;
  const series = body.series ? 1 : 0;
  const now = Date.now();
  const ttlDays = body.ttlDays ?? Number(c.env.PAD_TTL_DAYS);
  const expiresAt = now + ttlDays * DAY_MS;
  await c.env.DB.prepare(
    "INSERT INTO pads (id, title, html, edit_key_hash, ip_hash, created_at, updated_at, ttl_days, expires_at, link_key, series) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, body.title ?? extractTitle(html), html, await hashKey(editKey), ipHash, now, now, ttlDays, expiresAt, linkKey, series)
    .run();
  const origin = publicOrigin(c);
  const issues = await lint(c, html);
  await logStats(c, "published", issues);
  return c.json(
    {
      id,
      url: padUrl(c, id, linkKey),
      edit_key: editKey,
      ...(linkKey ? { private: true } : {}),
      ...(series ? { series: true } : {}),
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

const padFlags = async (env: Bindings, id: string) =>
  (await env.DB.prepare("SELECT link_key, series FROM pads WHERE id = ?").bind(id).first<{ link_key: string | null; series: number }>()) ?? { link_key: null, series: 0 };

// Past editions kept per series pad; the oldest goes when a new one comes.
const EDITIONS_KEPT = 30;

const authFailure = (status: 403 | 404) => (status === 404 ? fail(404, "not_found", "not found") : fail(403, "bad_edit_key", "bad edit key"));

app.put("/api/pads/:id", async (c) => {
  const id = c.req.param("id");
  const auth = await authorised(c, id);
  if (auth !== true) return authFailure(auth);
  const body = await readPad(c.req.raw, c.env);
  if (body instanceof Response) return body;
  const { link_key: linkKey, series } = await padFlags(c.env, id);
  // Refused rather than ignored, so an agent never believes a public pad became private.
  if (body.isPrivate !== undefined && body.isPrivate !== !!linkKey) return fail(400, "private_at_publish", "a pad is private or public from its publish on: publish a new pad instead");
  if (body.series !== undefined && body.series !== !!series) return fail(400, "series_at_publish", "a pad keeps editions or not from its publish on: publish a new pad instead");
  const attached = await attachImages(c, id, body);
  if (attached instanceof Response) return attached;
  const { html, images } = attached;
  // An update restarts the pad's lifetime, with the length it asked for before unless it asks again.
  const now = Date.now();
  const update = c.env.DB.prepare("UPDATE pads SET html = ?, title = ?, updated_at = ?, ttl_days = COALESCE(?, ttl_days), expires_at = ? + COALESCE(?, ttl_days) * ? WHERE id = ? RETURNING expires_at")
    .bind(html, body.title ?? extractTitle(html), now, body.ttlDays ?? null, now, body.ttlDays ?? null, DAY_MS, id);
  // A series pad keeps the page it replaces, with the data it had, dated when it went live.
  const archive = [
    c.env.DB.prepare("INSERT INTO editions (pad_id, n, title, html, data, created_at) SELECT id, COALESCE((SELECT MAX(n) FROM editions WHERE pad_id = ?), 0) + 1, title, html, data, updated_at FROM pads WHERE id = ? RETURNING n").bind(id, id),
    c.env.DB.prepare("DELETE FROM editions WHERE pad_id = ? AND n <= (SELECT MAX(n) FROM editions WHERE pad_id = ?) - ?").bind(id, id, EDITIONS_KEPT),
  ];
  const results = await c.env.DB.batch<{ n?: number; expires_at?: number }>(series ? [...archive, update] : [update]);
  const row = results.at(-1)!.results[0] as { expires_at: number };
  const edition = series ? (results[0].results[0] as { n: number }).n : undefined;
  const issues = await lint(c, html);
  await logStats(c, "updated", issues);
  return c.json({
    id,
    url: padUrl(c, id, linkKey),
    expires_at: new Date(row.expires_at).toISOString(),
    ...(edition ? { archived: padUrl(c, id, linkKey, `e/${edition}`) } : {}),
    ...lintReply(issues),
    ...(body.images.size ? { images } : {}),
  });
});

app.delete("/api/pads/:id", async (c) => {
  const id = c.req.param("id");
  const auth = await authorised(c, id);
  if (auth !== true) return authFailure(auth);
  await c.env.DB.batch([c.env.DB.prepare("DELETE FROM pads WHERE id = ?").bind(id), c.env.DB.prepare("DELETE FROM editions WHERE pad_id = ?").bind(id)]);
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

const DATA_MAX_BYTES = 256_000;

// The agent refreshes the JSON the page reads inline, without sending the page again; past editions keep the data they had.
app.put("/api/pads/:id/data", async (c) => {
  const id = c.req.param("id");
  const auth = await authorised(c, id);
  if (auth !== true) return authFailure(auth);
  if (Number(c.req.header("content-length") ?? 0) > DATA_MAX_BYTES) return fail(413, "data_too_large", `data over ${DATA_MAX_BYTES / 1000} KB`);
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > DATA_MAX_BYTES) return fail(413, "data_too_large", `data over ${DATA_MAX_BYTES / 1000} KB`);
  let data: string;
  try {
    data = JSON.stringify(JSON.parse(raw));
  } catch {
    return fail(400, "bad_data", "send a JSON document as the body");
  }
  // Bumps updated_at like a page update, so the link preview and the pad's lifetime follow.
  const now = Date.now();
  const row = await c.env.DB.prepare("UPDATE pads SET data = ?, updated_at = ?, expires_at = ? + ttl_days * ? WHERE id = ? RETURNING expires_at, link_key")
    .bind(data, now, now, DAY_MS, id)
    .first<{ expires_at: number; link_key: string | null }>();
  return c.json({ id, url: padUrl(c, id, row!.link_key), bytes: data.length, expires_at: new Date(row!.expires_at).toISOString() });
});

// The author sees the pad as a phone reader does: problems found, or the screenshot with ?screenshot=1.
app.post("/api/pads/:id/check", async (c) => {
  const id = c.req.param("id");
  const auth = await authorised(c, id);
  if (auth !== true) return authFailure(auth);
  if (!c.env.BROWSER) return fail(501, "check_unavailable", "this Scrawl has no browser to check pads with");
  const withScreenshot = c.req.query("screenshot") === "1";
  const report = await checkPad(c.env.BROWSER, padUrl(c, id, (await padFlags(c.env, id)).link_key), withScreenshot).catch((err) => {
    console.error(err);
    return fail(503, "check_busy", "no browser free to check the pad: try again in a minute");
  });
  if (report instanceof Response) return report;
  if (report.screenshot) return new Response(report.screenshot, { headers: { "content-type": "image/png" } });
  return c.json({ url: report.url, width: report.width, problems: report.problems });
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

const CLIENT_HEADERS = ["cf-connecting-ip", "x-forwarded-for", "x-real-ip"];

// MCP tools call the HTTP API in-process, as the same client, so limits and checks apply to both alike.
app.all("/mcp", (c) =>
  handleMcp(c.req.raw, (path, init = {}) => {
    const headers = new Headers(init.headers);
    for (const name of CLIENT_HEADERS) {
      const value = c.req.header(name);
      if (value) headers.set(name, value);
    }
    return app.fetch(new Request(new URL(path, c.req.url), { ...init, headers }), c.env, c.executionCtx);
  }),
);

app.get(`/p/:id/i/${PREVIEW}`, (c) => servePreview(c, c.req.param("id")));
app.get("/p/:id/i/:name", (c) => serveImage(c, c.req.param("id"), c.req.param("name")));
app.get("/p/:id/e", (c) => serveEditions(c, c.req.param("id"), false));
app.get("/p/:id/e/:n", (c) => serveEdition(c, c.req.param("id"), c.req.param("n"), false));

app.get("/p/:id", async (c) => {
  const id = c.req.param("id");
  if (onPadDomain(c) && /^[2-9a-z]{8}$/.test(id)) return c.redirect(padUrl(c, id, c.req.query("k")), 301);
  return servePad(c, id, false);
});

app.notFound((c) => c.env.ASSETS.fetch(c.req.raw));
app.onError((err) => {
  console.error(err);
  return fail(500, "internal", "internal error, try again");
});

// Daily: delete expired pads, then the reports, editions and images left without a pad (also those of pads deleted by hand).
export async function deleteExpired(env: Bindings, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM pads WHERE expires_at < ?").bind(now),
    env.DB.prepare("DELETE FROM reports WHERE pad_id NOT IN (SELECT id FROM pads)"),
    env.DB.prepare("DELETE FROM editions WHERE pad_id NOT IN (SELECT id FROM pads)"),
  ]);
  const orphans = await env.DB.prepare("SELECT DISTINCT pad_id FROM images WHERE pad_id NOT IN (SELECT id FROM pads)").all<{ pad_id: string }>();
  await deletePadImages(env, orphans.results.map((r) => r.pad_id));
}

export default {
  fetch: app.fetch,
  scheduled: (_controller, env, ctx) => ctx.waitUntil(deleteExpired(env)),
} satisfies ExportedHandler<Bindings>;
