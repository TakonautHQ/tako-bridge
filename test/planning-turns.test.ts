import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandRunner } from "../src/git";
import {
	cleanupPlanningTurnWorktree,
	createPlanningTurnWorktree,
	PlanningTurnController,
	type PlanningTurnExecutor,
	type PlanningTurnOffer,
	type PlanningTurnsApi,
	type PlanningTurnWorktree,
	selectAcceptableOffer,
	shaAvailableLocally,
} from "../src/planning-turns";

const execFileAsync = promisify(execFile);
const run: CommandRunner = async (command, args, options) => {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options?.cwd,
			encoding: "utf8",
		});
		return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
	} catch (error) {
		const failure = error as { stdout?: string; stderr?: string; code?: number };
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

function offer(overrides: Partial<PlanningTurnOffer> = {}): PlanningTurnOffer {
	return {
		turn_id: "11111111-1111-1111-1111-111111111111",
		run_id: "22222222-2222-2222-2222-222222222222",
		session_id: "33333333-3333-3333-3333-333333333333",
		project_id: "44444444-4444-4444-4444-444444444444",
		instruction: "Draft the plan",
		repository_id: "55555555-5555-5555-5555-555555555555",
		sha: "a".repeat(40),
		claim_token: "token-abc",
		...overrides,
	};
}

describe("selectAcceptableOffer", () => {
	it("accepts the oldest offer only when the local agent is idle", () => {
		const offers = [offer(), offer({ turn_id: "other" })];
		expect(selectAcceptableOffer(offers, true)).toBe(offers[0]);
	});

	it("defers (returns null) when the agent is busy, without declining", () => {
		expect(selectAcceptableOffer([offer()], false)).toBeNull();
	});

	it("returns null when there is nothing offered", () => {
		expect(selectAcceptableOffer([], true)).toBeNull();
	});
});

describe("planning turn worktree (real git)", () => {
	let root: string;
	let repoRoot: string;
	let sha: string;
	let worktree: PlanningTurnWorktree | null;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "tako-planning-turn-"));
		repoRoot = join(root, "source");
		mkdirSync(repoRoot, { recursive: true });
		await git(repoRoot, "init");
		await git(repoRoot, "config", "user.email", "test@takonaut.test");
		await git(repoRoot, "config", "user.name", "Takonaut Test");
		writeFileSync(join(repoRoot, "README.md"), "safe\n");
		await git(repoRoot, "add", "README.md");
		await git(repoRoot, "commit", "-m", "initial");
		sha = await git(repoRoot, "rev-parse", "HEAD");
		worktree = null;
	});

	afterEach(async () => {
		if (worktree) await cleanupPlanningTurnWorktree(run, worktree).catch(() => {});
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves whether the pinned SHA is reachable locally", async () => {
		await expect(shaAvailableLocally(run, repoRoot, sha)).resolves.toBe(true);
		await expect(shaAvailableLocally(run, repoRoot, "b".repeat(40))).resolves.toBe(
			false,
		);
		await expect(shaAvailableLocally(run, repoRoot, "not-a-sha")).resolves.toBe(
			false,
		);
	});

	it("creates a detached, read-only worktree under the OS temp dir, never inside the checkout", async () => {
		worktree = await createPlanningTurnWorktree(run, repoRoot, "turn-1", sha);

		expect(worktree.root.startsWith(tmpdir())).toBe(true);
		expect(worktree.root.startsWith(repoRoot)).toBe(false);
		expect(await git(worktree.root, "rev-parse", "HEAD")).toBe(sha);
		expect(await git(worktree.root, "symbolic-ref", "-q", "HEAD").catch(() => "detached")).toBe(
			"detached",
		);
	});

	it("cleans up the worktree directory and the git metadata", async () => {
		worktree = await createPlanningTurnWorktree(run, repoRoot, "turn-2", sha);
		const createdRoot = worktree.root;

		await cleanupPlanningTurnWorktree(run, worktree);
		worktree = null;

		expect(existsSync(createdRoot)).toBe(false);
		const list = await git(repoRoot, "worktree", "list", "--porcelain");
		expect(list).not.toContain(createdRoot);
	});

	it("checks out a committed symlink as a plain file, never a real symlink (core.symlinks=false)", async () => {
		symlinkSync("/etc/passwd", join(repoRoot, "escape-link"));
		await git(repoRoot, "add", "escape-link");
		await git(repoRoot, "commit", "-m", "add a symlink");
		const symlinkSha = await git(repoRoot, "rev-parse", "HEAD");

		worktree = await createPlanningTurnWorktree(run, repoRoot, "turn-symlink", symlinkSha);

		expect(lstatSync(join(worktree.root, "escape-link")).isSymbolicLink()).toBe(false);
	});

	it("throws on an invalid SHA instead of creating a worktree anywhere", async () => {
		await expect(
			createPlanningTurnWorktree(run, repoRoot, "turn-3", "not-a-sha"),
		).rejects.toThrow(/invalid/i);
	});

	it("surfaces the git failure when the SHA cannot be checked out (and leaves nothing to clean up)", async () => {
		await expect(
			createPlanningTurnWorktree(run, repoRoot, "turn-4", "c".repeat(40)),
		).rejects.toThrow(/worktree creation failed/i);
	});

	it("cleanup is still safe to call after creation failed", async () => {
		await expect(
			createPlanningTurnWorktree(run, repoRoot, "turn-5", "d".repeat(40)),
		).rejects.toThrow();
		// Nothing was created, so cleaning up an never-created root must not throw.
		await expect(
			cleanupPlanningTurnWorktree(run, {
				root: join(tmpdir(), "takonaut-planning-turns", "turn-5"),
				repoRoot,
				sha: "d".repeat(40),
			}),
		).resolves.toBeUndefined();
	});
});

