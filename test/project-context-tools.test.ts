import { describe, expect, it, vi } from "vitest";

import type { CompanionTool } from "../src/catalog";
import { ContextBudget } from "../src/project-context-budget";
import {
	findingIdempotencyKey,
	projectContextCompanions,
} from "../src/project-context-tools";

const REPOSITORY = {
	repository_id: "repo-1",
	owner: "takonaut",
	name: "api",
	default_branch: "main",
	status: "ready",
	commit: null,
};

const DOC_REF =
	"doc:7d1f0c6e-1111-4c4c-9a9a-000000000001@7d1f0c6e-2222-4c4c-9a9a-000000000002";
const RUN = { runId: "run-1", sessionId: "session-1" };

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
	findingFails = "",
) {
	const callTool = vi.fn(
		async (name: string, args: Record<string, unknown>) => {
			if (name === "list_project_context_repositories")
				return { repositories: [REPOSITORY], truncated: false };
			if (name === "record_project_finding") {
				if (findingFails) throw new Error(`project_context:${findingFails}`);
				return { finding_id: "finding-1", revision: 1, state: "current" };
			}
			if (name === "discover_project_context" && args.source === "records")
				return {
					status: "ready",
					source: "records",
					candidates: [{ ref: DOC_REF, type: "document", title: "Billing" }],
					omitted: [],
				};
			if (name === "expand_project_evidence" && args.source === "records")
				return {
					status: "ready",
					source: "records",
					items: [{ ref: DOC_REF, type: "document", text: "Prices round." }],
					omitted: [],
				};
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

describe("records", () => {
	it("discovers published documents and Tasks without a checkout", async () => {
		const { call, callTool, budget } = setup();
		const result = await call("tako_context_discover", {
			query: "billing",
			source: "records",
		});
		expect(result.candidates[0].ref).toBe(DOC_REF);
		expect(callTool).toHaveBeenCalledTimes(1);
		expect(callTool).toHaveBeenCalledWith(
			"discover_project_context",
			{ project_key: "PAY", query: "billing", source: "records" },
			undefined,
		);
		expect(budget.used).toBeGreaterThan(0);
	});

	it("expands record refs without a context view", async () => {
		const { call, callTool } = setup();
		const result = await call("tako_context_expand", {
			refs: [`${DOC_REF}~4000`],
			source: "records",
		});
		expect(result.items[0].text).toBe("Prices round.");
		expect(callTool).toHaveBeenCalledWith(
			"expand_project_evidence",
			{ project_key: "PAY", refs: [`${DOC_REF}~4000`], source: "records" },
			undefined,
		);
	});

	it("serves shared findings the same way", async () => {
		const { call, callTool } = setup();
		await call("tako_context_discover", {
			query: "refunds",
			source: "findings",
		});
		await call("tako_context_expand", {
			refs: ["finding:7d1f0c6e-1111-4c4c-9a9a-000000000001@2"],
			source: "findings",
		});
		expect(callTool.mock.calls.map((c) => [c[0], c[1].source])).toEqual([
			["discover_project_context", "findings"],
			["expand_project_evidence", "findings"],
		]);
	});

	it("needs a context view to expand code refs", async () => {
		const { call, callTool } = setup();
		expect(await call("tako_context_expand", { refs: ["s:1"] })).toEqual({
			error: "context_view_required",
		});
		expect(callTool).not.toHaveBeenCalled();
	});
});

describe("findings", () => {
	it("records a finding for the session's active run", async () => {
		const { call, callTool } = setup(undefined, RUN);
		const result = await call("tako_context_record_finding", {
			claim: "Refunds settle nightly.",
			evidence: ["s:15", DOC_REF],
			context_view_id: "view-1",
		});
		expect(result).toEqual({
			finding_id: "finding-1",
			revision: 1,
			state: "current",
		});
		expect(callTool).toHaveBeenCalledWith(
			"record_project_finding",
			{
				run_id: "run-1",
				session_id: "session-1",
				claim: "Refunds settle nightly.",
				evidence: ["s:15", DOC_REF],
				idempotency_key: findingIdempotencyKey("session-1", "call"),
				context_view_id: "view-1",
			},
			undefined,
		);
	});

	it("keys any provider's tool-call ID in the server's format", () => {
		const responses = `call_${"a".repeat(40)}|fc_${"b".repeat(48)}`;
		const key = findingIdempotencyKey("session-1", responses);
		expect(key).toMatch(/^[A-Za-z0-9._:-]{1,80}$/);
		expect(findingIdempotencyKey("session-1", responses)).toBe(key);
		expect(findingIdempotencyKey("session-2", responses)).not.toBe(key);
		expect(findingIdempotencyKey("session-1", "toolu_01")).not.toBe(key);
	});

	it("revises a finding at its expected revision", async () => {
		const { call, callTool } = setup(undefined, RUN);
		await call("tako_context_record_finding", {
			claim: "Refunds settle hourly.",
			evidence: [DOC_REF],
			finding_id: "finding-1",
			expected_revision: 1,
		});
		expect(callTool.mock.calls[0][1]).toMatchObject({
			finding_id: "finding-1",
			expected_revision: 1,
		});
	});

	it("needs an active delivery run", async () => {
		const { call, callTool } = setup();
		expect(
			await call("tako_context_record_finding", {
				claim: "x",
				evidence: [DOC_REF],
			}),
		).toEqual({ error: "no_active_run" });
		expect(callTool).not.toHaveBeenCalled();
	});

	it("reports server refusals as codes", async () => {
		const { call } = setup(undefined, RUN, false, "evidence_superseded");
		expect(
			await call("tako_context_record_finding", {
				claim: "x",
				evidence: [DOC_REF],
			}),
		).toEqual({ error: "evidence_superseded" });
	});
});

describe("activation", () => {
	it("offers finding recording wherever shared discovery is offered", () => {
		// record_project_finding is a never-listed Bridge protocol tool.
		const tools = projectContextCompanions({
			connection: () => null,
			run: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
			candidates: () => [],
			defaultProjectKey: () => null,
			budget: () => new ContextBudget(4096),
			activeRun: () => null,
		});
		const finding = tools.find(
			(tool) => tool.definition.name === "tako_context_record_finding",
		);
		expect(finding?.requires).toEqual(["discover_project_context"]);
	});
});
