import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandRunner } from "./git";

/** One pending planning turn offered on the Bridge heartbeat (ADR-0010 B7). */
export interface PlanningTurnOffer {
	turn_id: string;
	run_id: string;
	session_id: string;
	project_id: string;
	instruction: string;
	repository_id: string;
	sha: string;
	claim_token: string;
}

/** The ADRs in force, frozen at this turn's enqueue time (B14, mirrors tako-runner's AdrSnapshot). */
export interface PlanningTurnAdrSnapshot {
	digest: string;
	adrs: {
		adr_id: string;
		number: number;
		title: string;
		org_wide: boolean;
		revision_id: string;
		content: string;
		truncated: boolean;
	}[];
}

export interface PlanningTurnClaim {
	run_id: string;
	status: string;
	/** The Planner's exactly granted Takonaut MCP tool names (server-resolved). */
	granted_tools: string[];
	adr_snapshot: PlanningTurnAdrSnapshot | null;
}

export interface PlanningTurnsApi {
	claimPlanningTurn(input: {
		turnId: string;
		sessionId: string;
		token: string;
		leaseSeconds: number;
	}): Promise<PlanningTurnClaim>;
	declinePlanningTurn(input: { turnId: string; reason: string }): Promise<unknown>;
	streamPlanningTurnDraft(input: {
		turnId: string;
		runId: string;
		sessionId: string;
		token: string;
		text: string;
	}): Promise<unknown>;
	/** Extends a claimed turn's lease (N1); called every ~30s for the whole turn. */
	renewPlanningTurn(input: {
		turnId: string;
		runId: string;
		sessionId: string;
		token: string;
		leaseSeconds: number;
	}): Promise<unknown>;
	completePlanningTurn(input: {
		turnId: string;
		runId: string;
		sessionId: string;
		token: string;
		ok: boolean;
		outputMarkdown?: string;
		error?: string;
	}): Promise<{ run_id: string; status: string }>;
}

export interface PlanningTurnExecutor {
	/** Run the Planner's instruction against the pinned worktree; resolves with the final Draft markdown. */
	run(input: {
		worktreeRoot: string;
		instruction: string;
		/** The Planner's exactly granted Takonaut MCP tool names for this turn. */
		grantedTools: string[];
		adrSnapshot: PlanningTurnAdrSnapshot | null;
		onDraft: (text: string) => void;
		/** Aborted when the lease renewal loop (N1) learns the claim binding is no longer active. */
		signal?: AbortSignal;
	}): Promise<{ outputMarkdown: string }>;
}

// How often, and with what lease, the Bridge renews a claimed turn's lease
// for the whole turn (N1), independent of streamed output: must stay well
// under the server's lease window so a single missed/slow tick never lets
// the reaper's lease expire.
const PLANNING_TURN_RENEW_INTERVAL_MS = 30_000;
const PLANNING_TURN_RENEW_LEASE_SECONDS = 120;

/**
 * Idle gating/deferral (ADR-0010 B7/C2): accept the oldest offer only when
 * the local agent is idle; otherwise defer by returning null, leaving the
 * turn queued for the next heartbeat (never decline for this reason).
 */
export function selectAcceptableOffer(
	offers: PlanningTurnOffer[],
	agentIdle: boolean,
): PlanningTurnOffer | null {
	if (!agentIdle) return null;
	return offers[0] ?? null;
}

const SHA_RE = /^[0-9a-f]{40}$/i;

export async function shaAvailableLocally(
	run: CommandRunner,
	repoRoot: string,
	sha: string,
): Promise<boolean> {
	if (!SHA_RE.test(sha)) return false;
	const result = await run("git", ["-C", repoRoot, "cat-file", "-e", `${sha}^{commit}`]);
	return result.exitCode === 0;
}

export interface PlanningTurnWorktree {
	root: string;
	repoRoot: string;
	sha: string;
}

const PLANNING_WORKTREES_DIR = "takonaut-planning-turns";

function planningTurnWorktreeRoot(turnId: string): string {
	const safe = turnId.replace(/[^a-zA-Z0-9-]/g, "_");
	return join(tmpdir(), PLANNING_WORKTREES_DIR, safe);
}

