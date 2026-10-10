/**
 * Shared Project context through Tako Bridge.
 *
 * Takonaut serves a repository's published structure index (default branch,
 * built by a customer Runner); Bridge adds what only the machine knows: which
 * local checkout is that repository, how its HEAD relates to the indexed
 * commit, and whether returned files and spans still match local bytes.
 * Hashes cover Git blob bytes, so line-ending conversion in the working tree
 * reads as `modified`. Nothing local leaves the machine except the HEAD
 * commit sent with discovery.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";

import { type CommandRunner, normalizeGitHubRemote } from "./git";

const COMMIT = /^[0-9a-f]{40}$/;
const GIT_TIMEOUT_MS = 10_000;
// Larger files are reported as unverifiable rather than read.
const MAX_VERIFY_BYTES = 16 * 1024 * 1024;

export class ProjectContextError extends Error {
	readonly code: string;
	readonly details: Record<string, unknown>;

	constructor(code: string, details: Record<string, unknown> = {}) {
		super(code);
		this.code = code;
		this.details = details;
	}
}

export interface ContextRepository {
	repositoryId: string;
	owner: string;
	name: string;
	status: string;
	commit: string | null;
}

export type CommitRelation =
	| "same_commit"
	| "local_ahead"
	| "local_behind"
	| "diverged"
	| "indexed_commit_missing"
	| "unknown";

export interface CheckoutState {
	head: string | null;
	dirty: boolean;
	relation: CommitRelation;
}

export interface EvidenceVerification {
	state: EvidenceState;
	/** For `span_match`: the definition's lines in the local file. */
	lines?: [number, number];
}

export type EvidenceState =
	| "match"
	| "span_match"
	| "modified"
	| "missing"
	| "unverifiable";

type ToolCaller = (
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<unknown>;

interface LocalOptions {
	callTool: ToolCaller;
	run: CommandRunner;
	/** Directories that may hold checkouts, most specific first. */
	candidates: string[];
	projectKey: string;
	signal?: AbortSignal;
}

function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ProjectContextError("invalid_response");
	}
	return value as Record<string, unknown>;
}

export function parseContextRepositories(value: unknown): ContextRepository[] {
	const listing = record(value);
	if (!Array.isArray(listing.repositories)) {
		throw new ProjectContextError("invalid_response");
	}
	return listing.repositories.map((entry) => {
		const item = record(entry);
		if (
			typeof item.repository_id !== "string" ||
			typeof item.owner !== "string" ||
			typeof item.name !== "string" ||
			typeof item.status !== "string" ||
			!(item.commit === null || typeof item.commit === "string")
		) {
			throw new ProjectContextError("invalid_response");
		}
		return {
			repositoryId: item.repository_id,
			owner: item.owner,
			name: item.name,
			status: item.status,
			commit: item.commit,
		};
	});
}

async function git(
	run: CommandRunner,
	cwd: string,
	args: string[],
): Promise<{ ok: boolean; code: number; out: string }> {
	try {
		// No repository-configured fsmonitor hook runs on Bridge's behalf.
		const result = await run(
			"git",
			["-C", cwd, "-c", "core.fsmonitor=false", ...args],
			{ timeout: GIT_TIMEOUT_MS },
		);
		const code = result.timedOut ? -1 : result.exitCode;
		return { ok: code === 0, code, out: result.stdout.trim() };
	} catch {
		return { ok: false, code: -1, out: "" };
	}
}

async function checkoutIdentity(
	run: CommandRunner,
	directory: string,
): Promise<{ root: string; identity: string } | null> {
	const top = await git(run, directory, ["rev-parse", "--show-toplevel"]);
	if (!top.ok || !isAbsolute(top.out)) return null;
	const origin = await git(run, top.out, ["remote", "get-url", "origin"]);
	const identity = origin.ok ? normalizeGitHubRemote(origin.out) : null;
	return identity ? { root: top.out, identity } : null;
}

