import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	credentialsPathForConfig,
	loadConfigFromFiles,
	projectRepoMappingKey,
	readProjectRepoMapping,
	saveConfig,
	saveProjectRepoMapping,
	selectBridgeConfigPath,
} from "../src/config";

const CREDS = {
	serverUrl: "https://x.test/mcp/",
	apiKey: "key-new",
	orgId: "org-1",
	expiresAt: "2026-08-13T00:00:00Z",
	orgName: "Cureocity",
};

describe("secure Bridge profiles", () => {
	let dir: string;
	let path: string;
	let credentialsPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "tako-config-"));
		path = join(dir, ".takonaut", "bridge.json");
		credentialsPath = credentialsPathForConfig(path);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("separates credentials from non-secret repository configuration", () => {
		saveConfig(CREDS, path);

		const bridge = JSON.parse(readFileSync(path, "utf-8"));
		const credentials = JSON.parse(readFileSync(credentialsPath, "utf-8"));
		expect(bridge).toEqual({ version: 2 });
		expect(JSON.stringify(bridge)).not.toContain("key-new");
		expect(credentials).toEqual({
			version: 2,
			activeOrgId: "org-1",
			profiles: { "org-1": CREDS },
		});
		expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
	});

	it("refuses to persist a personal key for an insecure server", () => {
		expect(() =>
			saveConfig({ ...CREDS, serverUrl: "http://takonaut.test/mcp/" }, path),
		).toThrow("requires HTTPS");
	});

	it("preserves non-secret settings and stores organization profiles independently", () => {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(
			path,
			JSON.stringify({
				version: 2,
				repoRoot: "/work/repo",
				protectedBranches: ["main", "release"],
			}),
		);
		saveConfig(CREDS, path);
		saveConfig(
			{
				serverUrl: "https://y.test/mcp/",
				apiKey: "key-two",
				orgId: "org-2",
				expiresAt: "2026-09-01T00:00:00Z",
			},
			path,
		);

		const bridge = JSON.parse(readFileSync(path, "utf-8"));
		expect(bridge).toEqual({
			version: 2,
			repoRoot: "/work/repo",
			protectedBranches: ["main", "release"],
		});
		const credentials = JSON.parse(readFileSync(credentialsPath, "utf-8"));
		expect(credentials.activeOrgId).toBe("org-2");
		expect(Object.keys(credentials.profiles).sort()).toEqual([
			"org-1",
			"org-2",
		]);
		expect(credentials.profiles["org-1"].apiKey).toBe("key-new");
	});

	it("stores repository mappings only in the non-secret file", () => {
		saveConfig(CREDS, path);
		const mapping = {
			projectId: "project-1",
			repoRoot: "/work/payments",
			remoteFingerprint: "github.com/cureocity/payments",
			linkedAt: "2026-07-14T00:00:00.000Z",
		};
		saveProjectRepoMapping("org-1", "project-1", mapping, path);

		expect(readProjectRepoMapping("org-1", "project-1", path)).toEqual(mapping);
		const bridge = JSON.parse(readFileSync(path, "utf-8"));
		expect(
			bridge.projectRepos[projectRepoMappingKey("org-1", "project-1")],
		).toEqual(mapping);
		expect(JSON.stringify(bridge)).not.toContain("key-new");
	});

	it("stores an independently approved mapping for a Code Workspace", () => {
		saveConfig(CREDS, path);
		const mapping = {
			projectId: "project-1",
			repoRoot: "/work/web",
			remoteFingerprint: "github.com/cureocity/web",
			linkedAt: "2026-07-17T00:00:00.000Z",
		};

		saveProjectRepoMapping(
			"org-1",
			"project-1",
			mapping,
			path,
			undefined,
			"web",
		);

		const bridge = JSON.parse(readFileSync(path, "utf-8"));
		expect(
			bridge.projectRepos[`${projectRepoMappingKey("org-1", "project-1")}:web`],
		).toEqual(mapping);
	});

	it("does not create a mapping-only canonical file without a credential profile", () => {
		expect(() =>
			saveProjectRepoMapping(
				"org-1",
				"project-1",
				{
					projectId: "project-1",
					repoRoot: "/work/payments",
					remoteFingerprint: "github.com/cureocity/payments",
					linkedAt: "2026-07-14T00:00:00.000Z",
				},
				path,
			),
		).toThrow("Run /tako-login");
	});

	it("reports malformed configuration instead of silently replacing it", () => {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, "{not-json");
		expect(() => loadConfigFromFiles(path, credentialsPath)).toThrow(
			"Malformed Bridge config",
		);
	});

	it("rejects an unsafe existing credential file mode", () => {
		saveConfig(CREDS, path);
		chmodSync(credentialsPath, 0o644);
		expect(() => loadConfigFromFiles(path, credentialsPath)).toThrow(
			"chmod 600",
		);
	});

	it("rejects credentials stored under an unsafe parent directory", () => {
		saveConfig(CREDS, path);
		chmodSync(dirname(credentialsPath), 0o777);
		expect(() => loadConfigFromFiles(path, credentialsPath)).toThrow(
			"chmod 700",
		);
	});

	it("prefers an existing project-local config over credential-only canonical state", () => {
		const canonicalConfig = join(dir, "home", ".takonaut", "bridge.json");
		const projectConfig = join(dir, "repo", ".takonaut.local", "bridge.json");
		mkdirSync(dirname(canonicalConfig), { recursive: true, mode: 0o700 });
		mkdirSync(dirname(projectConfig), { recursive: true, mode: 0o700 });
		writeFileSync(
			credentialsPathForConfig(canonicalConfig),
			JSON.stringify({
				version: 2,
				activeOrgId: "org-1",
				profiles: { "org-1": CREDS },
			}),
			{ mode: 0o600 },
		);
		writeFileSync(
			projectConfig,
			JSON.stringify({
				version: 2,
				repoRoot: "/persisted/root",
				protectedBranches: ["develop"],
			}),
		);

		expect(
			selectBridgeConfigPath([canonicalConfig, projectConfig], projectConfig),
		).toBe(projectConfig);
	});

	it("can migrate project-local settings into an external credential store", () => {
		const projectConfig = join(dir, "repo", ".takonaut.local", "bridge.json");
		const canonicalCredentials = join(
			dir,
			"home",
			".takonaut",
			"credentials.json",
		);
		mkdirSync(dirname(projectConfig), { recursive: true, mode: 0o700 });
		writeFileSync(
			projectConfig,
			JSON.stringify({
				serverUrl: CREDS.serverUrl,
				apiKey: CREDS.apiKey,
				orgId: CREDS.orgId,
				repoRoot: "/work/repo",
			}),
			{ mode: 0o600 },
		);

		const loaded = loadConfigFromFiles(projectConfig, canonicalCredentials);
		expect(loaded?.credentialPath).toBe(canonicalCredentials);
		expect(readFileSync(canonicalCredentials, "utf-8")).toContain("key-new");
		expect(() =>
			readFileSync(join(dirname(projectConfig), "credentials.json"), "utf-8"),
		).toThrow();
	});

	it("migrates a secure v1 flat file without losing settings or credentials", () => {
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(
			path,
			JSON.stringify({
				serverUrl: CREDS.serverUrl,
				apiKey: CREDS.apiKey,
				orgId: CREDS.orgId,
				repoRoot: "/work/repo",
				projectRepos: {},
			}),
			{ mode: 0o600 },
		);

		const loaded = loadConfigFromFiles(path, credentialsPath);
		expect(loaded?.apiKey).toBe("key-new");
		expect(loaded?.credentialSource).toBe("secure file");
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
			version: 2,
			repoRoot: "/work/repo",
			projectRepos: {},
		});
		expect(
			JSON.parse(readFileSync(credentialsPath, "utf-8")).profiles["org-1"]
				.apiKey,
		).toBe("key-new");
		const backup = JSON.parse(
			readFileSync(`${credentialsPath}.v1-backup`, "utf-8"),
		);
		expect(backup.apiKey).toBe("key-new");
		expect(statSync(`${credentialsPath}.v1-backup`).mode & 0o777).toBe(0o600);
	});
});
