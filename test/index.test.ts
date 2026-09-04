import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

const taskContext = {
	task: {
		id: "task-1",
		key: "PAY-142",
		levelName: "Task",
		title: "Handle expired sessions",
		description: "Reject expired device codes.",
		acceptanceCriteria: ["Return 400", "Create no key"],
		assigneeId: "user-1",
		archived: false,
	},
	project: {
		id: "project-1",
		key: "PAY",
		name: "Payments",
		githubRepository: {
			owner: "cureocity",
			name: "payments",
			defaultBranch: "main",
			remoteFingerprint: "github.com/cureocity/payments",
		},
	},
	deliveryFlow: {
		stageId: "stage-1",
		stageName: "Ready",
		exitGates: [],
	},
	run: null,
	startability: { startable: true, reasons: [] },
};

const mocks = vi.hoisted(() => ({
	calls: [] as string[],
	close: vi.fn(),
	listStartableTasks: vi.fn(),
	createBridgeStandupDraft: vi.fn(),
	getBridgeStandupStatus: vi.fn(),
	panelSettings: {
		visible: true,
		showRun: true,
		showTasks: true,
		showStandup: true,
		taskLimit: 3 as 1 | 3 | 5 | 10,
		refreshSeconds: 30 as 0 | 15 | 30 | 60,
		standupProjectKey: undefined as string | undefined,
	},
	savePanelSettings: vi.fn(),
	getBridgeTaskContext: vi.fn(),
	startAgenticDelivery: vi.fn(),
	activateAgenticDelivery: vi.fn(),
	getAgenticDeliveryStatus: vi.fn(),
	reauthorizeAgenticDeliverySession: vi.fn(),
	acknowledgeAgenticDeliveryCancellation: vi.fn(),
	recordAgenticDeliveryCleanup: vi.fn(),
	uploadAgenticDeliveryDiagnostic: vi.fn(),
	readAndPrepareDiagnostic: vi.fn(),
	updateAgenticDeliveryStep: vi.fn(),
	answerAgenticDeliveryStep: vi.fn(),
	retryAgenticDeliveryStep: vi.fn(),
	recordAgenticDeliveryGraphRoute: vi.fn(),
	resolveAgenticDeliveryHumanGate: vi.fn(),
	getAgenticDeliveryContextContract: vi.fn(),
	recordAgenticDeliveryContext: vi.fn(),
	confirmAgenticDeliveryContext: vi.fn(),
	resumeAgenticDeliveryContext: vi.fn(),
	proposeAgenticDeliveryPlan: vi.fn(),
	resumeAgenticDeliveryReview: vi.fn(),
	proposeAgenticDeliveryCompletion: vi.fn(),
	finalizeAgenticDeliveryCompletion: vi.fn(),
	reportAgentTelemetry: vi.fn(),
	runGitHubPreflight: vi.fn(),
	collectAgenticWorkspaceCompletionEvidence: vi.fn(),
	collectLocalContext: vi.fn(),
	saveProjectRepoMapping: vi.fn(),
	storedAgenticRun: null as any,
	storedProjectSync: null as any,
	verifyAgenticManifest: vi.fn(),
	capabilityExpansionRequired: vi.fn(() => true),
	provisionAgenticWorktrees: vi.fn(),
	cleanupAgenticWorktree: vi.fn(),
	verifyAgenticRepositoryRoot: vi.fn(),
	saveProjectAgentSync: vi.fn((state: any) => {
		mocks.storedProjectSync = state;
	}),
	loadProjectAgentSync: vi.fn(() => mocks.storedProjectSync),
	saveActiveAgenticRun: vi.fn((run: any) => {
		mocks.storedAgenticRun = run;
	}),
	loadActiveAgenticRun: vi.fn(() => mocks.storedAgenticRun),
	clearActiveAgenticRun: vi.fn(() => {
		mocks.storedAgenticRun = null;
	}),
	getOrCreatePiClientId: vi.fn(() => "client-1"),
	stopTelemetry: vi.fn(),
	startAgentTelemetryReporter: vi.fn((_options: any) => mocks.stopTelemetry),
}));

vi.mock("../src/config", () => ({
	loadConfig: () => ({
		serverUrl: "https://takonaut.test/mcp/",
		apiKey: "device-secret",
		orgId: "org-123",
		repoRoot: "/work/repo",
		protectedBranches: ["main"],
		projectRepos: {},
		credentialSource: "secure file",
		configPath: "/home/dev/.takonaut/bridge.json",
		credentialPath: "/home/dev/.takonaut/credentials.json",
	}),
	saveConfig: vi.fn(),
	loadPanelSettings: () => mocks.panelSettings,
	savePanelSettings: mocks.savePanelSettings,
	projectRepoMappingKey: (orgId: string, projectId: string) =>
		`${orgId}:${projectId}`,
	saveProjectRepoMapping: mocks.saveProjectRepoMapping,
}));

vi.mock("../src/client", () => ({
	TakonautClient: class {
		close = mocks.close;
		listStartableTasks = mocks.listStartableTasks;
		createBridgeStandupDraft = mocks.createBridgeStandupDraft;
		getBridgeStandupStatus = mocks.getBridgeStandupStatus;
		getBridgeTaskContext = mocks.getBridgeTaskContext;
		startAgenticDelivery = mocks.startAgenticDelivery;
		activateAgenticDelivery = mocks.activateAgenticDelivery;
		getAgenticDeliveryStatus = mocks.getAgenticDeliveryStatus;
		reauthorizeAgenticDeliverySession = mocks.reauthorizeAgenticDeliverySession;
		acknowledgeAgenticDeliveryCancellation =
			mocks.acknowledgeAgenticDeliveryCancellation;
		recordAgenticDeliveryCleanup = mocks.recordAgenticDeliveryCleanup;
		uploadAgenticDeliveryDiagnostic = mocks.uploadAgenticDeliveryDiagnostic;
		updateAgenticDeliveryStep = mocks.updateAgenticDeliveryStep;
		answerAgenticDeliveryStep = mocks.answerAgenticDeliveryStep;
		retryAgenticDeliveryStep = mocks.retryAgenticDeliveryStep;
		recordAgenticDeliveryGraphRoute = mocks.recordAgenticDeliveryGraphRoute;
		resolveAgenticDeliveryHumanGate = mocks.resolveAgenticDeliveryHumanGate;
		getAgenticDeliveryContextContract = mocks.getAgenticDeliveryContextContract;
		recordAgenticDeliveryContext = mocks.recordAgenticDeliveryContext;
		confirmAgenticDeliveryContext = mocks.confirmAgenticDeliveryContext;
		resumeAgenticDeliveryContext = mocks.resumeAgenticDeliveryContext;
		proposeAgenticDeliveryPlan = mocks.proposeAgenticDeliveryPlan;
		resumeAgenticDeliveryReview = mocks.resumeAgenticDeliveryReview;
		proposeAgenticDeliveryCompletion = mocks.proposeAgenticDeliveryCompletion;
		finalizeAgenticDeliveryCompletion = mocks.finalizeAgenticDeliveryCompletion;
		reportAgentTelemetry = mocks.reportAgentTelemetry;
	},
}));

