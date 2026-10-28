/**
 * Real Planner execution in Pi (ADR-0010 B7/C2 follow-up): runs a claimed
 * planning turn's instruction in a headless `pi --print` child process,
 * restricted to exactly the turn's granted Takonaut MCP tools plus read-only
 * file tools scoped to the pinned worktree. Never touches the user's live
 * interactive Pi session: it is a separate OS process, in its own process
 * group, killed on timeout/abort, cleaned up in every path by the caller
 * (`PlanningTurnController`).
 *
 * Mirrors the Customer Runner's planning prompt (tako-runner/src/planning.ts)
 * so the Planner sees the same shape of instruction + ADRs in force,
 * regardless of which executor ran the turn.
 */
import { rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PlanningTurnAdrSnapshot, PlanningTurnExecutor } from "./planning-turns";
import { fenceNonce, fenceUntrustedData } from "./prompt-fence";
import { redactSensitiveValues } from "./redaction";

export interface PlanningTurnClientConfig {
	serverUrl: string;
	apiKey: string;
	orgId: string;
}

export interface PlanningTurnModel {
	provider: string;
	id: string;
}

/** The subset of node:child_process's ChildProcess this executor uses, so tests can inject a fake. */
export interface SpawnedPlanningProcess {
	readonly pid?: number;
	readonly stdin: NodeJS.WritableStream | null;
	readonly stdout: NodeJS.ReadableStream | null;
	readonly stderr: NodeJS.ReadableStream | null;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	kill(signal?: NodeJS.Signals): boolean | void;
}

/**
 * A planning turn's child process and worktree, live only while `run()` is
 * in flight, so an emergency cleanup can still reach it if Pi itself exits,
 * crashes, or is signaled while a turn is running (L4): the normal cleanup
 * path is `PlanningTurnController`'s `finally` block, which never runs if
 * the whole process goes away first.
 */
interface ActivePlanningChild {
	kill(): void;
	worktreeRoot: string;
}
const activePlanningChildren = new Set<ActivePlanningChild>();

/** Kills every still-live planning child and removes its worktree. Idempotent: safe to call with nothing active. */
function cleanupActivePlanningChildren(children: Iterable<ActivePlanningChild> = activePlanningChildren): void {
	for (const child of children) {
		try {
			child.kill();
		} catch {
			// Already exited.
		}
		try {
			rmSync(child.worktreeRoot, { recursive: true, force: true });
		} catch {
			// Best effort: a later `git worktree prune` still reclaims it.
		}
	}
	activePlanningChildren.clear();
}

let exitHandlersInstalled = false;

/**
 * Call once per process (from index.ts): the actual process-exit safety net
 * for `cleanupActivePlanningChildren`. Only ever touches a planning turn's
 * own child/worktree (a no-op when none are running), and never calls
 * `process.exit` itself: Pi owns its own shutdown sequencing (session
 * teardown, terminal restore on SIGTERM; suspend mode deliberately ignores
 * SIGINT), and a handler here that exited unconditionally cut that short (N5).
 */
export function installPlanningTurnExitHandlers(): void {
	if (exitHandlersInstalled) return;
	exitHandlersInstalled = true;
	process.once("exit", () => cleanupActivePlanningChildren());
	process.on("SIGTERM", () => cleanupActivePlanningChildren());
}

/** Exposed for tests: runs the same emergency cleanup the exit/SIGTERM handlers above run. */
export function planningTurnEmergencyCleanup(): void {
	cleanupActivePlanningChildren();
}

export type PlanningTurnSpawn = (
	command: string,
	args: string[],
	options: { cwd: string; env: NodeJS.ProcessEnv },
) => SpawnedPlanningProcess;