/**
 * A temporary, detached, read-only worktree at the turn's pinned SHA.
 * Always created under the OS temp dir, never inside the user's checkout.
 */
export async function createPlanningTurnWorktree(
	run: CommandRunner,
	repoRoot: string,
	turnId: string,
	sha: string,
): Promise<PlanningTurnWorktree> {
	if (!SHA_RE.test(sha)) {
		throw new Error("Planning turn SHA is invalid");
	}
	const root = planningTurnWorktreeRoot(turnId);
	rmSync(root, { recursive: true, force: true });
	mkdirSync(join(tmpdir(), PLANNING_WORKTREES_DIR), {
		recursive: true,
		mode: 0o700,
	});
	// core.symlinks=false: a symlink committed to the repo checks out as a
	// plain text file (its target path as bytes), so the tool-call gate in
	// planner-tools-extension.ts never has a real symlink to be tricked by
	// (defense in depth: that gate's realpath check holds even without this).
	const result = await run("git", [
		"-C",
		repoRoot,
		"-c",
		"core.symlinks=false",
		"worktree",
		"add",
		"--detach",
		root,
		sha,
	]);
	if (result.exitCode !== 0) {
		throw new Error(
			`Planning turn worktree creation failed: ${(result.stderr || result.stdout).trim()}`,
		);
	}
	return { root, repoRoot, sha };
}

/** Always remove the temp worktree, even after a failed or aborted run. */
export async function cleanupPlanningTurnWorktree(
	run: CommandRunner,
	worktree: PlanningTurnWorktree,
): Promise<void> {
	await run("git", [
		"-C",
		worktree.repoRoot,
		"worktree",
		"remove",
		"--force",
		"--",
		worktree.root,
	]);
	await run("git", ["-C", worktree.repoRoot, "worktree", "prune"]);
	if (existsSync(worktree.root)) {
		rmSync(worktree.root, { recursive: true, force: true });
	}
}

export type PlanningTurnOutcome =
	| { kind: "deferred" }
	| { kind: "declined"; reason: string }
	| { kind: "claim_failed" }
	| { kind: "completed"; ok: boolean };

export interface PlanningTurnControllerOptions {
	api: PlanningTurnsApi;
	run: CommandRunner;
	executor: PlanningTurnExecutor;
	/**
	 * Resolve the local repo root for this specific offer's named repository
	 * (L4: never a blind process.cwd()), or null when it can't be verified
	 * locally — which declines the turn with "repository_unavailable_locally",
	 * same as an unrecognized SHA.
	 */
	repoRoot: (offer: PlanningTurnOffer) => Promise<string | null>;
	isIdle: () => boolean;
	/** The user's local toggle for running planning turns at all (default: always on). */
	planningEnabled?: () => boolean;
	onEvent?: (event: string, detail?: Record<string, unknown>) => void;
}

/** Owns one planning turn end to end: idle-gate, claim, worktree, run, stream, complete, clean up. */
export class PlanningTurnController {
	private busy = false;

	constructor(private readonly options: PlanningTurnControllerOptions) {}

	isBusy(): boolean {
		return this.busy;
	}

	/** Called with each heartbeat's offered planning turns. At most one turn runs at a time. */
	async handleOffers(offers: PlanningTurnOffer[]): Promise<PlanningTurnOutcome> {
		if (this.busy) return { kind: "deferred" };
		const offer = selectAcceptableOffer(offers, this.options.isIdle());
		if (!offer) return { kind: "deferred" };

		const { api, planningEnabled } = this.options;
		if (planningEnabled && !planningEnabled()) {
			await api.declinePlanningTurn({
				turnId: offer.turn_id,
				reason: "planning_disabled_locally",
			});
			return { kind: "declined", reason: "planning_disabled_locally" };
		}

		const repoRoot = await this.options.repoRoot(offer);
		if (!repoRoot) {
			await api.declinePlanningTurn({
				turnId: offer.turn_id,
				reason: "repository_unavailable_locally",
			});
			return { kind: "declined", reason: "repository_unavailable_locally" };
		}
		const available = await shaAvailableLocally(this.options.run, repoRoot, offer.sha);
		if (!available) {
			await api.declinePlanningTurn({
				turnId: offer.turn_id,
				reason: "sha_unavailable_locally",
			});
			return { kind: "declined", reason: "sha_unavailable_locally" };
		}

		this.busy = true;
		try {
			let claim: PlanningTurnClaim;
			try {
				claim = await api.claimPlanningTurn({
					turnId: offer.turn_id,
					sessionId: offer.session_id,
					token: offer.claim_token,
					leaseSeconds: PLANNING_TURN_RENEW_LEASE_SECONDS,
				});
			} catch (error) {
				this.options.onEvent?.("planning_turn_claim_failed", {
					turnId: offer.turn_id,
					error: error instanceof Error ? error.message : String(error),
				});
				return { kind: "claim_failed" };
			}
			return await this.runClaimed(offer, repoRoot, claim);
		} finally {
			this.busy = false;
		}
	}

