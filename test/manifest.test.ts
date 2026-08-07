import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	canonicalJson,
	capabilityExpansionRequired,
	hashCanonicalJson,
	reconcileTrustedSigningKeys,
	verifyAgenticManifest,
	type SignedAgenticManifest,
	type TrustedSigningKey,
} from "../src/manifest";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const publicKeyB64 = publicKey
	.export({ format: "der", type: "spki" })
	.subarray(-32)
	.toString("base64");

function signedManifest(
	overrides: Record<string, unknown> = {},
): SignedAgenticManifest {
	const content = {
		code_workspaces: [
			{
				id: "api",
				repository_fingerprint: "github:123:takonaut/api",
				subpath: "backend",
			},
		],
	};
	const capabilityEnvelope = {
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
	};
	const payload = {
		manifest_schema_version: 1,
		minimum_extension_version: "0.2.0",
		organization_id: "org-1",
		project_id: "project-1",
		revision_id: "revision-1",
		revision: 1,
		content_hash: hashCanonicalJson(content),
		capability_envelope_hash: hashCanonicalJson(capabilityEnvelope),
		capability_envelope: capabilityEnvelope,
		content,
		issued_at: "2026-07-17T00:00:00Z",
		expires_at: "2026-08-16T00:00:00Z",
		...overrides,
	};
	const bytes = Buffer.from(canonicalJson(payload));
	return {
		algorithm: "Ed25519",
		key_id: "key-2026-01",
		payload_hash: hashCanonicalJson(payload),
		payload,
		signature_b64: sign(null, bytes, privateKey).toString("base64"),
	};
}

const trustedKey: TrustedSigningKey = {
	keyId: "key-2026-01",
	publicKeyB64,
	status: "active",
	validFrom: "2026-01-01T00:00:00Z",
	validUntil: "2027-01-01T00:00:00Z",
};

const expected = {
	organizationId: "org-1",
	projectId: "project-1",
	minimumRevision: 0,
	extensionVersion: "0.2.0",
	now: new Date("2026-07-18T00:00:00Z"),
};

