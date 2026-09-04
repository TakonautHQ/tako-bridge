// Thin Takonaut MCP client for the Pi extension — wraps the MCP TypeScript SDK and
// Takonaut's Agentic Delivery tools. Exercised at runtime against a live backend; pure
// policy and device-flow logic remain covered in their focused modules.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { TakonautConfig } from "./config";
import type { AgenticWorkspaceCompletionEvidence } from "./git";
import type { CapabilityEnvelope, SignedAgenticManifest } from "./manifest";
import { bridgeServerUrl } from "./server-url.js";

function parseToolJson(result: any): any {
	const text = String(
		result?.content?.find?.((c: any) => c.type === "text")?.text ?? "",
	);
	if (result?.isError === true) {
		throw new Error(text.slice(0, 2_000) || "Takonaut tool request failed.");
	}
	try {
		return JSON.parse(text || "{}");
	} catch {
		throw new Error("Takonaut returned an invalid successful tool response.");
	}
}

export interface StartableTask {
	task_key: string;
	task_title: string;
	project_key: string;
	startability: { startable: boolean; reasons: string[] };
}

export interface GitHubRepositoryContext {
	owner: string;
	name: string;
	defaultBranch: string;
	remoteFingerprint: string;
}

export interface BridgeTaskContext {
	task: {
		id: string;
		key: string;
		levelName: string;
		title: string;
		description: string;
		acceptanceCriteria: string[];
		assigneeId: string | null;
		archived: boolean;
	};
	project: {
		id: string;
		key: string;
		name: string;
		githubRepository: GitHubRepositoryContext;
	};
	deliveryFlow: {
		stageId: string | null;
		stageName: string | null;
		exitGates: Array<{
			id: string;
			name: string;
			gateType: string;
			enforcement: string;
			position: number;
		}>;
	};
	run: {
		id: string;
		status: string;
		ownedByCurrentUser: boolean;
		updatedAt?: string | null;
	} | null;
	startability: { startable: boolean; reasons: string[] };
}

export interface BaseRefOverrideRequest {
	workspaceKey: string;
	ref: string;
	reason: string;
}

export interface StartAgenticDeliveryInput {
	taskKey: string;
	clientId: string;
	sessionId: string;
	sessionLabel: string;
	extensionVersion: string;
	manifestSchemaVersion: number;
	idempotencyKey: string;
	baseRefOverrides?: BaseRefOverrideRequest[];
}

export interface AgenticWorkspacePlan {
	workspace_key: string;
	github_repo_id: string;
	repository_fingerprint: string;
	configured_base_ref: string;
	override_base_ref: string | null;
	override_reason: string | null;
	resolved_base_sha: string;
	branch_name: string;
}

export interface AgenticSigningKeyWire {
	key_id: string;
	algorithm: string;
	public_key_b64: string;
	status: "active" | "next" | "retired" | "revoked";
	valid_from: string;
	valid_until: string | null;
}

export interface StartAgenticDeliveryResult {
	run_id: string;
	session_id: string;
	intent_id: string;
	task_id: string;
	task_key: string;
	project_id: string;
	status: string;
	executor_phase: string;
	version: number;
	telemetry_sequence: number;
	created: boolean;
	manifest: SignedAgenticManifest;
	manifest_revision: number;
	manifest_hash: string;
	capability_envelope: CapabilityEnvelope;
	workspaces: AgenticWorkspacePlan[];
	signing_keys: AgenticSigningKeyWire[];
	next_command: string;
}

export interface WorktreeAcknowledgementInput {
	workspaceKey: string;
	repositoryFingerprint: string;
	resolvedBaseSha: string;
	branchName: string;
	initialHeadSha: string;
	relativeWorktreePath: string;
	effectiveConfigHash: string;
}

export interface ActivateAgenticDeliveryInput {
	runId: string;
	sessionId: string;
	expectedVersion: number;
	worktrees: WorktreeAcknowledgementInput[];
}

export interface ActivateAgenticDeliveryResult {
	run_id: string;
	status: string;
	executor_phase: string;
	version: number;
	activated: boolean;
	blocker_code: string | null;
	blocker: string | null;
	unmet_exit_gates: Array<Record<string, unknown>>;
	next_command: string;
}