function fakeApi(): PlanningTurnsApi & {
	claimed: unknown[];
	declined: unknown[];
	streamed: unknown[];
	completed: unknown[];
	renewed: unknown[];
} {
	const claimed: unknown[] = [];
	const declined: unknown[] = [];
	const streamed: unknown[] = [];
	const completed: unknown[] = [];
	const renewed: unknown[] = [];
	return {
		claimed,
		declined,
		streamed,
		completed,
		renewed,
		async claimPlanningTurn(input) {
			claimed.push(input);
			return {
				run_id: input.turnId,
				status: "running",
				granted_tools: [],
				adr_snapshot: null,
			};
		},
		async declinePlanningTurn(input) {
			declined.push(input);
			return { status: "waiting" };
		},
		async streamPlanningTurnDraft(input) {
			streamed.push(input);
		},
		async renewPlanningTurn(input) {
			renewed.push(input);
			return { ok: true };
		},
		async completePlanningTurn(input) {
			completed.push(input);
			return { run_id: input.runId, status: input.ok ? "completed" : "failed" };
		},
	};
}

describe("PlanningTurnController", () => {
	let root: string;
	let repoRoot: string;
	let sha: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "tako-planning-controller-"));
		repoRoot = join(root, "source");
		mkdirSync(repoRoot, { recursive: true });
		await git(repoRoot, "init");
		await git(repoRoot, "config", "user.email", "test@takonaut.test");
		await git(repoRoot, "config", "user.name", "Takonaut Test");
		writeFileSync(join(repoRoot, "README.md"), "safe\n");
		await git(repoRoot, "add", "README.md");
		await git(repoRoot, "commit", "-m", "initial");
		sha = await git(repoRoot, "rev-parse", "HEAD");
	});

	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it("defers when the agent is busy, without claiming or declining", async () => {
		const api = fakeApi();
		const executor: PlanningTurnExecutor = { run: vi.fn() };
		const controller = new PlanningTurnController({
			api,
			run,
			executor,
			repoRoot: async () => repoRoot,
			isIdle: () => false,
		});

		const outcome = await controller.handleOffers([offer({ sha })]);

		expect(outcome).toEqual({ kind: "deferred" });
		expect(api.claimed).toEqual([]);
		expect(api.declined).toEqual([]);
		expect(executor.run).not.toHaveBeenCalled();
	});

	it("declines with a reason when the pinned SHA isn't available locally", async () => {
		const api = fakeApi();
		const executor: PlanningTurnExecutor = { run: vi.fn() };
		const controller = new PlanningTurnController({
			api,
			run,
			executor,
			repoRoot: async () => repoRoot,
			isIdle: () => true,
		});

		const outcome = await controller.handleOffers([offer({ sha: "e".repeat(40) })]);

		expect(outcome).toEqual({
			kind: "declined",
			reason: "sha_unavailable_locally",
		});
		expect(api.declined).toEqual([
			{ turnId: offer().turn_id, reason: "sha_unavailable_locally" },
		]);
		expect(api.claimed).toEqual([]);
		expect(executor.run).not.toHaveBeenCalled();
	});

	it("declines with a reason when the repository isn't available locally", async () => {
		const api = fakeApi();
		const executor: PlanningTurnExecutor = { run: vi.fn() };
		const controller = new PlanningTurnController({
			api,
			run,
			executor,
			repoRoot: async () => null,
			isIdle: () => true,
		});

		const outcome = await controller.handleOffers([offer({ sha })]);

		expect(outcome).toEqual({
			kind: "declined",
			reason: "repository_unavailable_locally",
		});
		expect(api.claimed).toEqual([]);
	});

	it("resolves the repo root from the offer itself (L4), never a fixed root independent of which repository was named", async () => {
		const api = fakeApi();
		const executor: PlanningTurnExecutor = { run: vi.fn() };
		const seenOffers: unknown[] = [];
		const controller = new PlanningTurnController({
			api,
			run,
			executor,
			repoRoot: async (seenOffer) => {
				seenOffers.push(seenOffer);
				return repoRoot;
			},
			isIdle: () => true,
		});
		const thisOffer = offer({ sha });

		await controller.handleOffers([thisOffer]);

		expect(seenOffers).toEqual([thisOffer]);
	});

	it("declines when the user turned planning off locally", async () => {
		const api = fakeApi();
		const executor: PlanningTurnExecutor = { run: vi.fn() };
		const controller = new PlanningTurnController({
			api,
			run,
			executor,
			repoRoot: async () => repoRoot,
			isIdle: () => true,
			planningEnabled: () => false,
		});

		const outcome = await controller.handleOffers([offer({ sha })]);

		expect(outcome).toEqual({
			kind: "declined",
			reason: "planning_disabled_locally",
		});
		expect(api.claimed).toEqual([]);
	});

	it("claims, runs in a temporary worktree, streams drafts, completes, and cleans up", async () => {
		const api = fakeApi();
		let seenWorktreeRoot = "";
		const executor: PlanningTurnExecutor = {
			run: vi.fn(async ({ worktreeRoot, onDraft }) => {
				seenWorktreeRoot = worktreeRoot;
				onDraft("## Plan\n");
				onDraft("Do the thing.\n");
				return { outputMarkdown: "## Plan\n\nDo the thing.\n" };
			}),
		};
		const controller = new PlanningTurnController({
			api,
			run,
			executor,
			repoRoot: async () => repoRoot,
			isIdle: () => true,
		});

		const outcome = await controller.handleOffers([offer({ sha })]);

		expect(outcome).toEqual({ kind: "completed", ok: true });
		expect(api.claimed).toEqual([
			{
				turnId: offer().turn_id,
				sessionId: offer().session_id,
				token: offer().claim_token,
				leaseSeconds: 120,
			},
		]);
		expect(api.streamed).toHaveLength(2);
		expect(api.completed).toEqual([
			{
				turnId: offer().turn_id,
				runId: offer().run_id,
				sessionId: offer().session_id,
				token: offer().claim_token,
				ok: true,
				outputMarkdown: "## Plan\n\nDo the thing.\n",
			},
		]);
		expect(seenWorktreeRoot.startsWith(tmpdir())).toBe(true);
		expect(existsSync(seenWorktreeRoot)).toBe(false);
	});

	it("passes the claim's exact granted tools and ADR snapshot through to the executor", async () => {
		const api = fakeApi();
		const adrSnapshot = { digest: "sha256:abc", adrs: [] };
		api.claimPlanningTurn = vi.fn(async (input) => {
			api.claimed.push(input);
			return {
				run_id: input.turnId,
				status: "running",
				granted_tools: ["record_tako_grill_round", "get_adrs_in_force"],
				adr_snapshot: adrSnapshot,
			};
		});
		let seen: { grantedTools: string[]; adrSnapshot: unknown } | null = null;
		const executor: PlanningTurnExecutor = {
			run: vi.fn(async ({ grantedTools, adrSnapshot: seenAdrSnapshot }) => {
				seen = { grantedTools, adrSnapshot: seenAdrSnapshot };
				return { outputMarkdown: "done" };
			}),
		};
		const controller = new PlanningTurnController({
			api,
			run,
			executor,
			repoRoot: async () => repoRoot,
			isIdle: () => true,
		});

		await controller.handleOffers([offer({ sha })]);

		expect(seen).toEqual({
			grantedTools: ["record_tako_grill_round", "get_adrs_in_force"],
			adrSnapshot,
		});
	});

	it("reports failure and still cleans up the worktree when the executor throws", async () => {
		const api = fakeApi();
		let seenWorktreeRoot = "";
		const executor: PlanningTurnExecutor = {
			run: vi.fn(async ({ worktreeRoot }) => {
				seenWorktreeRoot = worktreeRoot;
				throw new Error("model exploded");
			}),
		};
		const controller = new PlanningTurnController({
			api,
			run,
			executor,
			repoRoot: async () => repoRoot,
			isIdle: () => true,
		});

		const outcome = await controller.handleOffers([offer({ sha })]);

		expect(outcome).toEqual({ kind: "completed", ok: false });
		expect(api.completed).toEqual([
			{
				turnId: offer().turn_id,
				runId: offer().run_id,
				sessionId: offer().session_id,
				token: offer().claim_token,
				ok: false,
				error: "model exploded",
			},
		]);
		expect(existsSync(seenWorktreeRoot)).toBe(false);
	});

	it("still cleans up the worktree when the completion report itself fails", async () => {
		const api = fakeApi();
		api.completePlanningTurn = vi.fn(async () => {
			throw new Error("server unreachable");
		});
		let seenWorktreeRoot = "";
		const executor: PlanningTurnExecutor = {
			run: vi.fn(async ({ worktreeRoot }) => {
				seenWorktreeRoot = worktreeRoot;
				return { outputMarkdown: "done" };
			}),
		};
		const controller = new PlanningTurnController({
			api,
			run,
			executor,
			repoRoot: async () => repoRoot,
			isIdle: () => true,
		});

		await controller.handleOffers([offer({ sha })]);

		expect(existsSync(seenWorktreeRoot)).toBe(false);
	});

	it("reports claim_failed and never touches the worktree when the claim is rejected", async () => {
		const api = fakeApi();
		api.claimPlanningTurn = vi.fn(async () => {
			throw new Error("already claimed");
		});
		const executor: PlanningTurnExecutor = { run: vi.fn() };
		const controller = new PlanningTurnController({
			api,
			run,
			executor,
			repoRoot: async () => repoRoot,
			isIdle: () => true,
		});

		const outcome = await controller.handleOffers([offer({ sha })]);

		expect(outcome).toEqual({ kind: "claim_failed" });
		expect(executor.run).not.toHaveBeenCalled();
		expect(api.completed).toEqual([]);
	});

	it("is busy while a turn runs, so a concurrent heartbeat defers instead of double-claiming", async () => {
		const api = fakeApi();
		// A fake, immediate CommandRunner: the only real-time dependency this
		// test should have is the executor's own gate below, not real git
		// subprocess latency (which flaked this test under parallel suites).
		const fakeRun: CommandRunner = async () => ({ stdout: "", stderr: "", exitCode: 0 });
		let release: (() => void) | undefined;
		const executor: PlanningTurnExecutor = {
			run: vi.fn(
				() =>
					new Promise<{ outputMarkdown: string }>((resolve) => {
						release = () => resolve({ outputMarkdown: "done" });
					}),
			),
		};
		const controller = new PlanningTurnController({
			api,
			run: fakeRun,
			executor,
			repoRoot: async () => repoRoot,
			isIdle: () => true,
		});

		const first = controller.handleOffers([offer({ sha })]);
		await vi.waitFor(() => expect(controller.isBusy()).toBe(true));

		const second = await controller.handleOffers([offer({ sha })]);
		expect(second).toEqual({ kind: "deferred" });

		release?.();
		await first;
	});
});