vi.mock("../src/context", () => ({
	collectLocalContext: mocks.collectLocalContext,
	formatLocalContextForInjection: (result: any) =>
		`LOCAL CONTEXT\n${result.documents.map((item: any) => item.content).join("\n")}`,
}));

vi.mock("../src/git", () => ({
	runGitHubPreflight: mocks.runGitHubPreflight,
	collectAgenticWorkspaceCompletionEvidence:
		mocks.collectAgenticWorkspaceCompletionEvidence,
	fromPiExecResult: (result: any) => ({
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		exitCode: result.exitCode ?? result.code ?? 0,
	}),
}));

vi.mock("../src/state", () => ({
	saveActiveAgenticRun: mocks.saveActiveAgenticRun,
	loadActiveAgenticRun: mocks.loadActiveAgenticRun,
	clearActiveAgenticRun: mocks.clearActiveAgenticRun,
	getOrCreatePiClientId: mocks.getOrCreatePiClientId,
	loadProjectAgentSync: mocks.loadProjectAgentSync,
	saveProjectAgentSync: mocks.saveProjectAgentSync,
}));

vi.mock("../src/manifest", () => ({
	verifyAgenticManifest: mocks.verifyAgenticManifest,
	capabilityExpansionRequired: mocks.capabilityExpansionRequired,
	reconcileTrustedSigningKeys: (keys: unknown[]) => keys,
	hashCanonicalJson: () => "b".repeat(64),
}));

vi.mock("../src/workspaces", () => ({
	provisionAgenticWorktrees: mocks.provisionAgenticWorktrees,
	cleanupAgenticWorktree: mocks.cleanupAgenticWorktree,
	verifyAgenticRepositoryRoot: mocks.verifyAgenticRepositoryRoot,
}));

vi.mock("../src/diagnostics", () => ({
	readAndPrepareDiagnostic: mocks.readAndPrepareDiagnostic,
}));

vi.mock("../src/telemetry", () => ({
	startAgentTelemetryReporter: mocks.startAgentTelemetryReporter,
	isFeatureDisabledError: (error: unknown) =>
		String(error).includes("feature_disabled:agent_profiles_v2"),
}));

import takonautExtension from "../src/index";

type Handler = (args: any, ctx: any) => Promise<void> | void;

function commandContext(notify = vi.fn()) {
	return {
		hasUI: true,
		ui: {
			notify,
			setWidget: vi.fn(),
			select: vi.fn(async (): Promise<string | undefined> => undefined),
			confirm: vi.fn(async () => true),
			editor: vi.fn(
				async (_title: string, value: string): Promise<string | undefined> => value,
			),
			input: vi.fn(
				async (
					_title: string,
					_placeholder?: string,
				): Promise<string | undefined> => undefined,
			),
		},
		sessionManager: { getSessionId: () => "pi-session-1" },
		reload: vi.fn(async () => undefined),
	};
}