export interface AgenticExecutionResult {
	run_id: string;
	step_instance_key: string;
	attempt_number: number;
	status: string;
	run_status: string;
	executor_phase: string;
	run_version: number;
	replayed: boolean;
}

export interface AgenticExecutionMutationInput {
	runId: string;
	sessionId: string;
	stepInstanceKey: string;
	attemptNumber: number;
	expectedVersion: number;
	idempotencyKey: string;
	status: "running" | "failed" | "completed";
	safeMetadata: Record<string, unknown>;
}

export interface AgenticContextContractSource {
	source_id: string;
	workspace_key: string;
	relative_path: string;
	required: boolean;
	sensitivity: "normal" | "sensitive";
}

export interface AgenticContextContract {
	run_id: string;
	step_instance_key: string;
	byte_budget: number;
	sources: AgenticContextContractSource[];
}

export interface AgenticContextObservation {
	source_id: string;
	provenance: string;
	content_hash: string;
	status: "verified" | "stale" | "unverified" | "missing";
	citations: string[];
	workspace_observation?: {
		head_sha?: string;
		dirty?: boolean;
		dirty_digest?: string;
		index_digest?: string;
		byte_count?: number;
		line_count?: number;
	};
}

export interface AgenticContextSnapshotResult {
	id: string;
	status: string;
	observation_hash: string;
	context_pack_id: string;
	context_pack_hash: string;
	run_version: number;
	replayed?: boolean;
}

export interface AgentTelemetryInstance {
	instanceKey: string;
	parentInstanceKey: string | null;
	label: string;
	role: string;
	reportedStatus: string;
	startedAt: string;
	lastActivityAt: string;
}

export interface AgentTelemetrySnapshot {
	runId: string;
	sessionId: string;
	sequence: number;
	observedAt: string;
	instances: AgentTelemetryInstance[];
}

export class TakonautClient {
	private client: Client;
	private connected = false;

	constructor(private cfg: TakonautConfig) {
		this.client = new Client(
			{ name: "tako-bridge", version: "0.4.5" },
			{ capabilities: {} },
		);
	}

	private async ensure(): Promise<void> {
		if (this.connected) return;
		const endpoint = bridgeServerUrl(this.cfg.serverUrl, "Takonaut MCP URL");
		const transport = new StreamableHTTPClientTransport(endpoint, {
			requestInit: {
				redirect: "error",
				headers: {
					"X-API-Key": this.cfg.apiKey,
					"X-Organization-Id": this.cfg.orgId,
				},
			},
		});
		await this.client.connect(transport);
		this.connected = true;
	}

	private async call(
		name: string,
		args: Record<string, unknown>,
	): Promise<any> {
		await this.ensure();
		return parseToolJson(await this.client.callTool({ name, arguments: args }));
	}

	listStartableTasks(projectKey = ""): Promise<{ tasks: StartableTask[] }> {
		return this.call("list_startable_tasks", { project_key: projectKey });
	}

	getBridgeStandupStatus(projectKey: string): Promise<{
		project_key: string;
		status: "pending" | "submitted";
		submitted_at: string | null;
	}> {
		return this.call("get_bridge_standup_status", { project_key: projectKey });
	}

	createBridgeStandupDraft(input: {
		projectKey: string;
		sections: Record<string, string>;
	}): Promise<{ draft_url: string; expires_at: string }> {
		return this.call("create_bridge_standup_draft", {
			project_key: input.projectKey,
			sections: input.sections,
		});
	}

	getBridgeTaskContext(taskKey: string): Promise<BridgeTaskContext> {
		return this.call("get_bridge_task_context", { task_key: taskKey });
	}

	startAgenticDelivery(
		input: StartAgenticDeliveryInput,
	): Promise<StartAgenticDeliveryResult> {
		return this.call("start_agentic_delivery_task", {
			task_key: input.taskKey,
			client_id: input.clientId,
			session_id: input.sessionId,
			session_label: input.sessionLabel,
			extension_version: input.extensionVersion,
			manifest_schema_version: input.manifestSchemaVersion,
			idempotency_key: input.idempotencyKey,
			base_ref_overrides: (input.baseRefOverrides ?? []).map((override) => ({
				workspace_key: override.workspaceKey,
				ref: override.ref,
				reason: override.reason,
			})),
		});
	}

