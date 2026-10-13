import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { type CommandRunner, normalizeGitHubRemote } from "./git";

export const WORK_LINK_HEARTBEAT_MS = 60_000;

export type WorkLinkSource = "branch" | "recent" | "picker" | "command" | "run";

export interface WorkLinkResult {
	work_session_id: string;
	task_key: string | null;
	task_title: string | null;
	no_task_reason: string | null;
	moved_to: string | null;
	warnings: string[];
	started_at: string;
}

export interface WorkLinkApi {
	linkWorkSession(input: {
		piSessionId: string;
		taskKey?: string;
		noTaskReason?: string;
		linkSource: WorkLinkSource;
		branchName?: string;
		repository?: string;
	}): Promise<WorkLinkResult>;
	heartbeatWorkSession(piSessionId: string): Promise<unknown>;
	endWorkSession(piSessionId: string, reason: "unlinked" | "shutdown"): Promise<unknown>;
}

export interface WorkLinkCandidate {
	taskKey: string;
	source: WorkLinkSource;
}

export interface GitWorkContext {
	branch: string | null;
	repoRoot: string | null;
	/** Normalized `github.com/owner/name`, when origin is on GitHub. */
	repository: string | null;
}

export type WorkLinkMode = "off" | "nudge" | "required";

const TASK_KEY_IN_BRANCH = /(?:^|[/_.-])([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?=$|[/_.-])/;

/** Extract a Task key such as `CP-42` from `feat/cp-42-login`. */
export function taskKeyFromBranch(branch: string | null | undefined): string | null {
	if (!branch) return null;
	const match = TASK_KEY_IN_BRANCH.exec(branch);
	return match ? match[1].toUpperCase() : null;
}

/** Suggest a branch carrying the Task key so GitHub PRs auto-link to it. */
export function suggestBranchName(taskKey: string, title: string): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "");
	const key = taskKey.toLowerCase();
	return slug ? `${key}-${slug}` : key;
}

export async function readGitWorkContext(
	runner: CommandRunner,
	cwd: string,
): Promise<GitWorkContext> {
	const run = async (args: string[]) => {
		try {
			const result = await runner("git", args, { cwd, timeout: 5_000 });
			return result.exitCode === 0 ? result.stdout.trim() || null : null;
		} catch {
			return null;
		}
	};
	const repoRoot = await run(["rev-parse", "--show-toplevel"]);
	if (!repoRoot) return { branch: null, repoRoot: null, repository: null };
	const branch = await run(["rev-parse", "--abbrev-ref", "HEAD"]);
	const remote = await run(["remote", "get-url", "origin"]);
	return {
		branch: branch === "HEAD" ? null : branch,
		repoRoot,
		repository: remote ? normalizeGitHubRemote(remote) : null,
	};
}

export function recentLinksPath(orgId: string): string {
	const safeOrgId = orgId.replace(/[^a-zA-Z0-9-]/g, "_");
	return join(homedir(), ".takonaut", "work-links", `${safeOrgId}.json`);
}

type RecentLinks = Record<string, { taskKey: string; linkedAt: string }>;

export function loadRecentLinks(path: string): RecentLinks {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function saveRecentLink(path: string, repoRoot: string, taskKey: string): void {
	const links = loadRecentLinks(path);
	links[repoRoot] = { taskKey, linkedAt: new Date().toISOString() };
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(links, null, 2) + "\n", { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
	}
}

/**
 * Pick the Task this session is most likely working on.
 * Active Run beats branch name; the branch beats the last link for this repo.
 * A `recent` candidate must be confirmed by the developer before linking.
 */
export function detectWorkLinkCandidate(input: {
	activeRunTaskKey?: string | null;
	git: GitWorkContext;
	recent: RecentLinks;
}): WorkLinkCandidate | null {
	if (input.activeRunTaskKey) return { taskKey: input.activeRunTaskKey, source: "run" };
	const fromBranch = taskKeyFromBranch(input.git.branch);
	if (fromBranch) return { taskKey: fromBranch, source: "branch" };
	const recent = input.git.repoRoot ? input.recent[input.git.repoRoot] : undefined;
	return recent ? { taskKey: recent.taskKey, source: "recent" } : null;
}

export interface CurrentWorkLink {
	taskKey: string | null;
	taskTitle: string | null;
	noTaskReason: string | null;
	startedAt: string;
}

/** Owns this Pi session's Task link and its heartbeat. */
export class WorkLinkController {
	private current: CurrentWorkLink | null = null;
	private timer: ReturnType<typeof setInterval> | undefined;
	private nudged = false;

	constructor(
		private readonly options: {
			intervalMs?: number;
			onHeartbeatError?: (error: unknown) => void;
		} = {},
	) {}

	snapshot(): CurrentWorkLink | null {
		return this.current;
	}

	/** True once per session: whether to remind the developer to link a Task. */
	shouldNudge(): boolean {
		if (this.current || this.nudged) return false;
		this.nudged = true;
		return true;
	}

	async link(
		api: WorkLinkApi,
		input: Parameters<WorkLinkApi["linkWorkSession"]>[0],
	): Promise<WorkLinkResult> {
		const result = await api.linkWorkSession(input);
		this.current = {
			taskKey: result.task_key,
			taskTitle: result.task_title,
			noTaskReason: result.no_task_reason,
			startedAt: result.started_at,
		};
		this.startHeartbeat(api, input.piSessionId);
		return result;
	}

	async end(
		api: WorkLinkApi | null,
		piSessionId: string,
		reason: "unlinked" | "shutdown",
	): Promise<boolean> {
		const wasLinked = this.current !== null;
		this.stopHeartbeat();
		this.current = null;
		if (wasLinked && api) await api.endWorkSession(piSessionId, reason);
		return wasLinked;
	}

	reset(): void {
		this.stopHeartbeat();
		this.current = null;
		this.nudged = false;
	}

	private startHeartbeat(api: WorkLinkApi, piSessionId: string): void {
		this.stopHeartbeat();
		this.timer = setInterval(() => {
			api.heartbeatWorkSession(piSessionId).catch((error) =>
				this.options.onHeartbeatError?.(error),
			);
		}, this.options.intervalMs ?? WORK_LINK_HEARTBEAT_MS);
		(this.timer as { unref?: () => void }).unref?.();
	}

	private stopHeartbeat(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
