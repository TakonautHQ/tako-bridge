import { describe, expect, it, vi } from "vitest";

import type { CompanionTool } from "../src/catalog";
import { ContextBudget } from "../src/project-context-budget";
import { projectContextCompanions } from "../src/project-context-tools";

const REPOSITORY = {
	repository_id: "repo-1",
	owner: "takonaut",
	name: "api",
	default_branch: "main",
	status: "ready",
	commit: null,
};

function item(ref: string, extra: Record<string, unknown> = {}) {
	return {
		ref,
		type: "file",
		path: "src/missing.ts",
		sha256: "0".repeat(64),
		outgoing: [{ rel: "imports", ref: "f:2", name: "src/b.ts" }],
		...extra,
	};
}

function setup(
	budget = new ContextBudget(4096),
	activeRun: { runId: string; sessionId: string } | null = null,
	pinFails = false,
) {
	const callTool = vi.fn(
		async (name: string, args: Record<string, unknown>) => {
			if (name === "list_project_context_repositories")
				return { repositories: [REPOSITORY], truncated: false };
			if (name === "discover_project_context")
				return {
					status: "ready",
					candidates: [],
					context_view_id: "view-1",
					local: {
						checkout: "found",
						head: "a".repeat(40),
						dirty: true,
						relation: "local_ahead",
					},
				};
			if (name === "pin_project_context_view") {
				if (pinFails) throw new Error("project_context:stale_view");
				return { status: "pinned" };
			}
			return {
				status: "ready",
				repository_id: "repo-1",
				source_snapshot_id: "snap-1",
				commit: "c".repeat(40),
				items: (args.refs as string[]).map((ref) => item(ref)),
				omitted: [],
			};
		},
	);
	const tools = projectContextCompanions({
		connection: () => ({ callTool }) as never,
		run: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
		candidates: () => [],
		defaultProjectKey: () => "PAY",
		budget: () => budget,
		activeRun: () => activeRun,
	});
	const byName = (name: string) =>
		tools.find((tool: CompanionTool) => tool.definition.name === name)
			?.definition as unknown as {
			execute: (...args: unknown[]) => Promise<{ content: { text: string }[] }>;
		};
	const call = async (name: string, params: Record<string, unknown>) =>
		JSON.parse(
			(await byName(name).execute("call", params, undefined, undefined, {}))
				.content[0].text,
		);
	return { call, callTool, budget };
}

describe("cumulative session context budget", () => {
	it("returns evidence already provided as a delta", async () => {
		const { call } = setup();
		const first = await call("tako_context_expand", {
			context_view_id: "view-1",
			refs: ["f:4"],
		});
		expect(first.items[0].outgoing).toHaveLength(1);
		const again = await call("tako_context_expand", {
			context_view_id: "view-1",
			refs: ["f:4", "f:5"],
		});
		// Unchanged evidence is not repeated; local state is always fresh.
		expect(again.items[0]).toEqual({
			ref: "f:4",
			type: "file",
			already_provided: true,
			local: { state: "unverifiable" },
		});
		expect(again.items[1].outgoing).toHaveLength(1);
	});

	it("stops serving shared context when the session budget is spent", async () => {
		const { call, callTool, budget } = setup(new ContextBudget(2048));
		await call("tako_context_discover", { query: "a" });
		let refused = null;
		for (let index = 0; index < 20 && !refused; index += 1) {
			const result = await call("tako_context_expand", {
				context_view_id: "view-1",
				refs: [`f:${index + 10}`],
			});
			if (result.error) refused = result;
		}
		expect(refused).toEqual({
			error: "context_budget_exhausted",
			fallback: "local",
			used_bytes: budget.used,
			limit_bytes: 2048,
		});
		const calls = callTool.mock.calls.length;
		await call("tako_context_discover", { query: "b" });
		// Exhausted: no further server calls.
		expect(callTool.mock.calls.length).toBe(calls);
	});

	it("provides evidence in full again after the session is compacted", async () => {
		const { call, budget } = setup();
		await call("tako_context_expand", {
			context_view_id: "view-1",
			refs: ["f:4"],
		});
		budget.forgetProvided();
		const again = await call("tako_context_expand", {
			context_view_id: "view-1",
			refs: ["f:4"],
		});
		expect(again.items[0].outgoing).toHaveLength(1);
	});

	it("bounds configured budgets", () => {
		expect(ContextBudget.fromEnvironment({}).limit).toBe(1024 * 1024);
		expect(
			ContextBudget.fromEnvironment({ TAKONAUT_CONTEXT_BUDGET_BYTES: "1" })
				.limit,
		).toBe(16 * 1024);
		expect(
			ContextBudget.fromEnvironment({
				TAKONAUT_CONTEXT_BUDGET_BYTES: String(64 * 1024 * 1024),
			}).limit,
		).toBe(4 * 1024 * 1024);
		expect(
			ContextBudget.fromEnvironment({ TAKONAUT_CONTEXT_BUDGET_BYTES: "abc" })
				.limit,
		).toBe(1024 * 1024);
	});
});

describe("run pins", () => {
	it("pins the view used by the session's active delivery run", async () => {
		const run = { runId: "run-1", sessionId: "session-1" };
		const { call, callTool } = setup(undefined, run);
		const result = await call("tako_context_discover", {
			query: "a",
			repository_id: "repo-1",
		});
		expect(result.run_pin).toBe("recorded");
		expect(callTool).toHaveBeenCalledWith(
			"pin_project_context_view",
			{
				run_id: "run-1",
				session_id: "session-1",
				context_view_id: "view-1",
				// No local checkout here: observations are unknown.
				local_relation: "unknown",
				local_head: "",
			},
			undefined,
		);
	});

	it("never pins without an active run, and never fails discovery", async () => {
		const quiet = setup();
		const plain = await quiet.call("tako_context_discover", {
			query: "a",
			repository_id: "repo-1",
		});
		expect(plain.run_pin).toBeUndefined();
		expect(quiet.callTool.mock.calls.map(([name]) => name)).not.toContain(
			"pin_project_context_view",
		);
		const failing = setup(undefined, { runId: "r", sessionId: "s" }, true);
		const result = await failing.call("tako_context_discover", {
			query: "a",
			repository_id: "repo-1",
		});
		expect(result.status).toBe("ready");
		expect(result.run_pin).toBe("failed");
	});
});