export interface PlanningTurnExecutorOptions {
	getClientConfig: () => PlanningTurnClientConfig | null;
	/** The model the user's live interactive session is currently using. */
	getModel: () => PlanningTurnModel | null;
	spawn: PlanningTurnSpawn;
	/** The `pi` binary/entry to re-invoke headlessly; defaults to this same installed build. */
	piCommand?: () => { command: string; args: string[] };
	/** Defaults to the sibling planner-tools-extension.ts next to this file. */
	toolsExtensionPath?: string;
	timeoutMs?: number;
	/** How often (ms) and how large (chars) a batch of streamed text may grow before flushing. */
	streamIntervalMs?: number;
	streamBatchChars?: number;
	maxOutputChars?: number;
	onEvent?: (event: string, detail?: Record<string, unknown>) => void;
}

// Must stay under the Bridge planning-turn claim token's lifetime (minted by
// backend/src/services/planning/turn_tokens.py), or a turn still running
// when its token expires can never stream or complete: see the fallback in
// createPlanningTurnExecutor.run's `timeoutMs` below, asserted in tests.
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
// pi (re-invoked headlessly below) resolves its own config/auth directory
// from HOME (see @earendil-works/pi-coding-agent's homedir()-based config
// dir), and needs PATH to find git and node. PI_CODING_AGENT_DIR overrides
// that config directory, so it is passed through when set. Everything else
// the ambient process has (other tools' credentials, unrelated secrets) is
// deliberately withheld from this child.
const INHERITED_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"USERPROFILE",
	"PI_CODING_AGENT_DIR",
	// Provider API key variables @earendil-works/pi-ai's getEnvApiKey
	// (env-api-keys.ts) reads, so a member authenticated through env vars
	// (rather than Pi's own credential store) still works inside this child
	// with whichever model it is granted (N2).
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"RADIUS_API_KEY",
	"OPENROUTER_API_KEY",
	"AI_GATEWAY_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"MOONSHOT_API_KEY",
	"HF_TOKEN",
	"FIREWORKS_API_KEY",
	"TOGETHER_API_KEY",
	"BASETEN_API_KEY",
	"OPENCODE_API_KEY",
	"KIMI_API_KEY",
	"CLOUDFLARE_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"QWEN_TOKEN_PLAN_API_KEY",
	"QWEN_TOKEN_PLAN_CN_API_KEY",
	"ANT_LING_API_KEY",
	"NVIDIA_API_KEY",
	"DEEPSEEK_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	// Vertex AI: Application Default Credentials, project and location.
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	// Amazon Bedrock credential sources.
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	// Network/TLS and locale/temp-dir, so the child resolves the same way the
	// user's own session does.
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"TMPDIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"LANG",
] as const;
// LC_* (LC_ALL, LC_CTYPE, ...): a prefix, not a fixed name, same as LANG above.
const INHERITED_ENV_PREFIX_ALLOWLIST = ["LC_"] as const;
const DEFAULT_STREAM_INTERVAL_MS = 1_000;
const DEFAULT_STREAM_BATCH_CHARS = 2_000;
const DEFAULT_MAX_OUTPUT_CHARS = 200_000;
// A short, generic reason is always the first part of a failed turn's error
// (L4); this is the most this excerpt ever adds on top of it.
const STDERR_EXCERPT_MAX_CHARS = 500;

function defaultPiCommand(): { command: string; args: string[] } {
	// Re-invoke the exact same installed Pi build that is hosting this
	// extension, headlessly, rather than resolving a "pi" binary on PATH.
	return { command: process.execPath, args: [process.argv[1] ?? "pi"] };
}

function defaultToolsExtensionPath(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "planner-tools-extension.ts");
}

function localToolName(serverName: string): string {
	return `tako_mcp_${serverName}`;
}

function adrSnapshotSection(
	nonce: string,
	snapshot: PlanningTurnAdrSnapshot | null | undefined,
): string {
	if (!snapshot || !Array.isArray(snapshot.adrs) || snapshot.adrs.length === 0) return "";
	const items = snapshot.adrs.map((adr) => {
		const number = String(adr.number).padStart(4, "0");
		// The title is untrusted too (set by any adrs.manage holder): kept
		// inside the fence below, never as prompt structure outside it.
		return `### ADR-${number}: ${adr.title}${adr.org_wide ? " (organization-wide)" : ""}\n${adr.content}${
			adr.truncated ? "\n(truncated)" : ""
		}`;
	});
	return `\n\nARCHITECTURE DECISION RECORDS IN FORCE (digest ${snapshot.digest}):\n${fenceUntrustedData(
		"ADR DATA",
		nonce,
		items.join("\n\n"),
	)}`;
}

