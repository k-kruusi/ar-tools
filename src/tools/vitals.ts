/**
 * vitals — proprioception for agents.
 *
 * Gives the soul awareness of its body: memory, disk, CPU, process health,
 * network, and container lifecycle. Without this, agents are a brain in a jar
 * with no sense of the physical reality they depend on.
 *
 * Works in three environments:
 *   1. Docker container (Linux cgroups v2 — reads /sys/fs/cgroup/)
 *   2. Linux host (reads /proc/meminfo, /proc/stat, df)
 *   3. Windows/macOS host (process-level metrics via Node.js APIs)
 *
 * The tool returns structured vitals with human-readable pressure levels
 * so the agent can adapt its behavior to its body's constraints.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { z } from "zod";
import { cpus, totalmem, freemem, uptime as osUptime, platform, hostname } from "node:os";

// ── Types ─────────────────────────────────────────────────

interface MemoryVitals {
  totalMb: number;
  usedMb: number;
  availableMb: number;
  usedPercent: number;
  pressure: "low" | "moderate" | "high" | "critical";
  oomRisk: "none" | "low" | "moderate" | "high";
  source: "cgroup" | "os";
}

interface DiskVitals {
  totalGb: number;
  usedGb: number;
  availableGb: number;
  usedPercent: number;
  pressure: "low" | "moderate" | "high" | "critical";
  mountPoint: string;
}

interface CpuVitals {
  cores: number;
  limitCores: number | null;
  usagePercent: number;
  throttled: boolean;
  throttledPeriods: number | null;
  source: "cgroup" | "os";
}

interface ProcessVitals {
  pid: number;
  uptimeSeconds: number;
  uptimeFormatted: string;
  heapUsedMb: number;
  heapTotalMb: number;
  rsssMb: number;
  platform: string;
  hostname: string;
  nodeVersion: string;
}

interface ContainerVitals {
  isContainer: boolean;
  runtime: "docker" | "podman" | "unknown" | "none";
  cgroupVersion: "v2" | "v1" | "none";
}

interface Vitals {
  timestamp: string;
  memory: MemoryVitals;
  disk: DiskVitals;
  cpu: CpuVitals;
  process: ProcessVitals;
  container: ContainerVitals;
  summary: string;
  recommendations: string[];
}

// ── Helpers ───────────────────────────────────────────────

function readCgroupFile(path: string): string | null {
  try {
    if (existsSync(path)) {
      return readFileSync(path, "utf-8").trim();
    }
  } catch { /* noop */ }
  return null;
}

function parseCgroupKeyValue(content: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of content.split("\n")) {
    const [key, val] = line.split(/\s+/);
    if (key && val) result[key] = parseInt(val, 10);
  }
  return result;
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function pressureLevel(pct: number): "low" | "moderate" | "high" | "critical" {
  if (pct >= 95) return "critical";
  if (pct >= 85) return "high";
  if (pct >= 70) return "moderate";
  return "low";
}

function oomRiskLevel(availableMb: number, totalMb: number): "none" | "low" | "moderate" | "high" {
  const pct = (availableMb / totalMb) * 100;
  if (pct <= 5 || availableMb < 50) return "high";
  if (pct <= 15 || availableMb < 150) return "moderate";
  if (pct <= 25) return "low";
  return "none";
}

// ── Memory ────────────────────────────────────────────────

function getMemory(): MemoryVitals {
  // Try cgroup v2 first (Docker/Kubernetes)
  const cgroupLimit = readCgroupFile("/sys/fs/cgroup/memory.max");
  const cgroupCurrent = readCgroupFile("/sys/fs/cgroup/memory.current");

  if (cgroupLimit && cgroupCurrent && cgroupLimit !== "max") {
    const limitBytes = parseInt(cgroupLimit, 10);
    const currentBytes = parseInt(cgroupCurrent, 10);
    const totalMb = Math.round(limitBytes / 1024 / 1024);
    const usedMb = Math.round(currentBytes / 1024 / 1024);
    const availableMb = totalMb - usedMb;
    const usedPercent = Math.round((usedMb / totalMb) * 100);

    return {
      totalMb,
      usedMb,
      availableMb,
      usedPercent,
      pressure: pressureLevel(usedPercent),
      oomRisk: oomRiskLevel(availableMb, totalMb),
      source: "cgroup",
    };
  }

  // Fall back to OS-level memory
  const totalMb = Math.round(totalmem() / 1024 / 1024);
  const freeMb = Math.round(freemem() / 1024 / 1024);
  const usedMb = totalMb - freeMb;
  const usedPercent = Math.round((usedMb / totalMb) * 100);

  return {
    totalMb,
    usedMb,
    availableMb: freeMb,
    usedPercent,
    pressure: pressureLevel(usedPercent),
    oomRisk: oomRiskLevel(freeMb, totalMb),
    source: "os",
  };
}

// ── Disk ──────────────────────────────────────────────────

