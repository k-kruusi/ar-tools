# @agentruntime/tools

Developer tools as an MCP server — give any model shell, file ops, glob, grep, web fetch, plus code-aware symbol tools and a JSON/JSONL data-lens.

## Why this exists

Claude Code has powerful built-in CLI tools (bash, file read/write, glob, grep), but they're baked into the binary. Models that don't ship with CLI tools — Ollama, Anthropic SDK agents, custom agents — have no way to interact with the filesystem or run commands.

This package extracts those capabilities as an MCP server so any model can use them through the AgentRuntime mesh.

## Two transport modes

### SSE (shared, slower) — `src/index.ts`

Runs an HTTP server with SSE transport. Multiple consumers connect to the same instance over the network.

```
Model A ──HTTP──▶ tools:3012 ◀──HTTP── Model B
                      │
                 one process
```

**Pros:** One instance serves many consumers. Simple to set up — spawn once, connect many.

**Cons:** Every tool call pays HTTP overhead (connection setup, JSON-RPC over HTTP, SSE framing). A `ls` that takes 5ms natively costs 50-200ms through SSE. Multiply by dozens of tool calls per task and it adds up.

**Use when:** Multiple models need tools concurrently, or you want a quick shared setup.

### stdio (dedicated, fast) — `src/stdio.ts`

Runs as a subprocess of a single consumer. Communication is JSON-RPC over stdin/stdout pipes — no HTTP, no connection negotiation, near-native speed.

```
Model A ──pipe──▶ tools-stdio (instance A)
Model B ──pipe──▶ tools-stdio (instance B)
                      │
                 N processes
```

**Pros:** Near-native speed. No HTTP overhead. Perfect process isolation between consumers.

**Cons:** One instance per consumer. Each consumer spawns its own tools process. More processes running.

**Use when:** Speed matters. A single model needs fast tool access. The "Game Genie" pattern — plug tools directly into a model that doesn't have them.

We call this the **Game Genie pattern** because it's like snapping an enhancement cartridge onto a model — the model gains capabilities it wasn't born with, at near-native speed, but the enhancement is dedicated to that one model.

## Tools

| Tool | Description |
|------|-------------|
| `run_command` | Execute shell commands (**Git Bash on Windows**, bash on Linux/macOS; cmd.exe only as a fallback when Git for Windows is absent — so pipes, `grep`/`sed`/`head`, alternation, and POSIX quoting all work). Timeout support (default 5min, max 10min), 50KB output cap. |
| `read_file` | Read a file. **For code files (.ts/.js/.py) it returns a structural outline with line ranges by default** (tree-sitter) — use `offset`/`limit` for specific sections, or `raw=true` for the full file. Binary detection. |
| `write_file` | Write or overwrite files. Auto-creates parent directories. |
| `edit_file` | Find-and-replace with uniqueness checking. For code files, reports **structural ripple** — a deleted/renamed/re-categorized export or a changed signature, plus the files that import it (tree-sitter). On a failed match, diagnoses a near-match location (line numbers + preview) or exact multiple-match line numbers instead of a bare "not found". |
| `edit_range` | Replace a span of lines by number (1-based, inclusive) — for JSON/markdown/config or any fragment awkward to quote exactly. Echoes the replaced content back so a stale read is easy to catch. |
| `glob_files` | File pattern matching (e.g. `**/*.ts`). Results sorted by modification time. |
| `grep_search` | Regex search with output modes (`content`, `files_with_matches`, `count`), pagination, multiline, type filters. Uses ripgrep, falls back to findstr/grep. |
| `web_fetch` | Fetch a URL and return content (Readability → Markdown). Prefer mesh **web-fetch** (SSE) when available; use this only as fallback. |
| `vitals` | System vitals — CPU, memory, disk usage. |

### Code-aware tools (tree-sitter)

These run on the `@agentruntime/tree-sitter` AST parser and exist to slash context cost — read a file's *shape*, then surgically read only the symbol you need.

