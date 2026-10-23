// Operator tool: delete one pad and its reports in production. Usage: npm run pad:delete -- <id>
import { execFileSync } from "node:child_process";

const id = process.argv[2] ?? "";
if (!/^[2-9a-z]{8}$/.test(id)) {
  console.error("Usage: npm run pad:delete -- <pad id>, for example q5a4c283");
  process.exit(1);
}
const sql = `DELETE FROM reports WHERE pad_id = '${id}'; DELETE FROM pads WHERE id = '${id}';`;
execFileSync("npx", ["wrangler", "d1", "execute", "scrawl", "--remote", "--command", sql], { stdio: "inherit" });
