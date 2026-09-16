import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ccrRetrieve } from "../lib/ccr-store.js";

export function registerCcr(server: McpServer): void {
  server.tool(
    "ccr_retrieve",
    "Retrieve the original bytes that token-funnel dropped during compression. Pass the <<ccr:HASH>> marker from a previous tool's output (or just the hex hash). Returns the full uncompressed content, or a clear error if the entry has been evicted from the recovery cache.",
    {
      marker: z.string().describe("The <<ccr:HASH>> marker from compressed tool output, or the bare hex hash"),
    },
    async ({ marker }) => {
      const content = ccrRetrieve(marker);
      if (content === null) {
        const hash = marker.match(/<<ccr:([0-9a-f]+)>>/)?.[1] ?? marker.trim();
        return {
          content: [{
            type: "text" as const,
            text: `ccr:${hash} expired from the recovery cache — re-run the tool to regenerate the output`,
          }],
          isError: true,
        };
      }
      return { content: [{ type: "text" as const, text: content }] };
    },
  );
}
