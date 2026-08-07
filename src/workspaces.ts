import { existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgenticWorkspacePlan } from "./client";
import {
	normalizeGitHubRemote,
	type CommandResult,
	type CommandRunner,
} from "./git";
import type { ActiveAgenticWorktreeState } from "./state";

const SHA_RE = /^[0-9a-f]{40}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const WORKSPACE_KEY_RE = /^[a-z][a-z0-9_-]{0,79}$/;
const BRANCH_RE =
	/^(?![-/])(?!.*(?:\.\.|\/\/|@\{|\\|\s))[A-Za-z0-9._/-]{1,255}(?<![./])$/;

function detail(result: CommandResult): string {
	return (result.stderr || result.stdout).trim();
}

async function git(
	run: CommandRunner,
	repoRoot: string,
	args: string[],
): Promise<string> {
	const result = await run("git", ["-C", repoRoot, ...args]);
	if (result.exitCode !== 0) {
		throw new Error(detail(result) || `git ${args[0]} failed`);
	}
	return result.stdout.trim();
}

function contained(root: string, target: string): boolean {
	const rel = relative(root, target);
	return (
		rel !== "" &&
		rel !== ".." &&
		!rel.startsWith(`..${sep}`) &&
		!isAbsolute(rel)
	);
}

export function validateManagedTarget(
	managedRoot: string,
	target: string,
): void {
	const root = resolve(managedRoot);
	const destination = resolve(target);
	if (!contained(root, destination)) {
		throw new Error(
			"Worktree target is outside the managed Agentic Delivery namespace",
		);
	}
	if (!existsSync(root)) {
		throw new Error("Managed Agentic Delivery namespace does not exist");
	}
	const realRoot = realpathSync(root);
	if (lstatSync(root).isSymbolicLink()) {
		throw new Error("Managed Agentic Delivery namespace cannot be a symlink");
	}
	const rel = relative(root, destination);
	let current = root;
	for (const segment of rel.split(sep)) {
		current = join(current, segment);
		if (!existsSync(current)) continue;
		if (lstatSync(current).isSymbolicLink()) {
			throw new Error("Managed worktree target contains a symlink escape");
		}
		const realCurrent = realpathSync(current);
		if (
			realCurrent !== realRoot &&
			!realCurrent.startsWith(`${realRoot}${sep}`)
		) {
			throw new Error("Managed worktree target escapes its namespace");
		}
	}
}

function expectedGitHubRemote(fingerprint: string): string | null {
	const match = /^github:\d+:([^/]+)\/(.+)$/i.exec(fingerprint);
	if (!match) return null;
	return `github.com/${match[1].toLowerCase()}/${match[2]
		.replace(/\.git$/i, "")
		.toLowerCase()}`;
}

function safeRelativeNamespace(value: string): boolean {
	return (
		value.length > 0 &&
		!isAbsolute(value) &&
		!value.includes("\\") &&
		!value
			.split("/")
			.some((segment) => !segment || segment === "." || segment === "..")
	);
}

export async function verifyAgenticRepositoryRoot(
	run: CommandRunner,
	configuredRoot: string,
	repositoryFingerprint: string,
): Promise<string> {
	if (
		!isAbsolute(configuredRoot) ||
		!existsSync(configuredRoot) ||
		lstatSync(configuredRoot).isSymbolicLink()
	) {
		throw new Error(
			"Code Workspace repository root is missing, relative, or a symlink",
		);
	}
	const repoRoot = realpathSync(configuredRoot);
	const actualRoot = realpathSync(
		await git(run, repoRoot, ["rev-parse", "--show-toplevel"]),
	);
	if (actualRoot !== repoRoot) {
		throw new Error("Code Workspace repository root mismatch");
	}
	const expectedRemote = expectedGitHubRemote(repositoryFingerprint);
	const actualRemote = normalizeGitHubRemote(
		await git(run, repoRoot, ["remote", "get-url", "origin"]),
	);
	if (!expectedRemote || actualRemote !== expectedRemote) {
		throw new Error("Code Workspace repository fingerprint mismatch");
	}
	if (await git(run, repoRoot, ["status", "--porcelain"])) {
		throw new Error("Code Workspace base checkout must be clean");
	}
	const [userName, userEmail] = await Promise.all([
		git(run, repoRoot, ["config", "user.name"]),
		git(run, repoRoot, ["config", "user.email"]),
	]);
	if (!userName || !userEmail) {
		throw new Error("Code Workspace Git identity is not configured");
	}
	return repoRoot;
}

export interface ProvisionAgenticWorktreesInput {
	run: CommandRunner;
	managedRoot: string;
	relativeNamespace: string;
	plans: AgenticWorkspacePlan[];
	repoRoots: Record<string, string>;
	effectiveConfigHash: string;
}

export async function provisionAgenticWorktrees(
	input: ProvisionAgenticWorktreesInput,
): Promise<ActiveAgenticWorktreeState[]> {
	if (!input.plans.length || input.plans.length > 32) {
		throw new Error(
			"Agentic Delivery Workspace plan must be non-empty and bounded",
		);
	}
	if (!safeRelativeNamespace(input.relativeNamespace)) {
		throw new Error("Managed Workspace namespace metadata is unsafe");
	}
	if (!HASH_RE.test(input.effectiveConfigHash)) {
		throw new Error("Effective Agentic Delivery configuration hash is invalid");
	}
	mkdirSync(input.managedRoot, { recursive: true, mode: 0o700 });
	const seen = new Set<string>();
	const verified: ActiveAgenticWorktreeState[] = [];
	for (const plan of input.plans) {
		if (
			!WORKSPACE_KEY_RE.test(plan.workspace_key) ||
			seen.has(plan.workspace_key)
		) {
			throw new Error(
				"Workspace plan contains an invalid or duplicate stable key",
			);
		}
		seen.add(plan.workspace_key);
		if (
			!SHA_RE.test(plan.resolved_base_sha) ||
			!BRANCH_RE.test(plan.branch_name)
		) {
			throw new Error(
				`Workspace '${plan.workspace_key}' has unsafe Git metadata`,
			);
		}
		const configuredRoot = input.repoRoots[plan.workspace_key];
		if (!configuredRoot) {
			throw new Error(
				`No locally approved repository root exists for Workspace '${plan.workspace_key}'`,
			);
		}
		const repoRoot = await verifyAgenticRepositoryRoot(
			input.run,
			configuredRoot,
			plan.repository_fingerprint,
		);
		await git(input.run, repoRoot, [
			"cat-file",
			"-e",
			`${plan.resolved_base_sha}^{commit}`,
		]);

		const worktreeRoot = join(input.managedRoot, plan.workspace_key);
		validateManagedTarget(input.managedRoot, worktreeRoot);
		if (!existsSync(worktreeRoot)) {
			const result = await input.run("git", [
				"-C",
				repoRoot,
				"worktree",
				"add",
				"-b",
				plan.branch_name,
				worktreeRoot,
				plan.resolved_base_sha,
			]);
			if (result.exitCode !== 0) {
				throw new Error(
					`Workspace '${plan.workspace_key}' worktree creation failed: ${detail(result)}`,
				);
			}
		}
		validateManagedTarget(input.managedRoot, worktreeRoot);
		const actualWorktreeRoot = realpathSync(
			await git(input.run, worktreeRoot, ["rev-parse", "--show-toplevel"]),
		);
		if (
			actualWorktreeRoot !== realpathSync(worktreeRoot) ||
			actualWorktreeRoot === repoRoot
		) {
			throw new Error(
				`Workspace '${plan.workspace_key}' fell back to the base checkout`,
			);
		}
		const headSha = await git(input.run, worktreeRoot, ["rev-parse", "HEAD"]);
		const branchName = await git(input.run, worktreeRoot, [
			"rev-parse",
			"--abbrev-ref",
			"HEAD",
		]);
		if (headSha !== plan.resolved_base_sha || branchName !== plan.branch_name) {
			throw new Error(
				`Workspace '${plan.workspace_key}' worktree identity mismatch`,
			);
		}
		verified.push({
			workspaceKey: plan.workspace_key,
			repositoryFingerprint: plan.repository_fingerprint,
			configuredBaseRef: plan.configured_base_ref,
			overrideBaseRef: plan.override_base_ref,
			repoRoot,
			worktreeRoot: actualWorktreeRoot,
			relativeWorktreePath: `${input.relativeNamespace}/${plan.workspace_key}`,
			branchName,
			baseSha: plan.resolved_base_sha,
			initialHeadSha: headSha,
			effectiveConfigHash: input.effectiveConfigHash,
			lifecycle: "verified",
		});
	}
	return verified;
}

export interface CleanupAgenticWorktreeInput {
	run: CommandRunner;
	managedRoot: string;
	repositoryRoot: string;
	workspace: ActiveAgenticWorktreeState;
}

export interface CleanupAgenticWorktreeResult {
	workspaceKey: string;
	repositoryFingerprint: string;
	branchName: string;
	relativeWorktreePath: string;
	finalHeadSha: string | null;
	clean: boolean;
	removed: boolean;
	retainedBranch: boolean;
	status: "completed" | "refused" | "failed";
	errorCode: string | null;
}

/** Remove only an exact, clean managed worktree. The branch is intentionally retained. */
export async function cleanupAgenticWorktree(
	input: CleanupAgenticWorktreeInput,
): Promise<CleanupAgenticWorktreeResult> {
	const { run, managedRoot, repositoryRoot, workspace } = input;
	const base = {
		workspaceKey: workspace.workspaceKey,
		repositoryFingerprint: workspace.repositoryFingerprint,
		branchName: workspace.branchName,
		relativeWorktreePath: workspace.relativeWorktreePath,
	};
	if (
		!safeRelativeNamespace(workspace.relativeWorktreePath) ||
		workspace.relativeWorktreePath.split("/").at(-1) !== workspace.workspaceKey
	) {
		throw new Error("Server-recorded managed worktree identity is invalid");
	}
	const configuredManagedRoot = resolve(managedRoot);
	const configuredWorktreeRoot = resolve(workspace.worktreeRoot);
	const canonicalManagedRoot = realpathSync(configuredManagedRoot);
	const storedTarget = contained(configuredManagedRoot, configuredWorktreeRoot)
		? join(
				canonicalManagedRoot,
				relative(configuredManagedRoot, configuredWorktreeRoot),
			)
		: configuredWorktreeRoot;
	const targetRoot = join(canonicalManagedRoot, workspace.workspaceKey);
	if (resolve(storedTarget) !== resolve(targetRoot)) {
		throw new Error(
			"Local worktree path does not match the server-recorded Workspace identity",
		);
	}
	validateManagedTarget(canonicalManagedRoot, targetRoot);
	const expectedRemote = expectedGitHubRemote(workspace.repositoryFingerprint);
	const sourceRemote = normalizeGitHubRemote(
		await git(run, repositoryRoot, ["config", "--get", "remote.origin.url"]),
	);
	if (sourceRemote !== expectedRemote) {
		return {
			...base,
			finalHeadSha: null,
			clean: false,
			removed: false,
			retainedBranch: true,
			status: "refused",
			errorCode: "repository_fingerprint_mismatch",
		};
	}
	if (!existsSync(targetRoot)) {
		const branch = await run("git", [
			"-C",
			repositoryRoot,
			"rev-parse",
			`refs/heads/${workspace.branchName}`,
		]);
		const retainedBranch = branch.exitCode === 0;
		const finalHeadSha = retainedBranch
			? branch.stdout.trim()
			: workspace.baseSha;
		return {
			...base,
			finalHeadSha,
			clean: true,
			removed: true,
			retainedBranch,
			status: "completed",
			errorCode: null,
		};
	}
	if (lstatSync(targetRoot).isSymbolicLink()) {
		return {
			...base,
			finalHeadSha: null,
			clean: false,
			removed: false,
			retainedBranch: true,
			status: "refused",
			errorCode: "worktree_symlink",
		};
	}
	const exactRoot = realpathSync(targetRoot);
	const reportedRoot = realpathSync(
		await git(run, targetRoot, ["rev-parse", "--show-toplevel"]),
	);
	if (exactRoot !== reportedRoot) {
		return {
			...base,
			finalHeadSha: null,
			clean: false,
			removed: false,
			retainedBranch: true,
			status: "refused",
			errorCode: "worktree_identity_mismatch",
		};
	}
	const remote = normalizeGitHubRemote(
		await git(run, exactRoot, ["config", "--get", "remote.origin.url"]),
	);
	const branch = await git(run, exactRoot, ["branch", "--show-current"]);
	const finalHeadSha = await git(run, exactRoot, ["rev-parse", "HEAD"]);
	if (
		remote !== expectedRemote ||
		branch !== workspace.branchName ||
		!SHA_RE.test(finalHeadSha)
	) {
		return {
			...base,
			finalHeadSha: SHA_RE.test(finalHeadSha) ? finalHeadSha : null,
			clean: false,
			removed: false,
			retainedBranch: true,
			status: "refused",
			errorCode: "worktree_identity_mismatch",
		};
	}
	const dirty = await git(run, exactRoot, ["status", "--porcelain=v1"]);
	if (dirty) {
		return {
			...base,
			finalHeadSha,
			clean: false,
			removed: false,
			retainedBranch: true,
			status: "refused",
			errorCode: "worktree_dirty",
		};
	}
	await git(run, repositoryRoot, ["worktree", "remove", "--", exactRoot]);
	await git(run, repositoryRoot, ["worktree", "prune"]);
	if (existsSync(exactRoot)) {
		return {
			...base,
			finalHeadSha,
			clean: true,
			removed: false,
			retainedBranch: true,
			status: "failed",
			errorCode: "worktree_remove_failed",
		};
	}
	const retainedHead = await git(run, repositoryRoot, [
		"rev-parse",
		`refs/heads/${workspace.branchName}`,
	]);
	return {
		...base,
		finalHeadSha: retainedHead,
		clean: true,
		removed: true,
		retainedBranch: true,
		status: "completed",
		errorCode: null,
	};
}
