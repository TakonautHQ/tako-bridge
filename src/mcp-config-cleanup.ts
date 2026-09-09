import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

export type McpConfigCleanupResult = "removed" | "absent" | "not_matching";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactTakonautUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname === "takonaut.app" &&
			url.port === "" &&
			url.username === "" &&
			url.password === "" &&
			url.search === "" &&
			url.hash === "" &&
			url.pathname.replace(/\/+$/, "") === "/mcp"
		);
	} catch {
		return false;
	}
}

function hasExactPersonalHeaders(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const entries = Object.entries(value).map(
		([key, headerValue]) => [key.toLowerCase(), headerValue] as const,
	);
	if (entries.length !== 2) return false;
	const headers = new Map(entries);
	return (
		headers.size === 2 &&
		typeof headers.get("x-api-key") === "string" &&
		String(headers.get("x-api-key")).length > 0 &&
		typeof headers.get("x-organization-id") === "string" &&
		String(headers.get("x-organization-id")).length > 0
	);
}

function isExactTakonautEntry(value: unknown): boolean {
	return (
		isRecord(value) &&
		value.type === "http" &&
		isExactTakonautUrl(value.url) &&
		hasExactPersonalHeaders(value.headers)
	);
}

function unsafeConfigError(): Error {
	return new Error("Refusing to modify an unsafe MCP configuration file.");
}

function ownedAndNotWritableByOthers(stat: {
	uid: number;
	mode: number;
}): boolean {
	const uid = process.getuid?.();
	return uid !== undefined && stat.uid === uid && (stat.mode & 0o022) === 0;
}

function sameIdentity(
	left: { dev: number; ino: number },
	right: { dev: number; ino: number },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Remove the one legacy project-local Takonaut MCP entry superseded by Tako
 * Bridge. No credential is accepted by this helper, and unrelated MCP servers
 * and top-level configuration are preserved.
 */
export function removeExactTakonautMcpEntry(
	cwd = process.cwd(),
): McpConfigCleanupResult {
	let canonicalCwd: string;
	let directoryStat;
	try {
		canonicalCwd = realpathSync(cwd);
		directoryStat = lstatSync(canonicalCwd);
	} catch {
		throw unsafeConfigError();
	}
	if (
		!directoryStat.isDirectory() ||
		directoryStat.isSymbolicLink() ||
		!ownedAndNotWritableByOthers(directoryStat)
	) {
		throw unsafeConfigError();
	}

	const configPath = resolve(canonicalCwd, ".mcp.json");
	let descriptor: number | undefined;
	try {
		let stat;
		try {
			stat = lstatSync(configPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
			throw unsafeConfigError();
		}
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			!ownedAndNotWritableByOthers(stat)
		) {
			throw unsafeConfigError();
		}

		try {
			descriptor = openSync(
				configPath,
				constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
			);
		} catch {
			throw unsafeConfigError();
		}
		const openedStat = fstatSync(descriptor);
		if (
			!openedStat.isFile() ||
			!sameIdentity(stat, openedStat) ||
			!ownedAndNotWritableByOthers(openedStat)
		) {
			throw unsafeConfigError();
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(descriptor, "utf8"));
		} catch {
			throw unsafeConfigError();
		} finally {
			closeSync(descriptor);
			descriptor = undefined;
		}
		if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
			return "not_matching";
		}
		const entry = parsed.mcpServers.takonaut;
		if (!isExactTakonautEntry(entry)) return "not_matching";

		delete parsed.mcpServers.takonaut;
		const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
		const tempPath = `${configPath}.tako-${randomBytes(8).toString("hex")}.tmp`;
		let tempDescriptor: number | undefined;
		try {
			tempDescriptor = openSync(
				tempPath,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
				0o600,
			);
			writeFileSync(tempDescriptor, serialized, "utf8");
			fsyncSync(tempDescriptor);
			closeSync(tempDescriptor);
			tempDescriptor = undefined;

			const currentFileStat = lstatSync(configPath);
			const currentDirectoryStat = lstatSync(canonicalCwd);
			if (
				currentFileStat.isSymbolicLink() ||
				!sameIdentity(stat, currentFileStat) ||
				!ownedAndNotWritableByOthers(currentFileStat) ||
				!sameIdentity(directoryStat, currentDirectoryStat) ||
				!ownedAndNotWritableByOthers(currentDirectoryStat)
			) {
				throw unsafeConfigError();
			}

			renameSync(tempPath, configPath);
			const directoryDescriptor = openSync(
				canonicalCwd,
				constants.O_RDONLY | (constants.O_DIRECTORY ?? 0),
			);
			try {
				fsyncSync(directoryDescriptor);
			} finally {
				closeSync(directoryDescriptor);
			}
		} catch {
			if (tempDescriptor !== undefined) closeSync(tempDescriptor);
			try {
				unlinkSync(tempPath);
			} catch {
				// The temp file may already have been renamed or never created.
			}
			throw unsafeConfigError();
		}
		return "removed";
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}
