import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { normalizePath } from "../utils.js";
import {
  dropPending,
  listPendings,
  pendingContent,
  planeAgent,
  planeLand,
  readJournal,
} from "../lib/edit-plane.js";

export function registerPlane(server: McpServer): void {
  server.tool(
    "plane_status",
    "Show the edit plane: edits staged or refused but NOT yet on disk, plus recently landed edits across all agents. Read this when an edit is refused, before editing a contended file, or to see what the rest of the colony has in flight.",
    {
      file_path: z.string().optional().describe("Limit to one file (absolute, or relative to the agentruntime root)"),
      all_agents: z.boolean().optional().describe("Include other agents' pendings (default: true)"),
    },
    async ({ file_path, all_agents }) => {
      const path = file_path ? normalizePath(file_path) : undefined;
      const me = planeAgent();
      let pendings = listPendings(path);
      if (all_agents === false) pendings = pendings.filter((e) => e.agent === me);
      const recent = readJournal(40).filter((e) => (path ? e.path === path : true) && e.status === "landed");

      const lines: string[] = [`plane agent: ${me}`];
      lines.push("", `── pending / blocked (${pendings.length}) ──`);
      if (pendings.length === 0) {
        lines.push("  none — nothing is staged; disk is the whole truth right now.");
      } else {
        for (const e of pendings) {
          lines.push(
            `  ${e.id}`,
            `    ${e.status.toUpperCase()}  ${e.agent} via ${e.tool}  ${e.at}`,
            `    ${e.path}`,
            ...(e.why ? [`    why: ${e.why}`] : []),
            ...(e.detail ? [`    detail: ${e.detail}`] : []),
          );
        }
      }
      lines.push("", `── recently landed (${recent.length}) ──`);
      for (const e of recent.slice(-15)) {
        lines.push(`  ${e.at}  ${e.agent}  ${e.tool}  ${e.path}${e.why ? `  — ${e.why}` : ""}`);
      }
      if (recent.length === 0) lines.push("  none in the retained journal.");

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "plane_show",
    "Read the full staged content of one pending plane edit — the file as it WOULD be if that edit landed. Use it to see another agent's in-flight change before you edit the same file.",
    { id: z.string().describe("Pending edit id from plane_status or a refusal message") },
    async ({ id }) => {
      const meta = listPendings().find((e) => e.id === id);
      const content = pendingContent(id);
      if (!meta || content === null) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No pending edit ${id}. It may have landed or been discarded — check plane_status.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text:
              `${meta.status.toUpperCase()} ${id} — ${meta.agent} via ${meta.tool}, ${meta.at}\n` +
              `${meta.path}${meta.why ? `\nwhy: ${meta.why}` : ""}\n` +
              `(projected content — NOT what is on disk)\n\n${content}`,
          },
        ],
      };
    },
  );

  server.tool(
    "land_edits",
    "Apply staged plane edits to the real files. Each is re-checked against disk first; one whose base bytes are gone is refused as orphaned rather than clobbering. With no id, lands all of YOUR pendings.",
    {
      id: z.string().optional().describe("Land just this pending edit"),
      force: z.boolean().optional().describe("Land even if the file changed underneath (overwrites the other agent's bytes — say why in the commit)"),
    },
    async ({ id, force }) => {
      const { landed, refused } = planeLand({ id, force });
      const lines: string[] = [];
      lines.push(`landed: ${landed.length}`);
      for (const e of landed) lines.push(`  OK  ${e.path}  (${e.id})`);
      if (refused.length) {
        lines.push("", `refused: ${refused.length}`);
        for (const r of refused) {
          lines.push(`  ${r.edit.path}`, `    ${r.reason}`, `    still staged as ${r.edit.id} — re-read the file, or land_edits(id, force=true)`);
        }
      }
      if (!landed.length && !refused.length) lines.push("  nothing staged.");
      return { content: [{ type: "text" as const, text: lines.join("\n") }], isError: refused.length > 0 };
    },
  );

  server.tool(
    "plane_discard",
    "Throw away a staged plane edit without applying it.",
    { id: z.string().describe("Pending edit id") },
    async ({ id }) => {
      const meta = listPendings().find((e) => e.id === id);
      if (!meta) {
        return { content: [{ type: "text" as const, text: `No pending edit ${id}.` }], isError: true };
      }
      dropPending(id);
      return { content: [{ type: "text" as const, text: `Discarded ${id} (${meta.path}) — disk untouched.` }] };
    },
  );
}
