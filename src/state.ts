import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { CapabilityEnvelope, TrustedSigningKey } from "./manifest";

export type ActiveRunPhase =
	| "claimed"
	| "working"
	| "submitting"
	| "pending_review"
	| "rejected";

export interface ActiveRunTestEvidence {
	command: string;
	exitCode: number;
	status: "passed" | "failed";
	summary: string;
	completedAt: string;
	headSha: string;
}

export interface ActiveBridgeRun {
	version: 1;
	orgId: string;
	runId: string;
	taskId: string;
	taskKey: string;
	projectId: string;
	projectKey: string;
	repoRoot: string;
	branch: string;
	baseSha: string;
	phase: ActiveRunPhase;
	proposalId: string | null;
	tests?: ActiveRunTestEvidence[];
	updatedAt: string;
}

export interface AcceptedAgenticManifestState {
	revision: number;
	revisionId: string;
	contentHash: string;
	envelopeHash: string;
	keyId: string;
	acceptedAt: string;
	capabilityApprovedAt: string;
}

export interface AgenticCompletionTestState {
	command: string;
	exitCode: number;
	status: "passed" | "failed";
	summary: string;
	completedAt: string;
	headSha: string;
}

export interface ActiveAgenticWorktreeState {
	workspaceKey: string;
	repositoryFingerprint: string;
	configuredBaseRef: string;
	overrideBaseRef: string | null;
	repoRoot: string;
	worktreeRoot: string;
	relativeWorktreePath: string;
	branchName: string;
	baseSha: string;
	initialHeadSha: string;
	effectiveConfigHash: string;
	lifecycle: "planned" | "verified" | "cleanup_hold" | "cleaned";
}

export interface ProjectAgentSyncState {
	version: 1;
	orgId: string;
	projectId: string;
	acceptedRevision: number;
	acceptedRevisionId: string;
	contentHash: string;
	envelopeHash: string;
	capabilityEnvelope: CapabilityEnvelope;
	trustedSigningKeys: TrustedSigningKey[];
	updatedAt: string;
}

export interface ActiveAgenticDeliveryRun {
	version: 1;
	orgId: string;
	clientId: string;
	piSessionId: string;
	serverSessionId: string;
	runId: string;
	taskId: string;
	taskKey: string;
	projectId: string;
	projectKey: string;
	repoRoot: string;
	status: string;
	executorPhase: string;
	versionNumber: number;
	startNonce: string;
	telemetrySequence: number;
	featureDisabled: boolean;
	reauthorizationRequired?: boolean;
	cancellationId?: string | null;
	acceptedManifest: AcceptedAgenticManifestState;
	trustedSigningKeys: TrustedSigningKey[];
	worktrees: ActiveAgenticWorktreeState[];
	completionTests: Record<string, AgenticCompletionTestState[]>;
	startedAt: string;
	lastActivityAt: string;
	updatedAt: string;
}

export const ACTIVE_RUN_PATH = join(homedir(), ".takonaut", "active-run.json");

export function activeRunPath(orgId: string): string {
	const safeOrgId = orgId.replace(/[^a-zA-Z0-9-]/g, "_");
	return join(homedir(), ".takonaut", "runs", `${safeOrgId}.json`);
}

export function agenticRunPath(orgId: string, piSessionId: string): string {
	const safeOrgId = orgId.replace(/[^a-zA-Z0-9-]/g, "_");
	const safeSessionId = piSessionId.replace(/[^a-zA-Z0-9-]/g, "_");
	return join(
		homedir(),
		".takonaut",
		"agentic-delivery",
		safeOrgId,
		`${safeSessionId}.json`,
	);
}

export function projectAgentSyncPath(orgId: string, projectId: string): string {
	const safeOrgId = orgId.replace(/[^a-zA-Z0-9-]/g, "_");
	const safeProjectId = projectId.replace(/[^a-zA-Z0-9-]/g, "_");
	return join(
		homedir(),
		".takonaut",
		"agentic-delivery",
		safeOrgId,
		"projects",
		`${safeProjectId}.json`,
	);
}

function valid(value: any): value is ActiveBridgeRun {
	return (
		value?.version === 1 &&
		typeof value.orgId === "string" &&
		typeof value.runId === "string" &&
		typeof value.taskId === "string" &&
		typeof value.taskKey === "string" &&
		typeof value.projectId === "string" &&
		typeof value.projectKey === "string" &&
		typeof value.repoRoot === "string" &&
		typeof value.branch === "string" &&
		typeof value.baseSha === "string" &&
		typeof value.phase === "string"
	);
}

