import { describe, it, expect } from "vitest";
import { normalizePath } from "../utils.js";

describe("normalizePath", () => {
  it("passes through absolute Windows paths unchanged", () => {
    const result = normalizePath("D:\\claudeplayground\\agentruntime\\file.ts");
    expect(result).toBe("D:\\claudeplayground\\agentruntime\\file.ts");
  });

  if (process.platform === "win32") {
    it("converts POSIX drive paths to Windows paths", () => {
      const result = normalizePath("/d/claudeplayground/agentruntime/file.ts");
      expect(result).toBe("D:\\claudeplayground\\agentruntime\\file.ts");
    });

    it("handles uppercase POSIX drive letters", () => {
      const result = normalizePath("/D/claudeplayground/file.ts");
      expect(result).toBe("D:\\claudeplayground\\file.ts");
    });

    it("does not mangle paths that start with /d/ creating a phantom directory", () => {
      const result = normalizePath("/d/claudeplayground/agentruntime/file.ts");
      // Before the fix, this would resolve to D:\d\claudeplayground\... (wrong)
      expect(result).not.toContain("\\d\\claudeplayground");
    });
  }
});