function identityOf(repository: ContextRepository): string {
	return `github.com/${repository.owner}/${repository.name}`.toLowerCase();
}

/** The first candidate checkout whose origin is the repository. */
export async function findContextCheckout(
	run: CommandRunner,
	candidates: string[],
	repository: ContextRepository,
): Promise<string | null> {
	for (const directory of new Set(candidates)) {
		const found = await checkoutIdentity(run, directory);
		if (found?.identity === identityOf(repository)) return found.root;
	}
	return null;
}

async function localHead(
	run: CommandRunner,
	root: string,
): Promise<string | null> {
	const head = await git(run, root, ["rev-parse", "HEAD"]);
	return head.ok && COMMIT.test(head.out) ? head.out : null;
}

/** How the checkout's HEAD relates to the indexed commit. */
export async function describeCheckout(
	run: CommandRunner,
	root: string,
	indexedCommit: string | null,
): Promise<CheckoutState> {
	const head = await localHead(run, root);
	const status = await git(run, root, [
		"status",
		"--porcelain",
		"--untracked-files=no",
	]);
	const dirty = !status.ok || status.out.length > 0;
	const state = (relation: CommitRelation) => ({ head, dirty, relation });
	if (!head || !indexedCommit || !COMMIT.test(indexedCommit)) {
		return state("unknown");
	}
	if (head === indexedCommit) return state("same_commit");
	if (
		!(await git(run, root, ["cat-file", "-e", `${indexedCommit}^{commit}`])).ok
	) {
		return state("indexed_commit_missing");
	}
	// Exit 0: ancestor; 1: not; anything else (shallow boundary, error):
	// unknown, never proof of divergence.
	const ancestor = async (older: string, newer: string) =>
		(await git(run, root, ["merge-base", "--is-ancestor", older, newer])).code;
	const forward = await ancestor(indexedCommit, head);
	if (forward === 0) return state("local_ahead");
	if (forward !== 1) return state("unknown");
	const backward = await ancestor(head, indexedCommit);
	if (backward === 0) return state("local_behind");
	return state(backward === 1 ? "diverged" : "unknown");
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function safeRelative(path: unknown, platform: string): path is string {
	if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
		return false;
	}
	if (isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
		return false;
	}
	return path.split("/").every(
		(segment) =>
			segment !== "" &&
			segment !== "." &&
			segment !== ".." &&
			// Streams, drive-relative forms, trailing dots/spaces and
			// device names resolve elsewhere on Windows.
			(platform !== "win32" ||
				(!segment.includes(":") &&
					!/[. ]$/.test(segment) &&
					!WINDOWS_RESERVED.test(segment))),
	);
}

