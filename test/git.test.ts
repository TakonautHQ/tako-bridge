import { describe, expect, it, vi } from "vitest";
import {
	collectAgenticWorkspaceCompletionEvidence,
	collectGitHubPrEvidence,
	fromPiExecResult,
	normalizeGitHubRemote,
	runGitHubPreflight,
	type CommandRunner,
} from "../src/git";

function runner(
	outputs: Record<
		string,
		{ stdout?: string; stderr?: string; exitCode?: number }
	>,
): CommandRunner {
	return vi.fn(async (command, args) => {
		const key = [command, ...args].join(" ");
		const result = outputs[key];
		if (!result) throw new Error(`unexpected command: ${key}`);
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode ?? 0,
		};
	});
}

const expectedRepo = {
	owner: "cureocity",
	name: "takonaut",
	defaultBranch: "main",
};

function healthyOutputs(
	root = "/work/takonaut",
): Record<string, { stdout?: string; stderr?: string; exitCode?: number }> {
	return {
		"git --version": { stdout: "git version 2.50.0\n" },
		[`git -C ${root} rev-parse --show-toplevel`]: { stdout: `${root}\n` },
		[`git -C ${root} config --get user.name`]: { stdout: "Sam Developer\n" },
		[`git -C ${root} config --get user.email`]: { stdout: "sam@example.com\n" },
		[`git -C ${root} remote get-url origin`]: {
			stdout: "git@github.com:cureocity/takonaut.git\n",
		},
		[`git -C ${root} branch --show-current`]: { stdout: "feat/demo\n" },
		[`git -C ${root} status --porcelain`]: { stdout: "" },
		[`git -C ${root} rev-parse origin/main`]: { stdout: `${"b".repeat(40)}\n` },
		"gh --version": { stdout: "gh version 2.74.0\n" },
		"gh auth status --hostname github.com": { stdout: "Logged in\n" },
		"gh api repos/cureocity/takonaut --jq .permissions.push": {
			stdout: "true\n",
		},
	};
}

describe("Pi command result normalization", () => {
	it("uses Pi 0.84's `code` field instead of treating failures as success", () => {
		expect(
			fromPiExecResult({
				stdout: "",
				stderr: "not found",
				code: 127,
				killed: false,
			}),
		).toEqual({ stdout: "", stderr: "not found", exitCode: 127 });
	});
});