	activateAgenticDelivery(
		input: ActivateAgenticDeliveryInput,
	): Promise<ActivateAgenticDeliveryResult> {
		return this.call("activate_agentic_delivery_task", {
			run_id: input.runId,
			session_id: input.sessionId,
			expected_version: input.expectedVersion,
			worktrees: input.worktrees.map((worktree) => ({
				workspace_key: worktree.workspaceKey,
				repository_fingerprint: worktree.repositoryFingerprint,
				resolved_base_sha: worktree.resolvedBaseSha,
				branch_name: worktree.branchName,
				initial_head_sha: worktree.initialHeadSha,
				relative_worktree_path: worktree.relativeWorktreePath,
				effective_config_hash: worktree.effectiveConfigHash,
			})),
		});
	}

	getAgenticDeliveryStatus(sessionId: string, runId = ""): Promise<any> {
		return this.call("get_agentic_delivery_status", {
			session_id: sessionId,
			run_id: runId,
		});
	}

	reauthorizeAgenticDeliverySession(input: {
		runId: string;
		sessionId: string;
		expectedVersion: number;
		idempotencyKey: string;
	}): Promise<{
		status: string;
		executor_phase: string;
		version: number;
		reauthorization_required: false;
		lifecycle_resumed: false;
	}> {
		return this.call("reauthorize_agentic_delivery_session", {
			run_id: input.runId,
			session_id: input.sessionId,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
		});
	}

	acknowledgeAgenticDeliveryCancellation(input: {
		runId: string;
		sessionId: string;
		cancellationId: string;
		expectedVersion: number;
		idempotencyKey: string;
	}): Promise<{
		status: string;
		executor_phase: string;
		version: number;
		cancellation_status: string;
	}> {
		return this.call("acknowledge_agentic_delivery_cancellation", {
			run_id: input.runId,
			session_id: input.sessionId,
			cancellation_id: input.cancellationId,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
		});
	}

	recordAgenticDeliveryCleanup(input: {
		runId: string;
		sessionId: string;
		workspaceKey: string;
		repositoryFingerprint: string;
		branchName: string;
		relativeWorktreePath: string;
		finalHeadSha: string | null;
		clean: boolean;
		removed: boolean;
		retainedBranch: boolean;
		status: "completed" | "refused" | "failed";
		errorCode: string | null;
		expectedVersion: number;
		idempotencyKey: string;
	}): Promise<{
		version: number;
		workspace_key: string;
		cleanup_status: "completed" | "refused" | "failed";
		all_cleaned: boolean;
	}> {
		return this.call("record_agentic_delivery_cleanup", {
			run_id: input.runId,
			session_id: input.sessionId,
			workspace_key: input.workspaceKey,
			repository_fingerprint: input.repositoryFingerprint,
			branch_name: input.branchName,
			relative_worktree_path: input.relativeWorktreePath,
			final_head_sha: input.finalHeadSha ?? "",
			clean: input.clean,
			removed: input.removed,
			retained_branch: input.retainedBranch,
			status: input.status,
			error_code: input.errorCode ?? "",
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
		});
	}

	uploadAgenticDeliveryDiagnostic(input: {
		runId: string;
		sessionId: string;
		expectedVersion: number;
		idempotencyKey: string;
		workspaceKey: string | null;
		title: string;
		content: string;
		confirmed: boolean;
	}): Promise<{
		artifact_id: string;
		version: number;
		redaction_count: number;
		sensitivity: "sensitive";
		scheduled_deletion_at: string;
		artifact_url: string;
	}> {
		return this.call("upload_agentic_delivery_diagnostic", {
			run_id: input.runId,
			session_id: input.sessionId,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
			workspace_key: input.workspaceKey ?? "",
			title: input.title,
			content: input.content,
			confirmed: input.confirmed,
		});
	}

	updateAgenticDeliveryStep(
		input: AgenticExecutionMutationInput,
	): Promise<AgenticExecutionResult> {
		return this.call("update_agentic_delivery_step", {
			run_id: input.runId,
			session_id: input.sessionId,
			step_instance_key: input.stepInstanceKey,
			attempt_number: input.attemptNumber,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
			status: input.status,
			safe_metadata: input.safeMetadata,
		});
	}