export function loadActiveRun(
	path?: string,
	orgId?: string,
): ActiveBridgeRun | null {
	const resolvedPath = path ?? (orgId ? activeRunPath(orgId) : ACTIVE_RUN_PATH);
	try {
		const parsed = JSON.parse(readFileSync(resolvedPath, "utf-8"));
		if (!valid(parsed)) return null;
		if (orgId && parsed.orgId !== orgId) return null;
		return parsed;
	} catch {
		return null;
	}
}

function saveJson(value: unknown, path: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
		chmodSync(path, 0o600);
	} finally {
		rmSync(tmp, { force: true });
	}
}

export function saveActiveRun(state: ActiveBridgeRun, path?: string): void {
	saveJson(state, path ?? activeRunPath(state.orgId));
}

export function clearActiveRun(
	runId: string,
	path?: string,
	orgId?: string,
): void {
	const resolvedPath = path ?? (orgId ? activeRunPath(orgId) : ACTIVE_RUN_PATH);
	const current = loadActiveRun(resolvedPath);
	if (!current || current.runId !== runId) return;
	rmSync(resolvedPath, { force: true });
}

function validTrustedKey(value: any): value is TrustedSigningKey {
	return (
		typeof value?.keyId === "string" &&
		typeof value.publicKeyB64 === "string" &&
		["active", "next", "retired", "revoked"].includes(value.status) &&
		typeof value.validFrom === "string" &&
		(value.validUntil === null || typeof value.validUntil === "string")
	);
}

function validAgenticWorktree(value: any): value is ActiveAgenticWorktreeState {
	return (
		typeof value?.workspaceKey === "string" &&
		typeof value.repositoryFingerprint === "string" &&
		typeof value.configuredBaseRef === "string" &&
		(value.overrideBaseRef === null ||
			typeof value.overrideBaseRef === "string") &&
		typeof value.repoRoot === "string" &&
		typeof value.worktreeRoot === "string" &&
		typeof value.relativeWorktreePath === "string" &&
		typeof value.branchName === "string" &&
		typeof value.baseSha === "string" &&
		typeof value.initialHeadSha === "string" &&
		typeof value.effectiveConfigHash === "string" &&
		["planned", "verified", "cleanup_hold", "cleaned"].includes(value.lifecycle)
	);
}

function validCompletionTest(value: any): value is AgenticCompletionTestState {
	return (
		typeof value?.command === "string" &&
		typeof value.exitCode === "number" &&
		["passed", "failed"].includes(value.status) &&
		typeof value.summary === "string" &&
		typeof value.completedAt === "string" &&
		typeof value.headSha === "string"
	);
}

function validAgentic(value: any): value is ActiveAgenticDeliveryRun {
	const accepted = value?.acceptedManifest;
	return (
		value?.version === 1 &&
		typeof value.orgId === "string" &&
		typeof value.clientId === "string" &&
		typeof value.piSessionId === "string" &&
		typeof value.serverSessionId === "string" &&
		typeof value.runId === "string" &&
		typeof value.taskId === "string" &&
		typeof value.taskKey === "string" &&
		typeof value.projectId === "string" &&
		typeof value.projectKey === "string" &&
		typeof value.repoRoot === "string" &&
		typeof value.status === "string" &&
		typeof value.executorPhase === "string" &&
		typeof value.versionNumber === "number" &&
		typeof value.startNonce === "string" &&
		typeof value.telemetrySequence === "number" &&
		Number.isSafeInteger(value.telemetrySequence) &&
		value.telemetrySequence >= 0 &&
		typeof value.featureDisabled === "boolean" &&
		(value.reauthorizationRequired === undefined ||
			typeof value.reauthorizationRequired === "boolean") &&
		(value.cancellationId === undefined ||
			value.cancellationId === null ||
			typeof value.cancellationId === "string") &&
		typeof accepted?.revision === "number" &&
		Number.isSafeInteger(accepted.revision) &&
		accepted.revision >= 1 &&
		typeof accepted.revisionId === "string" &&
		typeof accepted.contentHash === "string" &&
		typeof accepted.envelopeHash === "string" &&
		typeof accepted.keyId === "string" &&
		typeof accepted.acceptedAt === "string" &&
		typeof accepted.capabilityApprovedAt === "string" &&
		Array.isArray(value.trustedSigningKeys) &&
		value.trustedSigningKeys.every(validTrustedKey) &&
		Array.isArray(value.worktrees) &&
		value.worktrees.every(validAgenticWorktree) &&
		typeof value.completionTests === "object" &&
		value.completionTests !== null &&
		Object.values(value.completionTests).every(
			(tests) => Array.isArray(tests) && tests.every(validCompletionTest),
		) &&
		typeof value.startedAt === "string" &&
		typeof value.lastActivityAt === "string" &&
		typeof value.updatedAt === "string"
	);
}