/** Mirrors tako-runner's planningPrompt; Pi never keeps a warm session across turns. */
export function planningTurnPrompt(
	instruction: string,
	adrSnapshot: PlanningTurnAdrSnapshot | null | undefined,
): string {
	const nonce = fenceNonce();
	return `You are the Planner, helping a team plan work in a Tako Grill session. This is a read-only analysis: use only your granted tools, and never write, commit, push, or open a pull request.${adrSnapshotSection(
		nonce,
		adrSnapshot,
	)}

This is a fresh turn; you have no memory of earlier turns in this session.

THE TEAM ASKS:
${fenceUntrustedData("TEAM INSTRUCTION", nonce, instruction)}

Respond in Markdown with your draft thinking and conclusion. Cite files (path:line) or ADRs you used.`;
}

function killProcessGroup(child: SpawnedPlanningProcess): void {
	if (typeof child.pid === "number") {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			// Not a real process group (e.g. a test double, or already exited).
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		// Already gone.
	}
}

interface AssistantMessageEventLike {
	type?: unknown;
	delta?: unknown;
}

function extractTextDelta(line: string): string | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object") return null;
	const event = parsed as { type?: unknown; assistantMessageEvent?: AssistantMessageEventLike };
	if (event.type !== "message_update") return null;
	const inner = event.assistantMessageEvent;
	if (!inner || inner.type !== "text_delta" || typeof inner.delta !== "string") return null;
	return inner.delta;
}

