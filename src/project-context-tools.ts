import { createHash } from "node:crypto";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

import type { CompanionTool } from "./catalog";
import type { TakonautClient } from "./client";
import type { CommandRunner } from "./git";
import type { ContextBudget } from "./project-context-budget";
import {
	ProjectContextError,
	discoverWithLocalContext,
	expandWithLocalVerification,
} from "./project-context";

export interface ProjectContextToolDeps {
	connection(ctx: ExtensionContext): TakonautClient | null;
	run: CommandRunner;
	/** Directories that may hold checkouts, most specific first. */
	candidates(ctx: ExtensionContext): string[];
	/** The Project of the session's active Task, if any. */
	defaultProjectKey(ctx: ExtensionContext): string | null;
	/** The session's cumulative shared-context budget. */
	budget(ctx: ExtensionContext): ContextBudget;
	/** The session's active delivery run, which pins the views it uses. */
	activeRun(ctx: ExtensionContext): { runId: string; sessionId: string } | null;
}

const SERVER_ERROR = /project_context:([a-z_]+)/;

function toolResult(payload: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(payload) }],
		details: {},
	};
}

/** Best effort: a failed pin never fails discovery. */
async function pinForRun(
	callTool: (
		name: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	) => Promise<unknown>,
	run: { runId: string; sessionId: string } | null,
	result: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<"recorded" | "failed" | undefined> {
	if (
		!run ||
		result.status !== "ready" ||
		typeof result.context_view_id !== "string"
	) {
		return undefined;
	}
	const local = (result.local ?? {}) as Record<string, unknown>;
	try {
		await callTool(
			"pin_project_context_view",
			{
				run_id: run.runId,
				session_id: run.sessionId,
				context_view_id: result.context_view_id,
				local_relation:
					typeof local.relation === "string" ? local.relation : "unknown",
				local_head: typeof local.head === "string" ? local.head : "",
				...(typeof local.dirty === "boolean"
					? { local_dirty: local.dirty }
					: {}),
			},
			signal,
		);
		return "recorded";
	} catch {
		return "failed";
	}
}

async function guarded(action: () => Promise<unknown>) {
	try {
		return toolResult(await action());
	} catch (error) {
		if (error instanceof ProjectContextError) {
			return toolResult({ error: error.code, ...error.details });
		}
		const code =
			error instanceof Error ? SERVER_ERROR.exec(error.message)?.[1] : null;
		if (code) return toolResult({ error: code });
		throw error;
	}
}

function prepared(
	deps: ProjectContextToolDeps,
	ctx: ExtensionContext,
	projectKey: string | undefined,
) {
	const conn = deps.connection(ctx);
	if (!conn) return { error: toolResult({ error: "not_connected" }) };
	const key = projectKey ?? deps.defaultProjectKey(ctx);
	if (!key) return { error: toolResult({ error: "project_key_required" }) };
	return {
		options: {
			callTool: (
				name: string,
				args: Record<string, unknown>,
				signal?: AbortSignal,
			) => conn.callTool(name, args, signal),
			run: deps.run,
			candidates: deps.candidates(ctx),
			projectKey: key,
		},
	};
}

const optional = {
	project_key: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
	cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
	budget_bytes: Type.Optional(Type.Integer({ minimum: 2048, maximum: 7168 })),
};

const Source = Type.Optional(
	Type.Union([
		Type.Literal("code"),
		Type.Literal("records"),
		Type.Literal("findings"),
	]),
);
// Code refs ("s:<n>") or record refs ("doc:<id>@<revision>~<offset>").
const Ref = Type.String({ minLength: 1, maxLength: 128 });

const DiscoverParams = Type.Object(
	{
		query: Type.String({ minLength: 1, maxLength: 500 }),
		repository_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		source: Source,
		...optional,
	},
	{ additionalProperties: false },
);

const ExpandParams = Type.Object(
	{
		context_view_id: Type.Optional(
			Type.String({ minLength: 1, maxLength: 64 }),
		),
		refs: Type.Array(Ref, { minItems: 1, maxItems: 20 }),
		source: Source,
		...optional,
	},
	{ additionalProperties: false },
);

const FindingParams = Type.Object(
	{
		claim: Type.String({ minLength: 1, maxLength: 1000 }),
		evidence: Type.Array(Ref, { minItems: 1, maxItems: 10 }),
		context_view_id: Type.Optional(
			Type.String({ minLength: 1, maxLength: 64 }),
		),
		finding_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		expected_revision: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

/**
 * Tool-call IDs vary by provider (OpenAI Responses IDs contain "|" and can
 * exceed 80 characters); the server accepts [A-Za-z0-9._:-]{1,80}.
 */
export function findingIdempotencyKey(
	sessionId: string,
	toolCallId: string,
): string {
	const digest = createHash("sha256")
		.update(`${sessionId}\0${toolCallId}`)
		.digest("hex");
	return `pi:${digest.slice(0, 40)}`;
}

/** Only the fields that were given, so the server applies its defaults. */
function given(fields: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	);
}

/** Bridge tools over shared Project context, verified against the checkout. */
export function projectContextCompanions(
	deps: ProjectContextToolDeps,
): CompanionTool[] {
	return [
		{
			requires: [
				"list_project_context_repositories",
				"discover_project_context",
			],
			definition: {
				name: "tako_context_discover",
				label: "Discover Project context",
				description:
					"Find files and symbols in the Project's shared structure index for the local repository (ranked, not exhaustive), with how the local checkout relates to the indexed commit.",
				promptSnippet:
					"Find relevant files and symbols in the shared Project context index",
				promptGuidelines: [
					"In a large repository, call tako_context_discover with identifiers, file names or path words before broad searching; status not_ready means search locally.",
					"Use source records to find published documents and Tasks (by Task key or title words); expand their refs with source records.",
					"Use source findings for what agents already learned about this Project; findings are agent-authored claims, so check their evidence before relying on them.",
					"Then call tako_context_expand on the refs you need; rely only on spans whose local.state is match or span_match (use local.lines for span_match), otherwise read the file.",
					"Shared context has a per-session budget: request what you need, reuse evidence already returned (already_provided), and search locally after context_budget_exhausted.",
				],
				parameters: DiscoverParams,
				async execute(
					_toolCallId: string,
					params: Static<typeof DiscoverParams>,
					signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					if (signal?.aborted) throw new Error("Project context cancelled");
					const ready = prepared(deps, ctx, params.project_key);
					if (!ready.options) return ready.error;
					const budget = deps.budget(ctx);
					if (budget.exhausted) return toolResult(budget.exhaustion());
					if (params.source === "records" || params.source === "findings") {
						return guarded(async () => {
							const result = (await ready.options.callTool(
								"discover_project_context",
								given({
									project_key: ready.options.projectKey,
									query: params.query,
									source: params.source,
									cursor: params.cursor,
									budget_bytes: params.budget_bytes,
								}),
								signal,
							)) as Record<string, unknown>;
							budget.charge(result);
							return result;
						});
					}
					return guarded(async () => {
						const discovered = await discoverWithLocalContext({
							...ready.options,
							signal,
							query: params.query,
							repositoryId: params.repository_id,
							cursor: params.cursor,
							budgetBytes: params.budget_bytes,
						});
						const runPin = await pinForRun(
							ready.options.callTool,
							deps.activeRun(ctx),
							discovered,
							signal,
						);
						const result = runPin
							? { ...discovered, run_pin: runPin }
							: discovered;
						budget.charge(result);
						return result;
					});
				},
			},
		},
		{
			requires: [
				"list_project_context_repositories",
				"expand_project_evidence",
			],
			definition: {
				name: "tako_context_expand",
				label: "Expand Project evidence",
				description:
					"Expand refs from tako_context_discover (spans, hashes, parent, children, relations) and verify each against local bytes: match, span_match, modified, missing or unverifiable. With source records, return the text of document and Task refs.",
				promptSnippet:
					"Expand and locally verify shared Project context references",
				parameters: ExpandParams,
				async execute(
					_toolCallId: string,
					params: Static<typeof ExpandParams>,
					signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					if (signal?.aborted) throw new Error("Project context cancelled");
					const ready = prepared(deps, ctx, params.project_key);
					if (!ready.options) return ready.error;
					const budget = deps.budget(ctx);
					if (budget.exhausted) return toolResult(budget.exhaustion());
					if (params.source === "records" || params.source === "findings") {
						return guarded(async () => {
							const result = (await ready.options.callTool(
								"expand_project_evidence",
								given({
									project_key: ready.options.projectKey,
									refs: params.refs,
									source: params.source,
									cursor: params.cursor,
									budget_bytes: params.budget_bytes,
								}),
								signal,
							)) as Record<string, unknown>;
							budget.charge(result);
							return result;
						});
					}
					const contextViewId = params.context_view_id;
					if (!contextViewId) {
						return toolResult({ error: "context_view_required" });
					}
					return guarded(async () => {
						const expanded = await expandWithLocalVerification({
							...ready.options,
							signal,
							contextViewId,
							refs: params.refs,
							cursor: params.cursor,
							budgetBytes: params.budget_bytes,
						});
						const result = Array.isArray(expanded.items)
							? {
									...expanded,
									items: budget.delta(
										expanded.source_snapshot_id,
										expanded.items,
									),
								}
							: expanded;
						budget.charge(result);
						return result;
					});
				},
			},
		},
		{
			// record_project_finding is a Bridge protocol tool, never listed;
			// the server checks the run and its Profile grant.
			requires: ["discover_project_context"],
			definition: {
				name: "tako_context_record_finding",
				label: "Record a shared finding",
				description:
					"Share a short finding with this run's Project, citing current refs from tako_context_discover (code refs need their context_view_id). Needs an Agent Profile allowed to record findings. Teammates and agents see it as agent-authored.",
				promptSnippet: "Share a verified finding with the Project",
				promptGuidelines: [
					"Record a finding only for something you verified that will help later work in this Project, in one or two plain sentences, citing the refs that prove it.",
					"Never record findings about your local or unmerged changes, secrets, or personal data: findings describe the published default-branch code and published records.",
				],
				parameters: FindingParams,
				async execute(
					toolCallId: string,
					params: Static<typeof FindingParams>,
					signal: AbortSignal | undefined,
					_onUpdate: unknown,
					ctx: ExtensionContext,
				) {
					if (signal?.aborted) throw new Error("Project context cancelled");
					const run = deps.activeRun(ctx);
					if (!run) return toolResult({ error: "no_active_run" });
					const conn = deps.connection(ctx);
					if (!conn) return toolResult({ error: "not_connected" });
					return guarded(() =>
						conn.callTool(
							"record_project_finding",
							given({
								run_id: run.runId,
								session_id: run.sessionId,
								claim: params.claim,
								evidence: params.evidence,
								// A resent tool call replays; a new call is a new finding.
								idempotency_key: findingIdempotencyKey(
									run.sessionId,
									toolCallId,
								),
								context_view_id: params.context_view_id,
								finding_id: params.finding_id,
								expected_revision: params.expected_revision,
							}),
							signal,
						),
					);
				},
			},
		},
	];
}
