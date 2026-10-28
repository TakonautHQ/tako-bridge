/**
 * The ONLY extension loaded in a planning turn's headless `pi --print` child
 * process (ADR-0010 B7/C2 follow-up). Deliberately separate from the full
 * Takonaut extension (`index.ts`): loading that one here would open a second
 * Bridge heartbeat/connection for the same member and could pull a second
 * batch of planning-turn offers. This file does exactly one thing: expose
 * the turn's exactly granted Takonaut MCP tools, and refuse everything else.
 *
 * Configured entirely through environment variables set by
 * `createPlanningTurnExecutor` (never argv, so nothing granted here ever
 * shows up in a process listing):
 *   TAKONAUT_PLANNING_SERVER_URL, TAKONAUT_PLANNING_API_KEY,
 *   TAKONAUT_PLANNING_ORG_ID   -- this member's own Bridge credentials.
 *   TAKONAUT_PLANNING_ALLOWED_TOOLS -- JSON array of exact MCP tool names.
 *   TAKONAUT_PLANNING_WORKTREE -- the pinned worktree; read-only builtins
 *     (read/grep/find/ls) are refused for any path outside it.
 *
 * Fails closed: if required configuration is missing or malformed, no
 * tools are registered and every call is refused.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

import { TakonautClient, type TakonautMcpTool } from "./client";
import { TakonautToolCatalog } from "./catalog";
import { PLANNER_ALLOWED_MCP_TOOLS } from "./planner-allowed-tools";

const READ_ONLY_BUILTINS = new Set(["read", "grep", "find", "ls"]);
const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/;

function readAllowedTools(raw: string | undefined): string[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is string => typeof item === "string" && TOOL_NAME_RE.test(item));
	} catch {
		return [];
	}
}

/** The argument keys that hold a filesystem path for grep/find (their search pattern is not one). */
const PATH_LIKE_ARG_KEYS = new Set(["path", "paths", "cwd", "glob", "root"]);

/**
 * For `read`/`ls`, every string value in a tool call's arguments, since any
 * of them may be a filesystem path. For `grep`/`find`, only the values
 * under a path-like key (`path`/`paths`/`cwd`/`glob`/`root`): their search
 * pattern is not a path, and checking it as one refused ordinary patterns
 * that happen to look like a path or a route (N6). When a builtin got no
 * path-like argument at all, its default is the worktree root itself
 * ("."): still checked, never assumed safe.
 */
function candidatePaths(toolName: string, input: unknown): string[] {
	const pathKeysOnly = toolName === "grep" || toolName === "find";
	const out: string[] = [];
	const visit = (value: unknown, key: string | undefined) => {
		if (typeof value === "string") {
			if (!pathKeysOnly || (key !== undefined && PATH_LIKE_ARG_KEYS.has(key))) out.push(value);
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item, key);
			return;
		}
		if (value && typeof value === "object") {
			for (const [childKey, item] of Object.entries(value)) visit(item, childKey);
		}
	};
	visit(input, undefined);
	return out.length > 0 ? out : ["."];
}

/**
 * `realpathSync`, falling back to the nearest existing ancestor for a path
 * that doesn't exist yet (a new file, or a test fixture), so a committed
 * symlink is always followed to where it actually points before the
 * worktree-containment check runs, instead of comparing path text.
 */
function realpathNearestExisting(absolutePath: string): string {
	let current = absolutePath;
	const tail: string[] = [];
	for (;;) {
		try {
			const real = realpathSync(current);
			return tail.length > 0 ? resolve(real, ...tail) : real;
		} catch {
			const parent = dirname(current);
			if (parent === current) return resolve(absolutePath);
			tail.unshift(basename(current));
			current = parent;
		}
	}
}

function isWithinWorktree(candidate: string, worktreeRoot: string, worktreeRootReal: string): boolean {
	if (candidate.startsWith("~")) return false;
	const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(worktreeRoot, candidate);
	const real = realpathNearestExisting(absolute);
	return real === worktreeRootReal || real.startsWith(`${worktreeRootReal}${sep}`);
}

export default function planningTurnToolsExtension(pi: ExtensionAPI): void {
	const serverUrl = process.env.TAKONAUT_PLANNING_SERVER_URL ?? "";
	const apiKey = process.env.TAKONAUT_PLANNING_API_KEY ?? "";
	const orgId = process.env.TAKONAUT_PLANNING_ORG_ID ?? "";
	const worktreeRoot = process.env.TAKONAUT_PLANNING_WORKTREE
		? resolve(process.env.TAKONAUT_PLANNING_WORKTREE)
		: "";
	const allowedTools = new Set(readAllowedTools(process.env.TAKONAUT_PLANNING_ALLOWED_TOOLS));
	const configured = Boolean(serverUrl && apiKey && orgId && worktreeRoot);
	// Resolved once: an unconfigured worktree fails every read-only builtin
	// closed below, rather than ever reaching `isWithinWorktree("")`, which
	// `startsWith("/")` alone would pass for any absolute path.
	const worktreeRootReal = worktreeRoot ? realpathNearestExisting(worktreeRoot) : "";

	// Defense in depth, independent of --tools/--no-builtin-tools: refuse
	// anything not on the exact allowlist, and keep read-only builtins
	// inside the pinned worktree. Checked even for tools we never register.
	pi.on("tool_call", (event: ToolCallEvent): ToolCallEventResult | void => {
		if (READ_ONLY_BUILTINS.has(event.toolName)) {
			if (!worktreeRoot) {
				return { block: true, reason: "This planning turn has no configured worktree" };
			}
			const outside = candidatePaths(event.toolName, event.input).find(
				(candidate) => !isWithinWorktree(candidate, worktreeRoot, worktreeRootReal),
			);
			if (outside) {
				return { block: true, reason: "Path is outside this planning turn's worktree" };
			}
			return;
		}
		const serverName = event.toolName.startsWith("tako_mcp_")
			? event.toolName.slice("tako_mcp_".length)
			: null;
		if (serverName && allowedTools.has(serverName)) {
			// Defense in depth (M2): never a tool outside the Planner's own
			// server-side cap, even if this turn's granted_tools was widened.
			if (PLANNER_ALLOWED_MCP_TOOLS.has(serverName)) return;
			console.error(
				`[planner-tools-extension] dropping granted tool outside the Planner allowlist: ${serverName}`,
			);
		}
		return { block: true, reason: "Tool is not granted for this planning turn" };
	});

	if (!configured) return;

	const client = new TakonautClient({ serverUrl, apiKey, orgId });
	const catalog = new TakonautToolCatalog(pi, () => client, []);

	void (async () => {
		let tools: TakonautMcpTool[];
		try {
			tools = await client.listTools();
		} catch {
			return; // Fail closed: no tools registered.
		}
		const granted = tools.filter((tool) => allowedTools.has(tool.name));
		for (const tool of granted) {
			if (!PLANNER_ALLOWED_MCP_TOOLS.has(tool.name)) {
				console.error(
					`[planner-tools-extension] dropping granted tool outside the Planner allowlist: ${tool.name}`,
				);
			}
		}
		const grantedAndAllowed = granted.filter((tool) => PLANNER_ALLOWED_MCP_TOOLS.has(tool.name));
		try {
			const prepared = await catalog.prepare(client, grantedAndAllowed);
			catalog.activate(prepared);
		} catch {
			catalog.clear();
		}
	})();
}
