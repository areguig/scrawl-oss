// Checks that a live Scrawl answers the HTTP clients agents use, not only browsers: npm run smoke -- https://scrawls.dev
const base = process.argv[2] ?? "http://localhost:8787";
const agents = ["", "Python-urllib/3.13", "python-requests/2.32", "Go-http-client/2.0", "curl/8.7.1", "node"];
const paths = ["/guide.md", "/recipes/starter.html", "/health"];

let failed = 0;
for (const agent of agents) {
  const headers = { "user-agent": agent };
  const results = await Promise.all(paths.map(async (path) => `${path} ${(await fetch(base + path, { headers })).status}`));
  // An empty publish must get Scrawl's own JSON error, not a firewall page.
  const publish = await fetch(`${base}/api/publish`, { method: "POST", headers: { ...headers, "content-type": "text/html" }, body: " " });
  const code = (await publish.json().catch(() => ({}))).code;
  results.push(`publish ${publish.status}${code ? ` ${code}` : ""}`);
  const ok = results.every((r) => / (200|400 empty_pad)$/.test(r));
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${agent || "(no user agent)"}: ${results.join(", ")}`);
}
process.exit(failed ? 1 : 0);
