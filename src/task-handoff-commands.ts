import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import type { TakonautClient } from "./client";
import type { CommandRunner } from "./git";
import {
	type HandoffPack,
	buildHandoffPack,
	compareCheckout,
	fromReviewMarkdown,
	repositoryState,
	resumeMessage,
	toReviewMarkdown,
} from "./task-handoff";

export interface HandoffCommandDeps {
	connection(ctx: ExtensionContext): TakonautClient | null;
	run: CommandRunner;
	/** The checkout the session works in. */
	cwd(): string;
	/** The session's active Task, if any. */
	activeTaskKey(ctx: ExtensionContext): string | null;
}

const DRAFT_TOOL = "tako_handoff_draft";
const PROJECT = "Everyone in the Project";
const PEOPLE = "Specific people";
const SERVER_ERROR = /task_handoff:([a-z_]+)/;
// Takonaut's limit for a pack's content.
const MAX_PACK_BYTES = 256 * 1024;

const DraftParams = Type.Object(
	{
		summary: Type.String({ minLength: 1, maxLength: 200_000 }),
		decisions: Type.Optional(
			Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 50 }),
		),
		plan: Type.Optional(Type.String({ maxLength: 100_000 })),
		open_questions: Type.Optional(
			Type.Array(Type.String({ maxLength: 1_000 }), { maxItems: 50 }),
		),
		files: Type.Optional(
			Type.Array(Type.String({ maxLength: 512 }), { maxItems: 200 }),
		),
	},
	{ additionalProperties: false },
);

function toolResult(payload: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload) }],
		details: {},
	};
}

function errorCode(error: unknown): string {
	return (
		(error instanceof Error ? SERVER_ERROR.exec(error.message)?.[1] : null) ??
		"failed"
	);
}

function words(args: string): string[] {
	return args.trim().split(/\s+/).filter(Boolean);
}

/**
 * `/tako-handoff [TASK]` asks the agent to draft a handoff through a
 * single-use tool; the author reviews, chooses who may see it and confirms
 * before it is attached to the Task. `/tako-handoff withdraw ID` withdraws
 * one. `/tako-resume [TASK]` starts a new session seeded with a pack.
 */
