import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { htmlToMarkdown as extractHtml } from "@agentruntime/html-extract";
import { fetchWithSsrfProtection } from "@agentruntime/url-guard";

const MAX_OUTPUT = 50_000;
const FETCH_TIMEOUT = 30_000;

export function registerWebFetch(server: McpServer): void {
  server.tool(
    "web_fetch",
    "Fetch a URL and convert to clean Markdown. Uses Mozilla Readability (Firefox Reader View) to extract article content, then converts to Markdown preserving headings, lists, code blocks, and tables. Private/loopback addresses are blocked. Prefer the mesh web-fetch cartridge (SSE: web_fetch / web_search / login) when it is available on this agent; use this ar-tools web_fetch only as a fallback when mesh web-fetch is not connected.",
    {
      url: z.string().describe("The URL to fetch"),
      max_length: z.number().optional().describe("Max response length in chars (default: 50000)"),
      raw: z.boolean().optional().describe("Skip Readability extraction, return full page as Markdown (default: false)"),
    },
    async ({ url, max_length, raw }) => {
      const maxLen = max_length || MAX_OUTPUT;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

        const response = await fetchWithSsrfProtection(url, {
          signal: controller.signal,
          headers: {
            "User-Agent": "Mozilla/5.0 (compatible; AgentRuntime/1.0; +https://agentruntime.dev)",
            "Accept": "text/html,application/json,text/plain,*/*",
          },
        });

        clearTimeout(timer);

        if (!response.ok) {
          return {
            content: [{ type: "text" as const, text: `HTTP ${response.status} ${response.statusText}` }],
            isError: true,
          };
        }

        const contentType = response.headers.get("content-type") || "";
        const body = await response.text();

        let output: string;
        if (contentType.includes("text/html")) {
          output = extractHtml(body, { raw: !!raw, baseUrl: url });
        } else {
          output = body;
        }

        if (output.length > maxLen) {
          output = output.slice(0, maxLen) + `\n\n... [truncated, ${body.length} chars total]`;
        }

        return {
          content: [{ type: "text" as const, text: output || "(empty response)" }],
        };
      } catch (err: any) {
        const msg = err.name === "AbortError"
          ? `Request timed out after ${FETCH_TIMEOUT}ms`
          : err.message;
        return {
          content: [{ type: "text" as const, text: `Error: ${msg}` }],
          isError: true,
        };
      }
    },
  );
}