const sha256 = (bytes: Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

type LocalFile = { bytes: Buffer; sha256: string } | "missing" | "unverifiable";

async function readLocal(
	root: string,
	path: unknown,
	platform: string,
): Promise<LocalFile> {
	if (!safeRelative(path, platform)) return "unverifiable";
	const full = join(root, ...path.split("/"));
	try {
		const info = await lstat(full);
		if (!info.isFile() || info.size > MAX_VERIFY_BYTES) return "unverifiable";
		// No symlinked directory may lead outside the checkout.
		const resolved = await realpath(full);
		if (resolved !== full || !resolved.startsWith(root + sep)) {
			return "unverifiable";
		}
		const handle = await open(
			full,
			constants.O_RDONLY |
				(constants.O_NOFOLLOW ?? 0) |
				(constants.O_NONBLOCK ?? 0),
		);
		try {
			// The file opened must be the one checked: not swapped since.
			const opened = await handle.stat();
			if (
				!opened.isFile() ||
				opened.dev !== info.dev ||
				opened.ino !== info.ino ||
				opened.size > MAX_VERIFY_BYTES
			) {
				return "unverifiable";
			}
			const buffer = Buffer.alloc(opened.size + 1);
			let length = 0;
			while (length < buffer.length) {
				const { bytesRead } = await handle.read(
					buffer,
					length,
					buffer.length - length,
					length,
				);
				if (bytesRead === 0) break;
				length += bytesRead;
			}
			// Grew while reading: not the file that was checked.
			if (length > opened.size) return "unverifiable";
			const bytes = buffer.subarray(0, length);
			return { bytes, sha256: sha256(bytes) };
		} finally {
			await handle.close();
		}
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? "missing"
			: "unverifiable";
	}
}

function newlines(bytes: Uint8Array): number {
	let count = 0;
	for (const byte of bytes) if (byte === 0x0a) count += 1;
	return count;
}

function span(value: unknown): [number, number] | null {
	if (!Array.isArray(value) || value.length !== 2) return null;
	const [start, end] = value;
	return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0
		? [start, end]
		: null;
}

function verifyOne(
	item: Record<string, unknown>,
	local: LocalFile,
): EvidenceVerification {
	if (local === "missing" || local === "unverifiable") return { state: local };
	if (item.type === "file") {
		return { state: item.sha256 === local.sha256 ? "match" : "modified" };
	}
	const bytes = span(item.bytes);
	const fits =
		bytes !== null && bytes[0] < bytes[1] && bytes[1] <= local.bytes.length;
	if (item.file_sha256 === local.sha256) {
		return { state: fits ? "match" : "unverifiable" };
	}
	if (
		fits &&
		typeof item.sha256 === "string" &&
		sha256(local.bytes.subarray(bytes[0], bytes[1])) === item.sha256
	) {
		// Same bytes at the same offsets; lines before may have shifted.
		const start = newlines(local.bytes.subarray(0, bytes[0])) + 1;
		const end = start + newlines(local.bytes.subarray(bytes[0], bytes[1] - 1));
		return { state: "span_match", lines: [start, end] };
	}
	return { state: "modified" };
}

/**
 * Each item with `local.state`: `match` (file identical), `span_match`
 * (file changed, the definition's bytes are identical at the same offsets;
 * `local.lines` gives its local lines), `modified`, `missing`, or
 * `unverifiable` (unsafe path, symlink, special or too large file, or
 * inconsistent evidence). Files are read one at a time.
 */
export async function verifyEvidence(
	root: string,
	items: unknown[],
	platform: string = process.platform,
): Promise<Array<Record<string, unknown> & { local: EvidenceVerification }>> {
	const realRoot = await realpath(root);
	const records = items.map(record);
	const groups = new Map<string, number[]>();
	records.forEach((item, index) => {
		const key = typeof item.path === "string" ? `p:${item.path}` : `i:${index}`;
		groups.set(key, [...(groups.get(key) ?? []), index]);
	});
	const results: Array<
		Record<string, unknown> & { local: EvidenceVerification }
	> = new Array(records.length);
	for (const indices of groups.values()) {
		const local = await readLocal(realRoot, records[indices[0]].path, platform);
		for (const index of indices) {
			results[index] = {
				...records[index],
				local: verifyOne(records[index], local),
			};
		}
	}
	return results;
}

async function lookupRepositories(
	options: LocalOptions,
	filters: Record<string, string> = {},
): Promise<ContextRepository[]> {
	return parseContextRepositories(
		await options.callTool(
			"list_project_context_repositories",
			{ project_key: options.projectKey, ...filters },
			options.signal,
		),
	);
}

async function repositoryById(
	options: LocalOptions,
	repositoryId: string,
): Promise<ContextRepository | null> {
	const [repository] = await lookupRepositories(options, {
		repository_id: repositoryId,
	});
	return repository?.repositoryId === repositoryId ? repository : null;
}

async function mappedCheckout(
	options: LocalOptions,
	repositoryId: string | undefined,
): Promise<{
	repositoryId: string;
	commit: string | null;
	root: string | null;
}> {
	if (repositoryId) {
		// Passed through even when not listed: the server decides.
		const repository = await repositoryById(options, repositoryId);
		return {
			repositoryId,
			commit: repository?.commit ?? null,
			root: repository
				? await findContextCheckout(options.run, options.candidates, repository)
				: null,
		};
	}
	const seen = new Set<string>();
	for (const directory of new Set(options.candidates)) {
		const found = await checkoutIdentity(options.run, directory);
		if (!found || seen.has(found.identity)) continue;
		seen.add(found.identity);
		const [, owner, name] = found.identity.split("/");
		const matches = (await lookupRepositories(options, { owner, name })).filter(
			(item) => identityOf(item) === found.identity,
		);
		if (matches.length > 1) {
			// Same owner and name twice in the Project: never guess.
			throw new ProjectContextError("repository_ambiguous", {
				repositories: matches.map((item) => ({
					repository_id: item.repositoryId,
					owner: item.owner,
					name: item.name,
					status: item.status,
				})),
			});
		}
		if (matches.length === 1) {
			return {
				repositoryId: matches[0].repositoryId,
				commit: matches[0].commit,
				root: found.root,
			};
		}
	}
	const repositories = await lookupRepositories(options);
	throw new ProjectContextError("repository_not_mapped", {
		repositories: repositories.map((item) => ({
			repository_id: item.repositoryId,
			owner: item.owner,
			name: item.name,
			status: item.status,
		})),
	});
}

async function localSummary(
	run: CommandRunner,
	root: string | null,
	commit: unknown,
): Promise<Record<string, unknown>> {
	if (!root) return { checkout: "missing" };
	return {
		checkout: "found",
		...(await describeCheckout(
			run,
			root,
			typeof commit === "string" ? commit : null,
		)),
	};
}

/** Discovery in the repository of the local checkout (or the given one). */
export async function discoverWithLocalContext(
	options: LocalOptions & {
		query: string;
		repositoryId?: string;
		cursor?: string;
		budgetBytes?: number;
	},
): Promise<Record<string, unknown>> {
	const { repositoryId, commit, root } = await mappedCheckout(
		options,
		options.repositoryId,
	);
	const head = root ? await localHead(options.run, root) : null;
	const result = record(
		await options.callTool(
			"discover_project_context",
			{
				project_key: options.projectKey,
				repository_id: repositoryId,
				query: options.query,
				...(options.cursor ? { cursor: options.cursor } : {}),
				...(options.budgetBytes ? { budget_bytes: options.budgetBytes } : {}),
				...(head ? { local_commit: head } : {}),
			},
			options.signal,
		),
	);
	return {
		...result,
		local: await localSummary(options.run, root, result.commit ?? commit),
	};
}

/** Expansion with every item verified against the local checkout. */
export async function expandWithLocalVerification(
	options: LocalOptions & {
		contextViewId: string;
		refs: string[];
		cursor?: string;
		budgetBytes?: number;
	},
): Promise<Record<string, unknown>> {
	const result = record(
		await options.callTool(
			"expand_project_evidence",
			{
				project_key: options.projectKey,
				context_view_id: options.contextViewId,
				refs: options.refs,
				...(options.cursor ? { cursor: options.cursor } : {}),
				...(options.budgetBytes ? { budget_bytes: options.budgetBytes } : {}),
			},
			options.signal,
		),
	);
	if (
		typeof result.repository_id !== "string" ||
		!Array.isArray(result.items)
	) {
		return result;
	}
	// The expansion already succeeded: never lose it to a mapping failure.
	let repository: ContextRepository | null = null;
	try {
		repository = await repositoryById(options, result.repository_id);
	} catch {
		repository = null;
	}
	const root = repository
		? await findContextCheckout(options.run, options.candidates, repository)
		: null;
	return {
		...result,
		items: root
			? await verifyEvidence(root, result.items)
			: result.items.map((item) => ({
					...record(item),
					local: { state: "unverifiable" },
				})),
		local: repository
			? await localSummary(options.run, root, result.commit)
			: { checkout: "unknown" },
	};
}
