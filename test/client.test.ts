import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	connect: vi.fn(),
	callTool: vi.fn(),
	close: vi.fn(),
	streamableTransport: vi.fn(),
}));

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: class {
		connect = mocks.connect;
		callTool = mocks.callTool;
		close = mocks.close;
	},
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
	StreamableHTTPClientTransport: class {
		constructor(url: URL, options: unknown) {
			mocks.streamableTransport(url, options);
		}
	},
}));

import { TakonautClient } from "../src/client";

const cfg = {
	serverUrl: "https://takonaut.test/mcp/",
	apiKey: "device-secret",
	orgId: "org-123",
	repoRoot: "/work/repo",
	protectedBranches: ["main"],
	projectRepos: {},
	credentialSource: "secure file" as const,
	configPath: "/home/dev/.takonaut/bridge.json",
	credentialPath: "/home/dev/.takonaut/credentials.json",
};

describe("TakonautClient transport", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.callTool.mockResolvedValue({
			content: [{ type: "text", text: JSON.stringify({ tasks: [] }) }],
		});
	});

	it("connects with Streamable HTTP and both personal-key headers", async () => {
		const client = new TakonautClient(cfg);
		await client.listStartableTasks();

		expect(mocks.streamableTransport).toHaveBeenCalledOnce();
		const [url, options] = mocks.streamableTransport.mock.calls[0] as [
			URL,
			any,
		];
		expect(url.href).toBe("https://takonaut.test/mcp/");
		expect(options.requestInit.redirect).toBe("error");
		expect(options.requestInit.headers).toMatchObject({
			"X-API-Key": "device-secret",
			"X-Organization-Id": "org-123",
		});
		expect(mocks.connect).toHaveBeenCalledOnce();
	});

	it("parses successful MCP responses larger than 2,000 characters", async () => {
		const response = {
			tasks: [
				{
					task_key: "PAY-142",
					task_title: "Implement the complete payments workflow",
					project_key: "PAY",
				},
			],
			context: "x".repeat(8_192),
		};
		mocks.callTool.mockResolvedValue({
			content: [{ type: "text", text: JSON.stringify(response) }],
		});

		const client = new TakonautClient(cfg);

		await expect(client.listStartableTasks()).resolves.toEqual(response);
	});

	it("refuses to send a personal key over insecure transport", async () => {
		const client = new TakonautClient({
			...cfg,
			serverUrl: "http://takonaut.test/mcp/",
		});
		await expect(client.listStartableTasks()).rejects.toThrow("requires HTTPS");
		expect(mocks.streamableTransport).not.toHaveBeenCalled();
		expect(mocks.connect).not.toHaveBeenCalled();
	});

	it("reuses one connection and closes it on shutdown", async () => {
		const client = new TakonautClient(cfg);
		await client.listStartableTasks();
		await client.listStartableTasks();
		expect(mocks.connect).toHaveBeenCalledOnce();

		await client.close();
		expect(mocks.close).toHaveBeenCalledOnce();
	});

	it("calls the bounded task-context tool", async () => {
		const client = new TakonautClient(cfg);
		await client.getBridgeTaskContext("PAY-142");

		expect(mocks.callTool).toHaveBeenCalledWith({
			name: "get_bridge_task_context",
			arguments: { task_key: "PAY-142" },
		});
	});

	it("binds Agentic Delivery start, status, and telemetry to one Pi session", async () => {
		const client = new TakonautClient(cfg);
		await client.startAgenticDelivery({
			taskKey: "PAY-142",
			clientId: "client-1",
			sessionId: "pi-session-1",
			sessionLabel: "Payments session",
			extensionVersion: "0.1.0",
			manifestSchemaVersion: 1,
			idempotencyKey: "start:pi-session-1:PAY-142",
			baseRefOverrides: [
				{
					workspaceKey: "api",
					ref: "release/1.0",
					reason: "Supported-release fix",
				},
			],
		});
		await client.activateAgenticDelivery({
			runId: "run-1",
			sessionId: "server-session-1",
			expectedVersion: 1,
			worktrees: [
				{
					workspaceKey: "api",
					repositoryFingerprint: "github:123:takonaut/api",
					resolvedBaseSha: "a".repeat(40),
					branchName: "tako/pay-142-12345678",
					initialHeadSha: "a".repeat(40),
					relativeWorktreePath: "api/worktrees/pay-142",
					effectiveConfigHash: "b".repeat(64),
				},
			],
		});
		await client.getAgenticDeliveryStatus("pi-session-1", "run-1");
		await client.reportAgentTelemetry({
			runId: "run-1",
			sessionId: "pi-session-1",
			sequence: 1,
			observedAt: "2030-01-01T00:00:00.000Z",
			instances: [
				{
					instanceKey: "pi:pi-session-1",
					parentInstanceKey: null,
					label: "Pi parent",
					role: "executor",
					reportedStatus: "provisioning",
					startedAt: "2030-01-01T00:00:00.000Z",
					lastActivityAt: "2030-01-01T00:00:00.000Z",
				},
			],
		});

		expect(mocks.callTool.mock.calls.map(([call]) => call)).toEqual([
			{
				name: "start_agentic_delivery_task",
				arguments: {
					task_key: "PAY-142",
					client_id: "client-1",
					session_id: "pi-session-1",
					session_label: "Payments session",
					extension_version: "0.1.0",
					manifest_schema_version: 1,
					idempotency_key: "start:pi-session-1:PAY-142",
					base_ref_overrides: [
						{
							workspace_key: "api",
							ref: "release/1.0",
							reason: "Supported-release fix",
						},
					],
				},
			},
			{
				name: "activate_agentic_delivery_task",
				arguments: {
					run_id: "run-1",
					session_id: "server-session-1",
					expected_version: 1,
					worktrees: [
						{
							workspace_key: "api",
							repository_fingerprint: "github:123:takonaut/api",
							resolved_base_sha: "a".repeat(40),
							branch_name: "tako/pay-142-12345678",
							initial_head_sha: "a".repeat(40),
							relative_worktree_path: "api/worktrees/pay-142",
							effective_config_hash: "b".repeat(64),
						},
					],
				},
			},
			{
				name: "get_agentic_delivery_status",
				arguments: { session_id: "pi-session-1", run_id: "run-1" },
			},
			{
				name: "report_agentic_delivery_telemetry",
				arguments: {
					run_id: "run-1",
					session_id: "pi-session-1",
					sequence: 1,
					observed_at: "2030-01-01T00:00:00.000Z",
					instances: [
						{
							instance_key: "pi:pi-session-1",
							parent_instance_key: null,
							label: "Pi parent",
							role: "executor",
							reported_status: "provisioning",
							started_at: "2030-01-01T00:00:00.000Z",
							last_activity_at: "2030-01-01T00:00:00.000Z",
						},
					],
				},
			},
		]);
	});

	it("reads a session-owned Agentic Context contract without caller content", async () => {
		const client = new TakonautClient(cfg);
		await client.getAgenticDeliveryContextContract({
			runId: "run-1",
			sessionId: "session-1",
			stepInstanceKey: "inspect",
		});

		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "get_agentic_delivery_context_contract",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				step_instance_key: "inspect",
			},
		});
	});

	it("sends bounded Agentic execution and Context mutation envelopes", async () => {
		const client = new TakonautClient(cfg);
		await client.updateAgenticDeliveryStep({
			runId: "run-1",
			sessionId: "session-1",
			stepInstanceKey: "001-inspect",
			attemptNumber: 1,
			expectedVersion: 2,
			idempotencyKey: "step-1",
			status: "completed",
			safeMetadata: { summary: "Inspected Context" },
		});
		await client.confirmAgenticDeliveryContext({
			runId: "run-1",
			sessionId: "session-1",
			snapshotId: "snapshot-1",
			observationHash: "a".repeat(64),
			expectedVersion: 3,
			idempotencyKey: "confirm-1",
		});
		await client.resumeAgenticDeliveryContext({
			runId: "run-1",
			sessionId: "session-1",
			snapshotId: "snapshot-1",
			observationHash: "a".repeat(64),
			expectedVersion: 4,
			idempotencyKey: "resume-1",
			observations: [
				{
					source_id: "guide",
					provenance: "pi",
					content_hash: "b".repeat(64),
					status: "verified",
					citations: ["GUIDE.md#L1-L2"],
					workspace_observation: {
						head_sha: "c".repeat(40),
						byte_count: 120,
					},
				},
			],
		});

		expect(mocks.callTool.mock.calls.map(([call]) => call)).toEqual([
			{
				name: "update_agentic_delivery_step",
				arguments: {
					run_id: "run-1",
					session_id: "session-1",
					step_instance_key: "001-inspect",
					attempt_number: 1,
					expected_version: 2,
					idempotency_key: "step-1",
					status: "completed",
					safe_metadata: { summary: "Inspected Context" },
				},
			},
			{
				name: "confirm_agentic_delivery_context",
				arguments: {
					run_id: "run-1",
					session_id: "session-1",
					snapshot_id: "snapshot-1",
					observation_hash: "a".repeat(64),
					expected_version: 3,
					idempotency_key: "confirm-1",
				},
			},
			{
				name: "resume_agentic_delivery_context",
				arguments: {
					run_id: "run-1",
					session_id: "session-1",
					snapshot_id: "snapshot-1",
					observation_hash: "a".repeat(64),
					expected_version: 4,
					idempotency_key: "resume-1",
					observations: [
						{
							source_id: "guide",
							provenance: "pi",
							content_hash: "b".repeat(64),
							status: "verified",
							citations: ["GUIDE.md#L1-L2"],
							workspace_observation: {
								head_sha: "c".repeat(40),
								byte_count: 120,
							},
						},
					],
				},
			},
		]);
	});

	it.each([
		"feature_disabled:agent_profiles_v2",
		"unauthorized: personal key revoked",
		"task_already_claimed: another Pi session owns this Task",
	])("preserves MCP tool errors: %s", async (message) => {
		mocks.callTool.mockResolvedValue({
			isError: true,
			content: [{ type: "text", text: message }],
		});
		const client = new TakonautClient(cfg);
		await expect(client.listStartableTasks()).rejects.toThrow(message);
	});

	it("distinguishes a malformed successful response from a tool error", async () => {
		mocks.callTool.mockResolvedValue({
			isError: false,
			content: [{ type: "text", text: "not-json" }],
		});
		const client = new TakonautClient(cfg);
		await expect(client.listStartableTasks()).rejects.toThrow(
			"Takonaut returned an invalid successful tool response.",
		);
	});

	it("routes graph steps, resolves human gates, and retries the latest attempt", async () => {
		const client = new TakonautClient(cfg);
		await client.retryAgenticDeliveryStep({
			runId: "run-1",
			sessionId: "session-1",
			stepInstanceKey: "inspect",
			attemptNumber: 2,
			expectedVersion: 7,
			idempotencyKey: "retry-idem",
		});
		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "retry_agentic_delivery_step",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				step_instance_key: "inspect",
				attempt_number: 2,
				expected_version: 7,
				idempotency_key: "retry-idem",
			},
		});

		await client.recordAgenticDeliveryGraphRoute({
			runId: "run-1",
			sessionId: "session-1",
			stepInstanceKey: "inspect",
			attemptNumber: 2,
			expectedVersion: 8,
			idempotencyKey: "route-idem",
			facts: { "step.status": "completed" },
			contextSnapshotId: "snapshot-1",
			contextPackId: "pack-1",
			contextSnapshotHash: "a".repeat(64),
			contextPackHash: "b".repeat(64),
			fallbackEdgeId: null,
			fallbackRationale: null,
			evidenceBindings: [],
		});
		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "record_agentic_delivery_graph_route",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				step_instance_key: "inspect",
				attempt_number: 2,
				expected_version: 8,
				idempotency_key: "route-idem",
				facts: { "step.status": "completed" },
				context_snapshot_id: "snapshot-1",
				context_pack_id: "pack-1",
				context_snapshot_hash: "a".repeat(64),
				context_pack_hash: "b".repeat(64),
				fallback_edge_id: "",
				fallback_rationale: "",
				evidence_bindings: [],
			},
		});

		await client.resolveAgenticDeliveryHumanGate({
			runId: "run-1",
			sessionId: "session-1",
			stepInstanceKey: "approval",
			selectedEdgeId: "approved",
			rationale: "Approved by owner",
			expectedVersion: 9,
			idempotencyKey: "gate-idem",
		});
		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "resolve_agentic_delivery_human_gate",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				step_instance_key: "approval",
				selected_edge_id: "approved",
				rationale: "Approved by owner",
				expected_version: 9,
				idempotency_key: "gate-idem",
			},
		});
	});

	it("submits snapshot-bound plans and resumes only explicit decisions", async () => {
		const client = new TakonautClient(cfg);
		await client.proposeAgenticDeliveryPlan({
			runId: "run-1",
			sessionId: "session-1",
			contextSnapshotId: "snapshot-1",
			expectedVersion: 7,
			idempotencyKey: "plan-idem",
			title: "Implementation plan",
			markdown: "## Plan",
		});
		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "propose_agentic_delivery_plan",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				context_snapshot_id: "snapshot-1",
				expected_version: 7,
				idempotency_key: "plan-idem",
				title: "Implementation plan",
				markdown: "## Plan",
			},
		});

		await client.resumeAgenticDeliveryReview({
			runId: "run-1",
			sessionId: "session-1",
			approvalRequestId: "review-1",
			expectedVersion: 8,
			idempotencyKey: "resume-idem",
		});
		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "resume_agentic_delivery_review",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				approval_request_id: "review-1",
				expected_version: 8,
				idempotency_key: "resume-idem",
			},
		});

		const workspaces = [
			{
				workspace_key: "api",
				repository_fingerprint: "github:1:acme/api",
				branch_name: "tako/pay-42-api",
				head_sha: "a".repeat(40),
				clean: true as const,
				post_base_commit: true,
				pr_number: 42,
				tests: [],
			},
		];
		await client.proposeAgenticDeliveryCompletion({
			runId: "run-1",
			sessionId: "session-1",
			contextSnapshotId: "snapshot-1",
			expectedVersion: 9,
			idempotencyKey: "completion-idem",
			workspaces,
		});
		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "propose_agentic_delivery_completion",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				context_snapshot_id: "snapshot-1",
				expected_version: 9,
				idempotency_key: "completion-idem",
				workspaces,
			},
		});

		await client.finalizeAgenticDeliveryCompletion({
			runId: "run-1",
			sessionId: "session-1",
			approvalRequestId: "review-2",
			expectedVersion: 10,
			idempotencyKey: "finalize-idem",
			workspaces,
		});
		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "finalize_agentic_delivery_completion",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				approval_request_id: "review-2",
				expected_version: 10,
				idempotency_key: "finalize-idem",
				workspaces,
			},
		});

		await client.reauthorizeAgenticDeliverySession({
			runId: "run-1",
			sessionId: "session-1",
			expectedVersion: 10,
			idempotencyKey: "reauthorize-idem",
		});
		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "reauthorize_agentic_delivery_session",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				expected_version: 10,
				idempotency_key: "reauthorize-idem",
			},
		});

		await client.acknowledgeAgenticDeliveryCancellation({
			runId: "run-1",
			sessionId: "session-1",
			cancellationId: "cancel-1",
			expectedVersion: 11,
			idempotencyKey: "cancel-ack-idem",
		});
		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "acknowledge_agentic_delivery_cancellation",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				cancellation_id: "cancel-1",
				expected_version: 11,
				idempotency_key: "cancel-ack-idem",
			},
		});

		await client.recordAgenticDeliveryCleanup({
			runId: "run-1",
			sessionId: "session-1",
			workspaceKey: "api",
			repositoryFingerprint: "github:1:acme/api",
			branchName: "tako/pay-42-api",
			relativeWorktreePath: "project/run/api",
			finalHeadSha: "a".repeat(40),
			clean: true,
			removed: true,
			retainedBranch: true,
			status: "completed",
			errorCode: null,
			expectedVersion: 12,
			idempotencyKey: "cleanup-idem",
		});
		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "record_agentic_delivery_cleanup",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				workspace_key: "api",
				repository_fingerprint: "github:1:acme/api",
				branch_name: "tako/pay-42-api",
				relative_worktree_path: "project/run/api",
				final_head_sha: "a".repeat(40),
				clean: true,
				removed: true,
				retained_branch: true,
				status: "completed",
				error_code: "",
				expected_version: 12,
				idempotency_key: "cleanup-idem",
			},
		});

		await client.uploadAgenticDeliveryDiagnostic({
			runId: "run-1",
			sessionId: "session-1",
			expectedVersion: 13,
			idempotencyKey: "diagnostic-idem",
			workspaceKey: "api",
			title: "Redacted diagnostic",
			content: "safe summary",
			confirmed: true,
		});
		expect(mocks.callTool).toHaveBeenLastCalledWith({
			name: "upload_agentic_delivery_diagnostic",
			arguments: {
				run_id: "run-1",
				session_id: "session-1",
				expected_version: 13,
				idempotency_key: "diagnostic-idem",
				workspace_key: "api",
				title: "Redacted diagnostic",
				content: "safe summary",
				confirmed: true,
			},
		});
	});
});
