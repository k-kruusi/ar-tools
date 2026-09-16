# packages/tools — Source of Truth (ar-tools cartridge)

Blueprint for the **tools** package. The spawned cartridge is usually named **`ar-tools`** (`cartridges/ar-tools/`, port **3012**). Edit `packages/tools/src/`, not the cartridge copy (rebuild / dev junction).

Human spec: **`README.md`**. This file is the **agent invoke contract** only.

---

## What this is

**Developer-tools MCP** — shell, file I/O, grep/glob, tree-sitter symbols, JSON data-lens, vitals, bundled `web_fetch`. Gives models without built-in CLI the same capabilities (the **Game Genie** pattern via stdio).

---

## How agents reach it (two transports)

| Transport | When | How |
|-----------|------|-----|
| **stdio** (fast) | `disableBuiltinTools` agents (Grok Build, claude-pinnacle-stdio, …) | Harness spawns `npx tsx packages/tools/src/stdio.ts` (or cartridge path) as MCP child — **call tools by MCP name directly** (`read_file`, `run_command`, …). |
| **SSE** (shared) | Mesh `mcp.connect` from another cartridge | Container **`ar-tools`** (or template `tools`): `http://127.0.0.1:3012/mcp` → messages at `POST /mcp/messages?sessionId=…`. Supervisor `call_tool` / dashboard MCP proxy when wired. |

**Do not** use supervisor `tool_search` alone as your shell — that lists mesh tools; **stdio ar-tools** is plane-1 file/shell for in-cartridge agents.

### SSE endpoints

- **Connect:** `GET http://127.0.0.1:3012/mcp` (SSE; one `McpServer` per session)
- **Messages:** `POST http://127.0.0.1:3012/mcp/messages?sessionId=<id>`
- **Health:** `GET http://127.0.0.1:3012/health` → `{ status, sessions }`
- **Port env:** `PORT` (default **3012**); cartridge `EDITOR_PORT` does not apply here.

### Mesh wiring

In consumer `workspace.json` / spawn config:

```json
"mcp": { "connect": ["ar-tools"] }
```

Legacy docs may say `"tools"` — match the **registered container name** in `agentruntime.json` (typically `ar-tools`).

### Tool subset

`TOOLS` env (comma-separated registry keys) limits registration in **both** stdio and SSE:

`bash, read, write, edit, edit-symbol, edit-range, glob, grep, web-fetch, vitals, file-outline, typecheck, read-symbol, data-shape, data-select`

Omitted keys are not registered. Templates: `tools-readonly` exposes read/glob/grep/web-fetch only.

---

## MCP tool catalog (default: all)

| MCP name | Registry key | Role |
|----------|--------------|------|
| `run_command` | bash | Shell (Git Bash on Windows when available) |
| `read_file` | read | Read file; code → outline unless offset/limit/raw |
| `write_file` | write | Write/create file |
| `edit_file` | edit | Unique match replace + structural ripple |
| `edit_range` | edit-range | Line-span replace (1-based inclusive) |
| `edit_symbol` | edit-symbol | Replace symbol body (tree-sitter) |
| `glob_files` | glob | Glob under path |
| `grep_search` | grep | Regex search (rg → git-grep → findstr) |
| `web_fetch` | web-fetch | URL fetch fallback (not the web-fetch **cartridge** :3081). Prefer mesh web-fetch when connected. |
| `vitals` | vitals | CPU / memory / disk |
| `file_outline` | file-outline | Symbol outline with line ranges |
| `read_symbol` | read-symbol | One symbol body |
| `read_symbols` | read-symbol | Batch symbols (same register module) |
| `typecheck` | typecheck | `tsc --noEmit` nearest tsconfig |
| `data_shape` | data-shape | JSON/JSONL schema inference |
| `data_select` | data-select | Field projection + optional JMESPath filter |

`workspace.json` `mcp.notification` on **ar-tools** lists only the first six — **code registers all** unless `TOOLS` filters.

---

## Path and cwd rules (critical)

Relative paths and default **`run_command` cwd** resolve to **`agentruntimeRoot()`** — monorepo dir with `agentruntime.json` — **not** the agent cartridge cwd and not the shared SSE server's cwd (`cartridges/ar-tools`).

Override with **absolute paths** or explicit **`cwd`** on `run_command`.

Env: **`AGENTRUNTIME_ROOT`** if set and contains `agentruntime.json`.

---

## Bus / state

No event bus contract. No durable state files. Logs go to **stderr** in stdio mode (stdout is JSON-RPC only).

---

## Editing / rebuild

```bash
scripts/rebuild.ps1 -Name ar-tools   # package name mismatch: package is tools, cartridge is ar-tools
```

Package `tools` ↔ cartridge `ar-tools` — `rebuild.ps1 -Name tools` may not map; mirror by hand or use spawn script for `ar-tools`.

---

## Related

- **`web-fetch` cartridge** (`:3081`, path `/sse`) — dedicated fetch/search/login tools on the mesh; prefer when consumer already connects there.
- Full tool behavior: `packages/tools/README.md` and `src/tools/*.ts`.
