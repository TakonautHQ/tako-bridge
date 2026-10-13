import { describe, expect, it } from "vitest";

import { AgentMetricsTracker, describeToolCall } from "../src/agent-metrics";

describe("describeToolCall", () => {
	it("keeps only file names", () => {
		expect(describeToolCall("read", { path: "/Users/me/secret/repo/src/app.ts" })).toBe(
			"read app.ts",
		);
	});
	it("redacts and truncates commands", () => {
		const text = describeToolCall("bash", {
			command: `curl -H "Authorization: Bearer ghp_${"a".repeat(36)}" ${"x".repeat(300)}`,
		});
		expect(text).not.toContain("ghp_aaaa");
		expect(text.length).toBeLessThanOrEqual(120);
	});
	it("falls back to the tool name", () => {
		expect(describeToolCall("todo", null)).toBe("todo");
	});
});

describe("AgentMetricsTracker", () => {
	it("accumulates tools, turns, tokens and cost", () => {
		const m = new AgentMetricsTracker();
		m.onAgentStart();
		m.onToolStart("read", { path: "a/b.ts" });
		m.onToolEnd("read", false);
		m.onToolStart("bash", { command: "npm test" });
		m.onToolEnd("bash", true);
		m.onTurnEnd({ usage: { input: 100, cacheRead: 50, output: 20, cost: { total: 0.012345 } } });
		m.onTurnEnd({ role: "assistant" });
		m.onAgentIdle();
		expect(m.snapshot()).toEqual({
			currentActivity: "Waiting for input",
			lastTool: "bash",
			toolCalls: 2,
			turns: 2,
			tokensIn: 150,
			tokensOut: 20,
			costUsd: 0.0123,
			lastError: "bash failed",
		});
		m.reset();
		expect(m.snapshot().toolCalls).toBe(0);
	});
});
