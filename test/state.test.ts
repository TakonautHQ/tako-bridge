import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	agenticRunPath,
	loadActiveAgenticRun,
	loadProjectAgentSync,
	saveActiveAgenticRun,
	saveProjectAgentSync,
	type ActiveAgenticDeliveryRun,
} from "../src/state";

const AGENTIC_RUN: ActiveAgenticDeliveryRun = {
	version: 1,
	orgId: "org-1",
	clientId: "client-1",
	piSessionId: "pi-session-1",
	serverSessionId: "server-session-1",
	runId: "agentic-run-1",
	taskId: "task-1",
	taskKey: "PAY-142",
	projectId: "project-1",
	projectKey: "PAY",
	repoRoot: "/work/payments",
	status: "provisioning",
	executorPhase: "provisioning",
	versionNumber: 1,
	startNonce: "11111111-1111-4111-8111-111111111111",
	telemetrySequence: 12,
	featureDisabled: false,
	acceptedManifest: {
		revision: 3,
		revisionId: "revision-3",
		contentHash: "a".repeat(64),
		envelopeHash: "b".repeat(64),
		keyId: "key-2026-01",
		acceptedAt: "2030-01-01T00:00:00.000Z",
		capabilityApprovedAt: "2030-01-01T00:00:00.000Z",
	},
	trustedSigningKeys: [
		{
			keyId: "key-2026-01",
			publicKeyB64: "c".repeat(44),
			status: "active",
			validFrom: "2029-01-01T00:00:00.000Z",
			validUntil: null,
		},
	],
	worktrees: [
		{
			workspaceKey: "api",
			repositoryFingerprint: "github:123:takonaut/api",
			configuredBaseRef: "main",
			overrideBaseRef: null,
			repoRoot: "/work/payments",
			worktreeRoot: "/managed/org-1/project-1/api",
			relativeWorktreePath: "api/worktrees/pay-142",
			branchName: "tako/pay-142-12345678",
			baseSha: "d".repeat(40),
			initialHeadSha: "d".repeat(40),
			effectiveConfigHash: "e".repeat(64),
			lifecycle: "verified",
		},
	],
	completionTests: {},
	startedAt: "2030-01-01T00:00:00.000Z",
	lastActivityAt: "2030-01-01T00:00:00.000Z",
	updatedAt: "2030-01-01T00:00:00.000Z",
};

describe("durable Agentic Delivery run state", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tako-run-state-"));
	});

	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("persists Project manifest trust independently from a Run", () => {
		const syncPath = join(dir, "project-sync.json");
		saveProjectAgentSync(
			{
				version: 1,
				orgId: "org-1",
				projectId: "project-1",
				acceptedRevision: 3,
				acceptedRevisionId: "revision-3",
				contentHash: "a".repeat(64),
				envelopeHash: "b".repeat(64),
				capabilityEnvelope: {
					workspace_scopes: [
						{
							id: "api",
							repository_fingerprint: "github:123:takonaut/api",
							subpath: "backend",
						},
					],
					allowed_tools: ["read", "edit"],
					allowed_model_policies: ["sonnet"],
					executable_step_types: ["inspect", "edit", "test"],
					protected_paths: [".env", ".git"],
				},
				trustedSigningKeys: AGENTIC_RUN.trustedSigningKeys,
				updatedAt: "2030-01-01T00:00:00.000Z",
			},
			syncPath,
		);

		expect(loadProjectAgentSync(syncPath, "org-1", "project-1")).toMatchObject({
			acceptedRevision: 3,
			projectId: "project-1",
		});
	});

	it("stores separate Agentic Delivery Runs for separate Pi sessions in one org", () => {
		const pathA = join(dir, "agentic-a.json");
		const pathB = join(dir, "agentic-b.json");
		saveActiveAgenticRun(AGENTIC_RUN, pathA);
		saveActiveAgenticRun(
			{
				...AGENTIC_RUN,
				piSessionId: "pi-session-2",
				serverSessionId: "server-session-2",
				runId: "agentic-run-2",
				taskId: "task-2",
				taskKey: "PAY-143",
			},
			pathB,
		);

		const loaded = loadActiveAgenticRun(pathA, "org-1", "pi-session-1");
		expect(loaded?.runId).toBe("agentic-run-1");
		expect(loaded?.acceptedManifest.revision).toBe(3);
		expect(loaded?.worktrees[0].workspaceKey).toBe("api");
		expect(loadActiveAgenticRun(pathB, "org-1", "pi-session-2")?.runId).toBe(
			"agentic-run-2",
		);
		expect(agenticRunPath("org-1", "pi-session-1")).not.toBe(
			agenticRunPath("org-1", "pi-session-2"),
		);
	});
});