export function registerHandoffCommands(
	pi: Pick<
		ExtensionAPI,
		| "on"
		| "registerCommand"
		| "registerTool"
		| "getActiveTools"
		| "setActiveTools"
		| "sendUserMessage"
	>,
	deps: HandoffCommandDeps,
): void {
	let pending: { taskKey: string } | null = null;
	let registered = false;

	function setDraftActive(active: boolean): void {
		const others = pi.getActiveTools().filter((name) => name !== DRAFT_TOOL);
		pi.setActiveTools(active ? [...others, DRAFT_TOOL] : others);
	}

	async function share(
		ctx: ExtensionContext,
		taskKey: string,
		params: Static<typeof DraftParams>,
	) {
		const conn = deps.connection(ctx);
		if (!conn) return { error: "not_connected" };
		const repository = await repositoryState(deps.run, deps.cwd());
		const { pack, redactions } = buildHandoffPack(params, repository);
		const reviewed = await ctx.ui.editor(
			`Review the handoff for ${taskKey} (clear the summary to cancel)`,
			toReviewMarkdown(pack),
		);
		const edited: HandoffPack | null =
			reviewed === undefined ? null : fromReviewMarkdown(reviewed, repository);
		if (!edited) return { status: "cancelled" };
		// What the author added during review is redacted too.
		const again = buildHandoffPack(edited, repository);
		const final = again.pack;
		const redacted = redactions + again.redactions;
		const audience = await ctx.ui.select("Who can see this handoff?", [
			PROJECT,
			PEOPLE,
			"Cancel",
		]);
		if (audience !== PROJECT && audience !== PEOPLE) {
			return { status: "cancelled" };
		}
		let emails: string[] = [];
		if (audience === PEOPLE) {
			const typed = await ctx.ui.input(
				"Emails of Project members, comma-separated",
				"",
			);
			emails = (typed ?? "")
				.split(",")
				.map((email) => email.trim().toLowerCase())
				.filter(Boolean);
			if (!emails.length) return { status: "cancelled" };
		}
		const bytes = Buffer.byteLength(JSON.stringify(final), "utf8");
		if (bytes > MAX_PACK_BYTES) {
			ctx.ui.notify(
				"The handoff is larger than 256 KiB; shorten it and run /tako-handoff again.",
				"error",
			);
			return { error: "too_large" };
		}
		const kilobytes = (bytes / 1024).toFixed(1);
		const confirmed = await ctx.ui.confirm(
			"Share handoff",
			`Attach this handoff (${kilobytes} KB${redacted ? `, ${redacted} secret(s) redacted` : ""}) to ${taskKey}, visible to ${audience === PEOPLE ? emails.join(", ") : "everyone in the Project"}? Your session itself is not uploaded. This is exactly what will be shared:\n\n${toReviewMarkdown(final)}`,
		);
		if (!confirmed) return { status: "cancelled" };
		const created = (await conn.callTool("create_task_handoff", {
			task_key: taskKey,
			pack: final,
			visibility: emails.length ? "people" : "project",
			recipient_emails: emails,
		})) as { handoff_id?: unknown; redactions?: unknown };
		ctx.ui.notify(`Handoff shared on ${taskKey}.`, "info");
		return {
			status: "shared",
			handoff_id: created.handoff_id,
			// Takonaut redacts again (e.g. local absolute paths).
			server_redactions: created.redactions,
		};
	}

	function ensureDraftTool(): void {
		if (registered) return;
		registered = true;
		pi.registerTool({
			name: DRAFT_TOOL,
			label: "Draft Takonaut handoff",
			description:
				"Submit the handoff the user asked for with /tako-handoff: what was done and learned, decisions, the current plan, open questions and files touched. The user reviews it before anything is shared.",
			parameters: DraftParams,
			async execute(
				_toolCallId: string,
				params: Static<typeof DraftParams>,
				_signal: AbortSignal | undefined,
				_onUpdate: unknown,
				ctx: ExtensionContext,
			) {
				const request = pending;
				if (!request) return toolResult({ error: "no_handoff_requested" });
				pending = null;
				try {
					if (!ctx.hasUI) return toolResult({ error: "confirmation_required" });
					return toolResult(await share(ctx, request.taskKey, params));
				} catch (error) {
					const code = errorCode(error);
					ctx.ui.notify(`The handoff was not shared: ${code}`, "error");
					return toolResult({ error: code });
				} finally {
					setDraftActive(false);
				}
			},
		});
		// Registration may activate it; it stays off until requested.
		setDraftActive(false);
	}

	// A request never outlives its session.
	pi.on("session_shutdown", () => {
		pending = null;
		if (registered) setDraftActive(false);
	});

	pi.registerCommand("tako-handoff", {
		description:
			"Share a reviewed handoff of this session on a Task (/tako-handoff PAY-12), or withdraw one (/tako-handoff withdraw ID)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const [first, second] = words(args);
			const conn = deps.connection(ctx);
			if (!conn) return;
			if (first === "withdraw") {
				if (!second) {
					ctx.ui.notify("Usage: /tako-handoff withdraw HANDOFF_ID", "error");
					return;
				}
				try {
					await conn.callTool("withdraw_task_handoff", { handoff_id: second });
					ctx.ui.notify("Handoff withdrawn; its content was erased.", "info");
				} catch (error) {
					ctx.ui.notify(`Could not withdraw: ${errorCode(error)}`, "error");
				}
				return;
			}
			const taskKey = first ?? deps.activeTaskKey(ctx);
			if (!taskKey) {
				ctx.ui.notify("Usage: /tako-handoff TASK-KEY", "error");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify("A handoff needs an interactive review.", "error");
				return;
			}
			if (pending) {
				ctx.ui.notify(
					`A handoff for ${pending.taskKey} is already being drafted.`,
					"error",
				);
				return;
			}
			ensureDraftTool();
			pending = { taskKey };
			setDraftActive(true);
			try {
				// Queued behind a running turn rather than refused.
				pi.sendUserMessage(
					`Prepare a handoff of this session for ${taskKey}: call ${DRAFT_TOOL} once with a concise summary of what was done and learned, the decisions made, the current plan, open questions and the files you touched (repository-relative paths). Leave out secrets and credentials. I will review it before it is shared.`,
					{ deliverAs: "followUp" },
				);
			} catch {
				pending = null;
				setDraftActive(false);
				ctx.ui.notify("Could not ask the agent for a handoff draft.", "error");
			}
		},
	});

	pi.registerCommand("tako-resume", {
		description:
			"Continue a Task from a teammate's handoff in a new session (/tako-resume PAY-12)",
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			const taskKey = words(args)[0] ?? deps.activeTaskKey(ctx);
			if (!taskKey) {
				ctx.ui.notify("Usage: /tako-resume TASK-KEY", "error");
				return;
			}
			const conn = deps.connection(ctx);
			if (!conn) return;
			try {
				const listed = (await conn.callTool("list_task_handoffs", {
					task_key: taskKey,
				})) as {
					handoffs?: Array<{
						handoff_id: string;
						created_at?: string;
						preview?: string;
					}>;
				};
				const handoffs = listed.handoffs ?? [];
				if (!handoffs.length) {
					ctx.ui.notify(`No handoff you can see on ${taskKey}.`, "info");
					return;
				}
				let chosen = handoffs[0];
				if (handoffs.length > 1) {
					// Numbered: identical labels still pick the right pack.
					const labels = handoffs.map((item, index) =>
						`${index + 1}. ${item.created_at ?? ""} ${item.preview ?? ""}`.trim(),
					);
					const picked = await ctx.ui.select(
						"Resume from which handoff?",
						labels,
					);
					if (!picked) return;
					chosen = handoffs[labels.indexOf(picked)] ?? chosen;
				}
				const pack = (await conn.callTool("get_task_handoff", {
					handoff_id: chosen.handoff_id,
				})) as { created_at?: string; content: HandoffPack };
				const comparison = await compareCheckout(
					deps.run,
					deps.cwd(),
					pack.content.repository ?? null,
				);
				const message = resumeMessage(
					pack.content,
					{ task_key: taskKey, created_at: pack.created_at },
					comparison,
				);
				await ctx.newSession({
					withSession: async (next) => {
						await next.sendMessage(
							{ customType: "tako-handoff", content: message, display: true },
							{ triggerTurn: false },
						);
					},
				});
			} catch (error) {
				ctx.ui.notify(`Could not resume: ${errorCode(error)}`, "error");
			}
		},
	});
}