| Tool | Description |
|------|-------------|
| `file_outline` | Functions, classes, methods, interfaces with line ranges — a file's shape before you read it. |
| `read_symbol` | Read one named symbol's body (fewer tokens than the whole file). `fuzzy=true` for partial names; `followImports=true` to resolve a symbol from the file it's imported from. |
| `read_symbols` | Read several named symbols in one call; lists any that were missing. |
| `typecheck` | Run `tsc --noEmit` on the nearest `tsconfig.json`. Returns only the errors. |
| `edit_symbol` | Replace a named symbol's entire body (function / class / method / type) via tree-sitter — the write-side of `read_symbol`. Locates structurally (no exact-text match needed) and reports structural ripple to importers. |

### Data tools (data-lens)

The data-side analog of `file_outline`/`read_symbol` — read a JSON/JSONL record array's *shape*, then project only the fields you need, for far fewer tokens than reading the whole file.

| Tool | Description |
|------|-------------|
| `data_shape` | Infer a JSON/JSONL record array's shape without reading it whole — per field: type(s), optionality (presence %), a sample value, enum candidates, and semantic hints (epoch-ms / uuid / sha256). Claims-not-facts: stamps its sample size and won't claim "uniform" unless it read the entire array. |
| `data_select` | Project only the named field paths from a record array (the data-side `read_symbol`), with an optional jmespath `where` filter and `limit`. Dense TOON output. |

Tool registry keys (for the `TOOLS` env filter, below): `bash, read, write, edit, edit-range, glob, grep, web-fetch, vitals, file-outline, typecheck, read-symbol, edit-symbol, data-shape, data-select`.

## Quick start

### SSE mode (shared server)

```bash
# As an AgentRuntime template
!spawn tools -t tools

# Or standalone
cd packages/tools
npm install
npx tsx src/index.ts
# SSE server listening on port 3012
```

Connect any container via the mesh:

```json
{
  "my-agent": {
    "mcp": { "connect": ["tools"] }
  }
}
```

### stdio mode (Game Genie)

```bash
# Standalone — the consumer spawns this as a subprocess
npx tsx src/stdio.ts
```

Connect a container via stdio in `agentruntime.json`:

```json
{
  "my-agent": {
    "mcpServers": {
      "tools": {
        "command": "npx",
        "args": ["tsx", "packages/tools/src/stdio.ts"]
      }
    }
  }
}
```

Or use the `tools-stdio` template:

```
!spawn my-tools -t tools-stdio
```

## Configuration

### Port (SSE mode only)

Set `PORT` env var (default: `3012`).

### Path resolution

Relative paths (`run_command` cwd, `read_file`/`edit_file`/`write_file` paths, `glob_files`/`grep_search` roots) resolve against the **agentruntime root** — *not* the caller's cwd, and not the server's cwd. A shared SSE server is one process serving many consumers, so it genuinely can't know each caller's cwd; the root is the deliberate shared default (`$AGENTRUNTIME_ROOT` → walk up to `agentruntime.json` → `process.cwd()`). **Pass an absolute path, or an explicit `cwd`, to override.** (Per-consumer stdio instances could instead inherit the consumer's cwd — see `papers/agentruntime/plans/ar-tools-improvements.md`.)

### Tool filtering

Use the `TOOLS` env var to expose only specific tools:

```bash
TOOLS=read,glob,grep npx tsx src/stdio.ts
```

Only listed tools are registered. Omitted tools don't exist for consumers.

### Templates

| Template | Transport | Tools | Use case |
|----------|-----------|-------|----------|
| `tools` | SSE | All | Shared server, multiple consumers |
| `tools-readonly` | SSE | read, glob, grep, web-fetch | Safe access for untrusted agents |
| `tools-stdio` | stdio | All | Dedicated fast tools for one consumer |

## Architecture

- **`src/server.ts`** — `createMcpServer()` factory. Registers tools based on `TOOLS` env var. Transport-agnostic.
- **`src/index.ts`** — SSE entry point. HTTP server on `/mcp` with health check on `/health`. One `McpServer` per SSE connection.
- **`src/stdio.ts`** — stdio entry point. Single `McpServer` connected to stdin/stdout. No HTTP.
- Platform-aware: uses **Git Bash** on Windows (cmd.exe only as a fallback when Git for Windows isn't installed), bash on Linux/macOS.