describe("signed Agentic Delivery manifests", () => {
	it("verifies canonical content, identity, signature, expiry, and trusted key", () => {
		const result = verifyAgenticManifest(
			signedManifest(),
			[trustedKey],
			expected,
		);
		expect(result.revision).toBe(1);
		expect(result.keyId).toBe("key-2026-01");
		expect(result.contentHash).toHaveLength(64);
	});

	it("accepts schema-v2 graph manifests only at extension 0.3.0 or newer", () => {
		const graph = signedManifest({
			manifest_schema_version: 2,
			minimum_extension_version: "0.3.0",
		});
		expect(
			verifyAgenticManifest(graph, [trustedKey], {
				...expected,
				extensionVersion: "0.3.0",
			}).revision,
		).toBe(1);
		expect(() =>
			verifyAgenticManifest(graph, [trustedKey], {
				...expected,
				extensionVersion: "0.2.9",
			}),
		).toThrow(/does not satisfy/i);
	});

	it("preserves schema-v1 verification and rejects an invalid graph minimum", () => {
		expect(
			verifyAgenticManifest(signedManifest(), [trustedKey], expected).revision,
		).toBe(1);
		expect(() =>
			verifyAgenticManifest(
				signedManifest({
					manifest_schema_version: 2,
					minimum_extension_version: "0.2.0",
				}),
				[trustedKey],
				{ ...expected, extensionVersion: "0.3.0" },
			),
		).toThrow(/minimum/i);
	});

	it("verifies the Python backend canonical-signing golden vector", () => {
		const manifest = {
			algorithm: "Ed25519",
			key_id: "golden-key",
			payload_hash:
				"5991f330cefa6b99619ec76e7384c0f5e541e679e9170e807e8258597145d65c",
			signature_b64:
				"Y/pI0ZXI66RuL1qs+BXdC1S6IHRZOcICBNXJi7DTI+qZW8pJRAG6v8FY9TQKdZL+74UsWsECYWWMpIOZaCKUBg==",
			payload: {
				manifest_schema_version: 1,
				minimum_extension_version: "0.2.0",
				organization_id: "org-golden",
				project_id: "project-golden",
				revision_id: "revision-golden",
				revision: 7,
				content_hash:
					"68d292806bf3e93a81963e834dcfef7d4b39a40907a2e90211ed98446b38d4d8",
				capability_envelope_hash:
					"859ffad24c1f63ae9e2d6ae90eb9dccdd3d026fc9ce96bfde3ec35a6e3888df3",
				capability_envelope: {
					workspace_scopes: [
						{
							id: "api",
							repository_fingerprint: "github:123:takonaut/api",
							subpath: "backend",
						},
					],
					allowed_tools: ["edit", "read"],
					allowed_model_policies: ["sonnet"],
					executable_step_types: ["edit", "inspect", "test"],
					protected_paths: [".env", ".git"],
				},
				content: {
					code_workspaces: [
						{
							id: "api",
							repository_fingerprint: "github:123:takonaut/api",
							subpath: "backend",
						},
					],
				},
				issued_at: "2026-07-17T00:00:00Z",
				expires_at: "2026-08-16T00:00:00Z",
			},
		} satisfies SignedAgenticManifest;
		const result = verifyAgenticManifest(
			manifest,
			[
				{
					keyId: "golden-key",
					publicKeyB64: "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
					status: "active",
					validFrom: "2026-01-01T00:00:00Z",
					validUntil: null,
				},
			],
			{
				organizationId: "org-golden",
				projectId: "project-golden",
				minimumRevision: 6,
				extensionVersion: "0.2.0",
				now: new Date("2026-07-18T00:00:00Z"),
			},
		);
		expect(result.revision).toBe(7);
	});

	it.each([
		[
			"tampered content",
			(manifest: SignedAgenticManifest) => {
				manifest.payload.content.code_workspaces[0].subpath = "../outside";
			},
		],
		[
			"identity mismatch",
			(manifest: SignedAgenticManifest) => {
				manifest.payload.organization_id = "other-org";
			},
		],
		[
			"revision downgrade",
			(manifest: SignedAgenticManifest) => {
				manifest.payload.revision = 0;
			},
		],
	])("rejects %s before local writes", (_label, mutate) => {
		const manifest = signedManifest();
		mutate(manifest);
		expect(() =>
			verifyAgenticManifest(manifest, [trustedKey], {
				...expected,
				minimumRevision: 1,
			}),
		).toThrow();
	});

	it("applies authenticated revocation metadata to already pinned keys", () => {
		const reconciled = reconcileTrustedSigningKeys(
			[trustedKey],
			[
				{
					key_id: trustedKey.keyId,
					public_key_b64: trustedKey.publicKeyB64,
					status: "revoked",
					valid_from: trustedKey.validFrom,
					valid_until: "2026-07-17T00:00:00Z",
				},
			],
		);
		expect(reconciled[0].status).toBe("revoked");
		expect(() =>
			reconcileTrustedSigningKeys(
				[trustedKey],
				[
					{
						key_id: trustedKey.keyId,
						public_key_b64: Buffer.alloc(32, 7).toString("base64"),
						status: "active",
						valid_from: trustedKey.validFrom,
						valid_until: null,
					},
				],
			),
		).toThrow(/changed public key/i);
	});

	it("accepts a retired key only during its bounded overlap", () => {
		expect(
			verifyAgenticManifest(
				signedManifest(),
				[{ ...trustedKey, status: "retired" }],
				expected,
			).revision,
		).toBe(1);
		expect(() =>
			verifyAgenticManifest(
				signedManifest(),
				[{ ...trustedKey, status: "retired", validUntil: null }],
				expected,
			),
		).toThrow(/no expiry/i);
	});

	it("rejects unknown, revoked, and expired signing keys", () => {
		const manifest = signedManifest();
		expect(() => verifyAgenticManifest(manifest, [], expected)).toThrow(
			/unknown/i,
		);
		expect(() =>
			verifyAgenticManifest(
				manifest,
				[{ ...trustedKey, status: "revoked" }],
				expected,
			),
		).toThrow(/revoked/i);
		expect(() =>
			verifyAgenticManifest(
				manifest,
				[{ ...trustedKey, validUntil: "2026-07-01T00:00:00Z" }],
				expected,
			),
		).toThrow(/expired/i);
	});

	it("classifies authority widening separately from content-only changes", () => {
		const current = signedManifest().payload.capability_envelope;
		expect(capabilityExpansionRequired(current, { ...current })).toBe(false);
		expect(
			capabilityExpansionRequired(current, {
				...current,
				allowed_tools: [...current.allowed_tools, "bash"],
			}),
		).toBe(true);
		expect(
			capabilityExpansionRequired(current, {
				...current,
				protected_paths: [".git"],
			}),
		).toBe(true);
	});
});
