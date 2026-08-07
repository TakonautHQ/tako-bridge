import { describe, expect, it } from "vitest";
import {
	bridgeServerUrl,
	normalizeBridgeApiBaseUrl,
	requireSameBridgeOrigin,
} from "../src/server-url.js";

describe("Bridge server URLs", () => {
	it("requires HTTPS except for explicit loopback development", () => {
		expect(normalizeBridgeApiBaseUrl("https://takonaut.app/")).toBe(
			"https://takonaut.app",
		);
		expect(normalizeBridgeApiBaseUrl("http://localhost:8000/")).toBe(
			"http://localhost:8000",
		);
		expect(normalizeBridgeApiBaseUrl("http://127.0.0.1:8000")).toBe(
			"http://127.0.0.1:8000",
		);
		expect(() => normalizeBridgeApiBaseUrl("http://takonaut.app")).toThrow(
			"requires HTTPS",
		);
	});

	it("rejects embedded credentials and unsupported schemes", () => {
		expect(() => bridgeServerUrl("https://user:pass@takonaut.app/mcp")).toThrow(
			"must not include credentials",
		);
		expect(() => bridgeServerUrl("file:///tmp/mcp")).toThrow(
			"valid HTTPS URL",
		);
	});

	it("requires device and MCP endpoints to stay on the login origin", () => {
		expect(
			requireSameBridgeOrigin(
				"https://takonaut.app",
				"https://takonaut.app/mcp/",
				"MCP server URL",
			),
		).toBe("https://takonaut.app/mcp/");
		expect(() =>
			requireSameBridgeOrigin(
				"https://takonaut.app",
				"https://attacker.example/mcp",
				"MCP server URL",
			),
		).toThrow("same origin");
	});
});
