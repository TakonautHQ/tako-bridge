import { resolve } from "node:path";
import type {
	ActiveAgenticWorktreeState,
	AgenticCompletionTestState,
} from "./state";

export interface CommandResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface CommandOptions {
	cwd?: string;
}

export type CommandRunner = (
	command: string,
	args: string[],
	options?: CommandOptions,
) => Promise<CommandResult>;

/** Normalize Pi 0.84's exec result (`code`) while accepting older test adapters. */
export function fromPiExecResult(result: {
	stdout?: string;
	stderr?: string;
	code?: number;
	exitCode?: number;
	killed?: boolean;
}): CommandResult {
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		exitCode: result.exitCode ?? result.code ?? 0,
	};
}

export interface GitHubRepository {
	owner: string;
	name: string;
	defaultBranch: string;
}

export interface GitHubPreflight {
	repoRoot: string;
	remoteFingerprint: string;
	branch: string;
	defaultBranch: string;
	baseSha: string;
}

export interface GitHubPrEvidence {
	url: string;
	number: number;
	state: "open";
	branch: string;
	baseBranch: string;
	baseSha: string;
	headSha: string;
}

function failed(result: CommandResult): boolean {
	return result.exitCode !== 0;
}

function detail(result: CommandResult): string {
	return (result.stderr || result.stdout).trim();
}

export function normalizeGitHubRemote(remote: string): string | null {
	const value = remote.trim();
	let match = value.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i);
	if (!match)
		match = value.match(
			/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i,
		);
	if (!match)
		match = value.match(
			/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i,
		);
	if (!match) return null;
	const owner = match[1].toLowerCase();
	const name = match[2].replace(/\.git$/i, "").toLowerCase();
	return `github.com/${owner}/${name}`;
}

export async function runGitHubPreflight(
	run: CommandRunner,
	configuredRoot: string,
	expectedRepo: GitHubRepository,
	protectedBranches: string[],
	sessionCwd?: string,
): Promise<GitHubPreflight> {
	const gitVersion = await run("git", ["--version"]);
	if (failed(gitVersion)) {
		throw new Error(
			"Git is not installed or not available on PATH. Install Git before using Tako Bridge.",
		);
	}

	const rootResult = await run("git", [
		"-C",
		configuredRoot,
		"rev-parse",
		"--show-toplevel",
	]);
	if (failed(rootResult) || !rootResult.stdout.trim()) {
		throw new Error(
			`Tako Bridge cannot establish a Git repository at '${configuredRoot}'. Open Pi from the linked repository.`,
		);
	}
	const actualRoot = resolve(rootResult.stdout.trim());
	if (sessionCwd && resolve(sessionCwd) !== actualRoot) {
		throw new Error(
			`Pi session was opened from '${resolve(sessionCwd)}', but this Project is mapped to '${actualRoot}'. ` +
				"Quit Pi, open the mapped repository, and retry.",
		);
	}
	if (actualRoot !== resolve(configuredRoot)) {
		throw new Error(
			`The current Git root '${actualRoot}' does not match the configured repository '${resolve(configuredRoot)}'.`,
		);
	}

	const userName = await run("git", [
		"-C",
		actualRoot,
		"config",
		"--get",
		"user.name",
	]);
	const userEmail = await run("git", [
		"-C",
		actualRoot,
		"config",
		"--get",
		"user.email",
	]);
	if (
		failed(userName) ||
		!userName.stdout.trim() ||
		failed(userEmail) ||
		!userEmail.stdout.trim()
	) {
		throw new Error(
			"Git identity is incomplete. Set repository-local `git config user.name` and `git config user.email`, then retry.",
		);
	}

	const remoteResult = await run("git", [
		"-C",
		actualRoot,
		"remote",
		"get-url",
		"origin",
	]);
	const remoteFingerprint = normalizeGitHubRemote(remoteResult.stdout);
	const expectedFingerprint =
		`github.com/${expectedRepo.owner}/${expectedRepo.name}`.toLowerCase();
	if (failed(remoteResult) || !remoteFingerprint) {
		throw new Error(
			"The repository has no supported GitHub `origin` remote. Connect this project to GitHub and configure `origin`.",
		);
	}
	if (remoteFingerprint !== expectedFingerprint) {
		throw new Error(
			`Local remote '${remoteFingerprint}' does not match the GitHub repository connected to this Takonaut project ('${expectedFingerprint}').`,
		);
	}

	const branchResult = await run("git", [
		"-C",
		actualRoot,
		"branch",
		"--show-current",
	]);
	const branch = branchResult.stdout.trim();
	if (failed(branchResult) || !branch) {
		throw new Error(
			"Tako Bridge requires a named feature branch; detached HEAD is not supported.",
		);
	}
	if (
		protectedBranches.some(
			(item) => item.toLowerCase() === branch.toLowerCase(),
		)
	) {
		throw new Error(
			`Tako Bridge will not start on protected branch '${branch}'. Create a feature branch and retry.`,
		);
	}

	const status = await run("git", ["-C", actualRoot, "status", "--porcelain"]);
	if (failed(status))
		throw new Error(
			`Unable to inspect the Git working tree: ${detail(status)}`,
		);
	if (status.stdout.trim()) {
		throw new Error(
			"The Git working tree is not clean. Commit, stash, or remove existing changes before starting a Tako Bridge run.",
		);
	}

	const ghVersion = await run("gh", ["--version"]);
	if (failed(ghVersion)) {
		throw new Error(
			"GitHub CLI (`gh`) is not installed. Install it from https://cli.github.com/ and retry.",
		);
	}
	const ghAuth = await run("gh", [
		"auth",
		"status",
		"--hostname",
		"github.com",
	]);
	if (failed(ghAuth)) {
		throw new Error(
			"GitHub CLI is not authenticated. Run `gh auth login --hostname github.com`, then retry.",
		);
	}
	const push = await run("gh", [
		"api",
		`repos/${expectedRepo.owner}/${expectedRepo.name}`,
		"--jq",
		".permissions.push",
	]);
	if (failed(push)) {
		throw new Error(
			`GitHub CLI cannot access ${expectedRepo.owner}/${expectedRepo.name}: ${detail(push)}`,
		);
	}
	if (push.stdout.trim() !== "true") {
		throw new Error(
			`Your GitHub account does not have push access to ${expectedRepo.owner}/${expectedRepo.name}.`,
		);
	}
	const base = await run("git", [
		"-C",
		actualRoot,
		"rev-parse",
		`origin/${expectedRepo.defaultBranch}`,
	]);
	const baseSha = base.stdout.trim();
	if (failed(base) || !/^[0-9a-f]{40}$/i.test(baseSha)) {
		throw new Error(
			`Cannot resolve origin/${expectedRepo.defaultBranch}. Fetch the GitHub remote and retry.`,
		);
	}

	return {
		repoRoot: actualRoot,
		remoteFingerprint,
		branch,
		defaultBranch: expectedRepo.defaultBranch,
		baseSha: baseSha.toLowerCase(),
	};
}

