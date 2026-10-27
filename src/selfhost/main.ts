// Run Scrawl on Bun, outside Cloudflare: `bun src/selfhost/main.ts`. Settings default to the vars in wrangler.jsonc;
// any of them can be overridden by an environment variable of the same name. Data lives in DATA_DIR.
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker, { deleteExpired } from "../index";
import { DiskBucket, SqliteD1, staticAssets } from "./platform";

const ROOT = join(import.meta.dir, "../..");
const HOUR_MS = 3_600_000;

export function createEnv(dataDir: string, overrides: Record<string, string | undefined> = process.env) {
  const config = Bun.JSONC.parse(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")) as { vars: Record<string, string> };
  const vars = Object.fromEntries(Object.entries(config.vars).map(([name, value]) => [name, overrides[name] ?? value]));
  mkdirSync(dataDir, { recursive: true });
  const DB = new SqliteD1(join(dataDir, "scrawl.sqlite"));
  DB.migrate(join(ROOT, "migrations"));
  return { ...vars, DB, IMAGES: new DiskBucket(join(dataDir, "images")), ASSETS: staticAssets(join(ROOT, "public")) };
}

// Behind a reverse proxy that ends TLS, rebuild the address the reader used, so links and the guide say https://host.
function asSeenByReader(req: Request): Request {
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const host = req.headers.get("x-forwarded-host")?.split(",")[0].trim();
  if (!proto && !host) return req;
  const url = new URL(req.url);
  if (proto) url.protocol = `${proto}:`;
  if (host) {
    url.host = host;
    // The URL keeps the old port when the new host has none, and the proxy's public port is the default one.
    if (!host.includes(":")) url.port = "";
  }
  return new Request(url, req);
}

export function createHandler(env: ReturnType<typeof createEnv>) {
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
  return (req: Request) => worker.fetch(asSeenByReader(req), env as any, ctx as any);
}

if (import.meta.main) {
  const env = createEnv(process.env.DATA_DIR ?? join(ROOT, "data"));
  const port = Number(process.env.PORT ?? 8787);
  setInterval(() => deleteExpired(env as any).catch((err) => console.error("cleanup failed", err)), HOUR_MS);
  Bun.serve({ port, fetch: createHandler(env), maxRequestBodySize: Number(env.MAX_PAD_BYTES) + Number(env.IMAGE_MAX_BYTES) * Number(env.IMAGE_MAX_PER_PAD) * 2 });
  console.log(`Scrawl listening on http://localhost:${port}`);
}
