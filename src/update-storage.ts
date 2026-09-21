import {
	chmodSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

export interface UpdateStorage {
	readSettings(): unknown;
	writeSettings(value: unknown): void;
	readCache(): unknown;
	writeCache(value: unknown): void;
}

/** Separate from login/configuration: cache writes can never re-enable checks. */
export function createUpdateStorage(
	directory = join(homedir(), ".takonaut"),
): UpdateStorage {
	function validate(path: string, directoryEntry = false): void {
		const stat = lstatSync(path);
		if (
			stat.isSymbolicLink() ||
			(directoryEntry ? !stat.isDirectory() : !stat.isFile()) ||
			(typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
			(stat.mode & 0o077) !== 0
		) {
			throw new Error("Unsafe update state path");
		}
	}
	function read(name: string): unknown {
		try {
			validate(directory, true);
			const path = join(directory, name);
			validate(path);
			if (lstatSync(path).size > 32 * 1024)
				throw new Error("Oversized update state");
			return JSON.parse(readFileSync(path, "utf8"));
		} catch (error) {
			if (
				error &&
				typeof error === "object" &&
				"code" in error &&
				error.code === "ENOENT"
			)
				return undefined;
			throw new Error("Update state could not be read safely");
		}
	}
	function write(name: string, value: unknown): void {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		validate(directory, true);
		const path = join(directory, name);
		try {
			validate(path);
		} catch (error) {
			if (
				!(
					error &&
					typeof error === "object" &&
					"code" in error &&
					error.code === "ENOENT"
				)
			)
				throw error;
		}
		const temp = join(directory, `.bridge-update-${randomUUID()}.tmp`);
		try {
			writeFileSync(temp, JSON.stringify(value) + "\n", {
				mode: 0o600,
				flag: "wx",
			});
			chmodSync(temp, 0o600);
			renameSync(temp, path);
		} finally {
			rmSync(temp, { force: true });
		}
	}
	return {
		readSettings: () => read("bridge-update-settings.json"),
		writeSettings: (value) => write("bridge-update-settings.json", value),
		readCache: () => read("bridge-update-cache.json"),
		writeCache: (value) => write("bridge-update-cache.json", value),
	};
}