	answerAgenticDeliveryStep(input: {
		runId: string;
		sessionId: string;
		stepInstanceKey: string;
		attemptNumber: number;
		expectedVersion: number;
		idempotencyKey: string;
		answer: string;
	}): Promise<AgenticExecutionResult> {
		return this.call("answer_agentic_delivery_step", {
			run_id: input.runId,
			session_id: input.sessionId,
			step_instance_key: input.stepInstanceKey,
			attempt_number: input.attemptNumber,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
			answer: input.answer,
		});
	}

	retryAgenticDeliveryStep(input: {
		runId: string;
		sessionId: string;
		stepInstanceKey: string;
		attemptNumber: number;
		expectedVersion: number;
		idempotencyKey: string;
	}): Promise<AgenticExecutionResult> {
		return this.call("retry_agentic_delivery_step", {
			run_id: input.runId,
			session_id: input.sessionId,
			step_instance_key: input.stepInstanceKey,
			attempt_number: input.attemptNumber,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
		});
	}

	recordAgenticDeliveryGraphRoute(input: {
		runId: string;
		sessionId: string;
		stepInstanceKey: string;
		attemptNumber: number;
		expectedVersion: number;
		idempotencyKey: string;
		facts: Record<string, unknown>;
		contextSnapshotId: string;
		contextPackId: string;
		contextSnapshotHash: string;
		contextPackHash: string;
		fallbackEdgeId: string | null;
		fallbackRationale: string | null;
		evidenceBindings: string[];
	}): Promise<AgenticExecutionResult> {
		return this.call("record_agentic_delivery_graph_route", {
			run_id: input.runId,
			session_id: input.sessionId,
			step_instance_key: input.stepInstanceKey,
			attempt_number: input.attemptNumber,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
			facts: input.facts,
			context_snapshot_id: input.contextSnapshotId,
			context_pack_id: input.contextPackId,
			context_snapshot_hash: input.contextSnapshotHash,
			context_pack_hash: input.contextPackHash,
			fallback_edge_id: input.fallbackEdgeId ?? "",
			fallback_rationale: input.fallbackRationale ?? "",
			evidence_bindings: input.evidenceBindings,
		});
	}

	resolveAgenticDeliveryHumanGate(input: {
		runId: string;
		sessionId: string;
		stepInstanceKey: string;
		selectedEdgeId: string;
		rationale: string;
		expectedVersion: number;
		idempotencyKey: string;
	}): Promise<AgenticExecutionResult> {
		return this.call("resolve_agentic_delivery_human_gate", {
			run_id: input.runId,
			session_id: input.sessionId,
			step_instance_key: input.stepInstanceKey,
			selected_edge_id: input.selectedEdgeId,
			rationale: input.rationale,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
		});
	}

	getAgenticDeliveryContextContract(input: {
		runId: string;
		sessionId: string;
		stepInstanceKey: string;
	}): Promise<AgenticContextContract> {
		return this.call("get_agentic_delivery_context_contract", {
			run_id: input.runId,
			session_id: input.sessionId,
			step_instance_key: input.stepInstanceKey,
		});
	}

	recordAgenticDeliveryContext(input: {
		runId: string;
		sessionId: string;
		stepInstanceKey: string;
		expectedVersion: number;
		idempotencyKey: string;
		observations: AgenticContextObservation[];
	}): Promise<AgenticContextSnapshotResult> {
		return this.call("record_agentic_delivery_context", {
			run_id: input.runId,
			session_id: input.sessionId,
			step_instance_key: input.stepInstanceKey,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
			observations: input.observations,
		});
	}

	confirmAgenticDeliveryContext(input: {
		runId: string;
		sessionId: string;
		snapshotId: string;
		observationHash: string;
		expectedVersion: number;
		idempotencyKey: string;
	}): Promise<{ id: string; status: string; run_version: number }> {
		return this.call("confirm_agentic_delivery_context", {
			run_id: input.runId,
			session_id: input.sessionId,
			snapshot_id: input.snapshotId,
			observation_hash: input.observationHash,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
		});
	}

