# Set up Scrawl for this agent

Scrawl lets you publish a page and share the link. Install the one-file skill below, then tell the user it is ready. The skill only points at {{BASE_URL}}/guide.md, so it never needs updating.

## 1. Pick the skills directory
- Claude Code: `~/.claude/skills/scrawl/`
- Copilot CLI, OpenCode, omp, pi (or unsure): `~/.agents/skills/scrawl/`

If the user wants it for one project only, use `.claude/skills/scrawl/` or `.agents/skills/scrawl/` in the project instead.

## 2. Download the skill
```sh
DIR=~/.agents/skills/scrawl   # or the path chosen above
mkdir -p "$DIR"
curl -fsS {{BASE_URL}}/skill/SKILL.md -o "$DIR/SKILL.md"
ls "$DIR"
```
You must see `SKILL.md`. Do not edit it.

## 3. Tell the user
Say: "Scrawl is installed. Ask me to build a page, chart or small tool and I will publish it and send you a link. You may need to reload skills for it to appear."

Do not publish anything yet. Do not store secrets.

Agent without a shell or a skills folder (a web chat, for example): skip the install. Just read {{BASE_URL}}/guide.md when the user asks for a page.

Agent that takes remote MCP servers: instead of the skill, the user can add `{{BASE_URL}}/mcp` (Streamable HTTP, no sign-in). In Claude Code: `claude mcp add --transport http scrawl {{BASE_URL}}/mcp`.
