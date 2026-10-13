import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	detectWorkLinkCandidate,
	loadRecentLinks,
	readGitWorkContext,
	saveRecentLink,
	suggestBranchName,
	taskKeyFromBranch,
	type WorkLinkApi,
	WorkLinkController,
} from "../src/work-link";

describe("taskKeyFromBranch", () => {
	it.each([
		["feat/cp-42-login", "CP-42"],
		["CP-42", "CP-42"],
		["fix/TESTPROJ-7", "TESTPROJ-7"],
		["sanif/bw2-113_retry", "BW2-113"],
	])("%s → %s", (branch, key) => {
		expect(taskKeyFromBranch(branch)).toBe(key);
	});

	// Key-shaped names such as release-2026 still parse; the server rejects
	// unknown Tasks and the session falls back to the link nudge.
	it.each(["main", "feat/login-v2", "hotfix/x", null])(
		"%s has no key",
		(branch) => {
			expect(taskKeyFromBranch(branch)).toBeNull();
		},
	);
});

it("suggests a branch that carries the Task key", () => {
	expect(suggestBranchName("CP-42", "Fix login: redirect loop!")).toBe(
		"cp-42-fix-login-redirect-loop",
	);
	expect(suggestBranchName("CP-42", "!!!")).toBe("cp-42");
});

describe("detectWorkLinkCandidate", () => {
	const recent = { "/repo": { taskKey: "CP-1", linkedAt: "x" } };
	it("prefers active run, then branch, then recent link", () => {
		const git = { branch: "feat/cp-9-x", repoRoot: "/repo", repository: null };
		expect(
			detectWorkLinkCandidate({ activeRunTaskKey: "CP-5", git, recent }),
		).toEqual({ taskKey: "CP-5", source: "run" });
		expect(detectWorkLinkCandidate({ git, recent })).toEqual({
			taskKey: "CP-9",
			source: "branch",
		});
		expect(
			detectWorkLinkCandidate({ git: { branch: "main", repoRoot: "/repo", repository: null }, recent }),
		).toEqual({ taskKey: "CP-1", source: "recent" });
		expect(
			detectWorkLinkCandidate({ git: { branch: "main", repoRoot: "/x", repository: null }, recent }),
		).toBeNull();
	});
});

it("reads branch and repo root, treating detached HEAD as no branch", async () => {
	const runner = vi.fn(async (_cmd: string, args: string[]) => ({
		stdout: args.includes("--show-toplevel")
			? "/repo\n"
			: args.includes("get-url")
				? "git@github.com:Acme/App.git\n"
				: "HEAD\n",
		stderr: "",
		exitCode: 0,
	}));
	expect(await readGitWorkContext(runner, "/repo")).toEqual({
		branch: null,
		repoRoot: "/repo",
		repository: "github.com/acme/app",
	});
});

describe("recent links", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	it("round-trips per repo", () => {
		dir = mkdtempSync(join(tmpdir(), "worklink-"));
		const path = join(dir, "org.json");
		expect(loadRecentLinks(path)).toEqual({});
		saveRecentLink(path, "/repo", "CP-3");
		expect(loadRecentLinks(path)["/repo"].taskKey).toBe("CP-3");
	});
});

describe("WorkLinkController", () => {
	afterEach(() => vi.useRealTimers());

	function api(): WorkLinkApi & Record<string, ReturnType<typeof vi.fn>> {
		return {
			linkWorkSession: vi.fn(async (input) => ({
				work_session_id: "ws",
				task_key: input.taskKey ?? null,
				task_title: input.taskKey ? "Title" : null,
				no_task_reason: input.noTaskReason ?? null,
				moved_to: null,
				warnings: [],
				started_at: "2026-10-13T09:00:00Z",
			})),
			heartbeatWorkSession: vi.fn(async () => ({})),
			endWorkSession: vi.fn(async () => ({})),
		};
	}

	it("links, heartbeats, and ends", async () => {
		vi.useFakeTimers();
		const a = api();
		const link = new WorkLinkController({ intervalMs: 1_000 });
		await link.link(a, { piSessionId: "s", taskKey: "CP-1", linkSource: "command" });
		expect(link.snapshot()?.taskKey).toBe("CP-1");
		vi.advanceTimersByTime(2_500);
		expect(a.heartbeatWorkSession).toHaveBeenCalledTimes(2);

		expect(await link.end(a, "s", "unlinked")).toBe(true);
		expect(a.endWorkSession).toHaveBeenCalledWith("s", "unlinked");
		vi.advanceTimersByTime(5_000);
		expect(a.heartbeatWorkSession).toHaveBeenCalledTimes(2);
		expect(await link.end(a, "s", "unlinked")).toBe(false);
	});

	it("nudges once, and never when linked", async () => {
		const link = new WorkLinkController();
		expect(link.shouldNudge()).toBe(true);
		expect(link.shouldNudge()).toBe(false);
		link.reset();
		await link.link(api(), { piSessionId: "s", noTaskReason: "support", linkSource: "picker" });
		expect(link.shouldNudge()).toBe(false);
		await link.end(null, "s", "shutdown");
	});
});