describe("Takonaut Pi Agentic Delivery lifecycle", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.calls.length = 0;
		mocks.storedAgenticRun = null;
		mocks.storedProjectSync = null;
		mocks.panelSettings = {
			visible: true,
			showRun: true,
			showTasks: true,
			showStandup: true,
			taskLimit: 3,
			refreshSeconds: 30,
			standupProjectKey: undefined,
		};
		mocks.listStartableTasks.mockResolvedValue({ tasks: [] });
		mocks.getBridgeStandupStatus.mockResolvedValue({
			project_key: "PAY",
			status: "pending",
			submitted_at: null,
		});
		mocks.createBridgeStandupDraft.mockResolvedValue({
			draft_url: "/projects/PAY/standup?bridge_draft=token-1",
			expires_at: "2026-09-03T18:00:00+00:00",
		});
		mocks.getBridgeTaskContext.mockImplementation(async () => {
			mocks.calls.push("context");
			return taskContext;
		});
		mocks.verifyAgenticRepositoryRoot.mockImplementation(
			async (_run, root) => root,
		);
		mocks.runGitHubPreflight.mockImplementation(async () => {
			mocks.calls.push("preflight");
			return {
				repoRoot: "/work/repo",
				remoteFingerprint: "github.com/cureocity/payments",
				branch: "pay-142-expired",
				defaultBranch: "main",
				baseSha: "b".repeat(40),
			};
		});
		mocks.startAgenticDelivery.mockImplementation(async () => {
			mocks.calls.push("agentic-start");
			return {
				run_id: "run-1",
				session_id: "server-session-1",
				intent_id: "intent-1",
				task_id: "task-1",
				task_key: "PAY-142",
				project_id: "project-1",
				status: "provisioning",
				executor_phase: "provisioning",
				version: 1,
				telemetry_sequence: 7,
				created: true,
				manifest: { key_id: "key-1", payload: { revision_id: "rev-1" } },
				manifest_revision: 1,
				manifest_hash: "a".repeat(64),
				capability_envelope: {
					workspace_scopes: [],
					allowed_tools: [],
					allowed_model_policies: [],
					executable_step_types: [],
					protected_paths: [],
				},
				workspaces: [
					{
						workspace_key: "api",
						github_repo_id: "repo-1",
						repository_fingerprint: "github:123:cureocity/payments",
						configured_base_ref: "main",
						override_base_ref: null,
						override_reason: null,
						resolved_base_sha: "a".repeat(40),
						branch_name: "tako/pay-142-12345678",
					},
				],
				signing_keys: [
					{
						key_id: "key-1",
						algorithm: "Ed25519",
						public_key_b64: "c".repeat(44),
						status: "active",
						valid_from: "2026-01-01T00:00:00Z",
						valid_until: null,
					},
				],
				next_command: "/tako-status PAY-142",
			};
		});
		mocks.verifyAgenticManifest.mockImplementation(() => {
			mocks.calls.push("verify-manifest");
			return {
				revision: 1,
				contentHash: "a".repeat(64),
				envelopeHash: "b".repeat(64),
				keyId: "key-1",
				manifest: {},
			};
		});
		mocks.provisionAgenticWorktrees.mockImplementation(async () => {
			mocks.calls.push("provision");
			return [
				{
					workspaceKey: "api",
					repositoryFingerprint: "github:123:cureocity/payments",
					configuredBaseRef: "main",
					overrideBaseRef: null,
					repoRoot: "/work/repo",
					worktreeRoot: "/managed/api",
					relativeWorktreePath: "project-1/run-1/api",
					branchName: "tako/pay-142-12345678",
					baseSha: "a".repeat(40),
					initialHeadSha: "a".repeat(40),
					effectiveConfigHash: "b".repeat(64),
					lifecycle: "verified",
				},
			];
		});
		mocks.activateAgenticDelivery.mockImplementation(async () => {
			mocks.calls.push("activate");
			return {
				run_id: "run-1",
				status: "active",
				executor_phase: "gathering_context",
				version: 2,
				activated: true,
				blocker_code: null,
				blocker: null,
				unmet_exit_gates: [],
				next_command: "/tako-status PAY-142",
			};
		});
		mocks.updateAgenticDeliveryStep.mockResolvedValue({
			run_status: "active",
			executor_phase: "edit",
			run_version: 3,
			status: "completed",
			attempt_number: 1,
		});
		mocks.retryAgenticDeliveryStep.mockResolvedValue({
			run_status: "active",
			executor_phase: "inspect",
			run_version: 4,
			status: "running",
			attempt_number: 2,
		});
		mocks.recordAgenticDeliveryGraphRoute.mockResolvedValue({
			run_status: "active",
			executor_phase: "test",
			run_version: 11,
			status: "resolved",
			attempt_number: 1,
		});
		mocks.resolveAgenticDeliveryHumanGate.mockResolvedValue({
			run_status: "active",
			executor_phase: "edit",
			run_version: 12,
			status: "human_gate",
			attempt_number: 1,
		});
		mocks.getAgenticDeliveryContextContract.mockResolvedValue({
			run_id: "run-1",
			step_instance_key: "inspect",
			byte_budget: 4096,
			sources: [],
		});
		mocks.collectLocalContext.mockResolvedValue({
			observations: [],
			documents: [{ content: "local guide" }],
			totalBytes: 11,
		});
		mocks.recordAgenticDeliveryContext.mockResolvedValue({
			id: "snapshot-1",
			status: "requires_confirmation",
			observation_hash: "a".repeat(64),
			run_version: 13,
		});
		mocks.confirmAgenticDeliveryContext.mockResolvedValue({
			status: "confirmed",
			run_version: 5,
		});
		mocks.resumeAgenticDeliveryContext.mockResolvedValue({
			run_status: "active",
			executor_phase: "inspect",
			run_version: 6,
		});
		mocks.proposeAgenticDeliveryPlan.mockResolvedValue({
			approval_request_id: "review-1",
			artifact_id: "artifact-1",
			status: "pending",
			run_status: "waiting",
			executor_phase: "awaiting_plan_review",
			version: 7,
			evidence_hash: "a".repeat(64),
			review_url: "/inbox?agentic_review=review-1&run_id=run-1",
			run_url: "/agent-monitor/run-1",
			artifact_url: "/agent-monitor/run-1/artifacts/artifact-1",
			configuration_url: "/agent-monitor/run-1?configuration=setup-1",
			next_command: "/tako-resume-review review-1",
		});
		mocks.resumeAgenticDeliveryReview.mockResolvedValue({
			run_id: "run-1",
			status: "active",
			executor_phase: "executing_approved_plan",
			version: 8,
			next_action: "Continue",
			next_command: "/tako-status",
		});
		mocks.collectAgenticWorkspaceCompletionEvidence.mockResolvedValue({
			workspace_key: "api",
			repository_fingerprint: "github:123:cureocity/payments",
			branch_name: "tako/pay-142-api",
			head_sha: "f".repeat(40),
			clean: true,
			post_base_commit: true,
			pr_number: 42,
			tests: [],
		});
		mocks.proposeAgenticDeliveryCompletion.mockResolvedValue({
			created: true,
			run_id: "run-1",
			status: "waiting",
			executor_phase: "awaiting_completion_review",
			version: 9,
			blocker_code: null,
			unmet_exit_gates: [],
			approval_request_id: "review-2",
			artifact_id: "artifact-2",
			evidence_hash: "b".repeat(64),
			review_url: "/inbox?agentic_review=review-2&run_id=run-1",
			run_url: "/agent-monitor/run-1",
			artifact_url: "/agent-monitor/run-1/artifacts/artifact-2",
			next_command: null,
		});
		mocks.finalizeAgenticDeliveryCompletion.mockResolvedValue({
			finalized: true,
			run_id: "run-1",
			status: "completed",
			executor_phase: "completed",
			version: 11,
			approval_request_id: "review-2",
			blocker_code: null,
			unmet_exit_gates: [],
			next_action: "completed",
			next_command: null,
			run_url: "/agent-monitor/run-1",
		});
		mocks.getAgenticDeliveryStatus.mockResolvedValue({
			run_id: "run-1",
			session_id: "server-session-1",
			task_id: "task-1",
			task_key: "PAY-142",
			project_id: "project-1",
			status: "provisioning",
			executor_phase: "provisioning",
			version: 1,
			next_action: "Complete Project Agent Setup and Workspace verification",
			next_command: "/tako-status PAY-142",
			reconciled: true,
			lifecycle_mutated: false,
		});
		mocks.reportAgentTelemetry.mockResolvedValue({
			accepted: true,
			sequence: 1,
		});
		mocks.readAndPrepareDiagnostic.mockReturnValue({
			content: "redacted summary",
			redactionCount: 1,
			byteSize: 16,
		});
		mocks.uploadAgenticDeliveryDiagnostic.mockResolvedValue({
			artifact_id: "diagnostic-1",
			version: 5,
			redaction_count: 0,
			sensitivity: "sensitive",
			scheduled_deletion_at: "2030-01-31T00:00:00Z",
			artifact_url: "/agent-monitor/run-1/artifacts/diagnostic-1",
		});
	});

	function setup() {
		const commands = new Map<string, Handler>();
		const events = new Map<string, Handler>();
		const pi = {
			registerCommand: (name: string, options: { handler: Handler }) =>
				commands.set(name, options.handler),
			on: (name: string, handler: Handler) => events.set(name, handler),
			exec: vi.fn(async (_command: string, _args: string[]) => ({
				stdout: "ok\n",
				stderr: "",
				code: 0,
			})),
			sendUserMessage: vi.fn(),
		};
		takonautExtension(pi as any);
		return { commands, events, pi };
	}

	function renderPanel(ctx: ReturnType<typeof commandContext>, width = 80) {
		const calls = ctx.ui.setWidget.mock.calls.filter(
			([id]) => id === "tako-bridge-panel",
		);
		const factory = calls.at(-1)?.[1];
		expect(typeof factory).toBe("function");
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		return factory({}, theme).render(width) as string[];
	}

	it("does not register commands backed by retired legacy MCP tools", () => {
		const { commands } = setup();

		expect([...commands.keys()]).not.toEqual(
			expect.arrayContaining([
				"tako-test",
				"tako-submit",
				"tako-current",
				"tako-abandon",
			]),
		);
		expect(commands.has("tako-resume")).toBe(true);
	});

	it("shows the selected Project Standup status in the Pi panel", async () => {
		mocks.panelSettings = { ...mocks.panelSettings, standupProjectKey: "PAY" };
		const { events } = setup();
		const ctx = { ...commandContext(), mode: "tui" };

		await events.get("session_start")?.({}, ctx);

		const lines = renderPanel(ctx);
		expect(
			lines.some(
				(line) =>
					line.includes("STANDUP") &&
					line.includes("PAY") &&
					line.includes("Pending"),
			),
		).toBe(true);
		await events.get("session_shutdown")?.({}, ctx);
	});

	it("drafts a Standup from the Pi session and opens the confirmed web handoff", async () => {
		mocks.panelSettings = { ...mocks.panelSettings, standupProjectKey: "PAY" };
		const { commands, pi } = setup();
		const complete = vi.fn(async () => ({
			content: [
				{
					type: "text",
					text: JSON.stringify({
						yesterday: "Fixed device authentication.",
						today: "Finish task visibility.",
						blockers: "None.",
						other: "",
					}),
				},
			],
		}));
		const ctx = {
			...commandContext(),
			mode: "tui",
			model: { provider: "test", id: "model" },
			modelRegistry: { complete },
			sessionManager: {
				getSessionId: () => "pi-session-1",
				getBranch: () => [
					{
						type: "message",
						message: {
							role: "user",
							content: [{ type: "text", text: "Fix device authentication" }],
						},
					},
				],
			},
		};
		ctx.ui.editor = vi.fn(async (_title: string, value: string) => value);

		await commands.get("tako-standup")?.("", ctx);

		expect(complete).toHaveBeenCalledWith(
			ctx.model,
			expect.objectContaining({
				messages: expect.arrayContaining([
					expect.objectContaining({
						content: expect.arrayContaining([
							expect.objectContaining({
								text: expect.stringContaining("Fix device authentication"),
							}),
						]),
					}),
				]),
			}),
			expect.any(Object),
		);
		expect(mocks.createBridgeStandupDraft).toHaveBeenCalledWith({
			projectKey: "PAY",
			sections: {
				yesterday: "Fixed device authentication.",
				today: "Finish task visibility.",
				blockers: "None.",
				other: "",
			},
		});
		const url = "https://takonaut.test/projects/PAY/standup?bridge_draft=token-1";
		const opener =
			process.platform === "darwin"
				? "open"
				: process.platform === "win32"
					? "cmd"
					: "xdg-open";
		const openerArgs =
			process.platform === "win32" ? ["/c", "start", "", url] : [url];
		const headless =
			Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY) ||
			(process.platform === "linux" &&
				!process.env.DISPLAY &&
				!process.env.WAYLAND_DISPLAY);
		if (headless) {
			expect(pi.exec.mock.calls.some(([command]) => command === opener)).toBe(false);
		} else {
			expect(pi.exec).toHaveBeenCalledWith(opener, openerArgs, undefined);
		}
	});

	it("lets the developer hide and persist the Tako panel", async () => {
		const { commands } = setup();
		const ctx = { ...commandContext(), mode: "tui" };
		ctx.ui.select = vi
			.fn()
			.mockResolvedValueOnce("Hide panel")
			.mockResolvedValueOnce("Done");

		await commands.get("tako-panel")?.("", ctx);

		expect(mocks.savePanelSettings).toHaveBeenCalledWith(
			expect.objectContaining({ visible: false }),
			"/home/dev/.takonaut/bridge.json",
		);
		expect(ctx.ui.setWidget).toHaveBeenCalledWith(
			"tako-bridge-panel",
			undefined,
		);
	});

	it("shows a compact assigned-work panel above the Pi editor", async () => {
		mocks.listStartableTasks.mockResolvedValueOnce({
			tasks: [
				{
					task_key: "PAY-142",
					task_title: "Handle expired sessions",
					project_key: "PAY",
					startability: { startable: true, reasons: [] },
				},
				{
					task_key: "PAY-143",
					task_title: "Rotate credentials",
					project_key: "PAY",
					startability: {
						startable: false,
						reasons: ["project_agent_playbook_required"],
					},
				},
			],
		});
		const { events } = setup();
		const ctx = { ...commandContext(), mode: "tui" };

		await events.get("session_start")?.({}, ctx);

		const lines = renderPanel(ctx);
		expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
		expect(lines.some((line) => line.includes("RUN"))).toBe(true);
		expect(lines.some((line) => line.includes("WORK"))).toBe(true);
		expect(lines.some((line) => line.includes("STANDUP"))).toBe(true);
		expect(lines).toEqual(
			expect.arrayContaining([
				expect.stringContaining("◆ PAY-142  Handle expired sessions"),
				expect.stringContaining("◇ PAY-143  Rotate credentials"),
			]),
		);
		const narrow = renderPanel(ctx, 38);
		expect(narrow.every((line) => visibleWidth(line) === 38)).toBe(true);
		expect(narrow.join("\n")).not.toContain("Default Playbook");
		await events.get("session_shutdown")?.({}, ctx);
	});

	it("lists every assigned task with readiness and ineligibility reasons", async () => {
		mocks.listStartableTasks.mockResolvedValueOnce({
			tasks: [
				{
					task_key: "PAY-142",
					task_title: "Handle expired sessions",
					project_key: "PAY",
					startability: { startable: true, reasons: [] },
				},
				{
					task_key: "PAY-143",
					task_title: "Rotate credentials",
					project_key: "PAY",
					startability: {
						startable: false,
						reasons: ["project_agent_playbook_required"],
					},
				},
			],
		});
		const { commands } = setup();
		const notify = vi.fn();

		await commands.get("tako-tasks")?.("", commandContext(notify));

		expect(notify).toHaveBeenCalledWith(
			"Assigned work: 2 total · 1 ready · 1 blocked\n" +
				"  READY    PAY-142  Handle expired sessions  (PAY)\n" +
				"  BLOCKED  PAY-143  Rotate credentials  (PAY) — Default Playbook is not published.",
			"info",
		);
	});

	it("prompts for and persists an independently verified Workspace mapping", async () => {
		mocks.runGitHubPreflight.mockResolvedValueOnce({
			repoRoot: "/work/current",
			remoteFingerprint: "github.com/cureocity/other",
			branch: "feature",
			defaultBranch: "main",
			baseSha: "b".repeat(40),
		});
		const { commands } = setup();
		const ctx = commandContext();
		ctx.ui.input.mockResolvedValueOnce("/work/payments");

		await commands.get("tako-start")?.("PAY-142", ctx);

		expect(ctx.ui.input).toHaveBeenCalledWith(
			expect.stringContaining("api"),
			expect.stringContaining("absolute path"),
		);
		expect(mocks.verifyAgenticRepositoryRoot).toHaveBeenCalledWith(
			expect.any(Function),
			"/work/payments",
			"github:123:cureocity/payments",
		);
		expect(mocks.saveProjectRepoMapping).toHaveBeenCalledWith(
			"org-123",
			"project-1",
			expect.objectContaining({ repoRoot: "/work/payments" }),
			"/home/dev/.takonaut/bridge.json",
			"/home/dev/.takonaut/credentials.json",
			"api",
		);
	});

	it("uses repository preflight before one atomic Agentic Delivery start", async () => {
		const { commands, pi } = setup();
		const notify = vi.fn();
		await commands.get("tako-start")?.("PAY-142", commandContext(notify));

		expect(mocks.calls).toEqual([
			"context",
			"preflight",
			"agentic-start",
			"verify-manifest",
			"provision",
			"activate",
		]);
		expect(mocks.startAgenticDelivery).toHaveBeenCalledWith({
			taskKey: "PAY-142",
			clientId: "client-1",
			sessionId: "pi-session-1",
			sessionLabel: expect.stringContaining("PAY-142"),
			extensionVersion: "0.4.9",
			manifestSchemaVersion: 2,
			baseRefOverrides: [],
			idempotencyKey: expect.stringMatching(
				/^start:pi-session-1:[0-9a-f-]{36}$/,
			),
		});
		expect(mocks.saveActiveAgenticRun).toHaveBeenLastCalledWith(
			expect.objectContaining({
				runId: "run-1",
				piSessionId: "pi-session-1",
				serverSessionId: "server-session-1",
				status: "active",
				executorPhase: "gathering_context",
				startNonce: expect.stringMatching(/^[0-9a-f-]{36}$/),
				telemetrySequence: 7,
				acceptedManifest: expect.objectContaining({ revision: 1 }),
				worktrees: [expect.objectContaining({ workspaceKey: "api" })],
			}),
		);
		expect(mocks.startAgentTelemetryReporter).toHaveBeenCalledOnce();
		expect(
			mocks.startAgentTelemetryReporter.mock.calls[0][0].initialSequence,
		).toBe(7);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("activated"),
			"info",
		);
	});

	it("rejects an invalid signed manifest before worktree or activation writes", async () => {
		const { commands } = setup();
		mocks.verifyAgenticManifest.mockImplementationOnce(() => {
			throw new Error("Manifest signature is invalid");
		});
		const notify = vi.fn();

		await commands.get("tako-start")?.("PAY-142", commandContext(notify));

		expect(mocks.provisionAgenticWorktrees).not.toHaveBeenCalled();
		expect(mocks.activateAgenticDelivery).not.toHaveBeenCalled();
		expect(mocks.saveActiveAgenticRun).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("Manifest signature is invalid"),
			"error",
		);
	});

	it("applies a content-only revision without another capability prompt", async () => {
		const { commands } = setup();
		mocks.storedProjectSync = {
			version: 1,
			orgId: "org-123",
			projectId: "project-1",
			acceptedRevision: 1,
			acceptedRevisionId: "rev-1",
			contentHash: "a".repeat(64),
			envelopeHash: "b".repeat(64),
			capabilityEnvelope: {
				workspace_scopes: [],
				allowed_tools: [],
				allowed_model_policies: [],
				executable_step_types: [],
				protected_paths: [],
			},
			trustedSigningKeys: [
				{
					keyId: "key-1",
					publicKeyB64: "c".repeat(44),
					status: "active",
					validFrom: "2026-01-01T00:00:00Z",
					validUntil: null,
				},
			],
			updatedAt: "2026-07-17T00:00:00Z",
		};
		mocks.capabilityExpansionRequired.mockReturnValueOnce(false);
		const ctx = commandContext();

		await commands.get("tako-start")?.("PAY-142", ctx);

		expect(ctx.ui.confirm).not.toHaveBeenCalled();
		expect(mocks.provisionAgenticWorktrees).toHaveBeenCalledOnce();
		expect(mocks.activateAgenticDelivery).toHaveBeenCalledOnce();
	});

	it("routes Step updates and retries through the owning Agentic session", async () => {
		const { commands } = setup();
		mocks.storedAgenticRun = {
			version: 1,
			orgId: "org-123",
			clientId: "client-1",
			piSessionId: "pi-session-1",
			serverSessionId: "server-session-1",
			runId: "run-1",
			taskId: "task-1",
			taskKey: "PAY-142",
			projectId: "project-1",
			projectKey: "PAY",
			repoRoot: "/work/repo",
			status: "active",
			executorPhase: "inspect",
			versionNumber: 2,
			featureDisabled: false,
			startedAt: "2030-01-01T00:00:00.000Z",
			lastActivityAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		const ctx = commandContext();

		await commands.get("tako-step")?.(
			"001-inspect 1 completed bounded-summary",
			ctx,
		);
		expect(mocks.updateAgenticDeliveryStep).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				sessionId: "server-session-1",
				stepInstanceKey: "001-inspect",
				attemptNumber: 1,
				expectedVersion: 2,
				status: "completed",
				safeMetadata: { summary: "bounded-summary" },
			}),
		);

		await commands.get("tako-retry")?.("001-inspect 1", ctx);
		expect(mocks.retryAgenticDeliveryStep).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				sessionId: "server-session-1",
				stepInstanceKey: "001-inspect",
				attemptNumber: 1,
				expectedVersion: 3,
			}),
		);

		await commands.get("tako-plan")?.("snapshot-1 ## Plan", ctx);
		expect(mocks.proposeAgenticDeliveryPlan).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				sessionId: "server-session-1",
				contextSnapshotId: "snapshot-1",
				expectedVersion: 4,
				markdown: "## Plan",
			}),
		);

		await commands.get("tako-resume-review")?.("review-1", ctx);
		expect(mocks.resumeAgenticDeliveryReview).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				sessionId: "server-session-1",
				approvalRequestId: "review-1",
				expectedVersion: 7,
			}),
		);
	});

	it("exposes graph routes and human gates through bounded Pi commands", async () => {
		const { commands } = setup();
		mocks.storedAgenticRun = {
			version: 1,
			orgId: "org-123",
			clientId: "client-1",
			piSessionId: "pi-session-1",
			serverSessionId: "server-session-1",
			runId: "run-1",
			taskId: "task-1",
			taskKey: "PAY-142",
			projectId: "project-1",
			projectKey: "PAY",
			repoRoot: "/work/repo",
			status: "blocked",
			executorPhase: "blocked",
			versionNumber: 10,
			featureDisabled: false,
			startedAt: "2030-01-01T00:00:00.000Z",
			lastActivityAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		const ctx = commandContext();
		const route = {
			step_instance_key: "inspect",
			attempt_number: 1,
			facts: { "step.status": "completed" },
			context_snapshot_id: "snapshot-1",
			context_pack_id: "pack-1",
			context_snapshot_hash: "a".repeat(64),
			context_pack_hash: "b".repeat(64),
			evidence_bindings: [],
		};

		await commands.get("tako-route")?.(JSON.stringify(route), ctx);
		expect(mocks.recordAgenticDeliveryGraphRoute).toHaveBeenCalledWith({
			runId: "run-1",
			sessionId: "server-session-1",
			stepInstanceKey: "inspect",
			attemptNumber: 1,
			expectedVersion: 10,
			idempotencyKey: expect.any(String),
			facts: { "step.status": "completed" },
			contextSnapshotId: "snapshot-1",
			contextPackId: "pack-1",
			contextSnapshotHash: "a".repeat(64),
			contextPackHash: "b".repeat(64),
			fallbackEdgeId: null,
			fallbackRationale: null,
			evidenceBindings: [],
		});

		await commands.get("tako-resolve-gate")?.(
			"approval approved Approved by owner",
			ctx,
		);
		expect(mocks.resolveAgenticDeliveryHumanGate).toHaveBeenCalledWith({
			runId: "run-1",
			sessionId: "server-session-1",
			stepInstanceKey: "approval",
			selectedEdgeId: "approved",
			rationale: "Approved by owner",
			expectedVersion: 11,
			idempotencyKey: expect.any(String),
		});
	});

	it("collects and injects governed local Context without caller JSON, then auto-resumes exact durable confirmation", async () => {
		const { commands, pi } = setup();
		mocks.storedAgenticRun = {
			version: 1,
			orgId: "org-123",
			clientId: "client-1",
			piSessionId: "pi-session-1",
			serverSessionId: "server-session-1",
			runId: "run-1",
			taskId: "task-1",
			taskKey: "PAY-142",
			projectId: "project-1",
			projectKey: "PAY",
			repoRoot: "/work/repo",
			status: "active",
			executorPhase: "inspect",
			versionNumber: 12,
			featureDisabled: false,
			startedAt: "2030-01-01T00:00:00.000Z",
			lastActivityAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		const observations = [
			{
				source_id: "guide",
				provenance: "pi",
				content_hash: "b".repeat(64),
				status: "verified",
				citations: ["GUIDE.md"],
				workspace_observation: { byte_count: 120, head_sha: "c".repeat(40) },
			},
		];
		mocks.collectLocalContext.mockResolvedValue({
			observations,
			documents: [{ content: "local guide" }],
			totalBytes: 11,
		});
		const ctx = commandContext();

		await commands.get("tako-context")?.("inspect", ctx);
		expect(mocks.getAgenticDeliveryContextContract).toHaveBeenCalledWith({
			runId: "run-1",
			sessionId: "server-session-1",
			stepInstanceKey: "inspect",
		});
		expect(mocks.collectLocalContext).toHaveBeenCalledWith(
			expect.objectContaining({ step_instance_key: "inspect" }),
			expect.any(Array),
			expect.any(Function),
		);
		expect(mocks.recordAgenticDeliveryContext).toHaveBeenCalledWith(
			expect.objectContaining({
				stepInstanceKey: "inspect",
				expectedVersion: 12,
				observations,
			}),
		);
		expect(pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("local guide"),
			{ deliverAs: "followUp" },
		);

		mocks.storedAgenticRun.versionNumber = 13;
		mocks.getAgenticDeliveryStatus.mockResolvedValueOnce({
			status: "waiting",
			executor_phase: "inspect",
			version: 13,
			next_command: `/tako-resume snapshot-1 ${"a".repeat(64)} inspect`,
			context_confirmation: {
				snapshot_id: "snapshot-1",
				observation_hash: "a".repeat(64),
				status: "confirmed",
			},
			steps: [
				{ step_instance_key: "inspect", latest_attempt_status: "running" },
			],
		});
		await commands.get("tako-resume")?.("", ctx);
		expect(mocks.resumeAgenticDeliveryContext).toHaveBeenCalledWith(
			expect.objectContaining({
				snapshotId: "snapshot-1",
				observationHash: "a".repeat(64),
				expectedVersion: 13,
				observations,
			}),
		);
	});

	it("observes cancellation, acknowledges it explicitly, and cleans retained worktrees", async () => {
		const { commands } = setup();
		mocks.storedAgenticRun = {
			version: 1,
			orgId: "org-123",
			clientId: "client-1",
			piSessionId: "pi-session-1",
			serverSessionId: "server-session-1",
			runId: "run-1",
			taskId: "task-1",
			taskKey: "PAY-142",
			projectId: "project-1",
			projectKey: "PAY",
			repoRoot: "/work/repo",
			status: "active",
			executorPhase: "executing_approved_plan",
			versionNumber: 4,
			telemetrySequence: 0,
			featureDisabled: false,
			worktrees: [
				{
					workspaceKey: "api",
					repositoryFingerprint: "github:123:cureocity/payments",
					configuredBaseRef: "main",
					overrideBaseRef: null,
					repoRoot: "/work/repo",
					worktreeRoot: "/managed/api",
					relativeWorktreePath: "project-1/run-1/api",
					branchName: "tako/pay-142-api",
					baseSha: "a".repeat(40),
					initialHeadSha: "a".repeat(40),
					effectiveConfigHash: "b".repeat(64),
					lifecycle: "verified",
				},
			],
			completionTests: {},
			startedAt: "2030-01-01T00:00:00.000Z",
			lastActivityAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		await commands.get("tako-diagnostics")?.(
			"api logs/failure.txt",
			commandContext(),
		);
		expect(mocks.readAndPrepareDiagnostic).toHaveBeenCalledWith(
			"/managed/api",
			"logs/failure.txt",
		);
		expect(mocks.uploadAgenticDeliveryDiagnostic).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				sessionId: "server-session-1",
				expectedVersion: 4,
				workspaceKey: "api",
				content: "redacted summary",
				confirmed: true,
			}),
		);
		expect(mocks.storedAgenticRun.versionNumber).toBe(5);

		mocks.getAgenticDeliveryStatus.mockResolvedValue({
			run_id: "run-1",
			session_id: "server-session-1",
			status: "cancellation_requested",
			executor_phase: "cancellation_requested",
			version: 5,
			telemetry_sequence: 0,
			cancellation: { id: "cancel-1", status: "requested" },
			next_action: "Acknowledge local stop",
			next_command: "/tako-cancel-ack",
		});
		await commands.get("tako-status")?.("", commandContext());
		expect(mocks.storedAgenticRun.status).toBe("cancellation_requested");
		expect(mocks.acknowledgeAgenticDeliveryCancellation).not.toHaveBeenCalled();

		mocks.acknowledgeAgenticDeliveryCancellation.mockResolvedValue({
			status: "cancelled",
			executor_phase: "cancelled",
			version: 6,
		});
		await commands.get("tako-cancel-ack")?.("", commandContext());
		expect(mocks.storedAgenticRun).toMatchObject({
			status: "cancelled",
			versionNumber: 6,
		});
		expect(mocks.storedAgenticRun.worktrees[0].lifecycle).toBe("cleanup_hold");

		mocks.getAgenticDeliveryStatus.mockResolvedValue({
			run_id: "run-1",
			session_id: "server-session-1",
			status: "cancelled",
			executor_phase: "cancelled",
			version: 6,
			reauthorization_required: false,
			cleanup_workspaces: [
				{
					workspace_key: "api",
					repository_fingerprint: "github:123:cureocity/payments",
					branch_name: "tako/pay-142-api",
					relative_worktree_path: "project-1/run-1/api",
					lifecycle: "cleanup_hold",
				},
			],
		});
		mocks.cleanupAgenticWorktree.mockResolvedValue({
			workspaceKey: "api",
			repositoryFingerprint: "github:123:cureocity/payments",
			branchName: "tako/pay-142-api",
			relativeWorktreePath: "project-1/run-1/api",
			finalHeadSha: "a".repeat(40),
			clean: true,
			removed: true,
			retainedBranch: true,
			status: "completed",
			errorCode: null,
		});
		mocks.recordAgenticDeliveryCleanup.mockResolvedValue({
			version: 7,
			all_cleaned: true,
		});
		await commands.get("tako-cleanup")?.("", commandContext());
		expect(mocks.recordAgenticDeliveryCleanup).toHaveBeenCalledWith(
			expect.objectContaining({
				idempotencyKey: "cleanup:run-1:api:6:completed",
			}),
		);
		expect(mocks.clearActiveAgenticRun).toHaveBeenCalledWith(
			"run-1",
			undefined,
			"org-123",
			"pi-session-1",
		);
	});

	it("requires explicit reconciliation before a replacement key owns the session", async () => {
		const { commands } = setup();
		mocks.storedAgenticRun = {
			version: 1,
			orgId: "org-123",
			clientId: "client-1",
			piSessionId: "pi-session-1",
			serverSessionId: "server-session-1",
			runId: "run-1",
			taskId: "task-1",
			taskKey: "PAY-142",
			projectId: "project-1",
			projectKey: "PAY",
			repoRoot: "/work/repo",
			status: "active",
			executorPhase: "executing_approved_plan",
			versionNumber: 4,
			telemetrySequence: 0,
			featureDisabled: false,
			worktrees: [],
			completionTests: {},
			startedAt: "2030-01-01T00:00:00.000Z",
			lastActivityAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		mocks.getAgenticDeliveryStatus.mockResolvedValue({
			run_id: "run-1",
			session_id: "server-session-1",
			status: "active",
			executor_phase: "executing_approved_plan",
			version: 4,
			reauthorization_required: true,
			next_command: "/tako-reconnect",
		});
		await commands.get("tako-status")?.("", commandContext());
		expect(mocks.storedAgenticRun.reauthorizationRequired).toBe(true);

		mocks.reauthorizeAgenticDeliverySession.mockResolvedValue({
			status: "active",
			executor_phase: "executing_approved_plan",
			version: 5,
			reauthorization_required: false,
			lifecycle_resumed: false,
		});
		await commands.get("tako-reconnect")?.("", commandContext());
		expect(mocks.reauthorizeAgenticDeliverySession).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				sessionId: "server-session-1",
				expectedVersion: 4,
			}),
		);
		expect(mocks.storedAgenticRun).toMatchObject({
			reauthorizationRequired: false,
			versionNumber: 5,
		});
	});

	it("records Workspace tests, proposes one completion, and explicitly finalizes", async () => {
		const { commands, pi } = setup();
		mocks.storedAgenticRun = {
			version: 1,
			orgId: "org-123",
			clientId: "client-1",
			piSessionId: "pi-session-1",
			serverSessionId: "server-session-1",
			runId: "run-1",
			taskId: "task-1",
			taskKey: "PAY-142",
			projectId: "project-1",
			projectKey: "PAY",
			repoRoot: "/work/repo",
			status: "active",
			executorPhase: "executing_approved_plan",
			versionNumber: 2,
			featureDisabled: false,
			worktrees: [
				{
					workspaceKey: "api",
					repositoryFingerprint: "github:123:cureocity/payments",
					configuredBaseRef: "main",
					overrideBaseRef: null,
					repoRoot: "/work/repo",
					worktreeRoot: "/managed/api",
					relativeWorktreePath: "project-1/run-1/api",
					branchName: "tako/pay-142-api",
					baseSha: "a".repeat(40),
					initialHeadSha: "a".repeat(40),
					effectiveConfigHash: "b".repeat(64),
					lifecycle: "verified",
				},
			],
			completionTests: {},
			startedAt: "2030-01-01T00:00:00.000Z",
			lastActivityAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		pi.exec.mockImplementation(async (command: string, args: string[]) => ({
			stdout:
				command === "git" && args.includes("rev-parse")
					? `${"f".repeat(40)}\n`
					: "1 passed\n",
			stderr: "",
			code: 0,
		}));
		const ctx = commandContext();

		await commands.get("tako-agentic-test")?.(
			"api bun test --token supersecretvalue",
			ctx,
		);
		expect(pi.exec).not.toHaveBeenCalled();
		expect(mocks.storedAgenticRun.completionTests).toEqual({});

		await commands.get("tako-agentic-test")?.(
			"api git -C /managed/api push --force origin feature",
			ctx,
		);
		expect(pi.exec).not.toHaveBeenCalled();
		expect(mocks.storedAgenticRun.completionTests).toEqual({});

		await commands.get("tako-agentic-test")?.("api bun test", ctx);
		expect(mocks.storedAgenticRun.completionTests.api[0]).toMatchObject({
			command: "bun test",
			status: "passed",
			headSha: "f".repeat(40),
		});

		await commands.get("tako-complete")?.("snapshot-1", ctx);
		expect(mocks.proposeAgenticDeliveryCompletion).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				contextSnapshotId: "snapshot-1",
				expectedVersion: 2,
			}),
		);

		await commands.get("tako-finalize")?.("review-2", ctx);
		expect(mocks.finalizeAgenticDeliveryCompletion).toHaveBeenCalledWith(
			expect.objectContaining({
				runId: "run-1",
				approvalRequestId: "review-2",
				expectedVersion: 9,
			}),
		);
		expect(mocks.storedAgenticRun).toMatchObject({
			status: "completed",
			executorPhase: "completed",
			versionNumber: 11,
		});
	});

	it("persists emergency-off when an Agentic mutation observes it first", async () => {
		const { commands, events } = setup();
		mocks.storedAgenticRun = {
			version: 1,
			orgId: "org-123",
			clientId: "client-1",
			piSessionId: "pi-session-1",
			serverSessionId: "server-session-1",
			runId: "run-1",
			taskId: "task-1",
			taskKey: "PAY-142",
			projectId: "project-1",
			projectKey: "PAY",
			repoRoot: "/work/repo",
			status: "active",
			executorPhase: "executing_approved_plan",
			versionNumber: 10,
			telemetrySequence: 0,
			featureDisabled: false,
			worktrees: [],
			completionTests: {},
			startedAt: "2030-01-01T00:00:00.000Z",
			lastActivityAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		await events.get("session_start")?.(
			{ reason: "startup" },
			commandContext(),
		);
		mocks.finalizeAgenticDeliveryCompletion.mockRejectedValue(
			new Error("feature_disabled:agent_profiles_v2"),
		);
		await commands.get("tako-finalize")?.("review-1", commandContext());
		expect(mocks.storedAgenticRun).toMatchObject({
			runId: "run-1",
			featureDisabled: true,
		});
		expect(mocks.stopTelemetry).toHaveBeenCalled();
	});

	it("reconciles /tako-status without claiming a lifecycle mutation", async () => {
		const { commands } = setup();
		mocks.storedAgenticRun = {
			version: 1,
			orgId: "org-123",
			clientId: "client-1",
			piSessionId: "pi-session-1",
			serverSessionId: "server-session-1",
			runId: "run-1",
			taskId: "task-1",
			taskKey: "PAY-142",
			projectId: "project-1",
			projectKey: "PAY",
			repoRoot: "/work/repo",
			status: "provisioning",
			executorPhase: "provisioning",
			versionNumber: 1,
			telemetrySequence: 0,
			featureDisabled: false,
			worktrees: [],
			completionTests: {},
			startedAt: "2030-01-01T00:00:00.000Z",
			lastActivityAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		const notify = vi.fn();
		await commands.get("tako-status")?.("", commandContext(notify));

		expect(mocks.getAgenticDeliveryStatus).toHaveBeenCalledWith(
			"pi-session-1",
			"run-1",
		);
		expect(mocks.saveActiveAgenticRun).toHaveBeenCalledWith(
			expect.objectContaining({
				featureDisabled: false,
				status: "provisioning",
			}),
		);
		expect(notify).toHaveBeenCalledWith(
			expect.stringMatching(/provisioning[\s\S]*\/tako-status PAY-142/),
			"info",
		);
	});

	it.each(["idle", "completed"])(
		"releases the active session state after authoritative %s reconciliation",
		async (status) => {
			const { commands, events } = setup();
			mocks.storedAgenticRun = {
				version: 1,
				orgId: "org-123",
				clientId: "client-1",
				piSessionId: "pi-session-1",
				serverSessionId: "server-session-1",
				runId: "run-1",
				taskId: "task-1",
				taskKey: "PAY-142",
				projectId: "project-1",
				projectKey: "PAY",
				repoRoot: "/work/repo",
				status: "provisioning",
				executorPhase: "provisioning",
				versionNumber: 1,
				startNonce: "11111111-1111-4111-8111-111111111111",
				telemetrySequence: 4,
				featureDisabled: false,
				worktrees: [],
				completionTests: {},
				startedAt: "2030-01-01T00:00:00.000Z",
				lastActivityAt: "2030-01-01T00:00:00.000Z",
				updatedAt: "2030-01-01T00:00:00.000Z",
			};
			await events.get("session_start")?.(
				{ reason: "startup" },
				commandContext(),
			);
			mocks.getAgenticDeliveryStatus.mockResolvedValue(
				status === "idle"
					? { status: "idle", reconciled: true, lifecycle_mutated: false }
					: {
							status: "completed",
							executor_phase: "completed",
							run_id: "run-1",
							session_id: "server-session-1",
							version: 2,
							reconciled: true,
							lifecycle_mutated: false,
						},
			);

			await commands.get("tako-status")?.("", commandContext());

			expect(mocks.stopTelemetry).toHaveBeenCalled();
			if (status === "idle") {
				expect(mocks.clearActiveAgenticRun).toHaveBeenCalledWith(
					"run-1",
					undefined,
					"org-123",
					"pi-session-1",
				);
				expect(mocks.saveActiveAgenticRun).not.toHaveBeenCalled();
			} else {
				expect(mocks.clearActiveAgenticRun).not.toHaveBeenCalled();
				expect(mocks.saveActiveAgenticRun).toHaveBeenCalledWith(
					expect.objectContaining({ status: "completed" }),
				);
			}
		},
	);

	it("blocks execution tool calls after emergency-off or cancellation is observed", () => {
		const { events } = setup();
		mocks.storedAgenticRun = {
			orgId: "org-123",
			piSessionId: "pi-session-1",
			runId: "run-1",
			projectId: "project-1",
			status: "active",
			featureDisabled: true,
			worktrees: [],
		};
		const emergency = events.get("tool_call")?.(
			{ toolName: "bash", input: { command: "echo unsafe" } },
			commandContext(),
		);
		expect(emergency).toMatchObject({ block: true });

		mocks.storedAgenticRun = {
			...mocks.storedAgenticRun,
			featureDisabled: false,
			status: "cancellation_requested",
		};
		const cancellation = events.get("tool_call")?.(
			{ toolName: "write", input: { path: "README.md" } },
			commandContext(),
		);
		expect(cancellation).toMatchObject({ block: true });
	});

	it("preserves local state and stops telemetry after feature disable", async () => {
		const { commands, events } = setup();
		mocks.storedAgenticRun = {
			version: 1,
			orgId: "org-123",
			clientId: "client-1",
			piSessionId: "pi-session-1",
			serverSessionId: "server-session-1",
			runId: "run-1",
			taskId: "task-1",
			taskKey: "PAY-142",
			projectId: "project-1",
			projectKey: "PAY",
			repoRoot: "/work/repo",
			status: "provisioning",
			executorPhase: "provisioning",
			versionNumber: 1,
			featureDisabled: false,
			startedAt: "2030-01-01T00:00:00.000Z",
			lastActivityAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		await events.get("session_start")?.(
			{ reason: "startup" },
			commandContext(),
		);
		mocks.getAgenticDeliveryStatus.mockRejectedValue(
			new Error("feature_disabled:agent_profiles_v2"),
		);
		const notify = vi.fn();
		await commands.get("tako-status")?.("", commandContext(notify));

		expect(mocks.saveActiveAgenticRun).toHaveBeenCalledWith(
			expect.objectContaining({ featureDisabled: true, runId: "run-1" }),
		);
		expect(mocks.clearActiveAgenticRun).not.toHaveBeenCalled();
		expect(mocks.stopTelemetry).toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(
			expect.stringContaining("disabled"),
			"warning",
		);
	});

	it("recovers the current Pi session and cleans telemetry/client on shutdown", async () => {
		const { events } = setup();
		mocks.storedAgenticRun = {
			version: 1,
			orgId: "org-123",
			clientId: "client-1",
			piSessionId: "pi-session-1",
			serverSessionId: "server-session-1",
			runId: "run-1",
			taskId: "task-1",
			taskKey: "PAY-142",
			projectId: "project-1",
			projectKey: "PAY",
			repoRoot: "/work/repo",
			status: "provisioning",
			executorPhase: "provisioning",
			versionNumber: 1,
			startNonce: "11111111-1111-4111-8111-111111111111",
			telemetrySequence: 12,
			featureDisabled: false,
			startedAt: "2030-01-01T00:00:00.000Z",
			lastActivityAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		const ctx = commandContext();
		await events.get("session_start")?.({ reason: "startup" }, ctx);
		expect(mocks.startAgentTelemetryReporter).toHaveBeenCalledOnce();
		const reporterOptions = mocks.startAgentTelemetryReporter.mock.calls[0][0];
		expect(reporterOptions.initialSequence).toBe(12);
		reporterOptions.onSequence(13);
		expect(mocks.saveActiveAgenticRun).toHaveBeenCalledWith(
			expect.objectContaining({ telemetrySequence: 13 }),
		);

		await events.get("session_shutdown")?.({ reason: "quit" }, ctx);
		expect(mocks.stopTelemetry).toHaveBeenCalledOnce();
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("ignores callbacks from an old reporter after a new Run owns the session", async () => {
		const { events } = setup();
		mocks.storedAgenticRun = {
			version: 1,
			orgId: "org-123",
			clientId: "client-1",
			piSessionId: "pi-session-1",
			serverSessionId: "server-session-1",
			runId: "old-run",
			taskId: "task-1",
			taskKey: "PAY-142",
			projectId: "project-1",
			projectKey: "PAY",
			repoRoot: "/work/repo",
			status: "provisioning",
			executorPhase: "provisioning",
			versionNumber: 1,
			startNonce: "11111111-1111-4111-8111-111111111111",
			telemetrySequence: 5,
			featureDisabled: false,
			startedAt: "2030-01-01T00:00:00.000Z",
			lastActivityAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		await events.get("session_start")?.(
			{ reason: "startup" },
			commandContext(),
		);
		const reporterOptions = mocks.startAgentTelemetryReporter.mock.calls[0][0];
		mocks.storedAgenticRun = {
			...mocks.storedAgenticRun,
			runId: "new-run",
			taskId: "task-2",
			taskKey: "PAY-143",
			telemetrySequence: 0,
			featureDisabled: false,
		};
		mocks.saveActiveAgenticRun.mockClear();

		reporterOptions.onSequence(6);
		reporterOptions.onFeatureDisabled(
			new Error("feature_disabled:agent_profiles_v2"),
		);

		expect(mocks.saveActiveAgenticRun).not.toHaveBeenCalled();
		expect(mocks.storedAgenticRun.runId).toBe("new-run");
		expect(mocks.storedAgenticRun.featureDisabled).toBe(false);
	});
});
