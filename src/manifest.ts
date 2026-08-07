import {
	createHash,
	createPublicKey,
	timingSafeEqual,
	verify,
} from "node:crypto";
import { isAbsolute, posix } from "node:path";

export interface WorkspaceScope {
	id: string;
	repository_fingerprint: string;
	subpath: string;
}

export interface CapabilityEnvelope {
	workspace_scopes: WorkspaceScope[];
	allowed_tools: string[];
	allowed_model_policies: string[];
	executable_step_types: string[];
	protected_paths: string[];
}

export interface AgenticManifestWorkspace {
	id: string;
	repository_fingerprint: string;
	subpath: string;
	[key: string]: unknown;
}

export interface AgenticManifestContent {
	code_workspaces: AgenticManifestWorkspace[];
	[key: string]: unknown;
}

export interface AgenticManifestPayload {
	manifest_schema_version: number;
	minimum_extension_version: string;
	organization_id: string;
	project_id: string;
	revision_id: string;
	revision: number;
	content_hash: string;
	capability_envelope_hash: string;
	capability_envelope: CapabilityEnvelope;
	content: AgenticManifestContent;
	issued_at: string;
	expires_at: string;
}

export interface SignedAgenticManifest {
	algorithm: string;
	key_id: string;
	payload_hash: string;
	payload: AgenticManifestPayload;
	signature_b64: string;
}

export interface TrustedSigningKey {
	keyId: string;
	publicKeyB64: string;
	status: "active" | "next" | "retired" | "revoked";
	validFrom: string;
	validUntil: string | null;
}

export interface AdvertisedSigningKey {
	key_id: string;
	public_key_b64: string;
	status: "active" | "next" | "retired" | "revoked";
	valid_from: string;
	valid_until: string | null;
}

export function reconcileTrustedSigningKeys(
	trustedKeys: TrustedSigningKey[],
	advertisedKeys: AdvertisedSigningKey[],
): TrustedSigningKey[] {
	const advertisedById = new Map<string, AdvertisedSigningKey>();
	for (const advertised of advertisedKeys) {
		const duplicate = advertisedById.get(advertised.key_id);
		if (
			duplicate &&
			!sameText(duplicate.public_key_b64, advertised.public_key_b64)
		) {
			throw new Error(
				"Signing-key advertisement contains a conflicting key ID",
			);
		}
		advertisedById.set(advertised.key_id, advertised);
	}
	return trustedKeys.map((trusted) => {
		const advertised = advertisedById.get(trusted.keyId);
		if (!advertised) return trusted;
		if (!sameText(trusted.publicKeyB64, advertised.public_key_b64)) {
			throw new Error("A trusted signing-key ID changed public key material");
		}
		return {
			keyId: trusted.keyId,
			publicKeyB64: trusted.publicKeyB64,
			status: advertised.status,
			validFrom: advertised.valid_from,
			validUntil: advertised.valid_until,
		};
	});
}

export interface ManifestVerificationExpectation {
	organizationId: string;
	projectId: string;
	minimumRevision: number;
	extensionVersion: string;
	now?: Date;
}

export interface VerifiedAgenticManifest {
	manifest: SignedAgenticManifest;
	revision: number;
	contentHash: string;
	envelopeHash: string;
	keyId: string;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const HASH_RE = /^[0-9a-f]{64}$/;
const ID_RE = /^[a-z][a-z0-9_-]{0,79}$/;
const GRAPH_MANIFEST_SCHEMA_VERSION = 2;
const GRAPH_MINIMUM_EXTENSION_VERSION = "0.3.0";

function normalizeJson(value: unknown): unknown {
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	) {
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("Manifest contains a non-finite number");
		return value;
	}
	if (Array.isArray(value)) return value.map(normalizeJson);
	if (typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, normalizeJson(item)]),
		);
	}
	throw new Error("Manifest contains a non-JSON value");
}

export function canonicalJson(value: unknown): string {
	return JSON.stringify(normalizeJson(value));
}

export function hashCanonicalJson(value: unknown): string {
	return createHash("sha256")
		.update(canonicalJson(value), "utf8")
		.digest("hex");
}