	resumeAgenticDeliveryContext(input: {
		runId: string;
		sessionId: string;
		snapshotId: string;
		observationHash: string;
		expectedVersion: number;
		idempotencyKey: string;
		observations?: AgenticContextObservation[];
	}): Promise<AgenticExecutionResult | AgenticContextSnapshotResult> {
		return this.call("resume_agentic_delivery_context", {
			run_id: input.runId,
			session_id: input.sessionId,
			snapshot_id: input.snapshotId,
			observation_hash: input.observationHash,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
			observations: input.observations ?? [],
		});
	}

	proposeAgenticDeliveryPlan(input: {
		runId: string;
		sessionId: string;
		contextSnapshotId: string;
		expectedVersion: number;
		idempotencyKey: string;
		title: string;
		markdown: string;
	}): Promise<{
		approval_request_id: string;
		artifact_id: string;
		status: string;
		run_status: string;
		executor_phase: string;
		version: number;
		evidence_hash: string;
		review_url: string;
		run_url: string;
		artifact_url: string;
		configuration_url: string;
		next_command: string;
	}> {
		return this.call("propose_agentic_delivery_plan", {
			run_id: input.runId,
			session_id: input.sessionId,
			context_snapshot_id: input.contextSnapshotId,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
			title: input.title,
			markdown: input.markdown,
		});
	}

	resumeAgenticDeliveryReview(input: {
		runId: string;
		sessionId: string;
		approvalRequestId: string;
		expectedVersion: number;
		idempotencyKey: string;
	}): Promise<{
		run_id: string;
		status: string;
		executor_phase: string;
		version: number;
		next_action: string;
		next_command: string | null;
	}> {
		return this.call("resume_agentic_delivery_review", {
			run_id: input.runId,
			session_id: input.sessionId,
			approval_request_id: input.approvalRequestId,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
		});
	}

	proposeAgenticDeliveryCompletion(input: {
		runId: string;
		sessionId: string;
		contextSnapshotId: string;
		expectedVersion: number;
		idempotencyKey: string;
		workspaces: AgenticWorkspaceCompletionEvidence[];
	}): Promise<{
		created: boolean;
		run_id: string;
		status: string;
		executor_phase: string;
		version: number;
		blocker_code: string | null;
		unmet_exit_gates: Array<Record<string, unknown>>;
		approval_request_id: string | null;
		artifact_id: string | null;
		evidence_hash: string | null;
		review_url: string | null;
		run_url: string;
		artifact_url: string | null;
		next_command: string | null;
	}> {
		return this.call("propose_agentic_delivery_completion", {
			run_id: input.runId,
			session_id: input.sessionId,
			context_snapshot_id: input.contextSnapshotId,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
			workspaces: input.workspaces,
		});
	}

	finalizeAgenticDeliveryCompletion(input: {
		runId: string;
		sessionId: string;
		approvalRequestId: string;
		expectedVersion: number;
		idempotencyKey: string;
		workspaces: AgenticWorkspaceCompletionEvidence[];
	}): Promise<{
		finalized: boolean;
		run_id: string;
		status: string;
		executor_phase: string;
		version: number;
		approval_request_id: string;
		blocker_code: string | null;
		unmet_exit_gates: Array<Record<string, unknown>>;
		next_action: string;
		next_command: string | null;
		run_url: string;
	}> {
		return this.call("finalize_agentic_delivery_completion", {
			run_id: input.runId,
			session_id: input.sessionId,
			approval_request_id: input.approvalRequestId,
			expected_version: input.expectedVersion,
			idempotency_key: input.idempotencyKey,
			workspaces: input.workspaces,
		});
	}

	reportAgentTelemetry(snapshot: AgentTelemetrySnapshot): Promise<any> {
		return this.call("report_agentic_delivery_telemetry", {
			run_id: snapshot.runId,
			session_id: snapshot.sessionId,
			sequence: snapshot.sequence,
			observed_at: snapshot.observedAt,
			instances: snapshot.instances.map((instance) => ({
				instance_key: instance.instanceKey,
				parent_instance_key: instance.parentInstanceKey,
				label: instance.label,
				role: instance.role,
				reported_status: instance.reportedStatus,
				started_at: instance.startedAt,
				last_activity_at: instance.lastActivityAt,
			})),
		});
	}

	async close(): Promise<void> {
		if (this.connected) {
			try {
				await this.client.close();
			} catch {
				/* best effort */
			}
			this.connected = false;
		}
	}
}
