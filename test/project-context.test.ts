import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/git";
import {
	ProjectContextError,
	describeCheckout,
	discoverWithLocalContext,
	expandWithLocalVerification,
	findContextCheckout,
	parseContextRepositories,
	verifyEvidence,
} from "../src/project-context";

const execFileAsync = promisify(execFile);
const run: CommandRunner = async (command, args, options) => {
	try {
		const result = await execFileAsync(command, args, {
			cwd: options?.cwd,
			timeout: options?.timeout,
		});
		return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
	} catch (error) {
		const failed = error as { stdout?: string; stderr?: string; code?: number };
		return {
			stdout: failed.stdout ?? "",
			stderr: failed.stderr ?? "",
			exitCode: typeof failed.code === "number" ? failed.code : 1,
		};
	}
};

async function git(cwd: string, ...args: string[]): Promise<string> {
	const result = await run("git", args, { cwd });
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

const sha256 = (value: string | Buffer) =>
	createHash("sha256").update(value).digest("hex");

const APP = "export function helper() {\n\treturn 1;\n}\n// tail\n";
const HELPER_START = 0;
const HELPER_END = APP.indexOf("}") + 1;
const REPOSITORY = {
	repository_id: "6f1c3a52-1111-4e2f-9a43-3f0e1d2c4b5a",
	owner: "Takonaut",
	name: "API",
	default_branch: "main",
	status: "ready",
	commit: null as string | null,
	published_at: "2026-10-09T00:00:00+00:00",
};

let root: string;
let repo: string;
let indexed: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "tako-project-context-"));
	repo = join(root, "api");
	mkdirSync(join(repo, "src"), { recursive: true });
	await git(repo, "init", "-q");
	await git(repo, "config", "user.email", "test@takonaut.test");
	await git(repo, "config", "user.name", "Takonaut Test");
	await git(repo, "remote", "add", "origin", "git@github.com:takonaut/api.git");
	writeFileSync(join(repo, "src/app.ts"), APP);
	await git(repo, "add", ".");
	await git(repo, "commit", "-q", "-m", "initial");
	indexed = await git(repo, "rev-parse", "HEAD");
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function symbolItem(overrides: Record<string, unknown> = {}) {
	return {
		ref: "s:22",
		type: "symbol",
		name: "helper",
		path: "src/app.ts",
		lines: [1, 3],
		bytes: [HELPER_START, HELPER_END],
		sha256: sha256(APP.slice(HELPER_START, HELPER_END)),
		file_sha256: sha256(APP),
		...overrides,
	};
}

function fileItem(overrides: Record<string, unknown> = {}) {
	return {
		ref: "f:4",
		type: "file",
		path: "src/app.ts",
		sha256: sha256(APP),
		...overrides,
	};
}

describe("repository listing", () => {
	it("accepts the server's listing and rejects malformed entries", () => {
		const parsed = parseContextRepositories({
			repositories: [{ ...REPOSITORY, commit: "a".repeat(40) }],
			truncated: false,
		});
		expect(parsed).toEqual([
			{
				repositoryId: REPOSITORY.repository_id,
				owner: "Takonaut",
				name: "API",
				status: "ready",
				commit: "a".repeat(40),
			},
		]);
		expect(() =>
			parseContextRepositories({ repositories: [{ ...REPOSITORY, owner: 1 }] }),
		).toThrow(ProjectContextError);
		expect(() => parseContextRepositories({ repositories: "x" })).toThrow(
			ProjectContextError,
		);
	});
});

describe("local checkouts", () => {
	const repository = {
		repositoryId: REPOSITORY.repository_id,
		owner: "Takonaut",
		name: "API",
		status: "ready",
		commit: null,
	};

	it("finds the checkout whose origin is the repository", async () => {
		const other = join(root, "other");
		mkdirSync(other);
		await git(other, "init", "-q");
		await git(other, "remote", "add", "origin", "https://github.com/x/y.git");
		expect(
			await findContextCheckout(
				run,
				[other, join(repo, "src"), join(root, "missing")],
				repository,
			),
		).toBe(await git(repo, "rev-parse", "--show-toplevel"));
		expect(await findContextCheckout(run, [other], repository)).toBeNull();
	});

	it("relates the local HEAD to the indexed commit", async () => {
		expect(await describeCheckout(run, repo, indexed)).toEqual({
			head: indexed,
			dirty: false,
			relation: "same_commit",
		});
		writeFileSync(join(repo, "src/app.ts"), `${APP}// more\n`);
		expect((await describeCheckout(run, repo, indexed)).dirty).toBe(true);
		await git(repo, "commit", "-q", "-am", "local work");
		expect((await describeCheckout(run, repo, indexed)).relation).toBe(
			"local_ahead",
		);
		const ahead = await git(repo, "rev-parse", "HEAD");
		await git(repo, "reset", "-q", "--hard", indexed);
		expect((await describeCheckout(run, repo, ahead)).relation).toBe(
			"local_behind",
		);
		writeFileSync(join(repo, "README.md"), "other\n");
		await git(repo, "add", ".");
		await git(repo, "commit", "-q", "-m", "diverge");
		expect((await describeCheckout(run, repo, ahead)).relation).toBe(
			"diverged",
		);
		expect((await describeCheckout(run, repo, "b".repeat(40))).relation).toBe(
			"indexed_commit_missing",
		);
		expect((await describeCheckout(run, repo, null)).relation).toBe("unknown");
		// A Git error (e.g. a shallow boundary) is not proof of divergence,
		// even when the reverse check succeeds.
		let failures = 0;
		const failing: CommandRunner = async (command, args, options) =>
			args.includes("merge-base") && failures++ === 0
				? { stdout: "", stderr: "fatal", exitCode: 128 }
				: run(command, args, options);
		expect((await describeCheckout(failing, repo, ahead)).relation).toBe(
			"unknown",
		);
	});
});