function sameText(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left, "utf8");
	const rightBytes = Buffer.from(right, "utf8");
	return (
		leftBytes.length === rightBytes.length &&
		timingSafeEqual(leftBytes, rightBytes)
	);
}

function parseSemver(value: string): [number, number, number] {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
	if (!match) throw new Error(`Invalid extension version: ${value}`);
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual: string, minimum: string): boolean {
	const left = parseSemver(actual);
	const right = parseSemver(minimum);
	for (let index = 0; index < left.length; index += 1) {
		if (left[index] !== right[index]) return left[index] > right[index];
	}
	return true;
}

function parseDate(value: string, label: string): Date {
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime()))
		throw new Error(`Invalid manifest ${label}`);
	return parsed;
}

function safeRelativePath(value: string): boolean {
	if (!value || value.includes("\\") || isAbsolute(value)) return false;
	const normalized = posix.normalize(value);
	return (
		normalized === value &&
		!value.split("/").some((part) => part === ".." || part === "")
	);
}

function validateEnvelope(envelope: CapabilityEnvelope): void {
	if (
		!Array.isArray(envelope.workspace_scopes) ||
		envelope.workspace_scopes.length === 0
	) {
		throw new Error("Manifest has no bounded Workspace scope");
	}
	for (const scope of envelope.workspace_scopes) {
		if (!ID_RE.test(scope.id) || !scope.repository_fingerprint) {
			throw new Error("Manifest Workspace scope is invalid");
		}
		if (scope.subpath !== "." && !safeRelativePath(scope.subpath)) {
			throw new Error("Manifest Workspace scope escapes its repository");
		}
	}
	for (const path of envelope.protected_paths) {
		if (!safeRelativePath(path))
			throw new Error("Manifest protected path is unsafe");
	}
}

function validateContent(content: AgenticManifestContent): void {
	if (
		!Array.isArray(content.code_workspaces) ||
		content.code_workspaces.length === 0
	) {
		throw new Error("Manifest has no Code Workspace");
	}
	const encoded = canonicalJson(content);
	for (const forbidden of [
		'"command":',
		'"shell_command":',
		'"mcp_servers":',
		'"credential_files":',
		'"recursive_capabilities":',
	]) {
		if (encoded.includes(forbidden))
			throw new Error("Manifest contains a forbidden capability");
	}
	for (const workspace of content.code_workspaces) {
		if (!ID_RE.test(workspace.id) || !workspace.repository_fingerprint) {
			throw new Error("Manifest Code Workspace is invalid");
		}
		if (workspace.subpath !== "." && !safeRelativePath(workspace.subpath)) {
			throw new Error("Manifest Code Workspace path is unsafe");
		}
	}
}

