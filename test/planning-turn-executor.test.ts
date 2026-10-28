import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createPlanningTurnExecutor,
	DEFAULT_TIMEOUT_MS,
	installPlanningTurnExitHandlers,
	planningTurnEmergencyCleanup,
	planningTurnPrompt,
	type PlanningTurnSpawn,
	type SpawnedPlanningProcess,
} from "../src/planning-turn-executor";

const BRIDGE_TURN_TOKEN_LIFETIME_MS = 15 * 60_000;

class FakeChild extends EventEmitter implements SpawnedPlanningProcess {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = 4242;
	killed = false;
	killSignals: string[] = [];
	stdinWritten = "";

	constructor() {
		super();
		this.stdin.on("data", (chunk: Buffer) => {
			this.stdinWritten += chunk.toString("utf8");
		});
	}

	kill(signal?: string): boolean {
		this.killed = true;
		if (signal) this.killSignals.push(signal);
		return true;
	}

	exit(code: number | null): void {
		this.emit("exit", code, null);
	}
}

function jsonLine(delta: string): string {
	return `${JSON.stringify({
		type: "message_update",
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
	})}\n`;
}

describe("planningTurnPrompt", () => {
	it("includes the instruction and, when present, the ADR snapshot", () => {
		const withAdrs = planningTurnPrompt("Draft the plan", {
			digest: "sha256:abc",
			adrs: [
				{
					adr_id: "1",
					number: 3,
					title: "Use Postgres",
					org_wide: false,
					revision_id: "r1",
					content: "Body text",
					truncated: false,
				},
			],
		});
		expect(withAdrs).toContain("Draft the plan");
		expect(withAdrs).toContain("ADR-0003: Use Postgres");
		expect(withAdrs).toContain("Body text");

		const withoutAdrs = planningTurnPrompt("Draft the plan", null);
		expect(withoutAdrs).toContain("Draft the plan");
		expect(withoutAdrs).not.toContain("ARCHITECTURE DECISION RECORDS");
	});

	it("fences the instruction and the ADR section (titles included) with one shared per-prompt nonce (L2)", () => {
		const prompt = planningTurnPrompt("Draft the plan", {
			digest: "sha256:abc",
			adrs: [
				{
					adr_id: "1",
					number: 3,
					title: "Use Postgres",
					org_wide: false,
					revision_id: "r1",
					content: "Body text",
					truncated: false,
				},
			],
		});

		const nonceMatches = [...prompt.matchAll(/nonce ([0-9a-f]{32})/g)].map((match) => match[1]);
		expect(nonceMatches.length).toBeGreaterThanOrEqual(2);
		expect(new Set(nonceMatches).size).toBe(1);
		expect(prompt).toContain("BEGIN TEAM INSTRUCTION");
		expect(prompt).toContain("BEGIN ADR DATA");
		// The ADR title is inside the fenced ADR DATA block, not prompt structure.
		const adrFenceStart = prompt.indexOf("BEGIN ADR DATA");
		const adrFenceEnd = prompt.indexOf("END ADR DATA");
		const titleIndex = prompt.indexOf("Use Postgres");
		expect(titleIndex).toBeGreaterThan(adrFenceStart);
		expect(titleIndex).toBeLessThan(adrFenceEnd);
	});
});

describe("DEFAULT_TIMEOUT_MS", () => {
	it("stays under the Bridge planning-turn claim token's 15-minute lifetime", () => {
		expect(DEFAULT_TIMEOUT_MS).toBeLessThan(BRIDGE_TURN_TOKEN_LIFETIME_MS);
	});
});