describe("evidence verification", () => {
	it("matches unchanged files and spans", async () => {
		const [file, symbol] = await verifyEvidence(repo, [
			fileItem(),
			symbolItem(),
		]);
		expect(file.local).toEqual({ state: "match" });
		expect(symbol.local).toEqual({ state: "match" });
	});

	it("keeps a span that is unchanged at the same offsets", async () => {
		writeFileSync(join(repo, "src/app.ts"), APP.replace("tail", "TAIL"));
		const [file, symbol] = await verifyEvidence(repo, [
			fileItem(),
			symbolItem(),
		]);
		expect(file.local).toEqual({ state: "modified" });
		expect(symbol.local).toEqual({ state: "span_match", lines: [1, 3] });
	});

	it("reports where a span moved to when lines shift before it", async () => {
		// The same bytes before the span, but one more newline locally.
		const indexedContent = `abcd\n${APP}`;
		writeFileSync(join(repo, "src/app.ts"), `ab\nc\n${APP}`);
		const [symbol] = await verifyEvidence(repo, [
			symbolItem({
				bytes: [5, 5 + HELPER_END],
				lines: [2, 4],
				file_sha256: sha256(indexedContent),
			}),
		]);
		expect(symbol.local).toEqual({ state: "span_match", lines: [3, 5] });
	});

	it("refuses special files and Windows-only path forms on Windows", async () => {
		await run("mkfifo", [join(repo, "src/pipe.ts")]);
		const [pipe] = await verifyEvidence(repo, [
			fileItem({ path: "src/pipe.ts" }),
		]);
		expect(pipe.local).toEqual({ state: "unverifiable" });
		const windows = await verifyEvidence(
			repo,
			["src/a:b.ts", "src/CON.ts", "src/app.ts."].map((path) =>
				fileItem({ path }),
			),
			"win32",
		);
		expect(windows.map((item) => item.local.state)).toEqual([
			"unverifiable",
			"unverifiable",
			"unverifiable",
		]);
		const [posix] = await verifyEvidence(
			repo,
			[fileItem({ path: "src/a:b.ts" })],
			"linux",
		);
		expect(posix.local).toEqual({ state: "missing" });
	});

	it("flags changed definitions, constants and missing files", async () => {
		writeFileSync(join(repo, "src/app.ts"), APP.replace("1", "2"));
		const [symbol, constant] = await verifyEvidence(repo, [
			symbolItem(),
			symbolItem({ ref: "s:11", sha256: null }),
		]);
		expect(symbol.local).toEqual({ state: "modified" });
		expect(constant.local).toEqual({ state: "modified" });
		rmSync(join(repo, "src/app.ts"));
		const [missing] = await verifyEvidence(repo, [fileItem()]);
		expect(missing.local).toEqual({ state: "missing" });
	});

	it("never reads outside the checkout", async () => {
		writeFileSync(join(root, "secret.txt"), APP);
		symlinkSync(join(root, "secret.txt"), join(repo, "src/link.ts"));
		mkdirSync(join(root, "outside"));
		writeFileSync(join(root, "outside/app.ts"), APP);
		symlinkSync(join(root, "outside"), join(repo, "linked"));
		const results = await verifyEvidence(repo, [
			fileItem({ path: "linked/app.ts" }),
			fileItem({ path: "../secret.txt" }),
			fileItem({ path: join(root, "secret.txt") }),
			fileItem({ path: "src/link.ts" }),
			fileItem({ path: "src/../src/app.ts" }),
			fileItem({ path: null }),
			symbolItem({ bytes: [0, 10 ** 9] }),
		]);
		expect(results.map((item) => item.local.state)).toEqual([
			"unverifiable",
			"unverifiable",
			"unverifiable",
			"unverifiable",
			"unverifiable",
			"unverifiable",
			// An unchanged file with a span outside it: inconsistent evidence.
			"unverifiable",
		]);
	});
});