describe("GitHub repository preflight", () => {
	it.each([
		["git@github.com:cureocity/takonaut.git", "github.com/cureocity/takonaut"],
		[
			"https://github.com/Cureocity/Takonaut.git",
			"github.com/cureocity/takonaut",
		],
		[
			"ssh://git@github.com/cureocity/takonaut.git",
			"github.com/cureocity/takonaut",
		],
	])("normalizes GitHub remote %s", (remote, expected) => {
		expect(normalizeGitHubRemote(remote)).toBe(expected);
	});

	it("accepts a clean mapped GitHub repository with git identity, gh auth, and push access", async () => {
		const result = await runGitHubPreflight(
			runner(healthyOutputs()),
			"/work/takonaut",
			expectedRepo,
			["main"],
		);
		expect(result).toMatchObject({
			repoRoot: "/work/takonaut",
			remoteFingerprint: "github.com/cureocity/takonaut",
			branch: "feat/demo",
			defaultBranch: "main",
			baseSha: "b".repeat(40),
		});
	});

	it("rejects a Pi session opened outside the mapped repository", async () => {
		await expect(
			runGitHubPreflight(
				runner(healthyOutputs()),
				"/work/takonaut",
				expectedRepo,
				["main"],
				"/work/other",
			),
		).rejects.toThrow("Pi session was opened from '/work/other'");
	});

	it("alerts clearly when GitHub CLI is not installed", async () => {
		const outputs = healthyOutputs();
		outputs["gh --version"] = { stderr: "command not found", exitCode: 127 };
		await expect(
			runGitHubPreflight(runner(outputs), "/work/takonaut", expectedRepo, [
				"main",
			]),
		).rejects.toThrow("GitHub CLI (`gh`) is not installed");
	});

	it("alerts when the local remote does not match the Takonaut project repository", async () => {
		const outputs = healthyOutputs();
		outputs["git -C /work/takonaut remote get-url origin"] = {
			stdout: "git@github.com:other/wrong-repo.git\n",
		};
		await expect(
			runGitHubPreflight(runner(outputs), "/work/takonaut", expectedRepo, [
				"main",
			]),
		).rejects.toThrow(
			"does not match the GitHub repository connected to this Takonaut project",
		);
	});

	it("alerts when gh is not authenticated", async () => {
		const outputs = healthyOutputs();
		outputs["gh auth status --hostname github.com"] = {
			stderr: "not logged in",
			exitCode: 1,
		};
		await expect(
			runGitHubPreflight(runner(outputs), "/work/takonaut", expectedRepo, [
				"main",
			]),
		).rejects.toThrow("Run `gh auth login --hostname github.com`");
	});

	it("rejects a protected branch and a dirty worktree before a run starts", async () => {
		const protectedOutputs = healthyOutputs();
		protectedOutputs["git -C /work/takonaut branch --show-current"] = {
			stdout: "main\n",
		};
		await expect(
			runGitHubPreflight(
				runner(protectedOutputs),
				"/work/takonaut",
				expectedRepo,
				["main"],
			),
		).rejects.toThrow("protected branch 'main'");

		const dirtyOutputs = healthyOutputs();
		dirtyOutputs["git -C /work/takonaut status --porcelain"] = {
			stdout: " M src/app.ts\n",
		};
		await expect(
			runGitHubPreflight(runner(dirtyOutputs), "/work/takonaut", expectedRepo, [
				"main",
			]),
		).rejects.toThrow("working tree is not clean");
	});
});

