// @takonaut/tako-bridge — governed Takonaut delivery workflows for Pi.
//
// Commands:
//   /tako-setup                 install required Pi companion packages
//   /tako-login [api-base-url]  connect with device authorization
//   /tako-status                reconcile session and lifecycle state
//   /tako-reconnect             authorize a replacement personal Pi key
//   /tako-cancel-ack            acknowledge an observed cancellation request
//   /tako-cleanup               clean retained terminal managed worktrees
//   /tako-diagnostics W PATH    explicitly upload one redacted Diagnostic bundle
//   /tako-tasks                 list current assigned work with Stage status
//   /tako-start TASK-KEY        context → repository preflight → reserve/claim
//   /tako-agentic-test W CMD    execute head-bound Workspace test evidence
//   /tako-complete SNAPSHOT     propose exact completion evidence for review
//   /tako-resume                resume Agentic Context after revalidation

import { createHash, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	TakonautClient,
	type BridgeTaskContext,
	type GitHubRepositoryContext,
	type StartableTask,
} from "./client";
import { collectLocalContext, formatLocalContextForInjection } from "./context";
import { readAndPrepareDiagnostic } from "./diagnostics";
import {
	loadConfig,
	loadPanelSettings,
	projectRepoMappingKey,
	saveConfig,
	savePanelSettings,
	saveProjectRepoMapping,
	type PanelSettings,
	type TakonautConfig,
} from "./config";
import { runDeviceLogin, type DeviceDeps } from "./device";
import {
	collectAgenticWorkspaceCompletionEvidence,
	fromPiExecResult,
	runGitHubPreflight,
	type CommandResult,
	type CommandRunner,
} from "./git";
import { evaluateToolCall } from "./policy";
import { missingCompanionPackages } from "./setup";
import {
	clearActiveAgenticRun,
	getOrCreatePiClientId,
	loadActiveAgenticRun,
	loadProjectAgentSync,
	saveActiveAgenticRun,
	saveProjectAgentSync,
	type ActiveAgenticDeliveryRun,
} from "./state";
import {
	capabilityExpansionRequired,
	hashCanonicalJson,
	reconcileTrustedSigningKeys,
	verifyAgenticManifest,
	type TrustedSigningKey,
} from "./manifest";
import {
	createBridgePanelErrorWidget,
	createBridgePanelWidget,
	type BridgePanelData,
	type BridgePanelDebugData,
	type SyncOperationDebug,
} from "./panel.js";
import { PanelSettingsView } from "./panel-settings.js";
import { normalizeBridgeApiBaseUrl } from "./server-url.js";
import { parseStartArguments } from "./start";
import { TaskPicker } from "./task-picker.js";
import {
	cleanupAgenticWorktree,
	provisionAgenticWorktrees,
	verifyAgenticRepositoryRoot,
} from "./workspaces";
import {
	AGENT_TELEMETRY_TIMEOUT_MS,
	isFeatureDisabledError,
	startAgentTelemetryReporter,
} from "./telemetry";

function safePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9-]/g, "_");
}

function remoteFromServerFingerprint(value: string): string | null {
	const match = /^github:\d+:([^/]+)\/(.+)$/i.exec(value);
	return match
		? `github.com/${match[1].toLowerCase()}/${match[2]
				.replace(/\.git$/i, "")
				.toLowerCase()}`
		: null;
}

function signingKeyFingerprint(publicKeyB64: string): string {
	return (
		createHash("sha256")
			.update(Buffer.from(publicKeyB64, "base64"))
			.digest("hex")
			.match(/.{1,4}/g)
			?.join(":") ?? "invalid"
	);
}

function trustedKeyFromWire(key: {
	key_id: string;
	public_key_b64: string;
	status: "active" | "next" | "retired" | "revoked";
	valid_from: string;
	valid_until: string | null;
}): TrustedSigningKey {
	return {
		keyId: key.key_id,
		publicKeyB64: key.public_key_b64,
		status: key.status,
		validFrom: key.valid_from,
		validUntil: key.valid_until,
	};
}

const TERMINAL_AGENTIC_STATUSES = new Set([
	"completed",
	"cancelled",
	"abandoned",
]);
const PANEL_REFRESH_TIMEOUT_MS = 10_000;
const RECONCILE_TIMEOUT_MS = 10_000;

function idleSyncDebug(): SyncOperationDebug {
	return {
		state: "idle",
		attempt: 0,
		startedAt: null,
		durationMs: null,
		skipped: 0,
		errorCode: null,
	};
}