describe("orchestration", () => {
	it("keeps a successful expansion when its repository cannot be mapped", async () => {
		const fake = server({
			list_project_context_repositories: { repositories: [] },
			expand_project_evidence: {
				status: "ready",
				repository_id: "not-listed",
				commit: indexed,
				items: [fileItem()],
				omitted: [],
				cursor: "next",
			},
		});
		const result = await expandWithLocalVerification({
			callTool: fake.callTool,
			run,
			candidates: [repo],
			projectKey: "API",
			contextViewId: "view-1",
			refs: ["f:4"],
		});
		expect(result.cursor).toBe("next");
		expect(result.items).toEqual([
			{ ...fileItem(), local: { state: "unverifiable" } },
		]);
		expect(result.local).toEqual({ checkout: "unknown" });
	});

	function server(responses: Record<string, unknown>) {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		return {
			calls,
			callTool: async (name: string, args: Record<string, unknown>) => {
				calls.push({ name, args });
				const response = responses[name];
				if (name !== "list_project_context_repositories") return response;
				// Lookups by ID or by owner and name, as the server does.
				const listed = (response as { repositories: any[] }).repositories;
				return {
					truncated: false,
					repositories: listed.filter(
						(item) =>
							(!args.repository_id ||
								item.repository_id === args.repository_id) &&
							(!args.owner ||
								item.owner.toLowerCase() === String(args.owner)) &&
							(!args.name || item.name.toLowerCase() === String(args.name)),
					),
				};
			},
		};
	}

	it("discovers in the checkout's repository with its HEAD", async () => {
		const fake = server({
			list_project_context_repositories: {
				repositories: [{ ...REPOSITORY, commit: indexed }],
				truncated: false,
			},
			discover_project_context: { status: "ready", candidates: [] },
		});
		const result = await discoverWithLocalContext({
			callTool: fake.callTool,
			run,
			candidates: [repo],
			projectKey: "API",
			query: "helper",
		});
		expect(fake.calls[0]).toEqual({
			name: "list_project_context_repositories",
			args: { project_key: "API", owner: "takonaut", name: "api" },
		});
		expect(fake.calls[1]).toEqual({
			name: "discover_project_context",
			args: {
				project_key: "API",
				repository_id: REPOSITORY.repository_id,
				query: "helper",
				local_commit: indexed,
			},
		});
		expect(result.local).toEqual({
			checkout: "found",
			head: indexed,
			dirty: false,
			relation: "same_commit",
		});
	});

	it("refuses to guess between repositories with the same name", async () => {
		const fake = server({
			list_project_context_repositories: {
				repositories: [
					{ ...REPOSITORY, commit: indexed },
					{ ...REPOSITORY, repository_id: "other-host-copy" },
				],
			},
		});
		await expect(
			discoverWithLocalContext({
				callTool: fake.callTool,
				run,
				candidates: [repo],
				projectKey: "API",
				query: "helper",
			}),
		).rejects.toThrow("repository_ambiguous");
		expect(fake.calls.map((call) => call.name)).not.toContain(
			"discover_project_context",
		);
	});

	it("asks for a repository when no checkout matches", async () => {
		const fake = server({
			list_project_context_repositories: {
				repositories: [{ ...REPOSITORY, owner: "someone" }],
				truncated: false,
			},
		});
		await expect(
			discoverWithLocalContext({
				callTool: fake.callTool,
				run,
				candidates: [repo],
				projectKey: "API",
				query: "helper",
			}),
		).rejects.toThrow("repository_not_mapped");
		// An explicit repository is passed through; the server decides.
		const explicit = server({
			list_project_context_repositories: { repositories: [] },
			discover_project_context: { status: "not_ready", fallback: "local" },
		});
		const result = await discoverWithLocalContext({
			callTool: explicit.callTool,
			run,
			candidates: [repo],
			projectKey: "API",
			query: "helper",
			repositoryId: "unlisted",
		});
		expect(explicit.calls.map((call) => call.name)).toEqual([
			"list_project_context_repositories",
			"discover_project_context",
		]);
		expect(explicit.calls[1].args.repository_id).toBe("unlisted");
		expect(result.status).toBe("not_ready");
		expect(result.local).toEqual({ checkout: "missing" });
	});

	it("verifies expanded evidence against the local checkout", async () => {
		const fake = server({
			list_project_context_repositories: {
				repositories: [{ ...REPOSITORY, commit: indexed }],
				truncated: false,
			},
			expand_project_evidence: {
				status: "ready",
				repository_id: REPOSITORY.repository_id,
				commit: indexed,
				items: [symbolItem(), fileItem()],
				omitted: [],
			},
		});
		writeFileSync(join(repo, "src/app.ts"), APP.replace("tail", "TAIL"));
		const result = await expandWithLocalVerification({
			callTool: fake.callTool,
			run,
			candidates: [repo],
			projectKey: "API",
			contextViewId: "view-1",
			refs: ["s:22", "f:4"],
		});
		expect(fake.calls[0]).toEqual({
			name: "expand_project_evidence",
			args: {
				project_key: "API",
				context_view_id: "view-1",
				refs: ["s:22", "f:4"],
			},
		});
		const items = result.items as Array<{ local: { state: string } }>;
		expect(items.map((item) => item.local.state)).toEqual([
			"span_match",
			"modified",
		]);
		expect(fake.calls[1].args).toEqual({
			project_key: "API",
			repository_id: REPOSITORY.repository_id,
		});
		expect(result.local).toMatchObject({
			checkout: "found",
			dirty: true,
			relation: "same_commit",
		});
	});
});