export async function collectGitHubPrEvidence(
	run: CommandRunner,
	repoRoot: string,
	expectedRepo: GitHubRepository,
	branch: string,
	expectedBaseRef: string | null = expectedRepo.defaultBranch,
	expectedBaseSha?: string,
): Promise<GitHubPrEvidence> {
	const status = await run("git", ["-C", repoRoot, "status", "--porcelain"]);
	if (failed(status) || status.stdout.trim()) {
		throw new Error(
			"Commit all intended changes before submitting. Tako Bridge only submits evidence from a GitHub pull request.",
		);
	}
	const head = await run("git", ["-C", repoRoot, "rev-parse", "HEAD"]);
	if (failed(head) || !head.stdout.trim())
		throw new Error("Unable to resolve the current Git commit.");
	const headSha = head.stdout.trim();

	const prResult = await run("gh", [
		"pr",
		"view",
		branch,
		"--repo",
		`${expectedRepo.owner}/${expectedRepo.name}`,
		"--json",
		"url,number,state,headRefName,baseRefName,baseRefOid,headRefOid",
	]);
	if (failed(prResult)) {
		throw new Error(
			`No GitHub pull request found for '${branch}'. Commit and push the branch, run ` +
				"`gh pr create --fill`, then retry `/tako-submit`.",
		);
	}

	let pr: any;
	try {
		pr = JSON.parse(prResult.stdout);
	} catch {
		throw new Error("GitHub CLI returned an unreadable pull-request response.");
	}
	if (String(pr.state).toUpperCase() !== "OPEN")
		throw new Error("The GitHub pull request must be open.");
	if (pr.headRefName !== branch)
		throw new Error(
			"The GitHub pull request head branch does not match the active Bridge branch.",
		);
	if (expectedBaseRef && pr.baseRefName !== expectedBaseRef) {
		throw new Error(
			`The GitHub pull request must target '${expectedBaseRef}'.`,
		);
	}
	if (
		expectedBaseSha &&
		String(pr.baseRefOid).toLowerCase() !== expectedBaseSha.toLowerCase()
	) {
		throw new Error(
			"The GitHub pull request base commit no longer matches the pinned commit.",
		);
	}
	if (String(pr.headRefOid).toLowerCase() !== headSha.toLowerCase()) {
		throw new Error(
			"The local HEAD is not the pull request head. Push the current commit and retry.",
		);
	}
	if (!/^[0-9a-f]{40}$/i.test(pr.baseRefOid ?? "")) {
		throw new Error(
			"GitHub CLI did not return a valid pull request base commit.",
		);
	}

	return {
		url: pr.url,
		number: Number(pr.number),
		state: "open",
		branch,
		baseBranch: pr.baseRefName,
		baseSha: String(pr.baseRefOid).toLowerCase(),
		headSha,
	};
}

