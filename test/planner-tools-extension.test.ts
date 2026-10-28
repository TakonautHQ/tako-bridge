import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import planningTurnToolsExtension from "../src/planner-tools-extension";

type ToolCallHandler = (event: {
	toolName: string;
	input: Record<string, unknown>;
}) => { block?: boolean; reason?: string } | void;

const ENV_KEYS = [
	"TAKONAUT_PLANNING_SERVER_URL",
	"TAKONAUT_PLANNING_API_KEY",
	"TAKONAUT_PLANNING_ORG_ID",
	"TAKONAUT_PLANNING_ALLOWED_TOOLS",
	"TAKONAUT_PLANNING_WORKTREE",
] as const;

function fakePi() {
	let toolCallHandler: ToolCallHandler | null = null;
	return {
		registerTool: vi.fn(),
		getActiveTools: vi.fn(() => [] as string[]),
		setActiveTools: vi.fn(),
		on: vi.fn((event: string, handler: ToolCallHandler) => {
			if (event === "tool_call") toolCallHandler = handler;
		}),
		call(toolName: string, input: Record<string, unknown> = {}) {
			return toolCallHandler?.({ toolName, input });
		},
	};
}

describe("planner-tools-extension (child-process-only, never the full Bridge extension)", () => {
	const previousEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of ENV_KEYS) previousEnv[key] = process.env[key];
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (previousEnv[key] === undefined) delete process.env[key];
			else process.env[key] = previousEnv[key];
		}
	});

	function configure(allowed: string[], worktree = "/tmp/worktree") {
		process.env.TAKONAUT_PLANNING_SERVER_URL = "https://takonaut.test";
		process.env.TAKONAUT_PLANNING_API_KEY = "secret";
		process.env.TAKONAUT_PLANNING_ORG_ID = "org-1";
		process.env.TAKONAUT_PLANNING_ALLOWED_TOOLS = JSON.stringify(allowed);
		process.env.TAKONAUT_PLANNING_WORKTREE = worktree;
	}

	it("refuses bash, write, and edit outright, regardless of what is granted", () => {
		configure(["record_tako_grill_round"]);
		const pi = fakePi();
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(pi);

		for (const toolName of ["bash", "write", "edit"]) {
			const result = pi.call(toolName, {});
			expect(result).toMatchObject({ block: true });
		}
	});

	it("drops a granted MCP tool that is outside the server's own Planner allowlist (M2 defense in depth)", () => {
		configure(["delete_task"]);
		const pi = fakePi();
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(pi);

		// "delete_task" is not in PLANNER_ALLOWED_MCP_TOOLS, so even though the
		// (hypothetical, widened) grant lists it, the call is still refused.
		expect(pi.call("tako_mcp_delete_task", { task_key: "DJ-1" })).toMatchObject({ block: true });
	});

	it("refuses an MCP tool that was not granted for this turn", () => {
		configure(["record_tako_grill_round"]);
		const pi = fakePi();
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(pi);

		const result = pi.call("tako_mcp_delete_task", { task_key: "DJ-1" });
		expect(result).toMatchObject({ block: true });
	});

	it("allows a granted MCP tool by its tako_mcp_ local name", () => {
		configure(["record_tako_grill_round"]);
		const pi = fakePi();
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(pi);

		const result = pi.call("tako_mcp_record_tako_grill_round", { session_id: "s1" });
		expect(result).toBeUndefined();
	});

	it("refuses a read-only builtin call whose path escapes the pinned worktree", () => {
		configure(["record_tako_grill_round"], "/tmp/worktree");
		const pi = fakePi();
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(pi);

		expect(pi.call("read", { path: "/etc/passwd" })).toMatchObject({ block: true });
		expect(pi.call("read", { path: "../outside.txt" })).toMatchObject({ block: true });
		expect(pi.call("read", { path: "~/.ssh/id_rsa" })).toMatchObject({ block: true });
	});

	it("allows a read-only builtin call whose path stays inside the pinned worktree", () => {
		configure(["record_tako_grill_round"], "/tmp/worktree");
		const pi = fakePi();
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(pi);

		expect(pi.call("read", { path: "README.md" })).toBeUndefined();
		expect(pi.call("ls", { path: "/tmp/worktree/src" })).toBeUndefined();
		expect(pi.call("grep", { pattern: "foo" })).toBeUndefined();
	});

	it("checks only path-like keys for grep/find, never the search pattern itself (N6)", () => {
		configure(["record_tako_grill_round"], "/tmp/worktree");
		const pi = fakePi();
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(pi);

		// A pattern that looks like a path (a route, a home-dir shorthand) is not
		// a filesystem path for grep/find: only `path`/`paths`/`cwd`/`glob` are.
		expect(pi.call("grep", { pattern: "/api/v1", path: "." })).toBeUndefined();
		expect(pi.call("grep", { pattern: "~/" })).toBeUndefined();
		expect(pi.call("find", { pattern: "../escape" })).toBeUndefined();

		// An actual path-like key for grep/find is still checked.
		expect(pi.call("grep", { pattern: "x", path: "/etc" })).toMatchObject({ block: true });
		expect(pi.call("find", { pattern: "x", cwd: "/etc" })).toMatchObject({ block: true });
	});

	it("blocks a symlink committed inside the worktree that points outside it (relative and absolute paths)", () => {
		const outside = mkdtempSync(join(tmpdir(), "pte-outside-"));
		writeFileSync(join(outside, "secret.txt"), "TOP-SECRET");
		const wt = mkdtempSync(join(tmpdir(), "pte-wt-"));
		mkdirSync(join(wt, "docs"));
		symlinkSync(outside, join(wt, "docs", "link"));
		configure(["record_tako_grill_round"], wt);
		const pi = fakePi();
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(pi);

		expect(pi.call("read", { path: "docs/link/secret.txt" })).toMatchObject({ block: true });
		expect(pi.call("read", { path: join(wt, "docs/link/secret.txt") })).toMatchObject({
			block: true,
		});
	});

	it("fails closed (blocks every read-only builtin) when no worktree is configured at all", () => {
		process.env.TAKONAUT_PLANNING_SERVER_URL = "https://takonaut.test";
		process.env.TAKONAUT_PLANNING_API_KEY = "secret";
		process.env.TAKONAUT_PLANNING_ORG_ID = "org-1";
		process.env.TAKONAUT_PLANNING_ALLOWED_TOOLS = JSON.stringify(["record_tako_grill_round"]);
		process.env.TAKONAUT_PLANNING_WORKTREE = "";
		const pi = fakePi();
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(pi);

		expect(pi.call("read", { path: "/etc/passwd" })).toMatchObject({ block: true });
		expect(pi.call("ls", { path: "." })).toMatchObject({ block: true });
	});

	it("allows a relative or absolute path that stays inside the pinned worktree, even through realpath resolution", () => {
		const wt = mkdtempSync(join(tmpdir(), "pte-wt-ok-"));
		writeFileSync(join(wt, "README.md"), "hi\n");
		configure(["record_tako_grill_round"], wt);
		const pi = fakePi();
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(pi);

		expect(pi.call("read", { path: "README.md" })).toBeUndefined();
		expect(pi.call("read", { path: join(wt, "README.md") })).toBeUndefined();
	});

	it("never registers any tool when required configuration is missing", () => {
		process.env.TAKONAUT_PLANNING_SERVER_URL = "";
		process.env.TAKONAUT_PLANNING_API_KEY = "";
		process.env.TAKONAUT_PLANNING_ORG_ID = "";
		process.env.TAKONAUT_PLANNING_ALLOWED_TOOLS = JSON.stringify(["record_tako_grill_round"]);
		process.env.TAKONAUT_PLANNING_WORKTREE = "/tmp/worktree";
		const pi = fakePi();
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(pi);

		expect(pi.registerTool).not.toHaveBeenCalled();
		// Still fails closed for everything, even with no config at all.
		expect(pi.call("read", { path: "/etc/passwd" })).toMatchObject({ block: true });
	});
});
