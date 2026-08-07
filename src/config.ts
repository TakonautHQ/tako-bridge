// Secure, organization-profiled Takonaut connection and repository configuration.
//
// Non-secret repository settings live in bridge.json. Bearer credentials live in
// an owner-only credentials.json beside it. Legacy flat files are migrated only
// when their existing ownership/mode is already safe.

import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bridgeServerUrl } from "./server-url.js";

export interface ProjectRepoMapping {
	projectId: string;
	repoRoot: string;
	remoteFingerprint: string;
	linkedAt: string;
}

export interface TakonautConfig {
	serverUrl: string;
	apiKey: string;
	orgId: string;
	repoRoot: string;
	protectedBranches: string[];
	projectRepos: Record<string, ProjectRepoMapping>;
	expiresAt?: string;
	orgName?: string;
	credentialSource: "environment" | "secure file";
	configPath: string;
	credentialPath: string;
}

interface CredentialProfile {
	serverUrl: string;
	apiKey: string;
	orgId: string;
	expiresAt?: string;
	orgName?: string;
}

interface CredentialFile {
	version: 2;
	activeOrgId: string;
	profiles: Record<string, CredentialProfile>;
}

interface BridgeFile {
	version?: number;
	repoRoot?: string;
	protectedBranches?: string[];
	projectRepos?: Record<string, ProjectRepoMapping>;
	// v1 migration-only fields. They are removed from bridge.json after migration.
	mcp?: {
		serverUrl?: string;
		apiKey?: string;
		orgId?: string;
		expiresAt?: string;
	};
	serverUrl?: string;
	apiKey?: string;
	orgId?: string;
	expiresAt?: string;
}

export const BRIDGE_CONFIG_PATH = join(homedir(), ".takonaut", "bridge.json");
export const BRIDGE_CREDENTIALS_PATH = join(
	homedir(),
	".takonaut",
	"credentials.json",
);