export interface AgenticWorkspaceCompletionEvidence {
	workspace_key: string;
	repository_fingerprint: string;
	branch_name: string;
	head_sha: string;
	clean: true;
	post_base_commit: boolean;
	pr_number: number | null;
	tests: Array<{
		command: string;
		exit_code: number;
		status: "passed" | "failed";
		summary: string;
		completed_at: string;
		head_sha: string;
	}>;
}

function repositoryFromFingerprint(fingerprint: string): GitHubRepository {
	const server = /^github:\d+:([^/]+)\/(.+)$/i.exec(fingerprint);
	const normalized = /^github\.com\/([^/]+)\/(.+)$/i.exec(fingerprint);
	const match = server ?? normalized;
	if (!match) throw new Error("Workspace repository fingerprint is invalid");
	return {
		owner: match[1],
		name: match[2].replace(/\.git$/i, ""),
		defaultBranch: "main",
	};
}

export async function collectAgenticWorkspaceCompletionEvidence(
	run: CommandRunner,
	worktree: ActiveAgenticWorktreeState,
	tests: AgenticCompletionTestState[],
): Promise<AgenticWorkspaceCompletionEvidence> {
	const status = await run("git", [
		"-C",
		worktree.worktreeRoot,
		"status",
		"--porcelain",
	]);
	if (failed(status) || status.stdout.trim()) {
		throw new Error(
			`Workspace '${worktree.workspaceKey}' must be clean before completion.`,
		);
	}
	const headResult = await run("git", [
		"-C",
		worktree.worktreeRoot,
		"rev-parse",
		"HEAD",
	]);
	const headSha = headResult.stdout.trim().toLowerCase();
	if (failed(headResult) || !/^[0-9a-f]{40}$/.test(headSha)) {
		throw new Error(`Workspace '${worktree.workspaceKey}' HEAD is invalid.`);
	}
	const changed = headSha !== worktree.baseSha;
	if (!changed) {
		return {
			workspace_key: worktree.workspaceKey,
			repository_fingerprint: worktree.repositoryFingerprint,
			branch_name: worktree.branchName,
			head_sha: headSha,
			clean: true,
			post_base_commit: false,
			pr_number: null,
			tests: [],
		};
	}
	const ancestry = await run("git", [
		"-C",
		worktree.worktreeRoot,
		"merge-base",
		"--is-ancestor",
		worktree.baseSha,
		headSha,
	]);
	if (failed(ancestry)) {
		throw new Error(
			`Workspace '${worktree.workspaceKey}' HEAD is not based on the pinned commit.`,
		);
	}
	const currentTests = tests.filter((test) => test.headSha === headSha);
	if (
		!currentTests.length ||
		currentTests.some((test) => test.status !== "passed" || test.exitCode !== 0)
	) {
		throw new Error(
			`Workspace '${worktree.workspaceKey}' needs current passing test evidence.`,
		);
	}
	const expectedBaseRef = worktree.overrideBaseRef
		? null
		: worktree.configuredBaseRef;
	const repository = repositoryFromFingerprint(worktree.repositoryFingerprint);
	const pr = await collectGitHubPrEvidence(
		run,
		worktree.worktreeRoot,
		repository,
		worktree.branchName,
		expectedBaseRef,
		worktree.baseSha,
	);
	return {
		workspace_key: worktree.workspaceKey,
		repository_fingerprint: worktree.repositoryFingerprint,
		branch_name: worktree.branchName,
		head_sha: headSha,
		clean: true,
		post_base_commit: true,
		pr_number: pr.number,
		tests: currentTests.map((test) => ({
			command: test.command,
			exit_code: test.exitCode,
			status: test.status,
			summary: test.summary,
			completed_at: test.completedAt,
			head_sha: test.headSha,
		})),
	};
}
