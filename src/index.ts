import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { EventSubscriber } from "@helmetfire-labs/cartridge-common";
import { init, getSymbol, getSymbols, getSymbolWithImports, getOutline, formatOutline, detectLanguage } from "@agentruntime/tree-sitter";
import { createMcpServer } from "./server.js";
import { normalizePath } from "./utils.js";

const PORT = parseInt(process.env.PORT || "3012", 10);

const sseTransports = new Map<string, SSEServerTransport>();

async function parseBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  try {
    if (req.method === "GET" && url.pathname === "/mcp") {
      const mcpServer = createMcpServer();
      const transport = new SSEServerTransport("/mcp/messages", res);

      sseTransports.set(transport.sessionId, transport);
      console.log(`[mcp] SSE session connected: ${transport.sessionId}`);

      res.on("close", () => {
        sseTransports.delete(transport.sessionId);
        console.log(`[mcp] SSE session disconnected: ${transport.sessionId}`);
      });

      await mcpServer.connect(transport);
      return;
    }

    if (req.method === "POST" && url.pathname === "/mcp/messages") {
      const sessionId = url.searchParams.get("sessionId");
      if (!sessionId) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Missing sessionId" }));
        return;
      }

      const transport = sseTransports.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Session not found" }));
        return;
      }

      const body = await parseBody(req);
      await transport.handlePostMessage(req, res, body);
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sessions: sseTransports.size }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  } catch (err) {
    console.error("[server] Error handling request:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
});

server.listen(PORT, () => {
  console.log(`[tools] MCP SSE server listening on port ${PORT}`);
});

// ── Event bus surface (agentruntime-native) ──────────────────────────────────
{
  const subscriber = EventSubscriber.fromWorkspace(
    resolve(process.cwd(), "workspace.json"),
    { name: "tools" },
  );

  subscriber.subscribe(async (event) => {
    const tag = event.cartridgeEvent as string;
    if (!tag?.startsWith("@agentruntime/tools:")) return;

    const correlationId = (event._correlationId as string) || "";

    try {
      if (tag === "@agentruntime/tools:read_symbol") {
        const filePath = normalizePath((event.file_path as string) || "");
        const symbolName = (event.symbol_name as string) || "";
        const fuzzy = Boolean(event.fuzzy);
        const followImports = Boolean(event.followImports);
        if (!filePath || !symbolName) {
          console.log(`[@agentruntime/tools:result] _correlationId=${correlationId}, ok=false, error=missing_args`);
          return;
        }
        await init();
        if (followImports) {
          const result = await getSymbolWithImports(filePath, symbolName);
          if (!result) {
            console.log(`[@agentruntime/tools:result] _correlationId=${correlationId}, ok=false, error=symbol_not_found`);
            return;
          }
          const { chunk, resolvedFrom } = result;
          console.log(
            `[@agentruntime/tools:result] _correlationId=${correlationId}, ok=true, ` +
            `data=${JSON.stringify({ path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, kind: chunk.kind, name: chunk.name, text: chunk.text, resolvedFrom })}`
          );
          return;
        }
        const chunk = await getSymbol(filePath, symbolName, { fuzzy });
        if (!chunk) {
          console.log(`[@agentruntime/tools:result] _correlationId=${correlationId}, ok=false, error=symbol_not_found`);
          return;
        }
        console.log(
          `[@agentruntime/tools:result] _correlationId=${correlationId}, ok=true, ` +
          `data=${JSON.stringify({ path: chunk.path, startLine: chunk.startLine, endLine: chunk.endLine, kind: chunk.kind, name: chunk.name, text: chunk.text })}`
        );
      } else if (tag === "@agentruntime/tools:read_symbols") {
        const filePath = normalizePath((event.file_path as string) || "");
        const symbolNames = event.symbol_names as string[] | undefined;
        if (!filePath || !Array.isArray(symbolNames) || symbolNames.length === 0) {
          console.log(`[@agentruntime/tools:result] _correlationId=${correlationId}, ok=false, error=missing_args`);
          return;
        }
        await init();
        const { found, missing } = await getSymbols(filePath, symbolNames);
        console.log(
          `[@agentruntime/tools:result] _correlationId=${correlationId}, ok=true, ` +
          `data=${JSON.stringify({ found, missing })}`
        );
      } else if (tag === "@agentruntime/tools:file_outline") {
        const filePath = normalizePath((event.file_path as string) || "");
        if (!filePath) {
          console.log(`[@agentruntime/tools:result] _correlationId=${correlationId}, ok=false, error=missing_args`);
          return;
        }
        await init();
        const symbols = await getOutline(filePath);
        const totalLines = readFileSync(filePath, "utf-8").split("\n").length;
        const outline = formatOutline(filePath, symbols, totalLines);
        console.log(
          `[@agentruntime/tools:result] _correlationId=${correlationId}, ok=true, ` +
          `data=${JSON.stringify({ outline })}`
        );
      }
    } catch (err) {
      console.log(
        `[@agentruntime/tools:result] _correlationId=${correlationId}, ok=false, ` +
        `error=${err instanceof Error ? err.message : String(err)}`
      );
    }
  });

  console.log("[tools] Event bus subscriber active");
}

function shutdown() {
  console.log("[tools] Shutting down...");
  server.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
