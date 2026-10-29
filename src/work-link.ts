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
	/** Several Stages fit: nothing moved until the developer picks one. */
	move_choices?: string[];
	/** `PROJECT:track_id`, the key for remembering the pick. */
	move_scope?: string | null;
}

export interface WorkLinkApi {
	linkWorkSession(input: {
		piSessionId: string;
		taskKey?: string;
		noTaskReason?: string;
		linkSource: WorkLinkSource;
		branchName?: string;
		repository?: string;
		/** The Stage picked from a previous link's `move_choices`. */
		columnName?: string;
	}): Promise<WorkLinkResult>;
	heartbeatWorkSession(
		piSessionId: string,
		planningCapable?: boolean,
		availableModels?: string[],
	): Promise<unknown>;
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

export function stagePreferencesPath(orgId: string): string {
	const safeOrgId = orgId.replace(/[^a-zA-Z0-9-]/g, "_");
	return join(homedir(), ".takonaut", "work-links", `stages-${safeOrgId}.json`);
}

/** Last Stage picked on link, keyed by `PROJECT:track_id`. */
export type StagePreferences = Record<string, string>;

export function loadStagePreferences(path: string): StagePreferences {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function saveStagePreference(path: string, scope: string, stage: string): void {
	const prefs = loadStagePreferences(path);
	prefs[scope] = stage;
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(prefs, null, 2) + "\n", { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
	}
}

export const DONT_MOVE = "Don't move";
const LAST_USED = " (last used)";

/**
 * When the link left several Stages open, ask which one and relink with it.
 * The last pick for the Track is offered first. Without a UI, or on
 * "Don't move" / cancel, the Task stays where it is.
 */
export async function settleLinkStage(input: {
	result: WorkLinkResult;
	select: ((title: string, options: string[]) => Promise<string | undefined>) | null;
	relink: (columnName: string) => Promise<WorkLinkResult>;
	preferences: StagePreferences;
	remember?: (scope: string, stage: string) => void;
}): Promise<WorkLinkResult> {
	const { result, select } = input;
	const choices = result.move_choices ?? [];
	if (!choices.length || !select) return result;
	const scope = result.move_scope ?? null;
	const last = scope ? input.preferences[scope] : undefined;
	const ordered =
		last && choices.includes(last)
			? [`${last}${LAST_USED}`, ...choices.filter((c) => c !== last)]
			: choices;
	const picked = await select(`Move ${result.task_key ?? "this Task"} to which Stage?`, [
		...ordered,
		DONT_MOVE,
	]);
	if (!picked || picked === DONT_MOVE) return result;
	const stage = picked.endsWith(LAST_USED) ? picked.slice(0, -LAST_USED.length) : picked;
	const moved = await input.relink(stage);
	if (scope) input.remember?.(scope, stage);
	return moved;
}

export function describeWorkLink(result: WorkLinkResult): string {
	const subject = result.task_key
		? `Working on ${result.task_key} · ${result.task_title ?? ""}`.trim()
		: `Working without a Task (${result.no_task_reason})`;
	const moved = result.moved_to ? `\nMoved to ${result.moved_to}.` : "";
	const choices = result.move_choices ?? [];
	const open =
		!result.moved_to && choices.length && result.task_key
			? `\nNot moved: pick a Stage (${choices.join(", ")}) with /tako-link ${result.task_key}.`
			: "";
	const warnings = result.warnings.length ? `\n${result.warnings.join("\n")}` : "";
	return `${subject}${moved}${open}${warnings}`;
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
			/** Each heartbeat's response (it carries requests to watch live). */
			onHeartbeat?: (result: unknown, piSessionId: string) => void;
			/** Whether this Pi build can run an offered planning turn (default: true). */
			planningCapable?: () => boolean;
			/** The `provider/id` models this Pi can run; undefined while unknown. */
			availableModels?: () => string[] | undefined;
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
			const planningCapable = this.options.planningCapable?.() ?? true;
			const models = this.options.availableModels?.();
			(models === undefined
				? api.heartbeatWorkSession(piSessionId, planningCapable)
				: api.heartbeatWorkSession(piSessionId, planningCapable, models)
			)
				.then((result) => this.options.onHeartbeat?.(result, piSessionId))
				.catch((error) => this.options.onHeartbeatError?.(error));
		}, this.options.intervalMs ?? WORK_LINK_HEARTBEAT_MS);
		(this.timer as { unref?: () => void }).unref?.();
	}

	private stopHeartbeat(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}
}
