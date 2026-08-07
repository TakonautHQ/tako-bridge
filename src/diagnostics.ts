import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const MAX_DIAGNOSTIC_BYTES = 128 * 1024;
const PRIVATE_KEY_RE = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i;
const REDACTIONS: Array<{ pattern: RegExp; replacement: string }> = [
	{ pattern: /\bAuthorization:\s*Bearer\s+\S+/gi, replacement: "[REDACTED]" },
	{
		pattern: /\b(?:password|passwd|secret|token|api[_-]?key)\s*[=:]\s*\S+/gi,
		replacement: "[REDACTED]",
	},
	{ pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replacement: "[REDACTED]" },
	{
		pattern:
			/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
		replacement: "[REDACTED]",
	},
	{
		pattern: /(^|\s)\/(?:Users|home)\/[^\s:]+/g,
		replacement: "$1[LOCAL_PATH]",
	},
	{
		pattern: /\b[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]+/g,
		replacement: "[LOCAL_PATH]",
	},
];

export interface PreparedDiagnostic {
	content: string;
	redactionCount: number;
	byteSize: number;
}

export function prepareDiagnosticContent(value: string): PreparedDiagnostic {
	const rawBytes = Buffer.byteLength(value, "utf8");
	if (rawBytes === 0 || rawBytes > MAX_DIAGNOSTIC_BYTES) {
		throw new Error("Diagnostic content must be non-empty and at most 128 KiB");
	}
	if (PRIVATE_KEY_RE.test(value)) {
		throw new Error("Diagnostic contains prohibited high-risk material");
	}
	let content = value;
	let redactionCount = 0;
	for (const { pattern, replacement } of REDACTIONS) {
		pattern.lastIndex = 0;
		const matches = content.match(pattern)?.length ?? 0;
		pattern.lastIndex = 0;
		content = content.replace(pattern, replacement);
		redactionCount += matches;
	}
	return {
		content,
		redactionCount,
		byteSize: Buffer.byteLength(content, "utf8"),
	};
}

function safeRelativePath(value: string): boolean {
	return (
		value.length > 0 &&
		!isAbsolute(value) &&
		!value.includes("\\") &&
		!value
			.split("/")
			.some((segment) => !segment || segment === "." || segment === "..")
	);
}

export function readAndPrepareDiagnostic(
	worktreeRoot: string,
	relativePath: string,
): PreparedDiagnostic {
	if (!safeRelativePath(relativePath)) {
		throw new Error("Diagnostic path must be a safe Workspace-relative path");
	}
	const root = realpathSync(worktreeRoot);
	const target = resolve(root, relativePath);
	const rel = relative(root, target);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
		throw new Error("Diagnostic path escapes its managed Workspace");
	}
	if (!existsSync(target) || lstatSync(target).isSymbolicLink()) {
		throw new Error(
			"Diagnostic file must be an existing regular file, not a symlink",
		);
	}
	const actual = realpathSync(target);
	if (!actual.startsWith(`${root}${sep}`) || !lstatSync(actual).isFile()) {
		throw new Error("Diagnostic file is outside its managed Workspace");
	}
	const stat = lstatSync(actual);
	if (stat.size === 0 || stat.size > MAX_DIAGNOSTIC_BYTES) {
		throw new Error("Diagnostic file must be non-empty and at most 128 KiB");
	}
	return prepareDiagnosticContent(readFileSync(actual, "utf8"));
}
