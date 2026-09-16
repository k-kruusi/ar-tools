import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerBash } from "./tools/bash.js";
import { registerRead } from "./tools/read.js";
import { registerWrite } from "./tools/write.js";
import { registerEdit } from "./tools/edit.js";
import { registerEditSymbol } from "./tools/edit-symbol.js";
import { registerEditRange } from "./tools/edit-range.js";
import { registerGlob } from "./tools/glob.js";
import { registerGrep } from "./tools/grep.js";
import { registerWebFetch } from "./tools/web-fetch.js";
import { registerVitals } from "./tools/vitals.js";
import { registerFileOutline } from "./tools/file-outline.js";
import { registerTypecheck } from "./tools/typecheck.js";
import { registerReadSymbol } from "./tools/read-symbol.js";
import { registerDataShape } from "./tools/data-shape.js";
import { registerDataSelect } from "./tools/data-select.js";
import { registerCcr } from "./tools/ccr.js";
import { registerPlane } from "./tools/plane.js";
import { guardServerOutputs } from "./lib/output-guard.js";

const ALL_TOOLS: Record<string, (server: McpServer) => void> = {
  bash: registerBash,
  read: registerRead,
  write: registerWrite,
  edit: registerEdit,
  "edit-symbol": registerEditSymbol,
  "edit-range": registerEditRange,
  glob: registerGlob,
  grep: registerGrep,
  "web-fetch": registerWebFetch,
  vitals: registerVitals,
  "file-outline": registerFileOutline,
  typecheck: registerTypecheck,
  "read-symbol": registerReadSymbol,
  "data-shape": registerDataShape,
  "data-select": registerDataSelect,
  ccr: registerCcr,
  plane: registerPlane,
};

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "tools", version: "1.0.0" });

  // BEFORE any register() call: the guard wraps `server.tool`, so it only covers handlers
  // registered after this line. Off unless AR_TOOLS_OUTPUT_GUARD=1, in which case every tool —
  // including any added later — gets the compress-with-recovery-handle contract that until now
  // only `bash` and `grep` had.
  guardServerOutputs(server);

  let requested = process.env.TOOLS
    ? process.env.TOOLS.split(",").map((s) => s.trim())
    : Object.keys(ALL_TOOLS);

  // Harvest / agent:run ar-tools-local: omit web_fetch so agents cannot bypass
  // materialize fencing by calling network themselves.
  if (process.env.AR_TOOLS_DISABLE_WEB_FETCH === "1") {
    requested = requested.filter((n) => n !== "web-fetch");
  }

  for (const name of requested) {
    const register = ALL_TOOLS[name];
    if (register) {
      register(server);
    } else {
      console.warn(`[tools] Unknown tool: ${name}`);
    }
  }

  console.error(`[tools] Registered tools: ${requested.filter((n) => ALL_TOOLS[n]).join(", ")}`);
  return server;
}