async function withSyncTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	errorCode: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export default function takonautExtension(pi: ExtensionAPI): void {
	let cfg: TakonautConfig | null = null;
	let client: TakonautClient | null = null;
	let stopTelemetry: (() => void) | null = null;
	let panelTimer: ReturnType<typeof setInterval> | null = null;
	let panelRefreshInFlight = false;
	let panelRefreshQueued = false;
	let cachedPanelTasks: StartableTask[] = [];
	let cachedStandupStatus: "pending" | "submitted" | null = null;
	let panelSync = idleSyncDebug();
	let telemetrySync = idleSyncDebug();
	let reconcileSync = idleSyncDebug();

	const runner: CommandRunner = async (command, args, options) =>
		execute(pi, command, args, options);

	async function collectGovernedContext(
		conn: TakonautClient,
		active: ActiveAgenticDeliveryRun,
		stepInstanceKey: string,
	) {
		const contract = await conn.getAgenticDeliveryContextContract({
			runId: active.runId,
			sessionId: active.serverSessionId,
			stepInstanceKey,
		});
		if (
			contract.run_id !== active.runId ||
			contract.step_instance_key !== stepInstanceKey
		) {
			throw new Error("Takonaut returned Context for another Run or node");
		}
		return collectLocalContext(contract, active.worktrees ?? [], runner);
	}

	function ensure(ctx: ExtensionContext): TakonautClient | null {
		if (!cfg) cfg = loadConfig();
		if (!cfg) {
			note(
				ctx,
				"Takonaut not connected. Run /tako-login " +
					"(or set TAKONAUT_MCP_URL / TAKONAUT_API_KEY / TAKONAUT_ORG_ID).",
				"error",
			);
			return null;
		}
		if (!client) client = new TakonautClient(cfg);
		return client;
	}

	function currentConfig(ctx: ExtensionContext): TakonautConfig | null {
		const loaded = cfg ?? (cfg = loadConfig());
		if (!loaded) note(ctx, "Not connected — run /tako-login.", "error");
		return loaded;
	}

	function piSessionId(ctx: ExtensionContext): string {
		const sessionContext = ctx as ExtensionContext & {
			sessionManager: { getSessionId(): string };
		};
		return sessionContext.sessionManager.getSessionId();
	}

	function stopAgentTelemetry(): void {
		stopTelemetry?.();
		stopTelemetry = null;
	}

	function stopPanel(): void {
		if (panelTimer) clearInterval(panelTimer);
		panelTimer = null;
	}

	function panelDebugData(
		settings: PanelSettings,
	): BridgePanelDebugData | undefined {
		if (!settings.debug) return undefined;
		return {
			panel: { ...panelSync },
			telemetry: { ...telemetrySync },
			reconcile: { ...reconcileSync },
			nextRefreshSeconds:
				settings.refreshSeconds === 0 ? null : settings.refreshSeconds,
		};
	}

	function currentPanelData(
		ctx: ExtensionContext,
		c: TakonautConfig,
		settings: PanelSettings,
	): BridgePanelData {
		return {
			run: loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx)),
			showRun: settings.showRun,
			showStandup: settings.showStandup,
			showTasks: settings.showTasks,
			standupProjectKey: settings.standupProjectKey,
			standupStatus: cachedStandupStatus,
			tasks: cachedPanelTasks,
			taskLimit: settings.taskLimit,
			debug: panelDebugData(settings),
		};
	}

	function renderCurrentPanel(
		ctx: ExtensionContext,
		c: TakonautConfig,
		settings: PanelSettings,
	): void {
		ctx.ui.setWidget("tako-bridge-panel", (_tui, theme) =>
			createBridgePanelWidget(currentPanelData(ctx, c, settings), theme),
		);
	}

	function renderConfiguredPanel(
		ctx: ExtensionContext,
		c: TakonautConfig,
		settings: PanelSettings,
	): void {
		if (!settings.visible) {
			ctx.ui.setWidget("tako-bridge-panel", undefined);
			return;
		}
		renderCurrentPanel(ctx, c, settings);
	}

	function renderSyncDebugUpdate(
		ctx: ExtensionContext,
		c: TakonautConfig,
	): void {
		if (ctx.mode !== "tui" || !ctx.ui?.setWidget) return;
		const settings = loadPanelSettings(c.configPath);
		if (settings.visible && settings.debug) {
			renderCurrentPanel(ctx, c, settings);
		}
	}

	function renderPanelRefreshError(
		ctx: ExtensionContext,
		settings: PanelSettings,
	): void {
		const message =
			panelSync.state === "timeout"
				? "Refresh timed out; retrying on the next interval."
				: "Refresh failed; retrying on the next interval.";
		ctx.ui.setWidget("tako-bridge-panel", (_tui, theme) =>
			createBridgePanelErrorWidget(message, theme, panelDebugData(settings)),
		);
	}

	async function refreshPanel(
		ctx: ExtensionContext,
		c: TakonautConfig,
		settings: PanelSettings = loadPanelSettings(c.configPath),
	): Promise<void> {
		if (ctx.mode !== "tui" || !ctx.ui?.setWidget) return;
		if (!settings.visible) {
			ctx.ui.setWidget("tako-bridge-panel", undefined);
			return;
		}
		const conn = ensure(ctx);
		if (!conn) return;
		if (panelRefreshInFlight) {
			panelRefreshQueued = true;
			panelSync = { ...panelSync, skipped: panelSync.skipped + 1 };
			renderCurrentPanel(ctx, c, settings);
			return;
		}

		panelRefreshInFlight = true;
		const startedAt = Date.now();
		panelSync = {
			state: "running",
			attempt: panelSync.attempt + 1,
			startedAt: new Date(startedAt).toISOString(),
			durationMs: null,
			skipped: panelSync.skipped,
			errorCode: null,
		};
		renderCurrentPanel(ctx, c, settings);
		try {
			const [{ tasks }, standup] = await withSyncTimeout(
				Promise.all([
					conn.listStartableTasks("", PANEL_REFRESH_TIMEOUT_MS),
					settings.showStandup && settings.standupProjectKey
						? conn
								.getBridgeStandupStatus(settings.standupProjectKey)
								.catch(() => null)
						: Promise.resolve(null),
				]),
				PANEL_REFRESH_TIMEOUT_MS,
				"panel_refresh_timeout",
			);
			cachedPanelTasks = tasks;
			cachedStandupStatus = standup?.status ?? null;
			panelSync = {
				...panelSync,
				state: "ok",
				durationMs: Date.now() - startedAt,
				errorCode: null,
			};
			renderConfiguredPanel(ctx, c, loadPanelSettings(c.configPath));
		} catch (error) {
			const timedOut =
				error instanceof Error && error.message === "panel_refresh_timeout";
			panelSync = {
				...panelSync,
				state: timedOut ? "timeout" : "error",
				durationMs: Date.now() - startedAt,
				errorCode: timedOut ? "panel_refresh_timeout" : "panel_refresh_failed",
			};
			const currentSettings = loadPanelSettings(c.configPath);
			if (currentSettings.visible) {
				renderPanelRefreshError(ctx, currentSettings);
			} else {
				ctx.ui.setWidget("tako-bridge-panel", undefined);
			}
		} finally {
			panelRefreshInFlight = false;
			if (panelRefreshQueued) {
				panelRefreshQueued = false;
				void refreshPanel(ctx, c, loadPanelSettings(c.configPath));
			}
		}
	}

	function startPanelRefresh(
		ctx: ExtensionContext,
		c: TakonautConfig,
		settings: PanelSettings,
	): void {
		stopPanel();
		if (!settings.visible || settings.refreshSeconds === 0) return;
		panelTimer = setInterval(
			() => void refreshPanel(ctx, c),
			settings.refreshSeconds * 1_000,
		);
		panelTimer.unref?.();
	}

	function saveFeatureDisabled(state: ActiveAgenticDeliveryRun): void {
		saveActiveAgenticRun({
			...state,
			featureDisabled: true,
			updatedAt: new Date().toISOString(),
		});
	}

	function observeAgenticFeatureDisable(
		ctx: ExtensionContext,
		state: ActiveAgenticDeliveryRun | null,
		error: unknown,
	): boolean {
		if (!state || !isFeatureDisabledError(error)) return false;
		saveFeatureDisabled(state);
		stopAgentTelemetry();
		note(
			ctx,
			"Agentic Delivery is disabled. Local state and worktrees were preserved; run /tako-status after re-enable.",
			"warning",
		);
		return true;
	}

	function blockDisabledAgenticMutation(
		ctx: ExtensionContext,
		state: ActiveAgenticDeliveryRun,
	): boolean {
		if (!state.featureDisabled && !state.reauthorizationRequired) return false;
		note(
			ctx,
			state.featureDisabled
				? "Agentic Delivery is disabled. Run /tako-status after re-enable."
				: "This replacement key must be authorized with /tako-reconnect first.",
			"warning",
		);
		return true;
	}

	function startTelemetry(
		ctx: ExtensionContext,
		c: TakonautConfig,
		state: ActiveAgenticDeliveryRun,
	): void {
		stopAgentTelemetry();
		if (state.featureDisabled) return;
		const conn = ensure(ctx);
		if (!conn) return;
		stopTelemetry = startAgentTelemetryReporter({
			initialSequence: state.telemetrySequence,
			onStart: (sequence) => {
				const current = loadActiveAgenticRun(
					undefined,
					c.orgId,
					state.piSessionId,
				);
				if (!current || current.runId !== state.runId) return;
				telemetrySync = {
					state: "running",
					attempt: telemetrySync.attempt + 1,
					startedAt: new Date().toISOString(),
					durationMs: null,
					skipped: telemetrySync.skipped,
					errorCode: null,
					sequence,
				};
				renderSyncDebugUpdate(ctx, c);
			},
			onSkip: (sequence) => {
				const current = loadActiveAgenticRun(
					undefined,
					c.orgId,
					state.piSessionId,
				);
				if (!current || current.runId !== state.runId) return;
				telemetrySync = {
					...telemetrySync,
					skipped: telemetrySync.skipped + 1,
					sequence,
				};
				renderSyncDebugUpdate(ctx, c);
			},
			onSuccess: (sequence, durationMs) => {
				const current = loadActiveAgenticRun(
					undefined,
					c.orgId,
					state.piSessionId,
				);
				if (!current || current.runId !== state.runId) return;
				telemetrySync = {
					...telemetrySync,
					state: "ok",
					durationMs,
					errorCode: null,
					sequence,
				};
				renderSyncDebugUpdate(ctx, c);
			},
			onSequence: (sequence) => {
				const current = loadActiveAgenticRun(
					undefined,
					c.orgId,
					state.piSessionId,
				);
				if (
					!current ||
					current.runId !== state.runId ||
					sequence <= current.telemetrySequence
				)
					return;
				saveActiveAgenticRun({
					...current,
					telemetrySequence: sequence,
					updatedAt: new Date().toISOString(),
				});
			},
			snapshot: () => {
				const current = loadActiveAgenticRun(
					undefined,
					c.orgId,
					state.piSessionId,
				);
				if (
					!current ||
					current.runId !== state.runId ||
					current.featureDisabled
				)
					return null;
				return {
					runId: current.runId,
					sessionId: current.piSessionId,
					observedAt: new Date().toISOString(),
					instances: [
						{
							instanceKey: `pi:${current.piSessionId}`,
							parentInstanceKey: null,
							label: `Pi — ${current.taskKey}`,
							role: "executor",
							reportedStatus: current.executorPhase,
							startedAt: current.startedAt,
							lastActivityAt: current.lastActivityAt,
						},
					],
				};
			},
			report: (snapshot) =>
				conn.reportAgentTelemetry(snapshot, AGENT_TELEMETRY_TIMEOUT_MS),
			onFeatureDisabled: () => {
				const current = loadActiveAgenticRun(
					undefined,
					c.orgId,
					state.piSessionId,
				);
				if (!current || current.runId !== state.runId) return;
				telemetrySync = {
					...telemetrySync,
					state: "error",
					errorCode: "agent_profiles_disabled",
				};
				renderSyncDebugUpdate(ctx, c);
				saveFeatureDisabled(current);
				note(
					ctx,
					"Agentic Delivery was disabled. Local state and worktrees were preserved; run /tako-status after re-enable.",
					"warning",
				);
			},
			onError: (error, sequence, durationMs) => {
				const current = loadActiveAgenticRun(
					undefined,
					c.orgId,
					state.piSessionId,
				);
				if (!current || current.runId !== state.runId) return;
				const timedOut =
					error instanceof Error && error.message === "telemetry_timeout";
				telemetrySync = {
					...telemetrySync,
					state: timedOut ? "timeout" : "error",
					durationMs,
					errorCode: timedOut ? "telemetry_timeout" : "telemetry_report_failed",
					sequence,
				};
				renderSyncDebugUpdate(ctx, c);
				note(
					ctx,
					timedOut
						? "Agent telemetry timed out; the next heartbeat will retry."
						: "Agent telemetry was delayed; the next heartbeat will retry.",
					"warning",
				);
			},
		});
	}

	function isHeadlessOrRemote(): boolean {
		if (process.env.SSH_CONNECTION || process.env.SSH_TTY) return true;
		return (
			process.platform === "linux" &&
			!process.env.DISPLAY &&
			!process.env.WAYLAND_DISPLAY
		);
	}

	function openUrl(url: string): void {
		if (isHeadlessOrRemote()) return;
		const cmd =
			process.platform === "darwin"
				? "open"
				: process.platform === "win32"
					? "cmd"
					: "xdg-open";
		const args =
			process.platform === "win32" ? ["/c", "start", "", url] : [url];
		void execute(pi, cmd, args);
	}

	pi.registerCommand("tako-setup", {
		description: "Install missing Takonaut Pi companion packages",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			const listing = await execute(pi, "pi", ["list"]);
			if (listing.exitCode !== 0) {
				return note(
					ctx,
					`Could not inspect installed Pi packages: ${boundedSummary(listing)}`,
					"error",
				);
			}

			const missing = missingCompanionPackages(listing.stdout);
			if (missing.length === 0) {
				return note(
					ctx,
					"✓ Required Takonaut Pi companions are already installed.",
				);
			}

			const installSpecs = missing.map((companion) => companion.installSpec);
			if (!ctx.hasUI) {
				return note(
					ctx,
					`Run these commands in an interactive terminal:\n${installSpecs.map((spec) => `pi install ${spec}`).join("\n")}`,
					"error",
				);
			}

			const approved = await ctx.ui.confirm(
				"Install Takonaut Pi companions?",
				`Tako Bridge will install these user-level packages:\n${installSpecs.join("\n")}`,
			);
			if (!approved)
				return note(ctx, "Companion installation cancelled.", "warning");

			for (const companion of missing) {
				note(ctx, `Installing ${companion.name}…`);
				const result = await execute(pi, "pi", [
					"install",
					companion.installSpec,
				]);
				if (result.exitCode !== 0) {
					return note(
						ctx,
						`Failed to install ${companion.name}: ${boundedSummary(result)}`,
						"error",
					);
				}
			}

			note(
				ctx,
				`✓ Installed ${missing.map((companion) => companion.name).join(" and ")}. Reloading Pi resources.`,
			);
			await ctx.reload();
		},
	});

	pi.registerCommand("tako-login", {
		description:
			"Connect to Takonaut via device login: /tako-login [api-base-url]",
		handler: async (args, ctx) => {
			const base = normalizeBridgeApiBaseUrl(
				args.trim().split(/\s+/)[0] ||
					process.env.TAKONAUT_API_BASE ||
					"https://takonaut.app",
			);
			const deps: DeviceDeps = {
				fetchJson: async (method, path, body) => {
					const res = await fetch(base + path, {
						method,
						headers: { "Content-Type": "application/json" },
						body: body !== undefined ? JSON.stringify(body) : undefined,
						redirect: "error",
					});
					let json: any = {};
					try {
						json = await res.json();
					} catch {
						/* empty body */
					}
					return { status: res.status, json };
				},
				sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
				log: (message) => note(ctx, message),
				openUrl,
			};
			try {
				const result = await runDeviceLogin(base, deps, 120, hostname());
				saveConfig(result);
				if (client) await client.close();
				client = null;
				cfg = null;
				note(ctx, "✓ Connected. Run /tako-status, then /tako-tasks.");
			} catch (error) {
				note(ctx, `Login failed: ${errMsg(error)}`, "error");
			}
		},
	});

	pi.registerCommand("tako-status", {
		description: "Reconcile this Pi session with Agentic Delivery",
		handler: async (_args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const sessionId = piSessionId(ctx);
			const active = loadActiveAgenticRun(undefined, c.orgId, sessionId);
			const startedAt = Date.now();
			reconcileSync = {
				state: "running",
				attempt: reconcileSync.attempt + 1,
				startedAt: new Date(startedAt).toISOString(),
				durationMs: null,
				skipped: reconcileSync.skipped,
				errorCode: null,
			};
			renderSyncDebugUpdate(ctx, c);
			try {
				const status = await withSyncTimeout(
					conn.getAgenticDeliveryStatus(
						sessionId,
						active?.runId ?? "",
						RECONCILE_TIMEOUT_MS,
					),
					RECONCILE_TIMEOUT_MS,
					"reconcile_timeout",
				);
				reconcileSync = {
					...reconcileSync,
					state: "ok",
					durationMs: Date.now() - startedAt,
					errorCode: null,
				};
				renderSyncDebugUpdate(ctx, c);
				if (!active || status.status === "idle") {
					if (active) {
						stopAgentTelemetry();
						clearActiveAgenticRun(
							active.runId,
							undefined,
							c.orgId,
							active.piSessionId,
						);
					}
					note(ctx, "✓ Agentic Delivery connected; this Pi session is idle.");
					return;
				}
				const now = new Date().toISOString();
				const reconciled: ActiveAgenticDeliveryRun = {
					...active,
					serverSessionId: status.session_id,
					status: status.status,
					executorPhase: status.executor_phase,
					versionNumber: status.version,
					telemetrySequence: Math.max(
						active.telemetrySequence,
						status.telemetry_sequence ?? 0,
					),
					featureDisabled: false,
					reauthorizationRequired: status.reauthorization_required ?? false,
					cancellationId:
						status.cancellation?.id ?? active.cancellationId ?? null,
					worktrees: active.worktrees.map((worktree) => ({
						...worktree,
						lifecycle: TERMINAL_AGENTIC_STATUSES.has(status.status)
							? worktree.lifecycle === "cleaned"
								? "cleaned"
								: "cleanup_hold"
							: worktree.lifecycle,
					})),
					updatedAt: now,
				};
				saveActiveAgenticRun(reconciled);
				if (
					status.reauthorization_required ||
					TERMINAL_AGENTIC_STATUSES.has(status.status) ||
					status.status === "cancellation_requested"
				) {
					stopAgentTelemetry();
				} else {
					startTelemetry(ctx, c, reconciled);
				}
				note(
					ctx,
					`${active.taskKey}: Delivery Stage ${status.delivery_stage?.name ?? "Unavailable"} · Executor phase ${status.executor_phase} (Run ${status.status})\n` +
						`Next action (${status.next_action_owner_type ?? "unassigned"}): ${status.next_action ?? "No action required"}\n` +
						`${status.next_command ?? `/tako-status ${active.taskKey}`}`,
				);
			} catch (error) {
				const timedOut =
					error instanceof Error && error.message === "reconcile_timeout";
				reconcileSync = {
					...reconcileSync,
					state: timedOut ? "timeout" : "error",
					durationMs: Date.now() - startedAt,
					errorCode: timedOut ? "reconcile_timeout" : "reconcile_failed",
				};
				renderSyncDebugUpdate(ctx, c);
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					timedOut
						? "Could not reconcile Agentic Delivery: request timed out; retry with /tako-status."
						: "Could not reconcile Agentic Delivery: request failed; retry with /tako-status.",
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-reconnect", {
		description: "Explicitly authorize a replacement personal Pi key",
		handler: async (_args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			if (!active?.reauthorizationRequired) {
				return note(
					ctx,
					"No retained Agentic Delivery session requires key reconciliation. Run /tako-status first.",
					"error",
				);
			}
			try {
				const result = await conn.reauthorizeAgenticDeliverySession({
					runId: active.runId,
					sessionId: active.serverSessionId,
					expectedVersion: active.versionNumber,
					idempotencyKey: `reauthorize:${active.runId}:${active.serverSessionId}`,
				});
				const reconciled: ActiveAgenticDeliveryRun = {
					...active,
					status: result.status,
					executorPhase: result.executor_phase,
					versionNumber: result.version,
					reauthorizationRequired: false,
					updatedAt: new Date().toISOString(),
				};
				saveActiveAgenticRun(reconciled);
				if (
					reconciled.status !== "cancellation_requested" &&
					!TERMINAL_AGENTIC_STATUSES.has(reconciled.status)
				) {
					startTelemetry(ctx, c, reconciled);
				}
				note(
					ctx,
					`${active.taskKey} session reauthorized. The Run was reconciled but not automatically resumed.`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Session reauthorization failed: ${errMsg(error)} Ownership and worktrees were preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-panel", {
		description: "Configure the Tako Bridge panel above the prompt editor",
		handler: async (_args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn || !ctx.hasUI || ctx.mode !== "tui") return;
			let settings = loadPanelSettings(c.configPath);
			const projects = [
				...new Set(cachedPanelTasks.map((task) => task.project_key)),
			];
			await ctx.ui.custom<void>(
				(tui, theme, _keybindings, done) =>
					new PanelSettingsView(settings, projects, theme, {
						onSettingsChange: (next) => {
							settings = next;
							savePanelSettings(settings, c.configPath);
							void refreshPanel(ctx, c, settings);
							startPanelRefresh(ctx, c, settings);
						},
						onRefresh: () => void refreshPanel(ctx, c, settings),
						onDone: () => done(undefined),
						onChange: () => tui.requestRender(),
					}),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "60%",
						minWidth: 48,
						maxHeight: "80%",
						margin: 1,
					},
				},
			);
		},
	});

	pi.registerCommand("tako-standup", {
		description: "Draft a Standup from this Pi session and open it in Takonaut",
		handler: async (_args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn || !ctx.hasUI) return;
			let settings = loadPanelSettings(c.configPath);
			let projectKey = settings.standupProjectKey;
			if (!projectKey) {
				const { tasks } = await conn.listStartableTasks();
				const projects = [...new Set(tasks.map((task) => task.project_key))];
				projectKey = await ctx.ui.select("Standup Project", projects);
				if (!projectKey) return;
				settings = { ...settings, standupProjectKey: projectKey };
				savePanelSettings(settings, c.configPath);
			}
			const approved = await ctx.ui.confirm(
				"Draft Standup from this Pi session?",
				"Your current Pi conversation plus bounded git log/status summaries will be sent to your configured Pi model. Only the draft you review and confirm will be uploaded to Takonaut.",
			);
			if (!approved) return;
			if (!ctx.model) {
				return note(
					ctx,
					"Select a Pi model before drafting a Standup.",
					"error",
				);
			}
			const conversation = buildStandupConversation(
				ctx.sessionManager.getBranch() as unknown[],
			);
			const [gitLog, gitStatus, gitDiff] = await Promise.all([
				execute(pi, "git", ["-C", c.repoRoot, "log", "-10", "--oneline"]),
				execute(pi, "git", ["-C", c.repoRoot, "status", "--short"]),
				execute(pi, "git", ["-C", c.repoRoot, "diff", "--stat", "HEAD"]),
			]);
			const response = await ctx.modelRegistry.complete(
				ctx.model,
				{
					messages: [
						{
							role: "user" as const,
							content: [
								{
									type: "text" as const,
									text: buildStandupDraftPrompt(projectKey, conversation, {
										log: boundedSummary(gitLog),
										status: boundedSummary(gitStatus),
										diff: boundedSummary(gitDiff),
									}),
								},
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					reasoningEffort: "low",
					cacheRetention: "none",
					sessionId: randomUUID(),
				},
			);
			const generated = response.content
				.filter(
					(part): part is { type: "text"; text: string } =>
						part.type === "text",
				)
				.map((part) => part.text)
				.join("\n");
			let sections: Record<string, string>;
			try {
				sections = parseStandupSections(generated);
			} catch (error) {
				return note(
					ctx,
					`Could not parse Standup draft: ${errMsg(error)}`,
					"error",
				);
			}
			const edited = await ctx.ui.editor(
				`Review ${projectKey} Standup draft`,
				JSON.stringify(sections, null, 2),
			);
			if (!edited) return;
			try {
				sections = parseStandupSections(edited);
			} catch (error) {
				return note(ctx, `Standup draft is invalid: ${errMsg(error)}`, "error");
			}
			const confirmed = await ctx.ui.confirm(
				"Open this draft in Takonaut?",
				"The reviewed draft will be stored for 15 minutes and opened in your authenticated browser. It is not submitted automatically.",
			);
			if (!confirmed) return;
			const draft = await conn.createBridgeStandupDraft({
				projectKey,
				sections,
			});
			const url = new URL(draft.draft_url, c.serverUrl).toString();
			openUrl(url);
			note(ctx, `Standup draft opened in Takonaut: ${url}`);
		},
	});

	pi.registerCommand("tako-tasks", {
		description: "Search current Takonaut work and open a selected item",
		handler: async (_args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			try {
				const { tasks } = await conn.listStartableTasks();
				if (!tasks?.length)
					return note(ctx, "No current work is assigned to you.");
				if (ctx.mode === "tui") {
					const selectedTaskKey = await ctx.ui.custom<string | null>(
						(tui, theme, _keybindings, done) =>
							new TaskPicker(tasks, theme, {
								onSelect: done,
								onCancel: () => done(null),
								onChange: () => tui.requestRender(),
							}),
						{
							overlay: true,
							overlayOptions: {
								anchor: "center",
								width: "75%",
								minWidth: 56,
								maxHeight: "70%",
								margin: 1,
							},
						},
					);
					if (!selectedTaskKey) return;
					const selectedTask = tasks.find(
						(task) => task.task_key === selectedTaskKey,
					);
					if (!selectedTask?.task_path) {
						return note(
							ctx,
							`No direct link is available for ${selectedTaskKey}. Update the Takonaut application and retry.`,
							"error",
						);
					}
					const url = new URL(selectedTask.task_path, c.serverUrl).toString();
					note(ctx, `Opening ${selectedTask.task_key}: ${url}`);
					openUrl(url);
					return;
				}

				const ready = tasks.filter(
					(task) => task.startability.startable,
				).length;
				const blocked = tasks.length - ready;
				note(
					ctx,
					`Current work: ${tasks.length} total · ${ready} ready · ${blocked} blocked\n` +
						tasks
							.map((task) => {
								const status = task.startability.startable
									? "READY  "
									: "BLOCKED";
								const reason = task.startability.startable
									? ""
									: ` — ${formatStartabilityReasons(task.startability.reasons)}`;
								const scope =
									task.workflow_mode === "kanban"
										? `${task.project_key} · Kanban`
										: task.sprint_name
											? `${task.project_key} · ${task.sprint_name}`
											: task.project_key;
								return `  ${status}  ${task.task_key}  [${task.stage_name ?? "Unknown Stage"}]  ${task.task_title}  (${scope})${reason}`;
							})
							.join("\n"),
				);
			} catch (error) {
				note(ctx, `Failed to list work: ${errMsg(error)}`, "error");
			}
		},
	});

	pi.registerCommand("tako-start", {
		description:
			"Reserve an Agentic Delivery Run: /tako-start TASK-KEY [--base-ref WORKSPACE=REF --reason WHY]",
		handler: async (args, ctx) => {
			let parsed: ReturnType<typeof parseStartArguments>;
			try {
				parsed = parseStartArguments(args);
			} catch (error) {
				return note(ctx, errMsg(error), "error");
			}
			const { taskKey, baseRefOverrides } = parsed;
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const sessionId = piSessionId(ctx);
			const existing = loadActiveAgenticRun(undefined, c.orgId, sessionId);
			if (existing && TERMINAL_AGENTIC_STATUSES.has(existing.status)) {
				clearActiveAgenticRun(existing.runId, undefined, c.orgId, sessionId);
			}
			if (existing && !TERMINAL_AGENTIC_STATUSES.has(existing.status)) {
				return note(
					ctx,
					`${existing.taskKey} already belongs to this Pi session (${existing.executorPhase}). Run /tako-status.`,
					"error",
				);
			}
			try {
				const context = await conn.getBridgeTaskContext(taskKey);
				if (!context.startability.startable) {
					throw new Error(startabilityMessage(context));
				}
				const preflight = await verifyRepository(runner, c, context);
				saveProjectRepoMapping(
					c.orgId,
					context.project.id,
					{
						projectId: context.project.id,
						repoRoot: preflight.repoRoot,
						remoteFingerprint: preflight.remoteFingerprint,
						linkedAt: new Date().toISOString(),
					},
					c.configPath,
					c.credentialPath,
				);
				const clientId = getOrCreatePiClientId();
				const startNonce = randomUUID();
				const started = await conn.startAgenticDelivery({
					taskKey,
					clientId,
					sessionId,
					sessionLabel: `${hostname()} - ${taskKey}`,
					extensionVersion: "0.4.11",
					manifestSchemaVersion: 2,
					idempotencyKey: `start:${sessionId}:${startNonce}`,
					baseRefOverrides,
				});
				const now = new Date().toISOString();
				const projectSync = loadProjectAgentSync(
					undefined,
					c.orgId,
					started.project_id,
				);
				const advertisedKeys = started.signing_keys.filter(
					(key) => key.algorithm === "Ed25519",
				);
				let trustedKeys = reconcileTrustedSigningKeys(
					projectSync?.trustedSigningKeys ?? [],
					advertisedKeys,
				);
				if (!trustedKeys.some((key) => key.keyId === started.manifest.key_id)) {
					const offeredKeys = advertisedKeys.filter(
						(key) => key.status !== "revoked",
					);
					const signingKey = offeredKeys.find(
						(key) => key.key_id === started.manifest.key_id,
					);
					if (!signingKey) throw new Error("Manifest signing key is unknown");
					if (!ctx.hasUI) {
						throw new Error(
							"Signing-key trust requires an interactive Pi session",
						);
					}
					const approved = await ctx.ui.confirm(
						"Trust Takonaut manifest signing keys?",
						`Project ${context.project.key} requests Ed25519 key ${signingKey.key_id}.\n` +
							`SHA-256: ${signingKeyFingerprint(signingKey.public_key_b64)}\n` +
							"Trust this key and the advertised next key only if this Project and fingerprint are expected.",
					);
					if (!approved)
						throw new Error("Manifest signing-key trust was declined");
					trustedKeys = advertisedKeys.map(trustedKeyFromWire);
				}
				const verified = verifyAgenticManifest(started.manifest, trustedKeys, {
					organizationId: c.orgId,
					projectId: started.project_id,
					minimumRevision: projectSync?.acceptedRevision ?? 0,
					extensionVersion: "0.4.11",
				});
				const capabilityExpansion = capabilityExpansionRequired(
					projectSync?.capabilityEnvelope ?? null,
					started.capability_envelope,
				);
				if (capabilityExpansion) {
					if (!ctx.hasUI) {
						throw new Error(
							"Capability approval requires an interactive Pi session",
						);
					}
					const envelope = started.capability_envelope;
					const approved = await ctx.ui.confirm(
						"Approve Agentic Delivery capabilities?",
						`Project ${context.project.key}, Setup revision ${verified.revision}\n` +
							`Workspaces: ${envelope.workspace_scopes.map((scope) => scope.id).join(", ")}\n` +
							`Tools: ${envelope.allowed_tools.join(", ") || "none"}\n` +
							`Executable Steps: ${envelope.executable_step_types.join(", ") || "none"}\n` +
							`Protected paths: ${envelope.protected_paths.join(", ") || "none"}`,
					);
					if (!approved)
						throw new Error(
							"Agentic Delivery capability approval was declined",
						);
				}
				saveProjectAgentSync({
					version: 1,
					orgId: c.orgId,
					projectId: started.project_id,
					acceptedRevision: verified.revision,
					acceptedRevisionId: started.manifest.payload.revision_id,
					contentHash: verified.contentHash,
					envelopeHash: verified.envelopeHash,
					capabilityEnvelope: started.capability_envelope,
					trustedSigningKeys: trustedKeys,
					updatedAt: now,
				});

				const defaultMappingKey = projectRepoMappingKey(
					c.orgId,
					started.project_id,
				);
				const repoRoots: Record<string, string> = {};
				for (const workspace of started.workspaces) {
					const expectedRemote = remoteFromServerFingerprint(
						workspace.repository_fingerprint,
					);
					if (!expectedRemote) {
						throw new Error(
							`Workspace '${workspace.workspace_key}' has an invalid server repository fingerprint`,
						);
					}
					if (expectedRemote === preflight.remoteFingerprint) {
						repoRoots[workspace.workspace_key] = preflight.repoRoot;
						continue;
					}
					const mapping =
						c.projectRepos[`${defaultMappingKey}:${workspace.workspace_key}`];
					if (mapping?.remoteFingerprint === expectedRemote) {
						repoRoots[workspace.workspace_key] = mapping.repoRoot;
						continue;
					}
					if (!ctx.hasUI) {
						throw new Error(
							`Workspace '${workspace.workspace_key}' needs a locally approved repository mapping`,
						);
					}
					const selectedRoot = await ctx.ui.input(
						`Map Code Workspace '${workspace.workspace_key}'`,
						`Enter the absolute path to the clean clone for ${expectedRemote}`,
					);
					if (!selectedRoot) {
						throw new Error(
							`Workspace '${workspace.workspace_key}' repository mapping was cancelled`,
						);
					}
					const verifiedRoot = await verifyAgenticRepositoryRoot(
						runner,
						selectedRoot,
						workspace.repository_fingerprint,
					);
					saveProjectRepoMapping(
						c.orgId,
						started.project_id,
						{
							projectId: started.project_id,
							repoRoot: verifiedRoot,
							remoteFingerprint: expectedRemote,
							linkedAt: now,
						},
						c.configPath,
						c.credentialPath,
						workspace.workspace_key,
					);
					repoRoots[workspace.workspace_key] = verifiedRoot;
				}
				const managedRoot = join(
					homedir(),
					".takonaut",
					"workspaces",
					safePathSegment(c.orgId),
					safePathSegment(started.project_id),
					safePathSegment(started.run_id),
				);
				const effectiveConfigHash = hashCanonicalJson({
					revision: verified.revision,
					content_hash: verified.contentHash,
					workspace_keys: started.workspaces.map(
						(workspace) => workspace.workspace_key,
					),
				});
				const provisional: ActiveAgenticDeliveryRun = {
					version: 1,
					orgId: c.orgId,
					clientId,
					piSessionId: sessionId,
					serverSessionId: started.session_id,
					runId: started.run_id,
					taskId: started.task_id,
					taskKey: started.task_key,
					projectId: started.project_id,
					projectKey: context.project.key,
					repoRoot: preflight.repoRoot,
					status: started.status,
					executorPhase: started.executor_phase,
					versionNumber: started.version,
					startNonce,
					telemetrySequence: started.telemetry_sequence ?? 0,
					featureDisabled: false,
					acceptedManifest: {
						revision: verified.revision,
						revisionId: started.manifest.payload.revision_id,
						contentHash: verified.contentHash,
						envelopeHash: verified.envelopeHash,
						keyId: verified.keyId,
						acceptedAt: now,
						capabilityApprovedAt: capabilityExpansion
							? now
							: (projectSync?.updatedAt ?? now),
					},
					trustedSigningKeys: trustedKeys,
					worktrees: started.workspaces.map((workspace) => ({
						workspaceKey: workspace.workspace_key,
						repositoryFingerprint: workspace.repository_fingerprint,
						configuredBaseRef: workspace.configured_base_ref,
						overrideBaseRef: workspace.override_base_ref,
						repoRoot: repoRoots[workspace.workspace_key],
						worktreeRoot: join(managedRoot, workspace.workspace_key),
						relativeWorktreePath: `${started.project_id}/${started.run_id}/${workspace.workspace_key}`,
						branchName: workspace.branch_name,
						baseSha: workspace.resolved_base_sha,
						initialHeadSha: "",
						effectiveConfigHash,
						lifecycle: "planned",
					})),
					completionTests: {},
					startedAt: now,
					lastActivityAt: now,
					updatedAt: now,
				};
				saveActiveAgenticRun(provisional);
				const worktrees = await provisionAgenticWorktrees({
					run: runner,
					managedRoot,
					relativeNamespace: `${started.project_id}/${started.run_id}`,
					plans: started.workspaces,
					repoRoots,
					effectiveConfigHash,
				});
				const activation = await conn.activateAgenticDelivery({
					runId: started.run_id,
					sessionId: started.session_id,
					expectedVersion: started.version,
					worktrees: worktrees.map((worktree) => ({
						workspaceKey: worktree.workspaceKey,
						repositoryFingerprint: worktree.repositoryFingerprint,
						resolvedBaseSha: worktree.baseSha,
						branchName: worktree.branchName,
						initialHeadSha: worktree.initialHeadSha,
						relativeWorktreePath: worktree.relativeWorktreePath,
						effectiveConfigHash: worktree.effectiveConfigHash,
					})),
				});
				const active: ActiveAgenticDeliveryRun = {
					...provisional,
					status: activation.status,
					executorPhase: activation.executor_phase,
					versionNumber: activation.version,
					worktrees,
					updatedAt: new Date().toISOString(),
				};
				saveActiveAgenticRun(active);
				startTelemetry(ctx, c, active);
				note(
					ctx,
					activation.activated
						? `${taskKey} activated (${activation.executor_phase}). ${activation.next_command}`
						: `${taskKey} provisioned but blocked: ${activation.blocker ?? activation.blocker_code ?? "unknown blocker"}`,
				);
			} catch (error) {
				const reserved = loadActiveAgenticRun(undefined, c.orgId, sessionId);
				if (observeAgenticFeatureDisable(ctx, reserved, error)) return;
				note(
					ctx,
					`Failed to start ${taskKey}: ${errMsg(error)} Repository preflight runs before reservation; if the Run was reserved, use /tako-status to reconcile it. Managed worktrees are preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-agentic-test", {
		description: "Run a head-bound test: /tako-agentic-test WORKSPACE COMMAND",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			if (!c) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			const argv = splitCommandLine(args.trim());
			const workspaceKey = argv.shift() ?? "";
			const worktree = active?.worktrees.find(
				(item) => item.workspaceKey === workspaceKey,
			);
			if (!active || !worktree || !argv.length) {
				return note(
					ctx,
					"Usage: /tako-agentic-test WORKSPACE COMMAND",
					"error",
				);
			}
			if (blockDisabledAgenticMutation(ctx, active)) return;
			const commandText = argv.join(" ");
			if (containsSensitiveValue(commandText)) {
				return note(
					ctx,
					"Test command contains a sensitive value and was not run or recorded.",
					"error",
				);
			}
			const projectSync = loadProjectAgentSync(
				undefined,
				c.orgId,
				active.projectId,
			);
			const policy = evaluateToolCall(
				"bash",
				{ command: commandText },
				{
					repoRoot: worktree.worktreeRoot,
					repoRoots: active.worktrees
						.filter((item) => item.lifecycle === "verified")
						.map((item) => item.worktreeRoot),
					protectedPaths: projectSync?.capabilityEnvelope.protected_paths,
					protectedBranches: c.protectedBranches,
				},
			);
			if (!policy.allow) {
				return note(
					ctx,
					policy.reason ?? "Test command was blocked by Takonaut policy.",
					"warning",
				);
			}
			const head = await runner("git", [
				"-C",
				worktree.worktreeRoot,
				"rev-parse",
				"HEAD",
			]);
			const headSha = head.stdout.trim().toLowerCase();
			if (head.exitCode !== 0 || !/^[0-9a-f]{40}$/.test(headSha)) {
				return note(ctx, "Could not resolve the Workspace HEAD.", "error");
			}
			const result = await runner(argv[0], argv.slice(1), {
				cwd: worktree.worktreeRoot,
			});
			const recorded = {
				command: commandText,
				exitCode: result.exitCode,
				status:
					result.exitCode === 0 ? ("passed" as const) : ("failed" as const),
				summary: boundedSummary(result),
				completedAt: new Date().toISOString(),
				headSha,
			};
			const existing = active.completionTests[workspaceKey] ?? [];
			saveActiveAgenticRun({
				...active,
				completionTests: {
					...active.completionTests,
					[workspaceKey]: [
						...existing.filter((test) => test.command !== commandText),
						recorded,
					],
				},
				updatedAt: new Date().toISOString(),
			});
			note(
				ctx,
				`${recorded.status === "passed" ? "✓" : "✖"} ${workspaceKey} test ${recorded.status}: ${commandText}\n${recorded.summary}`,
				recorded.status === "passed" ? "info" : "error",
			);
		},
	});

	pi.registerCommand("tako-complete", {
		description: "Propose exact completion evidence: /tako-complete SNAPSHOT",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			const contextSnapshotId = args.trim();
			if (!active || !contextSnapshotId) {
				return note(ctx, "Usage: /tako-complete SNAPSHOT", "error");
			}
			try {
				const workspaces = [];
				for (const worktree of active.worktrees) {
					workspaces.push(
						await collectAgenticWorkspaceCompletionEvidence(
							runner,
							worktree,
							active.completionTests[worktree.workspaceKey] ?? [],
						),
					);
				}
				const result = await conn.proposeAgenticDeliveryCompletion({
					runId: active.runId,
					sessionId: active.serverSessionId,
					contextSnapshotId,
					expectedVersion: active.versionNumber,
					idempotencyKey: `completion:${active.runId}:${randomUUID()}`,
					workspaces,
				});
				saveActiveAgenticRun({
					...active,
					status: result.status,
					executorPhase: result.executor_phase,
					versionNumber: result.version,
					updatedAt: new Date().toISOString(),
				});
				if (!result.created || !result.review_url) {
					return note(
						ctx,
						`Completion proposal blocked: ${result.blocker_code ?? "unknown blocker"}. ${result.next_command ?? "/tako-status"}`,
						"warning",
					);
				}
				const reviewUrl = new URL(result.review_url, c.serverUrl).toString();
				note(
					ctx,
					`Completion evidence submitted for all Workspaces: ${reviewUrl}\nApproval never completes the Run; resume only with ${result.next_command ?? `/tako-finalize ${result.approval_request_id}`}.`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Completion proposal failed: ${errMsg(error)} Local evidence was preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-finalize", {
		description:
			"Reverify and finalize approved evidence: /tako-finalize REQUEST",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			const approvalRequestId = args.trim();
			if (!active || !approvalRequestId) {
				return note(ctx, "Usage: /tako-finalize REQUEST", "error");
			}
			try {
				const workspaces = [];
				for (const worktree of active.worktrees) {
					workspaces.push(
						await collectAgenticWorkspaceCompletionEvidence(
							runner,
							worktree,
							active.completionTests[worktree.workspaceKey] ?? [],
						),
					);
				}
				const result = await conn.finalizeAgenticDeliveryCompletion({
					runId: active.runId,
					sessionId: active.serverSessionId,
					approvalRequestId,
					expectedVersion: active.versionNumber,
					idempotencyKey: `finalize:${active.runId}:${approvalRequestId}:${randomUUID()}`,
					workspaces,
				});
				saveActiveAgenticRun({
					...active,
					status: result.status,
					executorPhase: result.executor_phase,
					versionNumber: result.version,
					updatedAt: new Date().toISOString(),
				});
				note(
					ctx,
					result.finalized
						? `${active.taskKey} completed atomically. Managed worktrees remain retained until explicit cleanup.`
						: `Completion remains blocked: ${result.blocker_code ?? "revalidation failed"}. ${result.next_command ?? "/tako-status"}`,
					result.finalized ? "info" : "warning",
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Completion finalization failed: ${errMsg(error)} The claim and worktrees were preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-cancel-ack", {
		description: "Acknowledge an observed Agentic Delivery cancellation",
		handler: async (_args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			if (
				!active ||
				active.status !== "cancellation_requested" ||
				!active.cancellationId
			) {
				return note(
					ctx,
					"No observed cancellation is waiting for acknowledgement. Run /tako-status first.",
					"error",
				);
			}
			try {
				const result = await conn.acknowledgeAgenticDeliveryCancellation({
					runId: active.runId,
					sessionId: active.serverSessionId,
					cancellationId: active.cancellationId,
					expectedVersion: active.versionNumber,
					idempotencyKey: `cancel-ack:${active.runId}:${active.cancellationId}`,
				});
				const cancelled: ActiveAgenticDeliveryRun = {
					...active,
					status: result.status,
					executorPhase: result.executor_phase,
					versionNumber: result.version,
					worktrees: active.worktrees.map((worktree) => ({
						...worktree,
						lifecycle:
							worktree.lifecycle === "cleaned" ? "cleaned" : "cleanup_hold",
					})),
					updatedAt: new Date().toISOString(),
				};
				saveActiveAgenticRun(cancelled);
				stopAgentTelemetry();
				note(
					ctx,
					`${active.taskKey} cancellation acknowledged. Managed worktrees remain retained; run /tako-cleanup explicitly.`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Cancellation acknowledgement failed: ${errMsg(error)} Local worktrees and server ownership were preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-diagnostics", {
		description:
			"Explicitly scan, redact, and upload one bounded Workspace Diagnostic file",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			if (!active) {
				return note(
					ctx,
					"No Agentic Delivery Run is retained locally.",
					"error",
				);
			}
			if (blockDisabledAgenticMutation(ctx, active)) return;
			if (active.reauthorizationRequired) {
				return note(
					ctx,
					"Authorize the replacement key with /tako-reconnect before uploading diagnostics.",
					"warning",
				);
			}
			const [workspaceKey, relativePath, ...extra] = args.trim().split(/\s+/);
			if (!workspaceKey || !relativePath || extra.length > 0) {
				return note(
					ctx,
					"Usage: /tako-diagnostics WORKSPACE_KEY RELATIVE_PATH",
					"error",
				);
			}
			const workspace = active.worktrees.find(
				(candidate) =>
					candidate.workspaceKey === workspaceKey &&
					candidate.lifecycle !== "cleaned",
			);
			if (!workspace) {
				return note(ctx, "That retained Workspace was not found.", "error");
			}
			try {
				const diagnostic = readAndPrepareDiagnostic(
					workspace.worktreeRoot,
					relativePath,
				);
				const confirmed = await ctx.ui.confirm(
					"Upload sensitive Diagnostic bundle?",
					`Workspace ${workspaceKey}; ${diagnostic.byteSize} bytes after ${diagnostic.redactionCount} redaction(s). ` +
						"The redacted body requires dedicated access permission and is automatically deleted after 30 days unless held. Declining keeps it local.",
				);
				if (!confirmed) {
					return note(
						ctx,
						"Diagnostic upload declined; the file stayed local.",
					);
				}
				const contentHash = createHash("sha256")
					.update(diagnostic.content)
					.digest("hex");
				const result = await conn.uploadAgenticDeliveryDiagnostic({
					runId: active.runId,
					sessionId: active.serverSessionId,
					expectedVersion: active.versionNumber,
					idempotencyKey: `diagnostic:${active.runId}:${workspaceKey}:${contentHash}`,
					workspaceKey,
					title: `Diagnostic bundle: ${relativePath}`,
					content: diagnostic.content,
					confirmed: true,
				});
				saveActiveAgenticRun({
					...active,
					versionNumber: result.version,
					updatedAt: new Date().toISOString(),
				});
				note(
					ctx,
					`Sensitive Diagnostic uploaded with ${result.redaction_count} server redaction(s). Scheduled deletion: ${result.scheduled_deletion_at}. ${result.artifact_url}`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Diagnostic upload failed: ${errMsg(error)} No unredacted content was uploaded by this command.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-cleanup", {
		description: "Safely remove retained terminal managed worktrees",
		handler: async (_args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			let active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			if (!active || !TERMINAL_AGENTIC_STATUSES.has(active.status)) {
				return note(
					ctx,
					"Cleanup requires a terminal Agentic Delivery Run.",
					"error",
				);
			}
			if (blockDisabledAgenticMutation(ctx, active)) return;
			let serverWorkspaces: Array<Record<string, unknown>> = [];
			try {
				const status = await conn.getAgenticDeliveryStatus(
					active.piSessionId,
					active.runId,
				);
				if (
					status.reauthorization_required ||
					!TERMINAL_AGENTIC_STATUSES.has(status.status)
				) {
					return note(
						ctx,
						status.reauthorization_required
							? "Authorize the replacement key with /tako-reconnect before cleanup."
							: "Server reconciliation says this Run is not terminal; cleanup was not attempted.",
						"warning",
					);
				}
				serverWorkspaces = status.cleanup_workspaces ?? [];
				active = {
					...active,
					serverSessionId: status.session_id,
					status: status.status,
					executorPhase: status.executor_phase,
					versionNumber: status.version,
					updatedAt: new Date().toISOString(),
				};
				saveActiveAgenticRun(active);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				return note(
					ctx,
					`Cleanup reconciliation failed: ${errMsg(error)} No worktree was removed.`,
					"error",
				);
			}
			const managedRoot = join(
				homedir(),
				".takonaut",
				"workspaces",
				safePathSegment(c.orgId),
				safePathSegment(active.projectId),
				safePathSegment(active.runId),
			);
			for (const worktree of active.worktrees) {
				if (worktree.lifecycle === "cleaned") continue;
				try {
					const serverWorkspace = serverWorkspaces.find(
						(item) => item.workspace_key === worktree.workspaceKey,
					);
					if (
						!serverWorkspace ||
						serverWorkspace.repository_fingerprint !==
							worktree.repositoryFingerprint ||
						serverWorkspace.branch_name !== worktree.branchName ||
						serverWorkspace.relative_worktree_path !==
							worktree.relativeWorktreePath
					) {
						throw new Error(
							"Local Workspace state does not match server cleanup metadata",
						);
					}
					const local = await cleanupAgenticWorktree({
						run: runner,
						managedRoot,
						repositoryRoot: worktree.repoRoot,
						workspace: worktree,
					});
					const result = await conn.recordAgenticDeliveryCleanup({
						runId: active.runId,
						sessionId: active.serverSessionId,
						workspaceKey: local.workspaceKey,
						repositoryFingerprint: local.repositoryFingerprint,
						branchName: local.branchName,
						relativeWorktreePath: local.relativeWorktreePath,
						finalHeadSha: local.finalHeadSha,
						clean: local.clean,
						removed: local.removed,
						retainedBranch: local.retainedBranch,
						status: local.status,
						errorCode: local.errorCode,
						expectedVersion: active.versionNumber,
						idempotencyKey: `cleanup:${active.runId}:${local.workspaceKey}:${active.versionNumber}:${local.status}`,
					});
					active = {
						...active,
						versionNumber: result.version,
						worktrees: active.worktrees.map((item) =>
							item.workspaceKey === local.workspaceKey
								? {
										...item,
										lifecycle:
											local.status === "completed" ? "cleaned" : "cleanup_hold",
									}
								: item,
						),
						updatedAt: new Date().toISOString(),
					};
					saveActiveAgenticRun(active);
					if (local.status !== "completed") {
						return note(
							ctx,
							`Cleanup refused for ${local.workspaceKey}: ${local.errorCode ?? "safety check failed"}. The worktree and branch were retained.`,
							"warning",
						);
					}
				} catch (error) {
					if (observeAgenticFeatureDisable(ctx, active, error)) return;
					return note(
						ctx,
						`Cleanup failed for ${worktree.workspaceKey}: ${errMsg(error)} The branch and remaining local state were preserved.`,
						"error",
					);
				}
			}
			clearActiveAgenticRun(
				active.runId,
				undefined,
				c.orgId,
				active.piSessionId,
			);
			note(
				ctx,
				`${active.taskKey} managed worktrees cleaned. Branches were retained.`,
			);
		},
	});

	pi.registerCommand("tako-step", {
		description:
			"Update one Agentic Delivery Step: /tako-step STEP ATTEMPT running|failed|completed [summary]",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			if (!active)
				return note(
					ctx,
					"No Agentic Delivery Run is active in this Pi session.",
					"error",
				);
			const [stepInstanceKey, attemptText, status, ...summaryParts] = args
				.trim()
				.split(/\s+/);
			const attemptNumber = Number(attemptText);
			if (
				!stepInstanceKey ||
				!Number.isSafeInteger(attemptNumber) ||
				attemptNumber < 1 ||
				!(["running", "failed", "completed"] as string[]).includes(status)
			) {
				return note(
					ctx,
					"Usage: /tako-step STEP ATTEMPT running|failed|completed [summary]",
					"error",
				);
			}
			try {
				const result = await conn.updateAgenticDeliveryStep({
					runId: active.runId,
					sessionId: active.serverSessionId,
					stepInstanceKey,
					attemptNumber,
					expectedVersion: active.versionNumber,
					idempotencyKey: `step:${active.runId}:${randomUUID()}`,
					status: status as "running" | "failed" | "completed",
					safeMetadata: summaryParts.length
						? { summary: summaryParts.join(" ").slice(0, 2_000) }
						: {},
				});
				saveActiveAgenticRun({
					...active,
					status: result.run_status,
					executorPhase: result.executor_phase,
					versionNumber: result.run_version,
					updatedAt: new Date().toISOString(),
				});
				note(
					ctx,
					`${stepInstanceKey} attempt ${attemptNumber}: ${result.status}.`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Step update failed: ${errMsg(error)} Local state was preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-answer", {
		description:
			"Answer a bounded Agentic prompt: /tako-answer STEP ATTEMPT ANSWER",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			if (!active)
				return note(
					ctx,
					"No Agentic Delivery Run is active in this Pi session.",
					"error",
				);
			const [stepInstanceKey, attemptText, ...answerParts] = args
				.trim()
				.split(/\s+/);
			const attemptNumber = Number(attemptText);
			const answer = answerParts.join(" ").trim();
			if (!stepInstanceKey || !Number.isSafeInteger(attemptNumber) || !answer) {
				return note(ctx, "Usage: /tako-answer STEP ATTEMPT ANSWER", "error");
			}
			try {
				const result = await conn.answerAgenticDeliveryStep({
					runId: active.runId,
					sessionId: active.serverSessionId,
					stepInstanceKey,
					attemptNumber,
					expectedVersion: active.versionNumber,
					idempotencyKey: `answer:${active.runId}:${randomUUID()}`,
					answer: answer.slice(0, 2_000),
				});
				saveActiveAgenticRun({
					...active,
					versionNumber: result.run_version,
					updatedAt: new Date().toISOString(),
				});
				note(
					ctx,
					`Answer recorded for ${stepInstanceKey}; execution did not auto-resume.`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Answer failed: ${errMsg(error)} Local state was preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-retry", {
		description: "Retry only the current failed Step: /tako-retry STEP ATTEMPT",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			const [stepInstanceKey, attemptText] = args.trim().split(/\s+/);
			const attemptNumber = Number(attemptText);
			if (
				!active ||
				!stepInstanceKey ||
				!Number.isSafeInteger(attemptNumber) ||
				attemptNumber < 1
			)
				return note(
					ctx,
					"Usage: /tako-retry STEP ATTEMPT from an active Agentic Run.",
					"error",
				);
			try {
				const result = await conn.retryAgenticDeliveryStep({
					runId: active.runId,
					sessionId: active.serverSessionId,
					stepInstanceKey,
					attemptNumber,
					expectedVersion: active.versionNumber,
					idempotencyKey: `retry:${active.runId}:${randomUUID()}`,
				});
				saveActiveAgenticRun({
					...active,
					status: result.run_status,
					executorPhase: result.executor_phase,
					versionNumber: result.run_version,
					updatedAt: new Date().toISOString(),
				});
				note(
					ctx,
					`Started ${stepInstanceKey} attempt ${result.attempt_number}; upstream Steps were preserved.`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Retry failed: ${errMsg(error)} Local state was preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-route", {
		description:
			"Resolve a graph route from bounded JSON evidence: /tako-route JSON",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			if (!active)
				return note(
					ctx,
					"No Agentic Delivery Run is active in this Pi session.",
					"error",
				);
			try {
				const payload = JSON.parse(args) as Record<string, unknown>;
				const evidenceBindings = payload.evidence_bindings ?? [];
				if (
					typeof payload.step_instance_key !== "string" ||
					!Number.isSafeInteger(payload.attempt_number) ||
					(payload.attempt_number as number) < 1 ||
					typeof payload.facts !== "object" ||
					payload.facts === null ||
					Array.isArray(payload.facts) ||
					typeof payload.context_snapshot_id !== "string" ||
					typeof payload.context_pack_id !== "string" ||
					typeof payload.context_snapshot_hash !== "string" ||
					typeof payload.context_pack_hash !== "string" ||
					!Array.isArray(evidenceBindings) ||
					!evidenceBindings.every((value) => typeof value === "string")
				) {
					throw new Error("invalid route payload");
				}
				const result = await conn.recordAgenticDeliveryGraphRoute({
					runId: active.runId,
					sessionId: active.serverSessionId,
					stepInstanceKey: payload.step_instance_key,
					attemptNumber: payload.attempt_number as number,
					expectedVersion: active.versionNumber,
					idempotencyKey: `route:${active.runId}:${randomUUID()}`,
					facts: payload.facts as Record<string, unknown>,
					contextSnapshotId: payload.context_snapshot_id,
					contextPackId: payload.context_pack_id,
					contextSnapshotHash: payload.context_snapshot_hash,
					contextPackHash: payload.context_pack_hash,
					fallbackEdgeId:
						typeof payload.fallback_edge_id === "string"
							? payload.fallback_edge_id
							: null,
					fallbackRationale:
						typeof payload.fallback_rationale === "string"
							? payload.fallback_rationale
							: null,
					evidenceBindings: evidenceBindings as string[],
				});
				saveActiveAgenticRun({
					...active,
					status: result.run_status,
					executorPhase: result.executor_phase,
					versionNumber: result.run_version,
					updatedAt: new Date().toISOString(),
				});
				note(
					ctx,
					`Graph route ${result.status} for ${payload.step_instance_key}.`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Route failed: ${errMsg(error)} Local state was preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-resolve-gate", {
		description:
			"Resolve a human gate explicitly: /tako-resolve-gate STEP EDGE RATIONALE",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			const [stepInstanceKey, selectedEdgeId, ...rationaleParts] = args
				.trim()
				.split(/\s+/);
			const rationale = rationaleParts.join(" ").trim();
			if (!active || !stepInstanceKey || !selectedEdgeId || !rationale)
				return note(
					ctx,
					"Usage: /tako-resolve-gate STEP EDGE RATIONALE",
					"error",
				);
			try {
				const result = await conn.resolveAgenticDeliveryHumanGate({
					runId: active.runId,
					sessionId: active.serverSessionId,
					stepInstanceKey,
					selectedEdgeId,
					rationale: rationale.slice(0, 2_000),
					expectedVersion: active.versionNumber,
					idempotencyKey: `human-gate:${active.runId}:${randomUUID()}`,
				});
				saveActiveAgenticRun({
					...active,
					status: result.run_status,
					executorPhase: result.executor_phase,
					versionNumber: result.run_version,
					updatedAt: new Date().toISOString(),
				});
				note(ctx, `Resolved human gate ${stepInstanceKey}.`);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Human gate resolution failed: ${errMsg(error)} Local state was preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-context", {
		description:
			"Collect and record governed Pi-local Context: /tako-context NODE",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			const stepInstanceKey = args.trim();
			if (!active || !stepInstanceKey || /\s/.test(stepInstanceKey)) {
				return note(ctx, "Usage: /tako-context NODE", "error");
			}
			try {
				const local = await collectGovernedContext(
					conn,
					active,
					stepInstanceKey,
				);
				const result = await conn.recordAgenticDeliveryContext({
					runId: active.runId,
					sessionId: active.serverSessionId,
					stepInstanceKey,
					expectedVersion: active.versionNumber,
					idempotencyKey: `context:${active.runId}:${randomUUID()}`,
					observations: local.observations,
				});
				saveActiveAgenticRun({
					...active,
					versionNumber: result.run_version,
					updatedAt: new Date().toISOString(),
				});
				if (local.documents.length) {
					pi.sendUserMessage(formatLocalContextForInjection(local), {
						deliverAs: "followUp",
					});
				}
				note(
					ctx,
					result.status === "requires_confirmation"
						? `Recorded Context Snapshot ${result.id}. Confirm with /tako-confirm-context ${result.id} ${result.observation_hash}.`
						: `Recorded Context Snapshot ${result.id}.`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(ctx, `Context failed: ${errMsg(error)}`, "error");
			}
		},
	});

	pi.registerCommand("tako-confirm-context", {
		description:
			"Confirm one exact Context Snapshot: /tako-confirm-context SNAPSHOT HASH",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			const [snapshotId, observationHash] = args.trim().split(/\s+/);
			if (
				!active ||
				!snapshotId ||
				!/^[0-9a-f]{64}$/.test(observationHash ?? "")
			) {
				return note(ctx, "Usage: /tako-confirm-context SNAPSHOT HASH", "error");
			}
			try {
				const result = await conn.confirmAgenticDeliveryContext({
					runId: active.runId,
					sessionId: active.serverSessionId,
					snapshotId,
					observationHash,
					expectedVersion: active.versionNumber,
					idempotencyKey: `context-confirm:${active.runId}:${randomUUID()}`,
				});
				saveActiveAgenticRun({
					...active,
					versionNumber: result.run_version,
					updatedAt: new Date().toISOString(),
				});
				note(
					ctx,
					`Context ${result.status}. Run /tako-resume to re-collect the pinned documents and execute the server-owned resume command.`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(ctx, `Context confirmation failed: ${errMsg(error)}`, "error");
			}
		},
	});

	pi.registerCommand("tako-plan", {
		description: "Submit a snapshot-bound plan: /tako-plan SNAPSHOT MARKDOWN",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			const separator = args.trim().indexOf(" ");
			const snapshotId = separator > 0 ? args.trim().slice(0, separator) : "";
			const markdown =
				separator > 0
					? args
							.trim()
							.slice(separator + 1)
							.trim()
					: "";
			if (!active || !snapshotId || !markdown) {
				return note(ctx, "Usage: /tako-plan SNAPSHOT MARKDOWN", "error");
			}
			try {
				const result = await conn.proposeAgenticDeliveryPlan({
					runId: active.runId,
					sessionId: active.serverSessionId,
					contextSnapshotId: snapshotId,
					expectedVersion: active.versionNumber,
					idempotencyKey: `plan:${active.runId}:${randomUUID()}`,
					title: `${active.taskKey} implementation plan`,
					markdown,
				});
				saveActiveAgenticRun({
					...active,
					status: result.run_status,
					executorPhase: result.executor_phase,
					versionNumber: result.version,
					updatedAt: new Date().toISOString(),
				});
				const reviewUrl = new URL(result.review_url, c.serverUrl).toString();
				const runUrl = new URL(result.run_url, c.serverUrl).toString();
				const artifactUrl = new URL(
					result.artifact_url,
					c.serverUrl,
				).toString();
				const configurationUrl = new URL(
					result.configuration_url,
					c.serverUrl,
				).toString();
				note(
					ctx,
					`Plan submitted to the Review queue: ${reviewUrl}\nRun: ${runUrl}\nArtifact: ${artifactUrl}\nPinned configuration: ${configurationUrl}\nResume only after a decision with ${result.next_command}.`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Plan proposal failed: ${errMsg(error)} Local state was preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-resume-review", {
		description:
			"Resume after a Review queue decision: /tako-resume-review REQUEST",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
			const approvalRequestId = args.trim();
			if (!active || !approvalRequestId) {
				return note(ctx, "Usage: /tako-resume-review REQUEST", "error");
			}
			try {
				const result = await conn.resumeAgenticDeliveryReview({
					runId: active.runId,
					sessionId: active.serverSessionId,
					approvalRequestId,
					expectedVersion: active.versionNumber,
					idempotencyKey: `review-resume:${active.runId}:${randomUUID()}`,
				});
				saveActiveAgenticRun({
					...active,
					status: result.status,
					executorPhase: result.executor_phase,
					versionNumber: result.version,
					updatedAt: new Date().toISOString(),
				});
				note(
					ctx,
					`Review decision revalidated. ${active.taskKey} resumed in ${result.executor_phase}.`,
				);
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, active, error)) return;
				note(
					ctx,
					`Review resume failed: ${errMsg(error)} Local state was preserved.`,
					"error",
				);
			}
		},
	});

	pi.registerCommand("tako-resume", {
		description: "Explicitly resume an Agentic Context confirmation",
		handler: async (args, ctx) => {
			const c = currentConfig(ctx);
			const conn = ensure(ctx);
			if (!c || !conn) return;
			const agentic = loadActiveAgenticRun(
				undefined,
				c.orgId,
				piSessionId(ctx),
			);
			if (!agentic) {
				return note(
					ctx,
					"No Agentic Delivery Run is active in this Pi session.",
					"error",
				);
			}
			try {
				let resumeArgs = args.trim();
				let expectedVersion = agentic.versionNumber;
				if (!resumeArgs) {
					const status = await conn.getAgenticDeliveryStatus(
						piSessionId(ctx),
						agentic.runId,
					);
					if (typeof status.version === "number")
						expectedVersion = status.version;
					const durableCommand = String(status.next_command ?? "");
					if (!durableCommand.startsWith("/tako-resume ")) {
						throw new Error(
							"The durable Run does not currently own an executable Context resume command",
						);
					}
					resumeArgs = durableCommand.slice("/tako-resume ".length);
				}
				const parts = resumeArgs.split(/\s+/);
				const [snapshotId, observationHash, stepInstanceKey] = parts;
				if (
					parts.length !== 3 ||
					!snapshotId ||
					!/^[0-9a-f]{64}$/.test(observationHash ?? "") ||
					!stepInstanceKey
				) {
					throw new Error(
						"Usage: /tako-resume (automatic) or /tako-resume SNAPSHOT HASH NODE",
					);
				}
				const local = await collectGovernedContext(
					conn,
					agentic,
					stepInstanceKey,
				);
				const result = await conn.resumeAgenticDeliveryContext({
					runId: agentic.runId,
					sessionId: agentic.serverSessionId,
					snapshotId,
					observationHash,
					expectedVersion,
					idempotencyKey: `context-resume:${agentic.runId}:${randomUUID()}`,
					observations: local.observations,
				});
				if (local.documents.length) {
					pi.sendUserMessage(formatLocalContextForInjection(local), {
						deliverAs: "followUp",
					});
				}
				if ("context_pack_id" in result) {
					saveActiveAgenticRun({
						...agentic,
						versionNumber: result.run_version,
						updatedAt: new Date().toISOString(),
					});
					note(
						ctx,
						`Context drift created Snapshot ${result.id}; confirm with /tako-confirm-context ${result.id} ${result.observation_hash} before resuming.`,
						"warning",
					);
				} else {
					saveActiveAgenticRun({
						...agentic,
						status: result.run_status,
						executorPhase: result.executor_phase,
						versionNumber: result.run_version,
						updatedAt: new Date().toISOString(),
					});
					note(
						ctx,
						`Resumed ${agentic.taskKey} after exact Context revalidation.`,
					);
				}
			} catch (error) {
				if (observeAgenticFeatureDisable(ctx, agentic, error)) return;
				note(
					ctx,
					`Agentic resume failed: ${errMsg(error)} Local state was preserved.`,
					"error",
				);
			}
		},
	});

	pi.on(
		"tool_call",
		(
			event: ToolCallEvent,
			ctx: ExtensionContext,
		): ToolCallEventResult | void => {
			const c = cfg ?? (cfg = loadConfig());
			if (!c) return;
			const sessionId = piSessionId(ctx);
			const active = loadActiveAgenticRun(undefined, c.orgId, sessionId);
			if (!active) return;
			if (
				active.featureDisabled ||
				active?.reauthorizationRequired ||
				active?.status === "cancellation_requested" ||
				(active && TERMINAL_AGENTIC_STATUSES.has(active.status))
			) {
				const reason = active.featureDisabled
					? "Agentic Delivery is disabled; execution tool calls are blocked until /tako-status confirms re-enable."
					: active.reauthorizationRequired
						? "This replacement key is not authorized for the retained session; tool calls are blocked until /tako-reconnect."
						: active.status === "cancellation_requested"
							? "Cancellation was observed; execution tool calls are blocked until /tako-cancel-ack."
							: "This Agentic Delivery Run is terminal; execution tool calls are blocked until /tako-cleanup.";
				note(ctx, reason, "warning");
				return { block: true, reason };
			}
			if (active) {
				const now = new Date().toISOString();
				saveActiveAgenticRun({
					...active,
					lastActivityAt: now,
					updatedAt: now,
				});
			}
			const projectSync = active
				? loadProjectAgentSync(undefined, c.orgId, active.projectId)
				: null;
			const verifiedRoots = active?.worktrees
				.filter((worktree) => worktree.lifecycle === "verified")
				.map((worktree) => worktree.worktreeRoot);
			const decision = evaluateToolCall(event.toolName, event.input, {
				repoRoot: verifiedRoots?.[0] ?? c.repoRoot,
				repoRoots: verifiedRoots?.length ? verifiedRoots : undefined,
				protectedPaths: projectSync?.capabilityEnvelope.protected_paths,
				protectedBranches: c.protectedBranches,
			});
			if (!decision.allow) {
				note(ctx, decision.reason ?? "Blocked by Takonaut policy.", "warning");
				return { block: true, reason: decision.reason };
			}
		},
	);

	pi.on("session_start", async (_event, ctx) => {
		const c = cfg ?? (cfg = loadConfig());
		if (!c) return;
		const panelSettings = loadPanelSettings(c.configPath);
		await refreshPanel(ctx, c, panelSettings);
		startPanelRefresh(ctx, c, panelSettings);
		const active = loadActiveAgenticRun(undefined, c.orgId, piSessionId(ctx));
		if (!active) return;
		note(
			ctx,
			`Recovered ${active.taskKey} (${active.executorPhase}). Run /tako-status.`,
		);
		if (
			!active.featureDisabled &&
			!active.reauthorizationRequired &&
			active.status !== "cancellation_requested" &&
			!TERMINAL_AGENTIC_STATUSES.has(active.status)
		) {
			startTelemetry(ctx, c, active);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopPanel();
		ctx.ui?.setWidget?.("tako-bridge-panel", undefined);
		stopAgentTelemetry();
		if (client) {
			await client.close();
			client = null;
		}
	});
	// An agent turn ending is not proof that code is committed, pushed, tested, or
	// represented by an open PR. Submission is therefore explicit and recoverable.
}

function asExpectedRepo(repo: GitHubRepositoryContext) {
	return {
		owner: repo.owner,
		name: repo.name,
		defaultBranch: repo.defaultBranch,
	};
}

async function verifyRepository(
	runner: CommandRunner,
	cfg: TakonautConfig,
	context: BridgeTaskContext,
) {
	const expected = asExpectedRepo(context.project.githubRepository);
	const existing =
		cfg.projectRepos[projectRepoMappingKey(cfg.orgId, context.project.id)];
	if (existing && existing.projectId !== context.project.id) {
		throw new Error(
			"The saved repository mapping belongs to a different Takonaut Project.",
		);
	}
	const preflight = await runGitHubPreflight(
		runner,
		cfg.repoRoot,
		expected,
		cfg.protectedBranches,
		process.cwd(),
	);
	if (
		existing &&
		(existing.repoRoot !== preflight.repoRoot ||
			existing.remoteFingerprint !== preflight.remoteFingerprint)
	) {
		throw new Error(
			"The current checkout does not match the saved Takonaut Project repository mapping.",
		);
	}
	return preflight;
}

const STARTABILITY_REASON_MESSAGES: Record<string, string> = {
	not_assigned: "This work item is not assigned to you.",
	archived: "This work item is archived.",
	terminal_stage: "This work item is already in a terminal Stage.",
	missing_bridge_run_permission:
		"You do not have Bridge access for this Project.",
	project_agent_setup_required: "Project Agent Setup is not published.",
	project_agent_playbook_required: "Default Playbook is not published.",
	active_run_exists:
		"This work item already has an active Tako Bridge run. Reconcile it first.",
};

function formatStartabilityReasons(reasons: string[]): string {
	return (
		reasons
			.map((reason) => STARTABILITY_REASON_MESSAGES[reason] ?? reason)
			.join(" ") || "This work item cannot be started."
	);
}

function startabilityMessage(context: BridgeTaskContext): string {
	return formatStartabilityReasons(context.startability.reasons);
}

function buildStandupConversation(entries: unknown[]): string {
	const sections: string[] = [];
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") continue;
		const message = (entry as { type?: string; message?: any }).message;
		if ((entry as { type?: string }).type !== "message" || !message) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const parts = Array.isArray(message.content) ? message.content : [];
		const text = parts
			.filter(
				(part: any) => part?.type === "text" && typeof part.text === "string",
			)
			.map((part: any) => part.text)
			.join("\n")
			.trim();
		if (text)
			sections.push(
				`${message.role === "user" ? "User" : "Assistant"}: ${text}`,
			);
		for (const part of parts) {
			if (part?.type === "toolCall" && typeof part.name === "string") {
				sections.push(
					`Tool: ${part.name} ${JSON.stringify(part.arguments ?? {})}`,
				);
			}
		}
	}
	return sections.join("\n\n").slice(-40_000);
}

function buildStandupDraftPrompt(
	projectKey: string,
	conversation: string,
	git: { log: string; status: string; diff: string },
): string {
	return [
		`Draft a concise daily Standup for project ${projectKey}.`,
		"Use only evidence below. Do not invent completed work or blockers.",
		"Return only JSON with string keys yesterday, today, blockers, and other.",
		"Keep each section under 2,000 characters.",
		"",
		"<pi-session>",
		conversation || "No conversation evidence.",
		"</pi-session>",
		"<git-log>",
		git.log,
		"</git-log>",
		"<git-status>",
		git.status,
		"</git-status>",
		"<git-diff-stat>",
		git.diff,
		"</git-diff-stat>",
	].join("\n");
}

function parseStandupSections(value: string): Record<string, string> {
	const match = value.match(/\{[\s\S]*\}/);
	if (!match) throw new Error("expected JSON object");
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(match[0]) as Record<string, unknown>;
	} catch {
		throw new Error("expected valid JSON");
	}
	const keys = ["yesterday", "today", "blockers", "other"];
	if (
		Object.keys(parsed).some((key) => !keys.includes(key)) ||
		keys.some((key) => typeof parsed[key] !== "string")
	) {
		throw new Error("expected yesterday, today, blockers, and other strings");
	}
	return Object.fromEntries(
		keys.map((key) => [key, String(parsed[key]).trim().slice(0, 6_000)]),
	);
}

async function execute(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	options?: { cwd?: string },
): Promise<CommandResult> {
	try {
		return fromPiExecResult(await pi.exec(command, args, options));
	} catch (error: any) {
		return {
			stdout: error?.stdout ?? "",
			stderr: error?.stderr ?? error?.message ?? String(error),
			exitCode: Number.isInteger(error?.exitCode)
				? error.exitCode
				: Number.isInteger(error?.code)
					? error.code
					: 1,
		};
	}
}

function splitCommandLine(value: string): string[] {
	const result: string[] = [];
	const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s]+)/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(value)))
		result.push((match[1] ?? match[2] ?? match[3]).replace(/\\"/g, '"'));
	return result;
}

const SENSITIVE_VALUE_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g,
	/\b(?:authorization:\s*bearer|bearer)\s+[^\s]+/gi,
	/\b(?:--)?(?:password|passwd|secret|token|api[_-]?key)\s*(?:=|\s)\s*["']?[^\s"']{6,}/gi,
	/\b(?:postgres(?:ql)?|mysql):\/\/[^\s:@/]+:[^\s@/]+@[^\s]+/gi,
];

function redactSensitiveValues(value: string): string {
	return SENSITIVE_VALUE_PATTERNS.reduce(
		(redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
		value,
	);
}

function containsSensitiveValue(value: string): boolean {
	return redactSensitiveValues(value) !== value;
}

function boundedSummary(result: CommandResult): string {
	const text = (
		result.stdout ||
		result.stderr ||
		`exit ${result.exitCode}`
	).trim();
	return redactSensitiveValues(text).slice(-2_000);
}

function note(
	ctx: ExtensionContext,
	message: string,
	kind: "info" | "warning" | "error" = "info",
): void {
	if (ctx.ui?.notify) ctx.ui.notify(message, kind);
	else if (kind === "error") console.error(`[takonaut] ${message}`);
	else console.log(`[takonaut] ${message}`);
}

function errMsg(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
