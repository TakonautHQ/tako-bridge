import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { TakonautClient } from "./client";
import type { CommandRunner } from "./git";
import {
	DEFAULT_LIVE_WATCH_LIMITS,
	type LiveWatchLimits,
	LiveWatchBroadcaster,
	type Watcher,
} from "./live-watch";
import { repositoryState } from "./task-handoff";

export interface LiveWatchCommandDeps {
	connection(ctx: ExtensionContext): TakonautClient | null;
	/** This Pi session's key (the one work links use). */
	sessionKey(ctx: ExtensionContext): string;
	run: CommandRunner;
	cwd(): string;
}

const STATUS_KEY = "tako-watch";
const PROJECT = "Everyone in the Project";
const PEOPLE = "Specific people";
const SERVER_ERROR = /live_watch:([a-z_]+)/;

export const LIVE_WATCH_DISCLOSURE = [
	"Teammates you choose can watch this session live, read-only, in Takonaut.",
	"",
	"Shared: your prompts, the agent's replies and thinking, and one line per tool call (tool, file name, redacted command, success or failure).",
	"Not shared: tool output, file contents, command output, diffs, images, or anything from before now.",
	"",
	"Secrets are redacted. Nothing is kept after the broadcast ends. Watchers cannot send anything to this session.",
].join("\n");

const ERROR_MESSAGES: Record<string, string> = {
	live_watch_disabled:
		"Live watch is off for this Project. A Project administrator can allow it in the Project's Bridge settings.",
	not_project_member: "You need to be a member of the Project to broadcast in it.",
	invalid_recipients: "Every person must be a member of the Project.",
	too_many_viewers: "At most 20 people can be named.",
	live_watch_unavailable: "Takonaut can't relay live watch right now. Try again later.",
	project_not_found: "That Project was not found.",
};

const END_MESSAGES: Record<string, string> = {
	disabled: "a Project administrator turned live watch off",
	stale: "Takonaut stopped hearing from this session",
	max_duration: "it reached 8 hours; run /tako-watch to start again",
	author_removed: "you are no longer a member of the Project",
	replaced: "a new broadcast of this session replaced it",
};

function errorCode(error: unknown): string {
	return (
		(error instanceof Error ? SERVER_ERROR.exec(error.message)?.[1] : null) ??
		"failed"
	);
}

