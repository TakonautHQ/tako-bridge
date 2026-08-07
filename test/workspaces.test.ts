import { execFile } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgenticWorkspacePlan } from "../src/client";
import type { CommandRunner } from "../src/git";
import {
	cleanupAgenticWorktree,
	provisionAgenticWorktrees,
	validateManagedTarget,
	verifyAgenticRepositoryRoot,
} from "../src/workspaces";

const execFileAsync = promisify(execFile);
const run: CommandRunner = async (command, args, options) => {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options?.cwd,
			encoding: "utf8",
		});
		return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
	} catch (error) {
		const failure = error as {
			stdout?: string;
			stderr?: string;
			code?: number;
		};
		return {
			stdout: failure.stdout ?? "",
			stderr: failure.stderr ?? "",
			exitCode: typeof failure.code === "number" ? failure.code : 1,
		};
	}
};

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await run("git", ["-C", cwd, ...args]);
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

let root: string;
let repoRoot: string;
let managedRoot: string;
let sha: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "tako-workspaces-"));
	repoRoot = join(root, "source");
	managedRoot = join(root, "managed", "org-1", "project-1", "run-1");
	mkdirSync(repoRoot, { recursive: true });
	await git(repoRoot, "init");
	await git(repoRoot, "config", "user.email", "test@takonaut.test");
	await git(repoRoot, "config", "user.name", "Takonaut Test");
	await git(
		repoRoot,
		"remote",
		"add",
		"origin",
		"git@github.com:takonaut/api.git",
	);
	writeFileSync(join(repoRoot, "README.md"), "safe\n");
	await git(repoRoot, "add", "README.md");
	await git(repoRoot, "commit", "-m", "initial");
	sha = await git(repoRoot, "rev-parse", "HEAD");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function plan(
	overrides: Partial<AgenticWorkspacePlan> = {},
): AgenticWorkspacePlan {
	return {
		workspace_key: "api",
		github_repo_id: "repo-id-1",
		repository_fingerprint: "github:123:takonaut/api",
		configured_base_ref: "main",
		override_base_ref: null,
		override_reason: null,
		resolved_base_sha: sha,
		branch_name: "tako/pay-142-12345678",
		...overrides,
	};
}

describe("managed Agentic Delivery worktrees", () => {
	it("verifies an interactively selected clean repository root", async () => {
		await expect(
			verifyAgenticRepositoryRoot(run, repoRoot, "github:123:takonaut/api"),
		).resolves.toBe(realpathSync(repoRoot));

		writeFileSync(join(repoRoot, "dirty.txt"), "dirty\n");
		await expect(
			verifyAgenticRepositoryRoot(run, repoRoot, "github:123:takonaut/api"),
		).rejects.toThrow(/clean/i);
	});

	it("creates and idempotently verifies a dedicated worktree from the pinned SHA", async () => {
		const first = await provisionAgenticWorktrees({
			run,
			managedRoot,
			relativeNamespace: "project-1/run-1",
			plans: [plan()],
			repoRoots: { api: repoRoot },
			effectiveConfigHash: "b".repeat(64),
		});
		const second = await provisionAgenticWorktrees({
			run,
			managedRoot,
			relativeNamespace: "project-1/run-1",
			plans: [plan()],
			repoRoots: { api: repoRoot },
			effectiveConfigHash: "b".repeat(64),
		});

		expect(first).toEqual(second);
		expect(first[0]).toMatchObject({
			workspaceKey: "api",
			initialHeadSha: sha,
			baseSha: sha,
			lifecycle: "verified",
			relativeWorktreePath: "project-1/run-1/api",
		});
		expect(realpathSync(first[0].worktreeRoot)).not.toBe(
			realpathSync(repoRoot),
		);
		expect(await git(first[0].worktreeRoot, "rev-parse", "HEAD")).toBe(sha);
	});

	it("rejects repository fingerprint mismatches", async () => {
		await expect(
			provisionAgenticWorktrees({
				run,
				managedRoot,
				relativeNamespace: "project-1/run-1",
				plans: [plan({ repository_fingerprint: "github:123:other/repo" })],
				repoRoots: { api: repoRoot },
				effectiveConfigHash: "b".repeat(64),
			}),
		).rejects.toThrow(/fingerprint/i);
	});

	it("rejects dirty cleanup and removes an exact managed worktree while retaining its branch", async () => {
		const [workspace] = await provisionAgenticWorktrees({
			run,
			managedRoot,
			relativeNamespace: "project-1/run-1",
			plans: [plan()],
			repoRoots: { api: repoRoot },
			effectiveConfigHash: "b".repeat(64),
		});
		writeFileSync(join(workspace.worktreeRoot, "dirty.txt"), "dirty\n");
		const refused = await cleanupAgenticWorktree({
			run,
			managedRoot,
			repositoryRoot: repoRoot,
			workspace,
		});
		expect(refused).toMatchObject({
			status: "refused",
			removed: false,
			clean: false,
			errorCode: "worktree_dirty",
		});
		await expect(
			cleanupAgenticWorktree({
				run,
				managedRoot,
				repositoryRoot: repoRoot,
				workspace: {
					...workspace,
					worktreeRoot: join(managedRoot, "other"),
				},
			}),
		).rejects.toThrow(/server-recorded Workspace identity/i);

		rmSync(join(workspace.worktreeRoot, "dirty.txt"));
		const cleaned = await cleanupAgenticWorktree({
			run,
			managedRoot,
			repositoryRoot: repoRoot,
			workspace,
		});
		expect(cleaned).toMatchObject({
			status: "completed",
			removed: true,
			retainedBranch: true,
			finalHeadSha: sha,
		});
		await expect(
			git(
				repoRoot,
				"show-ref",
				"--verify",
				`refs/heads/${workspace.branchName}`,
			),
		).resolves.toContain(sha);
	});

	it("idempotently reconciles a planned Workspace that was never created", async () => {
		mkdirSync(managedRoot, { recursive: true });
		const result = await cleanupAgenticWorktree({
			run,
			managedRoot,
			repositoryRoot: repoRoot,
			workspace: {
				workspaceKey: "api",
				repositoryFingerprint: "github:123:takonaut/api",
				configuredBaseRef: "main",
				overrideBaseRef: null,
				repoRoot,
				worktreeRoot: join(managedRoot, "api"),
				relativeWorktreePath: "project-1/run-1/api",
				branchName: "tako/pay-142-never-created",
				baseSha: sha,
				initialHeadSha: "",
				effectiveConfigHash: "b".repeat(64),
				lifecycle: "planned",
			},
		});
		expect(result).toMatchObject({
			status: "completed",
			removed: true,
			retainedBranch: false,
			finalHeadSha: sha,
		});
	});

	it("rejects symlink escapes and unmanaged targets", () => {
		mkdirSync(managedRoot, { recursive: true });
		const outside = join(root, "outside");
		mkdirSync(outside);
		const target = join(managedRoot, "api");
		symlinkSync(outside, target);
		expect(() => validateManagedTarget(managedRoot, target)).toThrow(
			/symlink/i,
		);
		expect(() => validateManagedTarget(managedRoot, repoRoot)).toThrow(
			/managed/i,
		);
	});
});