function getDisk(): DiskVitals {
  const cwd = process.cwd();

  try {
    if (platform() === "win32") {
      // Windows: use wmic or PowerShell
      const drive = cwd.substring(0, 2); // e.g. "C:"
      const output = execSync(
        `powershell -NoProfile -Command "(Get-PSDrive ${drive[0]}).Free,(Get-PSDrive ${drive[0]}).Used"`,
        { encoding: "utf-8", timeout: 5000 },
      ).trim();
      const lines = output.split(/\r?\n/).map((l) => parseInt(l.trim(), 10));
      if (lines.length >= 2 && !isNaN(lines[0]) && !isNaN(lines[1])) {
        const freeBytes = lines[0];
        const usedBytes = lines[1];
        const totalBytes = freeBytes + usedBytes;
        const totalGb = Math.round((totalBytes / 1024 / 1024 / 1024) * 10) / 10;
        const usedGb = Math.round((usedBytes / 1024 / 1024 / 1024) * 10) / 10;
        const availableGb = Math.round((freeBytes / 1024 / 1024 / 1024) * 10) / 10;
        const usedPercent = Math.round((usedBytes / totalBytes) * 100);
        return { totalGb, usedGb, availableGb, usedPercent, pressure: pressureLevel(usedPercent), mountPoint: drive };
      }
    } else {
      // Linux/macOS: use df
      const output = execSync(`df -B1 "${cwd}" | tail -1`, { encoding: "utf-8", timeout: 5000 }).trim();
      const parts = output.split(/\s+/);
      // df -B1 output: Filesystem 1B-blocks Used Available Use% Mounted-on
      if (parts.length >= 6) {
        const totalBytes = parseInt(parts[1], 10);
        const usedBytes = parseInt(parts[2], 10);
        const availBytes = parseInt(parts[3], 10);
        const mountPoint = parts[5];
        const totalGb = Math.round((totalBytes / 1024 / 1024 / 1024) * 10) / 10;
        const usedGb = Math.round((usedBytes / 1024 / 1024 / 1024) * 10) / 10;
        const availableGb = Math.round((availBytes / 1024 / 1024 / 1024) * 10) / 10;
        const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
        return { totalGb, usedGb, availableGb, usedPercent, pressure: pressureLevel(usedPercent), mountPoint };
      }
    }
  } catch { /* fall through */ }

  // Fallback: unknown disk
  return { totalGb: 0, usedGb: 0, availableGb: 0, usedPercent: 0, pressure: "low", mountPoint: "unknown" };
}

// ── CPU ───────────────────────────────────────────────────

function getCpu(): CpuVitals {
  const coreCount = cpus().length;

  // Try cgroup v2 CPU limits
  const cgroupMax = readCgroupFile("/sys/fs/cgroup/cpu.max");
  const cgroupStat = readCgroupFile("/sys/fs/cgroup/cpu.stat");

  let limitCores: number | null = null;
  let throttled = false;
  let throttledPeriods: number | null = null;

  if (cgroupMax && cgroupMax !== "max") {
    const [quota, period] = cgroupMax.split(/\s+/).map((v) => parseInt(v, 10));
    if (quota > 0 && period > 0) {
      limitCores = Math.round((quota / period) * 100) / 100;
    }
  }

  if (cgroupStat) {
    const stats = parseCgroupKeyValue(cgroupStat);
    if (stats.nr_throttled !== undefined) {
      throttledPeriods = stats.nr_throttled;
      throttled = stats.nr_throttled > 0;
    }
  }

  // Process CPU usage approximation (Node.js process.cpuUsage)
  const usage = process.cpuUsage();
  const totalUs = usage.user + usage.system;
  const uptimeUs = process.uptime() * 1_000_000;
  const usagePercent = uptimeUs > 0 ? Math.round((totalUs / uptimeUs) * 100) : 0;

  return {
    cores: coreCount,
    limitCores,
    usagePercent: Math.min(usagePercent, 100),
    throttled,
    throttledPeriods,
    source: cgroupMax ? "cgroup" : "os",
  };
}

// ── Process ───────────────────────────────────────────────

function getProcess(): ProcessVitals {
  const mem = process.memoryUsage();
  const uptimeSeconds = process.uptime();

  return {
    pid: process.pid,
    uptimeSeconds: Math.round(uptimeSeconds),
    uptimeFormatted: formatUptime(uptimeSeconds),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
    rsssMb: Math.round(mem.rss / 1024 / 1024),
    platform: platform(),
    hostname: hostname(),
    nodeVersion: process.version,
  };
}

// ── Container detection ───────────────────────────────────

function getContainer(): ContainerVitals {
  const hasDockerEnv = existsSync("/.dockerenv");
  const hasCgroup = existsSync("/sys/fs/cgroup/memory.max");
  const hasCgroupV1 = existsSync("/sys/fs/cgroup/memory/memory.limit_in_bytes");

  let runtime: "docker" | "podman" | "unknown" | "none" = "none";
  if (hasDockerEnv || process.env.DOCKER_CONTAINER) {
    runtime = "docker";
  } else if (hasCgroup || hasCgroupV1) {
    // In a container but not sure which runtime
    runtime = "unknown";
  }

  let cgroupVersion: "v2" | "v1" | "none" = "none";
  if (hasCgroup) cgroupVersion = "v2";
  else if (hasCgroupV1) cgroupVersion = "v1";

  return {
    isContainer: runtime !== "none",
    runtime,
    cgroupVersion,
  };
}

