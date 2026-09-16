/**
 * stdio transport entry point — Game Genie pattern.
 *
 * Instead of running a shared SSE server that multiple consumers connect to,
 * this runs as a subprocess of a single consumer. Communication is over
 * stdin/stdout pipes — no HTTP, no connection negotiation, near-native speed.
 *
 * Usage:
 *   npx tsx src/stdio.ts                    # all tools
 *   TOOLS=read,glob,grep npx tsx src/stdio.ts  # subset
 *
 * The consumer spawns this as a child process and communicates via JSON-RPC
 * over stdio, which is the standard MCP stdio transport.
 *
 * RESILIENCE — why the crash guards below exist:
 * For a `disableBuiltinTools` consumer (e.g. claude-pinnacle-stdio) this
 * subprocess IS the agent's entire file/shell toolset. The Claude CLI will not
 * respawn a stdio MCP server mid-session, and refreshMcp never rewires command-
 * based entries (container-manager.ts ~1497), so a NON-evolve consumer is toolless
 * until its cartridge restarts. An `evolve: true` consumer (e.g. claude-pinnacle-
 * stdio) is wrapped by the evolution bridge, which DOES respawn a dead child in
 * place (mcp-evolution-bridge.ts scheduleRespawn) and re-lists tools — but these
 * guards stay the first line of defence (and the only one for non-evolve
 * consumers). So a single unhandled async fault in one tool handler must NOT
 * take the whole server down. We log runtime faults to stderr and keep serving —
 * each in-flight call still errors individually via the SDK, which is far better
 * than every tool vanishing at once. A fault DURING startup is genuine death and
 * stays fatal (a live-but-unconnected server would be worse than a clean exit).
 *
 * stdout is JSON-RPC ONLY — never write to it here. One stray non-JSON byte
 * corrupts the frame and silently zeroes the toolset (the original outage).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

let ready = false;

function onFault(kind: string, detail: unknown): void {
  const msg = detail instanceof Error ? (detail.stack ?? detail.message) : String(detail);
  process.stderr.write(`ar-tools stdio ${kind}: ${msg}\n`);
  // Pre-connect, a fault means we never came up — exit so the parent sees a
  // clean failure rather than a live-but-toolless server. Post-connect, stay up.
  if (!ready) process.exit(1);
}

process.on("uncaughtException", (err) => onFault("uncaughtException", err));
process.on("unhandledRejection", (reason) => onFault("unhandledRejection", reason));

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const server = createMcpServer();
const transport = new StdioServerTransport();

try {
  await server.connect(transport);
  ready = true;
} catch (err) {
  const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`ar-tools stdio startup failed: ${msg}\n`);
  process.exit(1);
}
