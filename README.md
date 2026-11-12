# Obsidian MCP Server for Cloudflare Workers

**English** | [Українська](README.uk.md)

An MCP (Model Context Protocol) server that gives AI assistants read and write
access to your Obsidian vault. Runs on Cloudflare Workers, stores notes in
**Koofr** (or any WebDAV host), and authenticates clients with **OAuth 2.1**.

Ask your assistant "what are my tasks for today" and get an answer from your real
vault. Say "add a task to call the bank" and the note is updated.

```
Claude / any MCP client
        │  OAuth 2.1 + Streamable HTTP
        ▼
  Cloudflare Worker  (/mcp)
        │  WebDAV (Basic auth)
        ▼
  your WebDAV storage  ──►  Koofr Sync / Remotely Save
                                  │
                                  ▼
                            Obsidian vault
```

## Why

Obsidian keeps notes on your device. There is no official remote API. This
project gives your AI assistant a narrow, auditable surface for reading and
writing those notes — without exposing your whole disk, without a paid sync
service, and without running a server at home.

Cloudflare Workers were chosen because the free tier is enough for personal
use, there is no machine to maintain, and the runtime is fast to cold start.

## Features

| Tool | What it does |
|---|---|
| `create_note` | Create a note. Never overwrites — appends ` 2`, ` 3` on name clash |
| `append_note` | Append text to an existing note |
| `read_note` | Read a note by path |
| `search_notes` | Search by file name and content, recursive |
| `list_notes` | List a folder |
| `daily_note` | Append to `Daily/YYYY-MM-DD.md`, creating it if needed |
| `today_tasks` | Open tasks for today, optionally across the whole vault |
| `add_task` | Add a `- [ ]` task with due date and priority |
| `create_folder` | Create a folder, including nested ones |
| `ping` | Verify WebDAV credentials and vault path |

Tasks follow the **Obsidian Tasks** convention: `- [ ]`, `- [x]`,
due date `📅 YYYY-MM-DD`, priority `⏫ 🔼 🔽`.

## Security

- **OAuth 2.1** with Dynamic Client Registration — the client registers itself.
- Authorization requires the owner password (`OWNER_PASSWORD`). Knowing the
  worker URL is not enough.
- Access tokens live for 1 hour, refresh tokens for 30 days.
- **Daily write limit** (`DAILY_WRITE_LIMIT`, counter in KV) — even a valid
  token cannot write more than N notes per day.
- **No delete or rename tools.** An assistant cannot destroy your notes.
- File names are sanitised (`\/:*?"<>|#^[]` removed).
- Notes are not polluted with metadata: the YAML header is empty unless you
  pass tags explicitly.
- Secrets are only ever set through `wrangler secret`, never in the repository.

## Requirements