function words(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

function parseEmails(typed: string | undefined): string[] {
	return (typed ?? "")
		.split(/[\s,;]+/)
		.map((email) => email.trim().toLowerCase())
		.filter(Boolean);
}

/** A teammate's pending request to watch this session (from the server). */
export interface WatchRequest {
	id: string;
	requester: { id: string; name: string };
	project_key?: string;
	expires_at?: string;
}

export function parseWatchRequests(raw: unknown): WatchRequest[] {
	if (!Array.isArray(raw)) return [];
	return raw.filter(
		(item): item is WatchRequest =>
			typeof item?.id === "string" &&
			typeof item?.requester?.id === "string" &&
			typeof item?.requester?.name === "string",
	);
}

const ALLOW_PROJECT = "Allow everyone in the Project";

interface Live {
	broadcaster: LiveWatchBroadcaster;
	sessionKey: string;
	url: string;
	watchers: Watcher[];
	ctx: ExtensionContext;
}

/**
 * `/tako-watch` starts a read-only live broadcast of this session after the
 * author confirms what is shared and chooses who may watch; run it again to
 * see who is watching, change who may watch, or stop. `/tako-watch stop`
 * stops. Ending, switching or reloading the session ends the broadcast.
 *
 * Teammates may also ask to watch. Their requests arrive on the work-link
 * heartbeat (or the relay while live) through `receiveRequests`; the author
 * is told at once, and asked (allow this person, allow the Project, decline,
 * decide later) only when the agent pauses or on `/tako-watch`, so a run is
 * never interrupted. Without an interactive UI requests are ignored and
 * expire.
 */
export function registerLiveWatchCommands(
	pi: Pick<ExtensionAPI, "on" | "registerCommand">,
	deps: LiveWatchCommandDeps,
): { receiveRequests(sessionKey: string, raw: unknown): void } {
	let live: Live | null = null;
	// The latest context seen, for requests that arrive between events.
	let uiCtx: ExtensionContext | null = null;
	let pending: WatchRequest[] = [];
	const announced = new Set<string>();
	const later = new Set<string>();
	let deciding = false;

	function footer(ctx: ExtensionContext | null = live?.ctx ?? uiCtx): void {
		if (!ctx) return;
		const asking = pending.length ? `${pending.length} asking to watch` : "";
		const text = live
			? [`● Live · ${live.watchers.length} watching`, asking].filter(Boolean).join(" · ")
			: asking
				? `${asking} · /tako-watch`
				: undefined;
		ctx.ui.setStatus?.(STATUS_KEY, text);
	}

	function clearFooter(ctx: ExtensionContext): void {
		ctx.ui.setStatus?.(STATUS_KEY, undefined);
		footer(ctx);
	}

	function forgetRequests(): void {
		pending = [];
		announced.clear();
		later.clear();
	}

	function receiveRequests(sessionKey: string, raw: unknown): void {
		const ctx = live?.ctx ?? uiCtx;
		if (!ctx?.hasUI || sessionKey !== deps.sessionKey(ctx)) return;
		pending = parseWatchRequests(raw);
		const ids = new Set(pending.map((request) => request.id));
		for (const id of later) if (!ids.has(id)) later.delete(id);
		const fresh = pending.filter((request) => !announced.has(request.id));
		for (const request of fresh) announced.add(request.id);
		if (fresh.length) {
			const names = fresh.map((request) => request.requester.name || "A teammate").join(", ");
			ctx.ui.notify?.(
				`${names} ${fresh.length === 1 ? "asks" : "ask"} to watch this session live. You'll be asked when the agent pauses, or run /tako-watch.`,
				"info",
			);
		}
		footer();
	}

	function drop(id: string): void {
		pending = pending.filter((request) => request.id !== id);
		later.delete(id);
	}

	async function answer(
		ctx: ExtensionContext,
		request: WatchRequest,
		decision: "allow" | "allow_project" | "decline",
	): Promise<void> {
		const conn = deps.connection(ctx);
		const name = request.requester.name || "A teammate";
		if (!conn) {
			ctx.ui.notify?.("Sign in with /tako-login to answer requests to watch.", "error");
			return;
		}
		try {
			await conn.callTool("decide_live_watch_request", { request_id: request.id, decision });
		} catch (error) {
			const code = errorCode(error);
			if (code === "request_expired" || code === "request_not_found") {
				drop(request.id);
				ctx.ui.notify?.(`${name}'s request has expired.`, "info");
			} else {
				ctx.ui.notify?.(`Not answered: ${ERROR_MESSAGES[code] ?? code}`, "error");
			}
			return;
		}
		drop(request.id);
		ctx.ui.notify?.(
			decision === "decline"
				? `Declined ${name}'s request.`
				: decision === "allow_project"
					? "Everyone in the Project may watch now."
					: `${name} may watch now.`,
			"info",
		);
	}

	async function allow(
		ctx: ExtensionContext,
		request: WatchRequest,
		visibility: "project" | "people",
	): Promise<void> {
		if (live) {
			await answer(ctx, request, visibility === "project" ? "allow_project" : "allow");
			return;
		}
		const conn = deps.connection(ctx);
		if (!conn) {
			ctx.ui.notify?.("Sign in with /tako-login to use live watch.", "error");
			return;
		}
		const audienceName =
			visibility === "project" ? "everyone in the Project" : request.requester.name || "a teammate";
		if (!(await ctx.ui.confirm(`Broadcast this session live to ${audienceName}?`, LIVE_WATCH_DISCLOSURE))) {
			later.add(request.id);
			return;
		}
		if (await begin(ctx, conn, { visibility, emails: [] }, request.project_key ?? "", request.id)) {
			drop(request.id);
		}
	}

	/** Ask about each pending request in turn (deferred ones only on demand). */
	async function decideRequests(ctx: ExtensionContext, includeDeferred: boolean): Promise<void> {
		if (deciding || !ctx.hasUI) return;
		const queue = pending.filter((request) => includeDeferred || !later.has(request.id));
		if (!queue.length) return;
		deciding = true;
		try {
			for (const request of queue) {
				if (!pending.some((p) => p.id === request.id)) continue;
				const name = request.requester.name || "A teammate";
				const allowOne = `Allow ${name}`;
				const choice = await ctx.ui.select(`${name} asks to watch this session live, read-only.`, [
					allowOne,
					ALLOW_PROJECT,
					"Decline",
					"Decide later",
				]);
				if (choice === allowOne) await allow(ctx, request, "people");
				else if (choice === ALLOW_PROJECT) {
					await allow(ctx, request, "project");
					// Everyone may watch now: the server settles the rest as allowed.
					if (!pending.some((p) => p.id === request.id)) {
						pending = [];
						break;
					}
				} else if (choice === "Decline") await answer(ctx, request, "decline");
				else later.add(request.id);
			}
		} finally {
			deciding = false;
			footer(ctx);
		}
	}

	function current(): LiveWatchBroadcaster | null {
		return live?.broadcaster.live ? live.broadcaster : null;
	}

	async function audience(
		ctx: ExtensionContext,
	): Promise<{ visibility: "project" | "people"; emails: string[] } | null> {
		const choice = await ctx.ui.select("Who may watch?", [PROJECT, PEOPLE, "Cancel"]);
		if (choice === PROJECT) return { visibility: "project", emails: [] };
		if (choice !== PEOPLE) return null;
		const emails = parseEmails(
			await ctx.ui.input("Email addresses of Project members (comma-separated)"),
		);
		return emails.length ? { visibility: "people", emails } : null;
	}

	async function start(ctx: ExtensionContext, projectKey: string): Promise<void> {
		if (!ctx.hasUI) {
			ctx.ui.notify?.(
				"Live watch needs an interactive session to confirm what is shared.",
				"error",
			);
			return;
		}
		const conn = deps.connection(ctx);
		if (!conn) {
			ctx.ui.notify?.("Sign in with /tako-login to use live watch.", "error");
			return;
		}
		if (!(await ctx.ui.confirm("Broadcast this session live?", LIVE_WATCH_DISCLOSURE))) {
			return;
		}
		const who = await audience(ctx);
		if (!who) return;
		await begin(ctx, conn, who, projectKey);
	}

	/** Start the broadcast (for a teammate's request when requestId is set). */
	async function begin(
		ctx: ExtensionContext,
		conn: TakonautClient,
		who: { visibility: "project" | "people"; emails: string[] },
		projectKey: string,
		requestId = "",
	): Promise<boolean> {
		uiCtx = ctx;
		const sessionKey = deps.sessionKey(ctx);
		const repository = await repositoryState(deps.run, deps.cwd()).catch(() => null);
		const request = async (key: string) =>
			(await conn.callTool("start_live_watch", {
				pi_session_id: sessionKey,
				project_key: key,
				visibility: who.visibility,
				recipient_emails: who.emails,
				branch_name: repository?.branch ?? "",
				model: ctx.model?.id ?? "",
				...(requestId ? { request_id: requestId } : {}),
			})) as {
				watch_id: string;
				watch_url: string;
				project_key: string;
				task_key: string | null;
				limits?: LiveWatchLimits;
			};
		let started: Awaited<ReturnType<typeof request>>;
		try {
			started = await request(projectKey);
		} catch (error) {
			if (errorCode(error) !== "project_required") {
				notifyError(ctx, error);
				return false;
			}
			const typed = (await ctx.ui.input(
				"This session has no linked Task. Project key to broadcast in",
			))?.trim();
			if (!typed) return false;
			try {
				started = await request(typed);
			} catch (retryError) {
				notifyError(ctx, retryError);
				return false;
			}
		}
		const broadcaster = new LiveWatchBroadcaster({
			watchId: started.watch_id,
			limits: started.limits ?? DEFAULT_LIVE_WATCH_LIMITS,
			transport: {
				append: async (watchId, events) =>
					(await conn.callTool("append_live_watch_events", {
						watch_id: watchId,
						events,
					})) as { stop: string | null; watchers: Watcher[]; requests?: unknown[] },
				stop: (watchId, reason) =>
					conn.callTool("stop_live_watch", { watch_id: watchId, reason }),
			},
			onWatchers: (watchers) => {
				if (!live || live.broadcaster !== broadcaster) return;
				const before = new Set(live.watchers.map((w) => w.id));
				live.watchers = watchers;
				footer();
				const joined = watchers.filter((w) => !before.has(w.id));
				if (joined.length) {
					live.ctx.ui.notify?.(
						`Now watching: ${joined.map((w) => w.name || "a teammate").join(", ")}`,
						"info",
					);
				}
			},
			onRequests: (requests) => {
				if (live?.broadcaster === broadcaster) receiveRequests(live.sessionKey, requests);
			},
			onEnded: (reason, byServer) => {
				if (!live || live.broadcaster !== broadcaster) return;
				const { ctx: lastCtx } = live;
				live = null;
				clearFooter(lastCtx);
				if (byServer) {
					lastCtx.ui.notify?.(
						`Live watch ended: ${END_MESSAGES[reason] ?? reason}.`,
						"warning",
					);
				}
			},
		});
		live = { broadcaster, sessionKey, url: started.watch_url, watchers: [], ctx };
		broadcaster.start();
		footer();
		const where = started.task_key ?? started.project_key;
		ctx.ui.notify?.(
			`Live on ${where}. Watchers open ${started.watch_url}. Run /tako-watch to manage or stop.`,
			"info",
		);
		return true;
	}

	function notifyError(ctx: ExtensionContext, error: unknown): void {
		const code = errorCode(error);
		ctx.ui.notify?.(
			`Live watch not started: ${ERROR_MESSAGES[code] ?? code}`,
			"error",
		);
	}

	async function manage(ctx: ExtensionContext): Promise<void> {
		if (!live) return;
		live.ctx = ctx;
		const names = live.watchers.map((w) => w.name || "a teammate");
		const choice = await ctx.ui.select(
			`Live: ${names.length ? `watching now: ${names.join(", ")}` : "nobody is watching yet"}`,
			["Change who may watch", "Stop broadcasting", "Cancel"],
		);
		if (choice === "Stop broadcasting") {
			await stop(ctx, "stopped");
			return;
		}
		if (choice !== "Change who may watch") return;
		const who = await audience(ctx);
		const conn = deps.connection(ctx);
		if (!who || !conn || !live) return;
		try {
			const result = (await conn.callTool("set_live_watch_viewers", {
				watch_id: live.broadcaster.watchId,
				visibility: who.visibility,
				recipient_emails: who.emails,
			})) as { watchers?: Watcher[] };
			live.watchers = result.watchers ?? live.watchers;
			footer();
			ctx.ui.notify?.(
				who.visibility === "project"
					? "Everyone in the Project may watch."
					: `Only ${who.emails.join(", ")} may watch; anyone else was disconnected.`,
				"info",
			);
		} catch (error) {
			const code = errorCode(error);
			ctx.ui.notify?.(`Not changed: ${ERROR_MESSAGES[code] ?? code}`, "error");
		}
	}

	async function stop(
		ctx: ExtensionContext | null,
		reason: "stopped" | "shutdown" | "session_switch",
	): Promise<void> {
		const ending = live;
		if (!ending) return;
		live = null;
		if (ctx) clearFooter(ctx);
		else clearFooter(ending.ctx);
		await ending.broadcaster.stop(reason);
		if (reason === "stopped") ctx?.ui.notify?.("Live watch stopped.", "info");
	}

	pi.registerCommand("tako-watch", {
		description:
			"Broadcast this session live, read-only, to teammates you choose (no tool output). Run again to manage or stop.",
		handler: async (args, ctx) => {
			const parts = words(args);
			if (parts[0] === "stop") {
				if (!live) ctx.ui.notify?.("This session is not being broadcast.", "info");
				await stop(ctx, "stopped");
				return;
			}
			if (live && live.sessionKey !== deps.sessionKey(ctx)) {
				await stop(ctx, "session_switch");
			}
			uiCtx = ctx;
			if (pending.length && ctx.hasUI) {
				await decideRequests(ctx, true);
				return;
			}
			if (live) {
				await manage(ctx);
				return;
			}
			const projectAt = parts.indexOf("--project");
			const projectKey = projectAt >= 0 ? (parts[projectAt + 1] ?? "") : "";
			await start(ctx, projectKey);
		},
	});

	// Prompts as the agent receives them, including steering and follow-ups.
	pi.on("message_start", (event) => {
		const broadcaster = current();
		if (!broadcaster) return;
		const role = (event.message as { role?: string }).role;
		if (role === "user") broadcaster.userMessage(event.message);
		if (role === "assistant") broadcaster.messageStart();
	});
	pi.on("message_update", (event) => {
		current()?.message(event.message, false);
	});
	pi.on("message_end", (event) => {
		if ((event.message as { role?: string }).role === "assistant") {
			current()?.message(event.message, true);
		}
	});
	// Newer Pi marks nested calls (e.g. from codemode) with parentToolCallId.
	const parentOf = (event: unknown) =>
		(event as { parentToolCallId?: string }).parentToolCallId;
	pi.on("tool_execution_start", (event) => {
		current()?.toolStart(event.toolCallId, event.toolName, event.args, parentOf(event));
	});
	pi.on("tool_execution_end", (event) => {
		current()?.toolEnd(event.toolCallId, event.toolName, event.isError, parentOf(event));
	});
	pi.on("turn_end", (event) => {
		current()?.turn(event.message);
	});
	pi.on("agent_start", (_event, ctx) => {
		uiCtx = ctx;
		current()?.status("working");
	});
	pi.on("agent_end", (_event, ctx) => {
		uiCtx = ctx;
		const broadcaster = current();
		broadcaster?.status("idle");
		void broadcaster?.flush();
		// An idle point: ask about requests that arrived meanwhile.
		void decideRequests(ctx, false);
	});
	pi.on("session_compact", () => {
		current()?.status("compacted", "The conversation was compacted.");
	});
	let sessionKey: string | null = null;
	pi.on("session_start", async (_event, ctx) => {
		uiCtx = ctx;
		// A different session (new, resume, fork): never carry a broadcast over.
		if (live && live.sessionKey !== deps.sessionKey(ctx)) {
			await stop(ctx, "session_switch");
		}
		if (sessionKey !== null && sessionKey !== deps.sessionKey(ctx)) {
			forgetRequests();
			clearFooter(ctx);
		}
		sessionKey = deps.sessionKey(ctx);
	});
	pi.on("session_shutdown", async (event, ctx) => {
		forgetRequests();
		const reason = event.reason;
		await stop(
			ctx,
			reason === "new" || reason === "resume" || reason === "fork"
				? "session_switch"
				: "shutdown",
		);
	});

	return { receiveRequests };
}
