// The few Cloudflare bindings Scrawl uses, rebuilt on Bun: D1 on SQLite, R2 on disk, static assets from public/.
// Only the calls the app makes are covered. Bun and Workers types cannot share one tsc program, so the tests check this file.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join, normalize, sep } from "node:path";

class Statement {
  constructor(
    private db: Database,
    private sql: string,
    private args: SQLQueryBindings[] = [],
  ) {}

  bind(...args: SQLQueryBindings[]) {
    return new Statement(this.db, this.sql, args);
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.query(this.sql).get(...this.args) as Record<string, unknown> | null;
    return (row && column ? row[column] : row) as T | null;
  }

  async all<T>() {
    return { results: this.db.query(this.sql).all(...this.args) as T[], success: true, meta: {} };
  }

  async run() {
    return this.runNow();
  }

  runNow() {
    const { changes } = this.db.query(this.sql).run(...this.args);
    return { success: true, meta: { changes } };
  }
}

export class SqliteD1 {
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.run("PRAGMA journal_mode = WAL");
  }

  prepare(sql: string) {
    return new Statement(this.db, sql);
  }

  // D1 runs a batch as one transaction.
  async batch(statements: Statement[]) {
    return this.db.transaction(() => statements.map((s) => s.runNow()))();
  }

  // The same migrations/ files wrangler applies to D1, each applied once.
  migrate(dir: string) {
    this.db.run("CREATE TABLE IF NOT EXISTS _scrawl_migrations (name TEXT PRIMARY KEY)");
    const done = new Set(this.db.query("SELECT name FROM _scrawl_migrations").all().map((r) => (r as { name: string }).name));
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(name)) continue;
      const sql = readFileSync(join(dir, name), "utf8");
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.query("INSERT INTO _scrawl_migrations (name) VALUES (?)").run(name);
      })();
    }
  }
}

const IMAGE_KEY = /^[2-9a-z]{8}\/[2-9a-z]{8}\.(?:jpg|png|gif|webp)$/;

export class DiskBucket {
  constructor(private dir: string) {}

  private path(key: string) {
    if (!IMAGE_KEY.test(key)) throw new Error(`bad image key: ${key}`);
    return join(this.dir, key);
  }

  async put(key: string, bytes: Uint8Array) {
    await Bun.write(this.path(key), bytes);
  }

  // The content type comes from the file extension, which the app chose from the file's bytes.
  async get(key: string) {
    const file = Bun.file(this.path(key));
    if (!(await file.exists())) return null;
    return { body: file.stream(), httpMetadata: { contentType: file.type } };
  }

  async delete(keys: string | string[]) {
    await Promise.all([keys].flat().map((key) => rm(this.path(key), { force: true })));
  }
}

// Like Cloudflare's asset binding: /x serves x or x.html, a folder serves its index.html.
export function staticAssets(root: string) {
  const base = normalize(root) + sep;
  return {
    async fetch(input: Request | string) {
      let path = decodeURIComponent(new URL(typeof input === "string" ? input : input.url).pathname);
      if (path.endsWith("/")) path += "index.html";
      for (const candidate of [path, `${path}.html`]) {
        const full = normalize(join(base, candidate));
        if (!full.startsWith(base)) break;
        const file = Bun.file(full);
        if (await file.exists()) return new Response(file, { headers: { "content-type": file.type } });
      }
      return new Response("Not found", { status: 404 });
    },
  };
}
