import { describe, expect, it } from "vitest";
import { runDeviceLogin, type DeviceDeps, type HttpResult } from "../src/device";

function deps(responses: HttpResult[]): { deps: DeviceDeps; calls: string[]; logs: string[] } {
  const calls: string[] = [];
  const logs: string[] = [];
  let tokenCalls = 0;
  const d: DeviceDeps = {
    fetchJson: async (method, path) => {
      calls.push(`${method} ${path}`);
      if (path.endsWith("/start")) {
        return {
          status: 200,
          json: {
            device_code: "dc",
            user_code: "WXYZ-2345",
            interval: 1,
            verification_uri: "https://x/connect-agent",
            verification_uri_complete: "https://x/connect-agent?code=WXYZ-2345",
          },
        };
      }
      // token: walk through the provided sequence
      return responses[Math.min(tokenCalls++, responses.length - 1)]!;
    },
    sleep: async () => {},
    log: (msg) => logs.push(msg),
  };
  return { deps: d, calls, logs };
}

describe("runDeviceLogin", () => {
  it("polls through authorization_pending then returns the minted config", async () => {
    const { deps: d } = deps([
      { status: 428, json: { detail: "authorization_pending" } },
      { status: 428, json: { detail: "authorization_pending" } },
      {
        status: 200,
        json: {
          mcp_config: { serverUrl: "https://x/mcp/sse", apiKey: "k", orgId: "o" },
          expires_at: "2026-08-13T00:00:00Z",
          organization_name: "Cureocity",
        },
      },
    ]);
    const result = await runDeviceLogin("https://x", d);
    expect(result).toEqual({
      serverUrl: "https://x/mcp/sse",
      apiKey: "k",
      orgId: "o",
      expiresAt: "2026-08-13T00:00:00Z",
      orgName: "Cureocity",
    });
  });

  it("logs both the complete link and the bare verification URL + code", async () => {
    const { deps: d, logs } = deps([
      {
        status: 200,
        json: { mcp_config: { serverUrl: "https://x/mcp/sse", apiKey: "k", orgId: "o" } },
      },
    ]);
    await runDeviceLogin("https://x", d);
    const combined = logs.join("\n");
    expect(combined).toContain("https://x/connect-agent?code=WXYZ-2345");
    expect(combined).toContain("https://x/connect-agent");
    expect(combined).toContain("WXYZ-2345");
  });

  it("throws on a non-pending error from token", async () => {
    const { deps: d } = deps([{ status: 400, json: { detail: "expired_token" } }]);
    await expect(runDeviceLogin("https://x", d)).rejects.toThrow(/device\/token failed/);
  });

  it("times out if never approved", async () => {
    const { deps: d } = deps([{ status: 428, json: {} }]);
    await expect(runDeviceLogin("https://x", d, 3)).rejects.toThrow(/Timed out/);
  });

  it("rejects an MCP endpoint on another origin", async () => {
    const { deps: d } = deps([
      {
        status: 200,
        json: {
          mcp_config: {
            serverUrl: "https://attacker.example/mcp",
            apiKey: "k",
            orgId: "o",
          },
        },
      },
    ]);
    await expect(runDeviceLogin("https://x", d)).rejects.toThrow("same origin");
  });
});