	private async runClaimed(
		offer: PlanningTurnOffer,
		repoRoot: string,
		claim: PlanningTurnClaim,
	): Promise<PlanningTurnOutcome> {
		const { api, executor, run } = this.options;
		let worktree: PlanningTurnWorktree | null = null;
		// N1: renew the claimed lease every ~30s for the whole turn, independent
		// of streamed output, so the server's reaper never fails a Bridge turn
		// that is simply slow between drafts. A transient failure is logged and
		// retried next tick; a server-reported dead binding aborts the turn
		// instead of letting it run on uselessly.
		const abortController = new AbortController();
		let renewTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
			api
				.renewPlanningTurn({
					turnId: offer.turn_id,
					runId: offer.run_id,
					sessionId: offer.session_id,
					token: offer.claim_token,
					leaseSeconds: PLANNING_TURN_RENEW_LEASE_SECONDS,
				})
				.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					this.options.onEvent?.("planning_turn_renew_failed", {
						turnId: offer.turn_id,
						error: message,
					});
					if (message.includes("no longer active")) {
						if (renewTimer) {
							clearInterval(renewTimer);
							renewTimer = null;
						}
						abortController.abort(
							new Error(`Planning turn lease renewal failed: ${message}`),
						);
					}
					// Any other failure is a transient blip: left running, retried next tick.
				});
		}, PLANNING_TURN_RENEW_INTERVAL_MS);
		try {
			worktree = await createPlanningTurnWorktree(
				run,
				repoRoot,
				offer.turn_id,
				offer.sha,
			);
			const { outputMarkdown } = await executor.run({
				worktreeRoot: worktree.root,
				instruction: offer.instruction,
				grantedTools: claim.granted_tools,
				adrSnapshot: claim.adr_snapshot,
				signal: abortController.signal,
				onDraft: (text) => {
					api
						.streamPlanningTurnDraft({
							turnId: offer.turn_id,
							runId: offer.run_id,
							sessionId: offer.session_id,
							token: offer.claim_token,
							text,
						})
						.catch((error) =>
							this.options.onEvent?.("planning_turn_stream_failed", {
								turnId: offer.turn_id,
								error: error instanceof Error ? error.message : String(error),
							}),
						);
				},
			});
			await api.completePlanningTurn({
				turnId: offer.turn_id,
				runId: offer.run_id,
				sessionId: offer.session_id,
				token: offer.claim_token,
				ok: true,
				outputMarkdown,
			});
			return { kind: "completed", ok: true };
		} catch (error) {
			await api
				.completePlanningTurn({
					turnId: offer.turn_id,
					runId: offer.run_id,
					sessionId: offer.session_id,
					token: offer.claim_token,
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				})
				.catch((completeError) =>
					this.options.onEvent?.("planning_turn_complete_failed", {
						turnId: offer.turn_id,
						error:
							completeError instanceof Error
								? completeError.message
								: String(completeError),
					}),
				);
			return { kind: "completed", ok: false };
		} finally {
			if (renewTimer) clearInterval(renewTimer);
			if (worktree) {
				await cleanupPlanningTurnWorktree(run, worktree).catch((error) =>
					this.options.onEvent?.("planning_turn_cleanup_failed", {
						turnId: offer.turn_id,
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		}
	}
}
