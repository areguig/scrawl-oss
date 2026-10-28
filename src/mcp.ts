// Scrawl as a remote MCP server: each tool is a thin wrapper over the HTTP API, so both behave the same.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

type Call = (path: string, init?: RequestInit) => Response | Promise<Response>;
type ToolResult = { content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; isError?: boolean };

const json = { "content-type": "application/json" };

const textResult = async (res: Response): Promise<ToolResult> => ({ content: [{ type: "text", text: await res.text() }], isError: !res.ok });

async function imageResult(res: Response): Promise<ToolResult> {
  if (!res.ok || !res.headers.get("content-type")?.startsWith("image/")) return textResult(res);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return { content: [{ type: "image", data: btoa(binary), mimeType: "image/png" }] };
}

const page = {
  html: z.string().describe("The whole HTML page"),
  title: z.string().optional(),
  expires_in_days: z.number().int().min(1).max(365).optional().describe("Days the pad lives after its last update (default 30)"),
  images: z.record(z.string(), z.string()).optional().describe('Image files the page refers to by file name, as {"photo.jpg": "<base64>"}'),
};
const pad = { id: z.string(), edit_key: z.string() };

function scrawlServer(call: Call): McpServer {
  const server = new McpServer({ name: "scrawl", version: "1.0.0" }, { instructions: "Call get_guide before making a page: it holds the rules and the recipes." });

  server.registerTool("get_guide", { description: "Read this first: how to make a good pad, the recipes to start from, and the rules." }, async () => textResult(await call("/guide.md")));

  server.registerTool(
    "get_recipe",
    { description: "Get a recipe page to fill in, by name from the guide (dashboard, compare, chart, article...).", inputSchema: { name: z.string() } },
    async ({ name }) => textResult(await call(`/recipes/${encodeURIComponent(name)}.html`)),
  );

  server.registerTool(
    "publish_pad",
    {
      description: "Publish an HTML page and get its link, plus the id and edit_key needed to change it. Fix every returned warning with update_pad.",
      inputSchema: {
        ...page,
        private: z.boolean().optional().describe("Only readers holding the returned url (it carries a key) can open the pad; anyone else gets 404. Set at publish, cannot change later."),
        series: z.boolean().optional().describe("Each update_pad keeps the page it replaces as a past edition, linked from the pad. For pages a scheduled job updates. Set at publish, cannot change later."),
      },
    },
    async (body) => textResult(await call("/api/publish", { method: "POST", headers: json, body: JSON.stringify(body) })),
  );

  server.registerTool(
    "update_pad",
    { description: "Replace the page of an existing pad, keeping its link.", inputSchema: { ...pad, ...page } },
    async ({ id, edit_key, ...body }) => textResult(await call(`/api/pads/${encodeURIComponent(id)}`, { method: "PUT", headers: { ...json, "x-edit-key": edit_key }, body: JSON.stringify(body) })),
  );

  server.registerTool(
    "update_data",
    {
      description: 'Replace the JSON data of a pad without sending its page again. The page reads it with JSON.parse(document.getElementById("scrawl-data").textContent).',
      inputSchema: { ...pad, data: z.unknown().describe("Any JSON value, up to 256 KB") },
    },
    async ({ id, edit_key, data }) =>
      textResult(await call(`/api/pads/${encodeURIComponent(id)}/data`, { method: "PUT", headers: { ...json, "x-edit-key": edit_key }, body: JSON.stringify(data) })),
  );

  server.registerTool(
    "check_pad",
    {
      description: "Open the pad on a phone screen and list what readers would hit (sideways scrolling, small text, broken images, script errors), or get a screenshot.",
      inputSchema: { ...pad, screenshot: z.boolean().optional() },
    },
    async ({ id, edit_key, screenshot }) =>
      imageResult(await call(`/api/pads/${encodeURIComponent(id)}/check${screenshot ? "?screenshot=1" : ""}`, { method: "POST", headers: { "x-edit-key": edit_key } })),
  );

  return server;
}

// Stateless: a new server per request, answering in plain JSON, so it runs on Workers and Bun alike.
export async function handleMcp(req: Request, call: Call): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await scrawlServer(call).connect(transport);
  return transport.handleRequest(req);
}