export function verifyAgenticManifest(
	manifest: SignedAgenticManifest,
	trustedKeys: TrustedSigningKey[],
	expected: ManifestVerificationExpectation,
): VerifiedAgenticManifest {
	if (manifest.algorithm !== "Ed25519")
		throw new Error("Unsupported manifest signature algorithm");
	const schemaVersion = manifest.payload.manifest_schema_version;
	if (schemaVersion !== 1 && schemaVersion !== GRAPH_MANIFEST_SCHEMA_VERSION)
		throw new Error("Unsupported manifest schema version");
	if (
		schemaVersion === GRAPH_MANIFEST_SCHEMA_VERSION &&
		!versionAtLeast(
			manifest.payload.minimum_extension_version,
			GRAPH_MINIMUM_EXTENSION_VERSION,
		)
	) {
		throw new Error("Graph manifest minimum extension version is invalid");
	}
	if (manifest.payload.organization_id !== expected.organizationId)
		throw new Error("Manifest organization identity mismatch");
	if (manifest.payload.project_id !== expected.projectId)
		throw new Error("Manifest Project identity mismatch");
	if (
		!Number.isSafeInteger(manifest.payload.revision) ||
		manifest.payload.revision < 1
	) {
		throw new Error("Manifest revision is invalid");
	}
	if (manifest.payload.revision < expected.minimumRevision)
		throw new Error("Manifest revision downgrade rejected");
	if (
		!versionAtLeast(
			expected.extensionVersion,
			manifest.payload.minimum_extension_version,
		)
	) {
		throw new Error(
			"Pi extension version does not satisfy the manifest minimum",
		);
	}

	const now = expected.now ?? new Date();
	const issuedAt = parseDate(manifest.payload.issued_at, "issued_at");
	const expiresAt = parseDate(manifest.payload.expires_at, "expires_at");
	if (issuedAt.getTime() > now.getTime() + 5 * 60_000)
		throw new Error("Manifest is not yet valid");
	if (expiresAt.getTime() <= now.getTime())
		throw new Error("Manifest is expired");
	if (expiresAt <= issuedAt)
		throw new Error("Manifest validity window is invalid");

	const key = trustedKeys.find(
		(candidate) => candidate.keyId === manifest.key_id,
	);
	if (!key) throw new Error("Manifest signing key is unknown");
	if (key.status === "revoked")
		throw new Error("Manifest signing key is revoked");
	if (key.status === "retired" && !key.validUntil)
		throw new Error("Retired manifest signing key has no expiry");
	const keyValidFrom = parseDate(key.validFrom, "key valid_from");
	if (keyValidFrom > issuedAt)
		throw new Error("Manifest predates its signing key");
	if (key.validUntil && parseDate(key.validUntil, "key valid_until") <= now) {
		throw new Error("Manifest signing key is expired");
	}

	validateEnvelope(manifest.payload.capability_envelope);
	validateContent(manifest.payload.content);
	const contentHash = hashCanonicalJson(manifest.payload.content);
	const envelopeHash = hashCanonicalJson(manifest.payload.capability_envelope);
	if (
		!HASH_RE.test(manifest.payload.content_hash) ||
		!sameText(contentHash, manifest.payload.content_hash)
	) {
		throw new Error("Manifest content hash mismatch");
	}
	if (
		!HASH_RE.test(manifest.payload.capability_envelope_hash) ||
		!sameText(envelopeHash, manifest.payload.capability_envelope_hash)
	) {
		throw new Error("Manifest capability envelope hash mismatch");
	}

	const payloadBytes = Buffer.from(canonicalJson(manifest.payload), "utf8");
	const payloadHash = createHash("sha256").update(payloadBytes).digest("hex");
	if (
		!HASH_RE.test(manifest.payload_hash) ||
		!sameText(payloadHash, manifest.payload_hash)
	) {
		throw new Error("Manifest payload hash mismatch");
	}
	const rawPublicKey = Buffer.from(key.publicKeyB64, "base64");
	if (rawPublicKey.length !== 32)
		throw new Error("Trusted Ed25519 public key is invalid");
	const publicKey = createPublicKey({
		key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
		format: "der",
		type: "spki",
	});
	const signature = Buffer.from(manifest.signature_b64, "base64");
	if (
		signature.length !== 64 ||
		!verify(null, payloadBytes, publicKey, signature)
	) {
		throw new Error("Manifest signature is invalid");
	}
	return {
		manifest,
		revision: manifest.payload.revision,
		contentHash,
		envelopeHash,
		keyId: manifest.key_id,
	};
}

function stringSet(value: string[]): Set<string> {
	return new Set(Array.isArray(value) ? value : []);
}

export function capabilityExpansionRequired(
	current: CapabilityEnvelope | null,
	candidate: CapabilityEnvelope,
): boolean {
	if (!current) return true;
	for (const key of [
		"allowed_tools",
		"allowed_model_policies",
		"executable_step_types",
	] as const) {
		const approved = stringSet(current[key]);
		if (candidate[key].some((value) => !approved.has(value))) return true;
	}
	const approvedScopes = new Map(
		current.workspace_scopes.map((scope) => [
			`${scope.id}\0${scope.repository_fingerprint}`,
			scope.subpath,
		]),
	);
	for (const scope of candidate.workspace_scopes) {
		const approvedSubpath = approvedScopes.get(
			`${scope.id}\0${scope.repository_fingerprint}`,
		);
		if (approvedSubpath === undefined || approvedSubpath !== scope.subpath)
			return true;
	}
	const candidateProtected = stringSet(candidate.protected_paths);
	return current.protected_paths.some((path) => !candidateProtected.has(path));
}