export function loadActiveAgenticRun(
	path?: string,
	orgId?: string,
	piSessionId?: string,
): ActiveAgenticDeliveryRun | null {
	if (!path && (!orgId || !piSessionId)) return null;
	const resolvedPath = path ?? agenticRunPath(orgId!, piSessionId!);
	try {
		const parsed = JSON.parse(readFileSync(resolvedPath, "utf-8"));
		if (!validAgentic(parsed)) return null;
		if (orgId && parsed.orgId !== orgId) return null;
		if (piSessionId && parsed.piSessionId !== piSessionId) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function saveActiveAgenticRun(
	state: ActiveAgenticDeliveryRun,
	path?: string,
): void {
	saveJson(state, path ?? agenticRunPath(state.orgId, state.piSessionId));
}

function validCapabilityEnvelope(value: any): value is CapabilityEnvelope {
	return (
		Array.isArray(value?.workspace_scopes) &&
		Array.isArray(value.allowed_tools) &&
		Array.isArray(value.allowed_model_policies) &&
		Array.isArray(value.executable_step_types) &&
		Array.isArray(value.protected_paths)
	);
}

function validProjectSync(value: any): value is ProjectAgentSyncState {
	return (
		value?.version === 1 &&
		typeof value.orgId === "string" &&
		typeof value.projectId === "string" &&
		Number.isSafeInteger(value.acceptedRevision) &&
		value.acceptedRevision >= 1 &&
		typeof value.acceptedRevisionId === "string" &&
		typeof value.contentHash === "string" &&
		typeof value.envelopeHash === "string" &&
		validCapabilityEnvelope(value.capabilityEnvelope) &&
		Array.isArray(value.trustedSigningKeys) &&
		value.trustedSigningKeys.every(validTrustedKey) &&
		typeof value.updatedAt === "string"
	);
}

export function loadProjectAgentSync(
	path?: string,
	orgId?: string,
	projectId?: string,
): ProjectAgentSyncState | null {
	if (!path && (!orgId || !projectId)) return null;
	const resolvedPath = path ?? projectAgentSyncPath(orgId!, projectId!);
	try {
		const parsed = JSON.parse(readFileSync(resolvedPath, "utf-8"));
		if (!validProjectSync(parsed)) return null;
		if (orgId && parsed.orgId !== orgId) return null;
		if (projectId && parsed.projectId !== projectId) return null;
		return parsed;
	} catch {
		return null;
	}
}

export function saveProjectAgentSync(
	state: ProjectAgentSyncState,
	path?: string,
): void {
	saveJson(state, path ?? projectAgentSyncPath(state.orgId, state.projectId));
}

export function clearActiveAgenticRun(
	runId: string,
	path?: string,
	orgId?: string,
	piSessionId?: string,
): void {
	if (!path && (!orgId || !piSessionId)) return;
	const resolvedPath = path ?? agenticRunPath(orgId!, piSessionId!);
	const current = loadActiveAgenticRun(resolvedPath);
	if (!current || current.runId !== runId) return;
	rmSync(resolvedPath, { force: true });
}

export function getOrCreatePiClientId(
	path = join(homedir(), ".takonaut", "pi-client-id"),
): string {
	try {
		const raw = readFileSync(path, "utf-8").trim();
		let existing = raw;
		try {
			const parsed = JSON.parse(raw);
			if (typeof parsed === "string") existing = parsed;
		} catch {
			// Accept the original plain-text form too.
		}
		if (/^[0-9a-f-]{36}$/i.test(existing)) return existing;
	} catch {
		// Create it below.
	}
	const id = randomUUID();
	saveJson(id, path);
	return id;
}