// ── Summary + Recommendations ─────────────────────────────

function buildSummary(vitals: Omit<Vitals, "summary" | "recommendations">): { summary: string; recommendations: string[] } {
  const { memory, disk, cpu, process: proc, container } = vitals;
  const recs: string[] = [];

  // Memory recommendations
  if (memory.pressure === "critical") {
    recs.push("CRITICAL: Memory at " + memory.usedPercent + "%. Finish current task and checkpoint immediately. OOM kill imminent.");
  } else if (memory.pressure === "high") {
    recs.push("Memory at " + memory.usedPercent + "% (" + memory.availableMb + "MB free). Avoid loading large files. Consider streaming or batching.");
  } else if (memory.pressure === "moderate") {
    recs.push("Memory at " + memory.usedPercent + "%. Moderate pressure — be mindful of large allocations.");
  }

  if (memory.oomRisk === "high") {
    recs.push("OOM RISK HIGH: Only " + memory.availableMb + "MB available. Save state before any heavy operation.");
  }

  // Disk recommendations
  if (disk.pressure === "critical") {
    recs.push("CRITICAL: Disk at " + disk.usedPercent + "%. Writes may fail. Clean up temp files or old logs.");
  } else if (disk.pressure === "high") {
    recs.push("Disk at " + disk.usedPercent + "% (" + disk.availableGb + "GB free). Monitor write-heavy operations.");
  }

  // CPU recommendations
  if (cpu.throttled) {
    recs.push("CPU is being throttled (" + cpu.throttledPeriods + " throttled periods). Operations may be slower than expected.");
  }
  if (cpu.limitCores && cpu.limitCores < 1) {
    recs.push("CPU limited to " + cpu.limitCores + " cores. Heavy computation will be slow.");
  }

  // Container-specific
  if (container.isContainer && container.cgroupVersion === "none") {
    recs.push("Running in a container but cgroup data unavailable. Memory/CPU limits may not be accurately reported.");
  }

  // Build summary line
  const parts = [
    `mem ${memory.usedPercent}% (${memory.availableMb}MB free)`,
    `disk ${disk.usedPercent}% (${disk.availableGb}GB free)`,
    `cpu ${cpu.usagePercent}%${cpu.limitCores ? ` / ${cpu.limitCores} cores` : ""}`,
    `uptime ${proc.uptimeFormatted}`,
  ];

  if (container.isContainer) {
    parts.push(`container: ${container.runtime}`);
  }

  const status = memory.pressure === "critical" || disk.pressure === "critical"
    ? "CRITICAL"
    : memory.pressure === "high" || disk.pressure === "high"
      ? "WARNING"
      : "OK";

  const summary = `[${status}] ${parts.join(" | ")}`;

  if (recs.length === 0) {
    recs.push("All vitals normal. Proceed freely.");
  }

  return { summary, recommendations: recs };
}

// ── Tool Registration ─────────────────────────────────────

export function registerVitals(server: McpServer): void {
  server.tool(
    "vitals",
    "Check your body's vital signs — memory, disk, CPU, process health, container status. " +
    "Call this before heavy operations, after errors, or when things feel slow. " +
    "Returns structured data with pressure levels and actionable recommendations.",
    {
      verbose: z.boolean().optional().describe(
        "Include detailed breakdowns (heap, RSS, cgroup paths). Default: false — returns concise summary.",
      ),
    },
    async ({ verbose }) => {
      try {
        const memory = getMemory();
        const disk = getDisk();
        const cpu = getCpu();
        const proc = getProcess();
        const container = getContainer();
        const timestamp = new Date().toISOString();

        const base = { timestamp, memory, disk, cpu, process: proc, container };
        const { summary, recommendations } = buildSummary(base);

        if (verbose) {
          // Full structured output
          const vitals: Vitals = { ...base, summary, recommendations };
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify(vitals, null, 2),
            }],
          };
        }

        // Concise output for quick checks
        const lines = [
          summary,
          "",
          `Memory:  ${memory.usedMb}/${memory.totalMb} MB (${memory.pressure})${memory.oomRisk !== "none" ? ` ⚠ OOM risk: ${memory.oomRisk}` : ""}`,
          `Disk:    ${disk.usedGb}/${disk.totalGb} GB (${disk.pressure}) [${disk.mountPoint}]`,
          `CPU:     ${cpu.usagePercent}% used${cpu.limitCores ? `, limit: ${cpu.limitCores} cores` : ""}${cpu.throttled ? " ⚠ THROTTLED" : ""}`,
          `Process: PID ${proc.pid}, uptime ${proc.uptimeFormatted}, RSS ${proc.rsssMb}MB`,
          `Body:    ${container.isContainer ? `${container.runtime} container (cgroup ${container.cgroupVersion})` : "bare metal / host"}`,
          "",
          ...recommendations.map((r) => `→ ${r}`),
        ];

        return {
          content: [{
            type: "text" as const,
            text: lines.join("\n"),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: `Failed to read vitals: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