export function credentialsPathForConfig(configPath: string): string {
	return join(dirname(configPath), "credentials.json");
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

function assertOwned(path: string, kind: string): void {
	const currentUid =
		typeof process.getuid === "function" ? process.getuid() : undefined;
	if (currentUid !== undefined && statSync(path).uid !== currentUid) {
		throw new Error(`${kind} is not owned by the current user: ${path}`);
	}
}

function assertSecureDirectory(path: string): void {
	assertOwned(path, "Bridge credential directory");
	if ((mode(path) & 0o077) !== 0) {
		throw new Error(
			`Unsafe Bridge credential directory. Run: chmod 700 ${path}`,
		);
	}
}

function assertSecureFile(path: string): void {
	assertSecureDirectory(dirname(path));
	const info = lstatSync(path);
	if (info.isSymbolicLink() || !info.isFile()) {
		throw new Error(`Bridge credential path must be a regular file: ${path}`);
	}
	assertOwned(path, "Bridge credential file");
	if ((info.mode & 0o077) !== 0) {
		throw new Error(`Unsafe Bridge credential file. Run: chmod 600 ${path}`);
	}
}

function readJson<T>(path: string, label: string, secret = false): T | null {
	if (!existsSync(path)) return null;
	if (secret) assertSecureFile(path);
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (error) {
		throw new Error(`Cannot read ${label} at ${path}: ${String(error)}`);
	}
	try {
		return JSON.parse(raw) as T;
	} catch {
		throw new Error(
			`Malformed ${label} at ${path}; fix or move the file before retrying.`,
		);
	}
}

function writeJson(path: string, value: unknown, secret: boolean): void {
	const parent = dirname(path);
	mkdirSync(parent, { recursive: true, mode: 0o700 });
	if (secret) assertSecureDirectory(parent);
	if (existsSync(path) && secret) assertSecureFile(path);

	const tmp = join(
		parent,
		`.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
	);
	try {
		writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
			mode: secret ? 0o600 : 0o600,
		});
		chmodSync(tmp, secret ? 0o600 : 0o600);
		renameSync(tmp, path);
		chmodSync(path, secret ? 0o600 : 0o600);
	} finally {
		rmSync(tmp, { force: true });
	}
}

function legacyProfile(file: BridgeFile): CredentialProfile | null {
	const serverUrl = file.mcp?.serverUrl ?? file.serverUrl;
	const apiKey = file.mcp?.apiKey ?? file.apiKey;
	const orgId = file.mcp?.orgId ?? file.orgId;
	const expiresAt = file.mcp?.expiresAt ?? file.expiresAt;
	return serverUrl && apiKey && orgId
		? { serverUrl, apiKey, orgId, expiresAt }
		: null;
}

function sanitizedBridge(file: BridgeFile): BridgeFile {
	const clean: BridgeFile = {
		version: 2,
		...(file.repoRoot ? { repoRoot: file.repoRoot } : {}),
		...(file.protectedBranches
			? { protectedBranches: file.protectedBranches }
			: {}),
		...(file.projectRepos ? { projectRepos: file.projectRepos } : {}),
	};
	return clean;
}

function migrateV1(
	configPath: string,
	credentialPath: string,
	file: BridgeFile,
): { bridge: BridgeFile; credentials: CredentialFile | null } {
	const profile = legacyProfile(file);
	if (!profile) {
		return {
			bridge: file.version === 2 ? file : sanitizedBridge(file),
			credentials: readJson<CredentialFile>(
				credentialPath,
				"Bridge credentials",
				true,
			),
		};
	}

	// The old file contains a bearer secret, so never read-and-migrate it from an
	// unsafe mode/owner. This gives an actionable remediation instead of silently
	// blessing an exposed credential.
	assertSecureFile(configPath);
	const existing = readJson<CredentialFile>(
		credentialPath,
		"Bridge credentials",
		true,
	);
	const credentials: CredentialFile = {
		version: 2,
		activeOrgId: profile.orgId,
		profiles: { ...(existing?.profiles ?? {}), [profile.orgId]: profile },
	};
	const bridge = sanitizedBridge(file);
	writeJson(credentialPath, credentials, true);
	const verified = readJson<CredentialFile>(
		credentialPath,
		"Bridge credentials",
		true,
	);
	if (verified?.profiles?.[profile.orgId]?.apiKey !== profile.apiKey) {
		throw new Error(
			"Bridge credential migration could not be verified; the v1 file was preserved.",
		);
	}
	// Keep an owner-only rollback copy outside the repository/config path before
	// removing bearer fields from the legacy file.
	writeJson(`${credentialPath}.v1-backup`, file, true);
	writeJson(configPath, bridge, false);
	return { bridge, credentials };
}

function readFiles(
	configPath: string,
	credentialPath: string,
): { bridge: BridgeFile; credentials: CredentialFile | null } {
	const rawBridge = readJson<BridgeFile>(configPath, "Bridge config") ?? {
		version: 2,
	};
	return migrateV1(configPath, credentialPath, rawBridge);
}

export function saveConfig(
	partial: CredentialProfile,
	path: string = BRIDGE_CONFIG_PATH,
	credentialPath: string = credentialsPathForConfig(path),
): void {
	bridgeServerUrl(partial.serverUrl, "Takonaut MCP URL");
	const { bridge, credentials } = readFiles(path, credentialPath);
	const updatedCredentials: CredentialFile = {
		version: 2,
		activeOrgId: partial.orgId,
		profiles: { ...(credentials?.profiles ?? {}), [partial.orgId]: partial },
	};
	writeJson(path, sanitizedBridge(bridge), false);
	writeJson(credentialPath, updatedCredentials, true);
}

export function projectRepoMappingKey(
	orgId: string,
	projectId: string,
): string {
	return `${orgId}:${projectId}`;
}

export function saveProjectRepoMapping(
	orgId: string,
	projectId: string,
	mapping: ProjectRepoMapping,
	path: string = BRIDGE_CONFIG_PATH,
	credentialPath: string = credentialsPathForConfig(path),
	workspaceKey?: string,
): void {
	const { bridge, credentials } = readFiles(path, credentialPath);
	const env = environmentCredential();
	if (!credentials?.profiles?.[orgId] && env?.orgId !== orgId) {
		throw new Error(
			"Cannot persist the repository mapping without a canonical login. Run /tako-login and retry.",
		);
	}
	const projectKey = projectRepoMappingKey(orgId, projectId);
	const key = workspaceKey ? `${projectKey}:${workspaceKey}` : projectKey;
	writeJson(
		path,
		{
			...sanitizedBridge(bridge),
			projectRepos: { ...bridge.projectRepos, [key]: mapping },
		},
		false,
	);
}

export function readProjectRepoMapping(
	orgId: string,
	projectId: string,
	path: string = BRIDGE_CONFIG_PATH,
): ProjectRepoMapping | null {
	const bridge = readJson<BridgeFile>(path, "Bridge config") ?? {};
	return bridge.projectRepos?.[projectRepoMappingKey(orgId, projectId)] ?? null;
}

function environmentCredential(): CredentialProfile | null {
	const values = [
		process.env.TAKONAUT_MCP_URL,
		process.env.TAKONAUT_API_KEY,
		process.env.TAKONAUT_ORG_ID,
	];
	const supplied = values.filter(Boolean).length;
	if (supplied > 0 && supplied < values.length) {
		throw new Error(
			"Partial Takonaut environment credentials. Set TAKONAUT_MCP_URL, " +
				"TAKONAUT_API_KEY, and TAKONAUT_ORG_ID together.",
		);
	}
	if (supplied === 0) return null;
	bridgeServerUrl(values[0]!, "Takonaut MCP URL");
	return {
		serverUrl: values[0]!,
		apiKey: values[1]!,
		orgId: values[2]!,
	};
}

export function loadConfigFromFiles(
	configPath: string,
	credentialPath: string = credentialsPathForConfig(configPath),
): TakonautConfig | null {
	const { bridge, credentials } = readFiles(configPath, credentialPath);
	const env = environmentCredential();
	const orgId =
		env?.orgId ?? process.env.TAKONAUT_ORG_ID ?? credentials?.activeOrgId;
	const profile = env ?? (orgId ? credentials?.profiles?.[orgId] : undefined);
	if (!profile) return null;
	bridgeServerUrl(profile.serverUrl, "Takonaut MCP URL");
	return {
		serverUrl: profile.serverUrl,
		apiKey: profile.apiKey,
		orgId: profile.orgId,
		expiresAt: profile.expiresAt,
		orgName: profile.orgName,
		credentialSource: env ? "environment" : "secure file",
		configPath,
		credentialPath,
		repoRoot:
			process.env.TAKONAUT_REPO_ROOT || bridge.repoRoot || process.cwd(),
		protectedBranches: bridge.protectedBranches?.length
			? bridge.protectedBranches
			: ["main", "master", "production", "release"],
		projectRepos: bridge.projectRepos ?? {},
	};
}

export function selectBridgeConfigPath(
	candidates: string[],
	projectLocalPath: string,
): string | undefined {
	// Non-secret config is authoritative for repository safety. Prefer any real
	// bridge.json (in precedence order) before considering a credential-only
	// profile; otherwise a canonical credential created by project-local v1
	// migration would hide that project's mappings on the next process start.
	return (
		candidates.find((path) => existsSync(path)) ??
		candidates.find(
			(path) =>
				path !== projectLocalPath && existsSync(credentialsPathForConfig(path)),
		)
	);
}

export function loadConfig(): TakonautConfig | null {
	const env = environmentCredential();
	const candidates = [
		BRIDGE_CONFIG_PATH,
		join(homedir(), ".takonaut.local", "bridge.json"),
		join(homedir(), ".pi", "bridge.json"),
		join(process.cwd(), ".takonaut.local", "bridge.json"),
	];
	const projectLocalPath = candidates[candidates.length - 1];
	const selected = selectBridgeConfigPath(candidates, projectLocalPath);
	if (selected) {
		// A project-local fallback may contain non-secret mappings, but its bearer
		// profile always lives in the canonical user credential store.
		const credentialPath =
			selected === projectLocalPath
				? BRIDGE_CREDENTIALS_PATH
				: credentialsPathForConfig(selected);
		return loadConfigFromFiles(selected, credentialPath);
	}
	if (!env) return null;
	return {
		serverUrl: env.serverUrl,
		apiKey: env.apiKey,
		orgId: env.orgId,
		credentialSource: "environment",
		configPath: BRIDGE_CONFIG_PATH,
		credentialPath: BRIDGE_CREDENTIALS_PATH,
		repoRoot: process.env.TAKONAUT_REPO_ROOT || process.cwd(),
		protectedBranches: ["main", "master", "production", "release"],
		projectRepos: {},
	};
}