- [Cloudflare account](https://dash.cloudflare.com/) (free tier works)
- Node.js 18+
- A WebDAV storage. For Koofr: an **app password**, not your account password
- An Obsidian vault synced to that storage (Koofr Sync, Remotely Save, or the
  Koofr desktop client)

## Setup

### 1. WebDAV credentials

For Koofr: open [koofr.eu](https://koofr.eu) → avatar → **Preferences →
Password → App passwords** → create one → copy it. It is shown only once.

The WebDAV endpoint is `https://app.koofr.net/dav/Koofr`.

### 2. Get the code

```bash
git clone https://github.com/RoboLask/obsidian-mcp-worker.git
cd obsidian-mcp-worker
npm install
```

> You need [Node.js](https://nodejs.org/) 18 or newer. Check with `node -v`.
> Git not installed? On GitHub click **Code → Download ZIP** and unpack it,
> then run `npm install` in that folder.

You do **not** need to create `.dev.vars` to deploy. That file is only for local
testing (`npx wrangler dev`); `npm run setup` asks for everything it needs.

### 3. Log in to Cloudflare

```bash
npx wrangler login
```

This opens your browser once. No API keys to copy around.

### 4. Create KV namespaces

Two namespaces are needed: one for the write counter, one for OAuth tokens.

```bash
npx wrangler kv namespace create MCP_COUNTER
npx wrangler kv namespace create OAUTH_KV
```

Put the returned `id` values into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_MCP_COUNTER_ID` and `REPLACE_WITH_YOUR_OAUTH_KV_ID`.

### 5. Set your worker URL

In `src/index.ts`:

```ts
const BASE_URL = "https://obsidian-mcp.example.workers.dev";
```

Replace with your own address. It is used in OAuth metadata and must match the
domain you deploy to.

### 6. Configure the vault path

In `wrangler.toml`:

```toml
VAULT_PATH = "/Obsidian"      # path inside WebDAV to the vault (where .obsidian/ lives)
DEFAULT_TZ = "Europe/Warsaw"  # timezone for daily note names and dates
```

Not sure about `VAULT_PATH`? Deploy first, then call the `ping` tool — it
reports how many objects it sees at that path.

### 7. Deploy

**One command — recommended:**

```bash
npm run setup
```

It asks for your WebDAV email and app password, generates the owner password,
sets all three secrets and deploys. At the end it prints your worker URL and the
owner password — save the password, you need it to connect a client.

Works the same on Windows, macOS and Linux. It is a small Node.js script and
uses the Node you already installed.

**Or do it manually:**

```bash
npx wrangler secret put KOOFR_EMAIL          # or your WebDAV username
npx wrangler secret put KOOFR_APP_PASSWORD   # or your WebDAV password
npx wrangler secret put OWNER_PASSWORD       # password for the login page
npx wrangler deploy
```

### 8. Connect your client

**Claude** — open claude.ai in a browser (mobile works too):

1. **Settings → Connectors → Add custom connector**
2. URL: `https://<your-worker>/mcp`
3. Authentication: leave the default (**OAuth**)
4. **Add** → you are redirected to the login page → enter `OWNER_PASSWORD`

After connecting on the web, the connector also appears in the Claude mobile app.

To force the assistant to use it, type `@` in a prompt and pick the connector.

### Other clients

This server was built and tested for **Claude** (web and mobile), because Claude
was the only client at the time that supported custom remote MCP connectors with
OAuth. The setup guide above is written for it.

It is not tied to Claude, though. Anything that speaks remote MCP will work:

- **ChatGPT** connectors (Developer mode, paid plans)
- **Claude Desktop** and other desktop MCP hosts, via `mcp-remote`
- **Cursor**, **Windsurf**, **VS Code** MCP support
- **LibreChat**, **Open WebUI**, **Msty** and similar self-hosted frontends
- **mcp-inspector** and your own scripts, for debugging

The requirements are the same everywhere: Streamable HTTP at `/mcp` and OAuth
authorization code flow with PKCE. Point the client at the worker URL and let it
register itself — it will land on the login page and ask for `OWNER_PASSWORD`.

The tools are plain MCP, so the assistant you use does not matter. What may
differ is how each client lets you reach them: Claude and ChatGPT offer a UI for
custom connectors, some desktop hosts need a JSON config entry, and self-hosted
frontends usually read a list of MCP servers from their own settings.

## How tasks work

`add_task` writes into a `## Задачи` / `## Tasks` section of the daily note if it
exists, otherwise appends to the end:

```markdown
## Tasks

- [ ] Call the bank ⏫ 📅 2026-11-14
- [ ] Buy milk
```

The section heading is only a convention; `add_task` also recognises `## Задачи`
and `## Задачі`, so an existing vault keeps working.

`today_tasks` reads `Daily/<today>.md` and returns unchecked items. With
`includeVault: true` it walks the whole vault (up to `maxFiles`, default 40) and
also returns open tasks from other notes, sorted by due date.

## Limitations

- `search_notes` reads files one by one — slow on very large vaults.
- No delete or rename by design.
- Streamable HTTP only; the legacy HTTP+SSE transport is not supported.

## Project layout

```
setup.js         interactive deploy script (Windows / macOS / Linux)
src/index.ts     routing and the OAuth provider wrapper
src/tools.ts     MCP tool definitions
src/koofr.ts     WebDAV client (HEAD / GET / PUT / MKCOL / PROPFIND)
src/markdown.ts  file names, frontmatter, dates
src/tasks.ts     Obsidian Tasks parser
src/login.ts     login page and signed sessions
```

## Local development

```bash
npx wrangler dev
```

Then call the MCP endpoint directly. The OAuth flow needs a real client; for
quick checks use the `ping` tool through your assistant, or `npx wrangler tail`
to watch requests.

## License

MIT. See [LICENSE](LICENSE).
