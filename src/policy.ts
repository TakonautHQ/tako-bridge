// Local safety policy for Pi tool calls (the §22 policy engine, local half).
//
// The Proposal gates *Takonaut* state, but Pi runs real bash/edits on the dev's machine
// BEFORE the proposal stage — so dangerous local operations must be caught here, at the
// `tool_call` event, and blocked (or surfaced for approval) before they execute.
//
// These functions are PURE so they can be unit-tested without Pi or Takonaut.

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

export interface PolicyConfig {
	/** Absolute path of the linked repo. Edits/writes must stay inside it. */
	repoRoot: string;
	/** Additional verified Agentic Delivery worktree roots. */
	repoRoots?: string[];
	/** Manifest-defined repository-relative paths that execution cannot write. */
	protectedPaths?: string[];
	/** Branches Pi must never push to / hard-reset. */
	protectedBranches: string[];
}

export interface PolicyDecision {
	allow: boolean;
	/** Present when blocked — a human-readable reason shown to the agent. */
	reason?: string;
}

const ALLOW: PolicyDecision = { allow: true };

function deny(reason: string): PolicyDecision {
	return { allow: false, reason: `Blocked by Takonaut policy: ${reason}` };
}

const GIT_COMMAND_PREFIX = String.raw`\bgit(?:\s+(?:(?:-C|-c|--git-dir|--work-tree)\s+\S+|--(?:git-dir|work-tree)=\S+))*\s+`;

function gitCommandPattern(commandPattern: string): RegExp {
	return new RegExp(`${GIT_COMMAND_PREFIX}${commandPattern}`, "i");
}

// Irreversible / out-of-scope shell operations. Each entry is [regex, reason].
const DENY_COMMANDS: Array<[RegExp, string]> = [
	[
		/\brm\b(?=[^\n]*(?:--recursive\b|-[a-z]*r[a-z]*\b))(?=[^\n]*(?:--force\b|-[a-z]*f[a-z]*\b))[^\n]*/i,
		"recursive force-delete (rm -rf)",
	],
	[
		gitCommandPattern(
			String.raw`push\b[^\n]*(?:--force(?:-with-lease)?\b|-f\b)`,
		),
		"force push",
	],
	[gitCommandPattern(String.raw`reset\s+--hard\b`), "git reset --hard"],
	[gitCommandPattern(String.raw`clean\s+-[a-z]*f`), "git clean -f"],
	[gitCommandPattern(String.raw`branch\s+-D\b`), "force-delete branch"],
	[
		/\b(drop\s+database|dropdb|truncate\s+table)\b/i,
		"destructive database operation",
	],
	[
		/\b(alembic|migrate|migration|flyway|prisma\s+migrate)\b/i,
		"database migration",
	],
	[
		/\b(deploy\.|deploy\.vps\.sh|kubectl\s+apply|terraform\s+apply|serverless\s+deploy)\b/i,
		"deployment",
	],
	[
		/(^|[^a-z])(cat|less|more|head|tail|bat)\s+[^\n]*\.env\b/i,
		"reading a .env / secrets file",
	],
	[
		/\b(printenv|env)\b[^\n]*\b(secret|token|key|password)\b/i,
		"exporting secrets from the environment",
	],
	[
		gitCommandPattern(String.raw`config\b[^\n]*\b(user\.|credential\.)`),
		"modifying git credentials/identity",
	],
];

const SECRET_PATH =
	/(^|\/)\.env(\.|$)|(^|\/)(secrets?|credentials?)(\.|\/|$)|\.pem$|id_rsa\b/i;

/** Evaluate a `bash` tool call. */
export function evaluateBash(
	command: string,
	cfg: PolicyConfig,
): PolicyDecision {
	const cmd = (command ?? "").trim();
	if (!cmd) return ALLOW;
	for (const [re, reason] of DENY_COMMANDS) {
		if (re.test(cmd)) return deny(reason);
	}
	// Push to a protected branch (e.g. `git push origin main`).
	const push = cmd.match(gitCommandPattern(String.raw`push\b([^\n]*)`));
	if (push) {
		const rest = push[1];
		for (const b of cfg.protectedBranches) {
			if (new RegExp(`(^|[\\s:/])${escapeRe(b)}(\\s|$)`).test(rest)) {
				return deny(`push to protected branch "${b}"`);
			}
		}
	}
	return ALLOW;
}

function evaluatePathInRoot(
	path: string,
	rootValue: string,
	cfg: PolicyConfig,
): PolicyDecision {
	const root = resolve(rootValue);
	const abs = isAbsolute(path) ? normalize(path) : resolve(root, path);
	const rel = relative(root, abs);
	if (
		rel === "" ||
		rel === ".." ||
		rel.startsWith(`..${sep}`) ||
		isAbsolute(rel)
	) {
		return deny("writing outside the linked repository or managed worktree");
	}
	for (const protectedPath of cfg.protectedPaths ?? []) {
		const protectedRel = normalize(protectedPath).replace(/^[/\\]+/, "");
		if (rel === protectedRel || rel.startsWith(`${protectedRel}${sep}`)) {
			return deny(`writing to protected path "${protectedPath}"`);
		}
	}
	if (!existsSync(root)) return ALLOW;
	if (lstatSync(root).isSymbolicLink())
		return deny("repository root is a symlink");
	const realRoot = realpathSync(root);
	let current = root;
	for (const segment of rel.split(sep)) {
		current = join(current, segment);
		if (!existsSync(current)) continue;
		if (lstatSync(current).isSymbolicLink()) {
			return deny("writing through a symlink escape");
		}
		const realCurrent = realpathSync(current);
		if (
			realCurrent !== realRoot &&
			!realCurrent.startsWith(`${realRoot}${sep}`)
		) {
			return deny("writing outside the verified worktree");
		}
	}
	return ALLOW;
}

/** Evaluate an `edit` / `write` tool call by its target path. */
export function evaluatePath(path: string, cfg: PolicyConfig): PolicyDecision {
	const p = (path ?? "").trim();
	if (!p) return ALLOW;
	if (SECRET_PATH.test(p)) return deny("writing to a .env / secrets file");
	const roots = cfg.repoRoots?.length ? cfg.repoRoots : [cfg.repoRoot];
	const decisions = roots.map((root) => evaluatePathInRoot(p, root, cfg));
	return decisions.find((decision) => decision.allow) ?? decisions[0];
}

/** Dispatch on a Pi tool_call event shape `{ toolName, input }`. */
export function evaluateToolCall(
	toolName: string,
	input: Record<string, unknown>,
	cfg: PolicyConfig,
): PolicyDecision {
	switch (toolName) {
		case "bash":
			return evaluateBash(String(input?.command ?? ""), cfg);
		case "edit":
		case "write":
			return evaluatePath(String(input?.path ?? ""), cfg);
		default:
			return ALLOW;
	}
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
