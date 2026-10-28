import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { PLANNER_ALLOWED_MCP_TOOLS } from "../src/planner-allowed-tools";

const BACKEND_SRC = join(__dirname, "..", "..", "..", "backend", "src");
// The backend only exists in the Takonaut monorepo; the public tako-bridge
// release has no backend to compare against.
const HAS_BACKEND = existsSync(join(BACKEND_SRC, "services", "agent_profile_template_seeds.py"));

function grantKeys(source: string, constantName: string): string[] {
	const match = new RegExp(`${constantName}\\s*=\\s*frozenset\\(\\s*\\{([^}]*)\\}`).exec(source);
	if (!match) throw new Error(`${constantName} not found in agent_profile_template_seeds.py`);
	return [...match[1].matchAll(/"([a-zA-Z0-9_.]+)"/g)].map((m) => m[1]);
}

function mcpToolsForGrant(catalogSource: string, grantKey: string): string[] {
	const start = catalogSource.indexOf(`"${grantKey}": _tool(`);
	if (start === -1) throw new Error(`Grant '${grantKey}' not found in catalog.py`);
	// The `mcp_tools` tuple is the first parenthesized group of only
	// string literals after the grant's own repeated key/name/description/
	// is_write arguments.
	const tupleMatch = /\(\s*((?:"[a-zA-Z0-9_]+",?\s*)+)\)/.exec(catalogSource.slice(start, start + 2000));
	if (!tupleMatch) throw new Error(`mcp_tools tuple not found for grant '${grantKey}'`);
	return [...tupleMatch[1].matchAll(/"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
}

describe("PLANNER_ALLOWED_MCP_TOOLS (mirrors backend/src/services/agent_profile_template_seeds.py)", () => {
	it.skipIf(!HAS_BACKEND)("is exactly the set of MCP tools the backend's _PLANNER_ALLOWED_GRANTS resolve to", () => {
		const seedsSource = readFileSync(
			join(BACKEND_SRC, "services", "agent_profile_template_seeds.py"),
			"utf8",
		);
		const catalogSource = readFileSync(
			join(BACKEND_SRC, "services", "ai", "agent_tools", "catalog.py"),
			"utf8",
		);
		const grants = [
			...grantKeys(seedsSource, "_PLANNER_READ_GRANTS"),
			...grantKeys(seedsSource, "_PLANNER_WRITE_GRANTS"),
		];
		expect(grants.length).toBeGreaterThan(0);

		const expected = new Set<string>();
		for (const grant of grants) {
			for (const toolName of mcpToolsForGrant(catalogSource, grant)) expected.add(toolName);
		}

		expect(new Set(PLANNER_ALLOWED_MCP_TOOLS)).toEqual(expected);
	});
});