describe("createPlanningTurnExecutor", () => {
	let spawnCalls: { command: string; args: string[]; options: { cwd: string; env: NodeJS.ProcessEnv } }[];
	let nextChild: FakeChild;
	let spawn: PlanningTurnSpawn;

	beforeEach(() => {
		spawnCalls = [];
		nextChild = new FakeChild();
		spawn = vi.fn((command, args, options) => {
			spawnCalls.push({ command, args, options });
			return nextChild;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function baseOptions(overrides: Partial<Parameters<typeof createPlanningTurnExecutor>[0]> = {}) {
		return {
			getClientConfig: () => ({
				serverUrl: "https://takonaut.test",
				apiKey: "secret-api-key",
				orgId: "org-1",
			}),
			getModel: () => ({ provider: "anthropic", id: "claude-sonnet" }),
			spawn,
			piCommand: () => ({ command: "/usr/bin/node", args: ["/opt/pi/cli.js"] }),
			toolsExtensionPath: "/opt/pi-extension/planner-tools-extension.ts",
			streamIntervalMs: 5,
			streamBatchChars: 1_000_000,
			...overrides,
		};
	}

	it("fails fast without spawning when not connected to Takonaut", async () => {
		const executor = createPlanningTurnExecutor(
			baseOptions({ getClientConfig: () => null }),
		);

		await expect(
			executor.run({
				worktreeRoot: "/tmp/worktree",
				instruction: "Draft the plan",
				grantedTools: [],
				adrSnapshot: null,
				onDraft: () => {},
			}),
		).rejects.toThrow(/Not connected/);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("fails fast without spawning when no model is resolvable", async () => {
		const executor = createPlanningTurnExecutor(baseOptions({ getModel: () => null }));

		await expect(
			executor.run({
				worktreeRoot: "/tmp/worktree",
				instruction: "Draft the plan",
				grantedTools: [],
				adrSnapshot: null,
				onDraft: () => {},
			}),
		).rejects.toThrow(/No model/);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("builds argv with exactly the granted tools (as tako_mcp_*) plus read-only builtins, never bash/write/edit, and puts no secret on argv", async () => {
		const executor = createPlanningTurnExecutor(baseOptions());
		const runPromise = executor.run({
			worktreeRoot: "/tmp/worktree",
			instruction: "Draft the plan",
			grantedTools: ["record_tako_grill_round", "get_adrs_in_force"],
			adrSnapshot: null,
			onDraft: () => {},
		});

		const [call] = spawnCalls;
		expect(call.command).toBe("/usr/bin/node");
		expect(call.args).toContain("/opt/pi/cli.js");
		expect(call.args).toContain("--print");
		expect(call.args).toContain("--no-session");
		expect(call.args).toContain("--no-extensions");
		expect(call.args).toContain("--no-builtin-tools");
		const toolsIndex = call.args.indexOf("--tools");
		expect(toolsIndex).toBeGreaterThan(-1);
		const toolsArg = call.args[toolsIndex + 1];
		expect(toolsArg.split(",").sort()).toEqual(
			["find", "get_adrs_in_force", "grep", "ls", "read", "record_tako_grill_round"]
				.map((name) => (name.startsWith("record_") || name.startsWith("get_") ? `tako_mcp_${name}` : name))
				.sort(),
		);
		expect(toolsArg).not.toContain("bash");
		expect(toolsArg).not.toContain("write");
		expect(toolsArg).not.toContain("edit");
		expect(call.options.cwd).toBe("/tmp/worktree");
		expect(JSON.stringify(call.args)).not.toContain("secret-api-key");
		expect(call.options.env.TAKONAUT_PLANNING_API_KEY).toBe("secret-api-key");
		expect(call.options.env.TAKONAUT_PLANNING_SERVER_URL).toBe("https://takonaut.test");
		expect(call.options.env.TAKONAUT_PLANNING_ORG_ID).toBe("org-1");
		expect(JSON.parse(call.options.env.TAKONAUT_PLANNING_ALLOWED_TOOLS as string)).toEqual([
			"record_tako_grill_round",
			"get_adrs_in_force",
		]);
		expect(call.options.env.TAKONAUT_PLANNING_WORKTREE).toBe("/tmp/worktree");

		nextChild.exit(0);
		await runPromise;
	});

	it("puts the prompt on stdin, never on argv, so it never shows up in a process listing (L4)", async () => {
		const executor = createPlanningTurnExecutor(baseOptions());
		const runPromise = executor.run({
			worktreeRoot: "/tmp/worktree",
			instruction: "Draft the super secret refund-flow plan",
			grantedTools: [],
			adrSnapshot: null,
			onDraft: () => {},
		});

		const [call] = spawnCalls;
		expect(JSON.stringify(call.args)).not.toContain("Draft the super secret refund-flow plan");
		await new Promise((r) => setImmediate(r));
		expect(nextChild.stdinWritten).toContain("Draft the super secret refund-flow plan");
		expect(nextChild.stdin.writableEnded).toBe(true);

		nextChild.exit(0);
		await runPromise;
	});

	it("passes only an allow-listed subset of the ambient environment to the child, never the rest", async () => {
		const previous = process.env.UNRELATED_TOOL_SECRET;
		process.env.UNRELATED_TOOL_SECRET = "do-not-leak-me";
		try {
			const executor = createPlanningTurnExecutor(baseOptions());
			const runPromise = executor.run({
				worktreeRoot: "/tmp/worktree",
				instruction: "Draft the plan",
				grantedTools: [],
				adrSnapshot: null,
				onDraft: () => {},
			});

			const [call] = spawnCalls;
			expect(call.options.env.UNRELATED_TOOL_SECRET).toBeUndefined();
			if (process.env.PATH !== undefined) expect(call.options.env.PATH).toBe(process.env.PATH);
			if (process.env.HOME !== undefined) expect(call.options.env.HOME).toBe(process.env.HOME);

			nextChild.exit(0);
			await runPromise;
		} finally {
			if (previous === undefined) delete process.env.UNRELATED_TOOL_SECRET;
			else process.env.UNRELATED_TOOL_SECRET = previous;
		}
	});

	it("also passes through the model-credential, proxy/CA, and locale variables pi-ai/pi itself reads (N2), still never an unrelated secret", async () => {
		const toSet: Record<string, string> = {
			// Unrelated secrets: never passed through, regardless of the allow-list below.
			GITHUB_TOKEN: "do-not-leak-me",
			UNRELATED_TOOL_SECRET: "do-not-leak-me-either",
			// Provider API keys pi-ai's getEnvApiKey (env-api-keys.ts) reads.
			ANTHROPIC_API_KEY: "sk-ant-test",
			OPENAI_API_KEY: "sk-openai-test",
			// Vertex AI application-default-credentials / project / location.
			GOOGLE_APPLICATION_CREDENTIALS: "/home/dev/.config/gcloud/adc.json",
			GOOGLE_CLOUD_PROJECT: "my-gcp-project",
			// Amazon Bedrock credential sources (L-C: temporary-credential and
			// region/shared-config variables pi-ai's bedrock-converse-stream.js
			// and the AWS SDK's credential chain read).
			AWS_PROFILE: "my-bedrock-profile",
			AWS_ACCESS_KEY_ID: "AKIATEST",
			AWS_SESSION_TOKEN: "session-token-test",
			AWS_REGION: "us-east-1",
			AWS_DEFAULT_REGION: "us-west-2",
			AWS_CONFIG_FILE: "/home/dev/.aws/config",
			AWS_SHARED_CREDENTIALS_FILE: "/home/dev/.aws/credentials",
			// Proxy/CA/locale/temp vars so the child resolves the same way the session does.
			HTTPS_PROXY: "http://proxy.local:8080",
			NODE_EXTRA_CA_CERTS: "/etc/ssl/corp-ca.pem",
			TMPDIR: "/tmp/custom",
			XDG_CONFIG_HOME: "/home/dev/.config",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
		};
		const previous: Record<string, string | undefined> = {};
		for (const key of Object.keys(toSet)) previous[key] = process.env[key];
		Object.assign(process.env, toSet);
		try {
			const executor = createPlanningTurnExecutor(baseOptions());
			const runPromise = executor.run({
				worktreeRoot: "/tmp/worktree",
				instruction: "Draft the plan",
				grantedTools: [],
				adrSnapshot: null,
				onDraft: () => {},
			});

			const [call] = spawnCalls;
			expect(call.options.env.GITHUB_TOKEN).toBeUndefined();
			expect(call.options.env.UNRELATED_TOOL_SECRET).toBeUndefined();
			for (const [key, value] of Object.entries(toSet)) {
				if (key === "GITHUB_TOKEN" || key === "UNRELATED_TOOL_SECRET") continue;
				expect(call.options.env[key]).toBe(value);
			}

			nextChild.exit(0);
			await runPromise;
		} finally {
			for (const key of Object.keys(toSet)) {
				if (previous[key] === undefined) delete process.env[key];
				else process.env[key] = previous[key];
			}
		}
	});

	it("streams batched draft text and resolves with the full accumulated text on a clean exit", async () => {
		const drafts: string[] = [];
		const executor = createPlanningTurnExecutor(baseOptions());
		const runPromise = executor.run({
			worktreeRoot: "/tmp/worktree",
			instruction: "Draft the plan",
			grantedTools: [],
			adrSnapshot: null,
			onDraft: (text) => drafts.push(text),
		});

		nextChild.stdout.write(jsonLine("## Plan\n"));
		nextChild.stdout.write(jsonLine("Do the thing.\n"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		nextChild.exit(0);

		const result = await runPromise;
		expect(result.outputMarkdown).toBe("## Plan\nDo the thing.\n");
		expect(drafts.join("")).toBe("## Plan\nDo the thing.\n");
	});

	it("rejects with a short generic reason plus the stderr excerpt on a non-zero exit", async () => {
		const executor = createPlanningTurnExecutor(baseOptions());
		const runPromise = executor.run({
			worktreeRoot: "/tmp/worktree",
			instruction: "Draft the plan",
			grantedTools: [],
			adrSnapshot: null,
			onDraft: () => {},
		});

		nextChild.stderr.write("model provider error");
		await new Promise((resolve) => setTimeout(resolve, 10));
		nextChild.exit(1);

		await expect(runPromise).rejects.toThrow(/failed \(exit code 1\).*model provider error/s);
	});

	it("never sends a secret found in stderr to the server, and bounds the excerpt (L4)", async () => {
		const executor = createPlanningTurnExecutor(baseOptions());
		const runPromise = executor.run({
			worktreeRoot: "/tmp/worktree",
			instruction: "Draft the plan",
			grantedTools: [],
			adrSnapshot: null,
			onDraft: () => {},
		});

		const leakedKey = `sk-ant-${"a".repeat(40)}`;
		nextChild.stderr.write(`model provider error: Authorization: Bearer ${leakedKey}\n`);
		nextChild.stderr.write("x".repeat(2_000));
		await new Promise((resolve) => setTimeout(resolve, 10));
		nextChild.exit(1);

		let error: Error | undefined;
		try {
			await runPromise;
		} catch (caught) {
			error = caught as Error;
		}
		expect(error?.message).toMatch(/^Planning turn's Pi process failed \(exit code 1\)/);
		expect(error?.message).not.toContain(leakedKey);
		expect(error?.message.length).toBeLessThan(600);
	});

	it("rejects on a spawn error", async () => {
		const executor = createPlanningTurnExecutor(baseOptions());
		const runPromise = executor.run({
			worktreeRoot: "/tmp/worktree",
			instruction: "Draft the plan",
			grantedTools: [],
			adrSnapshot: null,
			onDraft: () => {},
		});

		nextChild.emit("error", new Error("ENOENT"));

		await expect(runPromise).rejects.toThrow(/ENOENT/);
	});

	it("kills the process group and rejects on timeout", async () => {
		const killedPids: number[] = [];
		const originalKill = process.kill;
		process.kill = vi.fn((pid: number, signal?: string) => {
			killedPids.push(pid);
			throw new Error("no such process group in this sandbox");
		});
		try {
			const executor = createPlanningTurnExecutor(baseOptions({ timeoutMs: 10 }));
			const runPromise = executor.run({
				worktreeRoot: "/tmp/worktree",
				instruction: "Draft the plan",
				grantedTools: [],
				adrSnapshot: null,
				onDraft: () => {},
			});

			await expect(runPromise).rejects.toThrow(/timed out/);
			expect(killedPids).toContain(-4242);
			expect(nextChild.killed).toBe(true);
			expect(nextChild.killSignals).toContain("SIGKILL");
		} finally {
			process.kill = originalKill;
		}
	});

	it("kills the process group and rejects with the abort reason when the signal is aborted externally (N1)", async () => {
		const abortController = new AbortController();
		const executor = createPlanningTurnExecutor(baseOptions());
		const runPromise = executor.run({
			worktreeRoot: "/tmp/worktree",
			instruction: "Draft the plan",
			grantedTools: [],
			adrSnapshot: null,
			signal: abortController.signal,
			onDraft: () => {},
		});

		abortController.abort(
			new Error("Planning turn lease renewal failed: Planning turn binding is no longer active"),
		);

		await expect(runPromise).rejects.toThrow(/binding is no longer active/);
		expect(nextChild.killed).toBe(true);
	});

	it("planningTurnEmergencyCleanup kills a still-running child and removes its worktree (L4)", async () => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), "pte-emergency-"));
		writeFileSync(join(worktreeRoot, "marker.txt"), "x");
		const executor = createPlanningTurnExecutor(baseOptions());
		const runPromise = executor.run({
			worktreeRoot,
			instruction: "Draft the plan",
			grantedTools: [],
			adrSnapshot: null,
			onDraft: () => {},
		});

		planningTurnEmergencyCleanup();

		expect(nextChild.killed).toBe(true);
		expect(existsSync(worktreeRoot)).toBe(false);

		// A still-pending run settles independently once its child actually exits.
		nextChild.exit(137);
		await expect(runPromise).rejects.toThrow();
	});

	it("planningTurnEmergencyCleanup is a no-op once a turn has already finished", async () => {
		const worktreeRoot = mkdtempSync(join(tmpdir(), "pte-emergency-"));
		const executor = createPlanningTurnExecutor(baseOptions());
		const runPromise = executor.run({
			worktreeRoot,
			instruction: "Draft the plan",
			grantedTools: [],
			adrSnapshot: null,
			onDraft: () => {},
		});
		nextChild.exit(0);
		await runPromise;

		expect(() => planningTurnEmergencyCleanup()).not.toThrow();
		// The worktree is this test's own, left in place: not this executor's job once the turn settled.
		expect(existsSync(worktreeRoot)).toBe(true);
		rmSync(worktreeRoot, { recursive: true, force: true });
	});
});

describe("installPlanningTurnExitHandlers", () => {
	it("installs the exit/SIGTERM handlers exactly once, even when called repeatedly, and never a SIGINT handler (N5)", () => {
		const beforeExit = process.listenerCount("exit");
		const beforeSigterm = process.listenerCount("SIGTERM");
		const beforeSigint = process.listenerCount("SIGINT");
		installPlanningTurnExitHandlers();
		const afterFirstExit = process.listenerCount("exit");
		const afterFirstSigterm = process.listenerCount("SIGTERM");
		installPlanningTurnExitHandlers();
		const afterSecondExit = process.listenerCount("exit");
		const afterSecondSigterm = process.listenerCount("SIGTERM");

		expect(afterFirstExit).toBe(beforeExit + 1);
		expect(afterFirstSigterm).toBe(beforeSigterm + 1);
		expect(afterSecondExit).toBe(afterFirstExit);
		expect(afterSecondSigterm).toBe(afterFirstSigterm);
		// Never touches Pi's own SIGINT handling (its suspend mode deliberately ignores SIGINT).
		expect(process.listenerCount("SIGINT")).toBe(beforeSigint);
	});

	it("does nothing, and never calls process.exit, when no planning children are running on SIGTERM (N5)", () => {
		installPlanningTurnExitHandlers();
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit must never be called");
		});
		try {
			expect(() => process.emit("SIGTERM")).not.toThrow();
			expect(exitSpy).not.toHaveBeenCalled();
		} finally {
			exitSpy.mockRestore();
		}
	});

	it("kills any running planning children and removes their worktree on SIGTERM, without ever calling process.exit (N5)", async () => {
		const nextChild = new FakeChild();
		const spawn: PlanningTurnSpawn = vi.fn(() => nextChild);
		const worktreeRoot = mkdtempSync(join(tmpdir(), "pte-sigterm-"));
		writeFileSync(join(worktreeRoot, "marker.txt"), "x");
		const executor = createPlanningTurnExecutor({
			getClientConfig: () => ({
				serverUrl: "https://takonaut.test",
				apiKey: "secret-api-key",
				orgId: "org-1",
			}),
			getModel: () => ({ provider: "anthropic", id: "claude-sonnet" }),
			spawn,
			piCommand: () => ({ command: "/usr/bin/node", args: ["/opt/pi/cli.js"] }),
			toolsExtensionPath: "/opt/pi-extension/planner-tools-extension.ts",
		});
		const runPromise = executor.run({
			worktreeRoot,
			instruction: "Draft the plan",
			grantedTools: [],
			adrSnapshot: null,
			onDraft: () => {},
		});

		installPlanningTurnExitHandlers();
		const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit must never be called");
		});
		try {
			process.emit("SIGTERM");
			expect(nextChild.killed).toBe(true);
			expect(existsSync(worktreeRoot)).toBe(false);
			expect(exitSpy).not.toHaveBeenCalled();
		} finally {
			exitSpy.mockRestore();
		}

		// A still-pending run settles independently once its child actually exits.
		nextChild.exit(143);
		await expect(runPromise).rejects.toThrow();
	});
});