export function createPlanningTurnExecutor(
	options: PlanningTurnExecutorOptions,
): PlanningTurnExecutor {
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const streamIntervalMs = options.streamIntervalMs ?? DEFAULT_STREAM_INTERVAL_MS;
	const streamBatchChars = options.streamBatchChars ?? DEFAULT_STREAM_BATCH_CHARS;
	const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
	const toolsExtensionPath = options.toolsExtensionPath ?? defaultToolsExtensionPath();

	return {
		async run({ worktreeRoot, instruction, grantedTools, adrSnapshot, onDraft, signal }) {
			const clientConfig = options.getClientConfig();
			if (!clientConfig) {
				throw new Error("Not connected to Takonaut");
			}
			const model = options.getModel();
			if (!model) {
				throw new Error("No model is currently selected in Pi");
			}

			const { command, args: baseArgs } = (options.piCommand ?? defaultPiCommand)();
			const allowedBuiltins = ["read", "grep", "find", "ls"];
			const allowedLocalTools = grantedTools.map(localToolName);
			const prompt = planningTurnPrompt(instruction, adrSnapshot);
			// The prompt (instruction plus ADR text) never goes on argv: it would
			// otherwise sit in a process listing for any other local user to read
			// (L4). It is piped on stdin instead; Pi's own `--print` mode already
			// reads piped stdin as the initial message when no positional prompt
			// argument is given.
			const args = [
				...baseArgs,
				"--print",
				"--mode",
				"json",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-context-files",
				"--no-themes",
				"--extension",
				toolsExtensionPath,
				"--no-builtin-tools",
				"--tools",
				[...allowedBuiltins, ...allowedLocalTools].join(","),
				"--model",
				`${model.provider}/${model.id}`,
			];
			const inheritedEnvKeys = Object.keys(process.env).filter(
				(key) =>
					(INHERITED_ENV_ALLOWLIST as readonly string[]).includes(key) ||
					INHERITED_ENV_PREFIX_ALLOWLIST.some((prefix) => key.startsWith(prefix)),
			);
			const env: NodeJS.ProcessEnv = {
				...Object.fromEntries(inheritedEnvKeys.map((key) => [key, process.env[key]])),
				TAKONAUT_PLANNING_SERVER_URL: clientConfig.serverUrl,
				TAKONAUT_PLANNING_API_KEY: clientConfig.apiKey,
				TAKONAUT_PLANNING_ORG_ID: clientConfig.orgId,
				TAKONAUT_PLANNING_ALLOWED_TOOLS: JSON.stringify(grantedTools),
				TAKONAUT_PLANNING_WORKTREE: resolve(worktreeRoot),
			};

			const child = options.spawn(command, args, { cwd: worktreeRoot, env });
			try {
				child.stdin?.write(prompt, "utf8");
				child.stdin?.end();
			} catch {
				// A dead-on-arrival child surfaces through its own "error"/"exit" event below.
			}
			const activeEntry: ActivePlanningChild = { kill: () => killProcessGroup(child), worktreeRoot };
			activePlanningChildren.add(activeEntry);

			return await new Promise<{ outputMarkdown: string }>((resolvePromise, reject) => {
				let fullText = "";
				let pending = "";
				let settled = false;
				let stdoutBuffer = "";
				let flushTimer: ReturnType<typeof setInterval> | null = null;
				let cleanupAbort = () => {};

				const flush = () => {
					if (!pending) return;
					const text = pending;
					pending = "";
					try {
						onDraft(text);
					} catch {
						// A failed/slow stream relay must never abort the turn itself.
					}
				};

				const finish = (result: { ok: true; outputMarkdown: string } | { ok: false; error: Error }) => {
					if (settled) return;
					settled = true;
					activePlanningChildren.delete(activeEntry);
					if (flushTimer) clearInterval(flushTimer);
					flush();
					if (timeoutHandle) clearTimeout(timeoutHandle);
					cleanupAbort();
					if (result.ok) resolvePromise({ outputMarkdown: result.outputMarkdown });
					else reject(result.error);
				};

				const timeoutHandle = setTimeout(() => {
					options.onEvent?.("planning_turn_timed_out", { timeoutMs });
					killProcessGroup(child);
					finish({
						ok: false,
						error: new Error(`Planning turn timed out after ${Math.round(timeoutMs / 1000)}s`),
					});
				}, timeoutMs);

				// N1: the lease-renewal loop aborts this signal when the server reports
				// the claim binding is no longer active, so the child is killed instead
				// of running on uselessly once the turn can never complete or stream.
				if (signal) {
					const onAbort = () => {
						killProcessGroup(child);
						finish({
							ok: false,
							error:
								signal.reason instanceof Error
									? signal.reason
									: new Error(String(signal.reason ?? "Planning turn aborted")),
						});
					};
					if (signal.aborted) onAbort();
					else {
						signal.addEventListener("abort", onAbort);
						cleanupAbort = () => signal.removeEventListener("abort", onAbort);
					}
				}

				flushTimer = setInterval(flush, streamIntervalMs);

				child.stdout?.on("data", (chunk: Buffer | string) => {
					stdoutBuffer += chunk.toString("utf8");
					const lines = stdoutBuffer.split("\n");
					stdoutBuffer = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.trim()) continue;
						const delta = extractTextDelta(line);
						if (delta === null) continue;
						if (fullText.length < maxOutputChars) {
							fullText += delta;
							pending += delta;
						}
						if (pending.length >= streamBatchChars) flush();
					}
				});

				let stderrTail = "";
				child.stderr?.on("data", (chunk: Buffer | string) => {
					stderrTail = (stderrTail + chunk.toString("utf8")).slice(-4_000);
				});

				child.on("error", (error) => {
					finish({ ok: false, error });
				});

				child.on("exit", (code) => {
					if (code === 0) {
						finish({ ok: true, outputMarkdown: fullText });
					} else {
						// A short, generic reason plus a bounded, secret-scrubbed excerpt
						// at most (L4): this error string is sent to the server as-is by
						// completePlanningTurn, and raw model/tool stderr is untrusted.
						const excerpt = redactSensitiveValues(stderrTail).slice(-STDERR_EXCERPT_MAX_CHARS);
						finish({
							ok: false,
							error: new Error(
								`Planning turn's Pi process failed (exit code ${code})${excerpt ? `: ${excerpt}` : ""}`,
							),
						});
					}
				});
			});
		},
	};
}