describe("PlanningTurnController lease renewal (N1)", () => {
	// A fake, immediate CommandRunner: these tests exercise the renewal
	// timer's own cadence, not real git subprocess latency.
	const fakeRun: CommandRunner = async () => ({ stdout: "", stderr: "", exitCode: 0 });
	const sha = "a".repeat(40);

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renews the lease every 30s for the whole turn, independent of output, and stops once the turn completes", async () => {
		const api = fakeApi();
		let resolveRun: ((value: { outputMarkdown: string }) => void) | undefined;
		const executor: PlanningTurnExecutor = {
			run: vi.fn(
				() =>
					new Promise<{ outputMarkdown: string }>((resolve) => {
						resolveRun = resolve;
					}),
			),
		};
		const controller = new PlanningTurnController({
			api,
			run: fakeRun,
			executor,
			repoRoot: async () => "/repo",
			isIdle: () => true,
		});

		vi.useFakeTimers();
		const outcomePromise = controller.handleOffers([offer({ sha })]);
		// Flushes the microtask chain (claim, worktree create, executor.run) up
		// to the point where the renewal timer is armed and the fake executor
		// is awaiting `resolveRun`, without advancing any real/fake timers yet.
		await vi.advanceTimersByTimeAsync(0);
		expect(resolveRun).toBeDefined();

		await vi.advanceTimersByTimeAsync(30_000);
		expect(api.renewed).toEqual([
			{
				turnId: offer().turn_id,
				runId: offer().run_id,
				sessionId: offer().session_id,
				token: offer().claim_token,
				leaseSeconds: 120,
			},
		]);

		// Three more ticks (120s total): still running, still renewing, with no
		// draft output at all -- the renewal loop is independent of streaming.
		await vi.advanceTimersByTimeAsync(90_000);
		expect(api.renewed).toHaveLength(4);

		resolveRun?.({ outputMarkdown: "done" });
		const outcome = await outcomePromise;
		expect(outcome).toEqual({ kind: "completed", ok: true });

		const countAfterCompletion = api.renewed.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.renewed).toHaveLength(countAfterCompletion);
	});

	it("logs a failed renew and retries on the next tick, without aborting the turn", async () => {
		const api = fakeApi();
		let renewCalls = 0;
		api.renewPlanningTurn = vi.fn(async (input) => {
			renewCalls += 1;
			api.renewed.push(input);
			if (renewCalls === 1) throw new Error("network blip");
			return { ok: true };
		});
		let resolveRun: ((value: { outputMarkdown: string }) => void) | undefined;
		const executor: PlanningTurnExecutor = {
			run: vi.fn(
				() =>
					new Promise<{ outputMarkdown: string }>((resolve) => {
						resolveRun = resolve;
					}),
			),
		};
		const events: { event: string; detail?: Record<string, unknown> }[] = [];
		const controller = new PlanningTurnController({
			api,
			run: fakeRun,
			executor,
			repoRoot: async () => "/repo",
			isIdle: () => true,
			onEvent: (event, detail) => events.push({ event, detail }),
		});

		vi.useFakeTimers();
		const outcomePromise = controller.handleOffers([offer({ sha })]);
		await vi.advanceTimersByTimeAsync(0);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(renewCalls).toBe(1);
		expect(events.some((e) => e.event === "planning_turn_renew_failed")).toBe(true);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(renewCalls).toBe(2);

		resolveRun?.({ outputMarkdown: "done" });
		const outcome = await outcomePromise;
		expect(outcome).toEqual({ kind: "completed", ok: true });
	});

	it("aborts the turn when a renew reports the claim binding is no longer active", async () => {
		const api = fakeApi();
		api.renewPlanningTurn = vi.fn(async (input) => {
			api.renewed.push(input);
			throw new Error("Planning turn binding is no longer active");
		});
		let seenSignal: AbortSignal | undefined;
		const executor: PlanningTurnExecutor = {
			run: vi.fn(
				({ signal }) =>
					new Promise<{ outputMarkdown: string }>((_resolve, reject) => {
						seenSignal = signal;
						signal?.addEventListener("abort", () => {
							reject(
								signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)),
							);
						});
					}),
			),
		};
		const controller = new PlanningTurnController({
			api,
			run: fakeRun,
			executor,
			repoRoot: async () => "/repo",
			isIdle: () => true,
		});

		vi.useFakeTimers();
		const outcomePromise = controller.handleOffers([offer({ sha })]);
		await vi.advanceTimersByTimeAsync(0);
		expect(seenSignal?.aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(30_000);

		const outcome = await outcomePromise;
		expect(outcome).toEqual({ kind: "completed", ok: false });
		expect(api.completed).toHaveLength(1);
		const completedCall = api.completed[0] as { ok: boolean; error: string };
		expect(completedCall.ok).toBe(false);
		expect(completedCall.error).toMatch(/no longer active/);

		// No further renewal attempts once the turn has aborted.
		const countAfterAbort = api.renewed.length;
		await vi.advanceTimersByTimeAsync(60_000);
		expect(api.renewed).toHaveLength(countAfterAbort);
	});
});
