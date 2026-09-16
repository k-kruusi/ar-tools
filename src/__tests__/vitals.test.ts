import { describe, it, expect, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerVitals } from "../tools/vitals.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;

function makeMockServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      handlers.set(_name, handler);
    },
  };
  return {
    server: server as unknown as McpServer,
    call: (name: string, args: Record<string, unknown>) => handlers.get(name)!(args),
  };
}

describe("vitals tool", () => {
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    mock = makeMockServer();
    registerVitals(mock.server);
  });

  it("registers the vitals tool", () => {
    // registerVitals should have registered exactly one tool
    expect(mock.call("vitals", {})).toBeDefined();
  });

  it("returns concise output by default", async () => {
    const result = await mock.call("vitals", {});
    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);

    const text = result.content[0].text;
    // Should have the status line
    expect(text).toMatch(/\[(OK|WARNING|CRITICAL)\]/);
    // Should have memory, disk, CPU, process, body lines
    expect(text).toContain("Memory:");
    expect(text).toContain("Disk:");
    expect(text).toContain("CPU:");
    expect(text).toContain("Process:");
    expect(text).toContain("Body:");
    // Should have at least one recommendation
    expect(text).toContain("→");
  });

  it("returns JSON when verbose=true", async () => {
    const result = await mock.call("vitals", { verbose: true });
    expect(result.isError).toBeUndefined();

    const text = result.content[0].text;
    const parsed = JSON.parse(text);

    // Should have all top-level fields
    expect(parsed).toHaveProperty("timestamp");
    expect(parsed).toHaveProperty("memory");
    expect(parsed).toHaveProperty("disk");
    expect(parsed).toHaveProperty("cpu");
    expect(parsed).toHaveProperty("process");
    expect(parsed).toHaveProperty("container");
    expect(parsed).toHaveProperty("summary");
    expect(parsed).toHaveProperty("recommendations");
  });

  it("memory has required fields", async () => {
    const result = await mock.call("vitals", { verbose: true });
    const parsed = JSON.parse(result.content[0].text);
    const mem = parsed.memory;

    expect(typeof mem.totalMb).toBe("number");
    expect(typeof mem.usedMb).toBe("number");
    expect(typeof mem.availableMb).toBe("number");
    expect(typeof mem.usedPercent).toBe("number");
    expect(["low", "moderate", "high", "critical"]).toContain(mem.pressure);
    expect(["none", "low", "moderate", "high"]).toContain(mem.oomRisk);
    expect(["cgroup", "os"]).toContain(mem.source);

    // Sanity: total should be positive
    expect(mem.totalMb).toBeGreaterThan(0);
    // Used + available should roughly equal total
    expect(mem.usedMb + mem.availableMb).toBeGreaterThan(0);
  });

  it("disk has required fields", async () => {
    const result = await mock.call("vitals", { verbose: true });
    const parsed = JSON.parse(result.content[0].text);
    const disk = parsed.disk;

    expect(typeof disk.totalGb).toBe("number");
    expect(typeof disk.usedGb).toBe("number");
    expect(typeof disk.availableGb).toBe("number");
    expect(typeof disk.usedPercent).toBe("number");
    expect(["low", "moderate", "high", "critical"]).toContain(disk.pressure);
    expect(typeof disk.mountPoint).toBe("string");
  });

  it("cpu has required fields", async () => {
    const result = await mock.call("vitals", { verbose: true });
    const parsed = JSON.parse(result.content[0].text);
    const cpu = parsed.cpu;

    expect(typeof cpu.cores).toBe("number");
    expect(cpu.cores).toBeGreaterThan(0);
    expect(typeof cpu.usagePercent).toBe("number");
    expect(typeof cpu.throttled).toBe("boolean");
    expect(["cgroup", "os"]).toContain(cpu.source);
  });

  it("process has required fields", async () => {
    const result = await mock.call("vitals", { verbose: true });
    const parsed = JSON.parse(result.content[0].text);
    const proc = parsed.process;

    expect(typeof proc.pid).toBe("number");
    expect(proc.pid).toBeGreaterThan(0);
    expect(typeof proc.uptimeSeconds).toBe("number");
    expect(typeof proc.uptimeFormatted).toBe("string");
    expect(typeof proc.heapUsedMb).toBe("number");
    expect(typeof proc.heapTotalMb).toBe("number");
    expect(typeof proc.rsssMb).toBe("number");
    expect(typeof proc.platform).toBe("string");
    expect(typeof proc.hostname).toBe("string");
    expect(typeof proc.nodeVersion).toBe("string");
    expect(proc.nodeVersion).toMatch(/^v\d+/);
  });

  it("container detection has required fields", async () => {
    const result = await mock.call("vitals", { verbose: true });
    const parsed = JSON.parse(result.content[0].text);
    const container = parsed.container;

    expect(typeof container.isContainer).toBe("boolean");
    expect(["docker", "podman", "unknown", "none"]).toContain(container.runtime);
    expect(["v2", "v1", "none"]).toContain(container.cgroupVersion);
  });

  it("timestamp is valid ISO string", async () => {
    const result = await mock.call("vitals", { verbose: true });
    const parsed = JSON.parse(result.content[0].text);

    const date = new Date(parsed.timestamp);
    expect(date.getTime()).not.toBeNaN();
    // Should be recent (within last 10 seconds)
    expect(Date.now() - date.getTime()).toBeLessThan(10_000);
  });

  it("recommendations is a non-empty array", async () => {
    const result = await mock.call("vitals", { verbose: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(Array.isArray(parsed.recommendations)).toBe(true);
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    // Each recommendation is a string
    for (const rec of parsed.recommendations) {
      expect(typeof rec).toBe("string");
    }
  });

  it("summary contains status indicator", async () => {
    const result = await mock.call("vitals", { verbose: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.summary).toMatch(/\[(OK|WARNING|CRITICAL)\]/);
  });

  it("memory percentages are in valid range", async () => {
    const result = await mock.call("vitals", { verbose: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.memory.usedPercent).toBeGreaterThanOrEqual(0);
    expect(parsed.memory.usedPercent).toBeLessThanOrEqual(100);
  });

  it("cpu usage is in valid range", async () => {
    const result = await mock.call("vitals", { verbose: true });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.cpu.usagePercent).toBeGreaterThanOrEqual(0);
    expect(parsed.cpu.usagePercent).toBeLessThanOrEqual(100);
  });
});