describe("GitHub PR evidence", () => {
	it("collects an open PR whose repository, branch, and head SHA match", async () => {
		const outputs = healthyOutputs();
		Object.assign(outputs, {
			"git -C /work/takonaut status --porcelain": { stdout: "" },
			"git -C /work/takonaut rev-parse HEAD": { stdout: `${"a".repeat(40)}\n` },
			"gh pr view feat/demo --repo cureocity/takonaut --json url,number,state,headRefName,baseRefName,baseRefOid,headRefOid":
				{
					stdout: JSON.stringify({
						url: "https://github.com/cureocity/takonaut/pull/42",
						number: 42,
						state: "OPEN",
						headRefName: "feat/demo",
						baseRefName: "main",
						baseRefOid: "b".repeat(40),
						headRefOid: "a".repeat(40),
					}),
				},
		});
		const evidence = await collectGitHubPrEvidence(
			runner(outputs),
			"/work/takonaut",
			expectedRepo,
			"feat/demo",
		);
		expect(evidence).toEqual({
			url: "https://github.com/cureocity/takonaut/pull/42",
			number: 42,
			state: "open",
			branch: "feat/demo",
			baseBranch: "main",
			baseSha: "b".repeat(40),
			headSha: "a".repeat(40),
		});
	});

	it("collects exact changed-Workspace PR and head-bound test evidence", async () => {
		const baseSha = "b".repeat(40);
		const headSha = "a".repeat(40);
		const outputs = {
			"git -C /managed/api status --porcelain": { stdout: "" },
			"git -C /managed/api rev-parse HEAD": { stdout: `${headSha}\n` },
			[`git -C /managed/api merge-base --is-ancestor ${baseSha} ${headSha}`]: {
				stdout: "",
			},
			"gh pr view tako/pay-42-api --repo cureocity/takonaut --json url,number,state,headRefName,baseRefName,baseRefOid,headRefOid":
				{
					stdout: JSON.stringify({
						url: "https://github.com/cureocity/takonaut/pull/42",
						number: 42,
						state: "OPEN",
						headRefName: "tako/pay-42-api",
						baseRefName: "main",
						baseRefOid: baseSha,
						headRefOid: headSha,
					}),
				},
		};
		const evidence = await collectAgenticWorkspaceCompletionEvidence(
			runner(outputs),
			{
				workspaceKey: "api",
				repositoryFingerprint: "github:123:cureocity/takonaut",
				configuredBaseRef: "main",
				overrideBaseRef: null,
				repoRoot: "/work/takonaut",
				worktreeRoot: "/managed/api",
				relativeWorktreePath: "project/run/api",
				branchName: "tako/pay-42-api",
				baseSha,
				initialHeadSha: baseSha,
				effectiveConfigHash: "c".repeat(64),
				lifecycle: "verified",
			},
			[
				{
					command: "bun run test",
					exitCode: 0,
					status: "passed",
					summary: "42 passed",
					completedAt: "2030-01-01T00:00:00.000Z",
					headSha,
				},
			],
		);
		expect(evidence.pr_number).toBe(42);
		expect(evidence.post_base_commit).toBe(true);
		expect(evidence.tests[0].head_sha).toBe(headSha);
	});

	it("retains unchanged Workspace provenance without a synthetic PR", async () => {
		const baseSha = "b".repeat(40);
		const evidence = await collectAgenticWorkspaceCompletionEvidence(
			runner({
				"git -C /managed/docs status --porcelain": { stdout: "" },
				"git -C /managed/docs rev-parse HEAD": { stdout: `${baseSha}\n` },
			}),
			{
				workspaceKey: "docs",
				repositoryFingerprint: "github:124:cureocity/docs",
				configuredBaseRef: "main",
				overrideBaseRef: null,
				repoRoot: "/work/docs",
				worktreeRoot: "/managed/docs",
				relativeWorktreePath: "project/run/docs",
				branchName: "tako/pay-42-docs",
				baseSha,
				initialHeadSha: baseSha,
				effectiveConfigHash: "c".repeat(64),
				lifecycle: "verified",
			},
			[],
		);
		expect(evidence).toMatchObject({
			workspace_key: "docs",
			head_sha: baseSha,
			post_base_commit: false,
			pr_number: null,
			tests: [],
		});
	});

	it("rejects a pull request whose target branch advanced past the pinned base", async () => {
		const outputs = healthyOutputs();
		Object.assign(outputs, {
			"git -C /work/takonaut status --porcelain": { stdout: "" },
			"git -C /work/takonaut rev-parse HEAD": { stdout: `${"a".repeat(40)}\n` },
			"gh pr view feat/demo --repo cureocity/takonaut --json url,number,state,headRefName,baseRefName,baseRefOid,headRefOid":
				{
					stdout: JSON.stringify({
						url: "https://github.com/cureocity/takonaut/pull/42",
						number: 42,
						state: "OPEN",
						headRefName: "feat/demo",
						baseRefName: "main",
						baseRefOid: "c".repeat(40),
						headRefOid: "a".repeat(40),
					}),
				},
		});
		await expect(
			collectGitHubPrEvidence(
				runner(outputs),
				"/work/takonaut",
				expectedRepo,
				"feat/demo",
				"main",
				"b".repeat(40),
			),
		).rejects.toThrow("base commit no longer matches");
	});

	it("gives an actionable error when no PR exists", async () => {
		const outputs = healthyOutputs();
		Object.assign(outputs, {
			"git -C /work/takonaut status --porcelain": { stdout: "" },
			"git -C /work/takonaut rev-parse HEAD": { stdout: `${"a".repeat(40)}\n` },
			"gh pr view feat/demo --repo cureocity/takonaut --json url,number,state,headRefName,baseRefName,baseRefOid,headRefOid":
				{
					stderr: "no pull requests found",
					exitCode: 1,
				},
		});
		await expect(
			collectGitHubPrEvidence(
				runner(outputs),
				"/work/takonaut",
				expectedRepo,
				"feat/demo",
			),
		).rejects.toThrow("No GitHub pull request found");
	});
});
