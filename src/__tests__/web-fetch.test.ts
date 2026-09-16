import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWebFetch } from "../tools/web-fetch.js";
import { isPrivateUrl } from "@agentruntime/url-guard";

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

function mockFetch(body: string, contentType: string, status = 200) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: (_: string) => contentType },
    text: async () => body,
  }));
}

describe("web_fetch tool", () => {
  let mock: ReturnType<typeof makeMockServer>;

  beforeEach(() => {
    mock = makeMockServer();
    registerWebFetch(mock.server);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns plain text response as-is", async () => {
    mockFetch("hello world", "text/plain");
    const result = await mock.call("web_fetch", { url: "http://example.com/text" });
    expect(result.content[0].text).toBe("hello world");
    expect(result.isError).toBeUndefined();
  });

  it("strips HTML tags and returns readable text", async () => {
    mockFetch("<html><body><h1>Title</h1><p>Content here</p></body></html>", "text/html");
    const result = await mock.call("web_fetch", { url: "http://example.com" });
    const text = result.content[0].text;
    expect(text).toContain("Title");
    expect(text).toContain("Content here");
    expect(text).not.toContain("<h1>");
    expect(text).not.toContain("<p>");
  });

  it("removes script tags from HTML", async () => {
    mockFetch('<html><script>alert("xss")</script><p>Safe content</p></html>', "text/html");
    const result = await mock.call("web_fetch", { url: "http://example.com" });
    expect(result.content[0].text).not.toContain("alert");
    expect(result.content[0].text).toContain("Safe content");
  });

  it("removes style tags from HTML", async () => {
    mockFetch('<html><style>.foo { color: red }</style><p>Text</p></html>', "text/html");
    const result = await mock.call("web_fetch", { url: "http://example.com" });
    expect(result.content[0].text).not.toContain(".foo");
    expect(result.content[0].text).toContain("Text");
  });

  it("returns JSON response as-is", async () => {
    const json = JSON.stringify({ key: "value" });
    mockFetch(json, "application/json");
    const result = await mock.call("web_fetch", { url: "http://example.com/api" });
    expect(result.content[0].text).toBe(json);
  });

  it("returns isError for non-2xx status codes", async () => {
    mockFetch("Not Found", "text/plain", 404);
    const result = await mock.call("web_fetch", { url: "http://example.com/missing" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
  });

  it("truncates response when it exceeds max_length", async () => {
    const longBody = "x".repeat(1000);
    mockFetch(longBody, "text/plain");
    const result = await mock.call("web_fetch", { url: "http://example.com", max_length: 100 });
    expect(result.content[0].text.length).toBeLessThan(1000);
    expect(result.content[0].text).toContain("truncated");
  });

  it("returns error on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));
    const result = await mock.call("web_fetch", { url: "http://example.com" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Network error");
  });

  it("returns (empty response) for empty body", async () => {
    mockFetch("", "text/plain");
    const result = await mock.call("web_fetch", { url: "http://example.com" });
    expect(result.content[0].text).toBe("(empty response)");
  });

  it("decodes HTML entities in HTML responses", async () => {
    mockFetch("<p>Hello &amp; World &lt;test&gt;</p>", "text/html");
    const result = await mock.call("web_fetch", { url: "http://example.com" });
    expect(result.content[0].text).toContain("Hello & World <test>");
  });

  // SSRF protection tests
  it("blocks requests to localhost", async () => {
    const result = await mock.call("web_fetch", { url: "http://localhost/secret" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("private");
  });

  it("blocks requests to 127.0.0.1", async () => {
    const result = await mock.call("web_fetch", { url: "http://127.0.0.1/admin" });
    expect(result.isError).toBe(true);
  });

  it("blocks requests to 192.168.x.x", async () => {
    const result = await mock.call("web_fetch", { url: "http://192.168.1.1/" });
    expect(result.isError).toBe(true);
  });

  it("blocks requests to 10.x.x.x", async () => {
    const result = await mock.call("web_fetch", { url: "http://10.0.0.1/" });
    expect(result.isError).toBe(true);
  });

  it("blocks requests to 169.254.169.254 (AWS metadata)", async () => {
    const result = await mock.call("web_fetch", { url: "http://169.254.169.254/latest/meta-data" });
    expect(result.isError).toBe(true);
  });
});

describe("isPrivateUrl", () => {
  it("returns true for localhost", () => expect(isPrivateUrl("http://localhost")).toBe(true));
  it("returns true for 127.0.0.1", () => expect(isPrivateUrl("http://127.0.0.1")).toBe(true));
  it("returns true for ::1", () => expect(isPrivateUrl("http://[::1]")).toBe(true));
  it("returns true for 10.0.0.1", () => expect(isPrivateUrl("http://10.0.0.1")).toBe(true));
  it("returns true for 172.16.0.1", () => expect(isPrivateUrl("http://172.16.0.1")).toBe(true));
  it("returns true for 172.31.255.255", () => expect(isPrivateUrl("http://172.31.255.255")).toBe(true));
  it("returns false for 172.32.0.1 (not in 172.16-31 range)", () => expect(isPrivateUrl("http://172.32.0.1")).toBe(false));
  it("returns true for 192.168.1.1", () => expect(isPrivateUrl("http://192.168.1.1")).toBe(true));
  it("returns true for 169.254.169.254", () => expect(isPrivateUrl("http://169.254.169.254")).toBe(true));
  it("returns true for IPv6 unique-local fd00::1", () => expect(isPrivateUrl("http://[fd00::1]")).toBe(true));
  it("returns false for a public IP", () => expect(isPrivateUrl("https://93.184.216.34")).toBe(false));
  it("returns false for a public domain", () => expect(isPrivateUrl("https://example.com")).toBe(false));
  it("returns true for an invalid URL", () => expect(isPrivateUrl("not-a-url")).toBe(true));
});
