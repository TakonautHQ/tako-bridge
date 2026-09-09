import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { removeExactTakonautMcpEntry } from "../src/mcp-config-cleanup";

// Each case gets an isolated project root so cleanup cannot touch the real workspace.
function workspace(): string {
	return mkdtempSync(join(tmpdir(), "tako-mcp-cleanup-"));
}

function exactTakonautEntry() {
	return {
		type: "http",
		url: "https://takonaut.app/mcp/",
		headers: {
			"X-API-Key": "legacy-secret",
			"X-Organization-Id": "org-123",
		},
	};
}

describe("removeExactTakonautMcpEntry", () => {
	it("atomically removes only the exact Takonaut entry and preserves unrelated integrations", () => {
		const cwd = workspace();
		const path = join(cwd, ".mcp.json");
		writeFileSync(
			path,
			JSON.stringify({
				mcpServers: {
					takonaut: exactTakonautEntry(),
					supabase: { type: "http", url: "https://mcp.supabase.com/mcp" },
				},
				metadata: { owner: "developer" },
			}),
			{ mode: 0o600 },
		);

		expect(removeExactTakonautMcpEntry(cwd)).toBe("removed");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			mcpServers: {
				supabase: { type: "http", url: "https://mcp.supabase.com/mcp" },
			},
			metadata: { owner: "developer" },
		});
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it.each([
		["different name", "takonaut-prod", exactTakonautEntry()],
		[
			"different host",
			"takonaut",
			{ ...exactTakonautEntry(), url: "https://example.com/mcp/" },
		],
		[
			"unexpected headers",
			"takonaut",
			{
				...exactTakonautEntry(),
				headers: { Authorization: "Bearer legacy-secret" },
			},
		],
	])("does not remove a nonmatching %s entry", (_case, name, entry) => {
		const cwd = workspace();
		const path = join(cwd, ".mcp.json");
		const original = { mcpServers: { [name]: entry } };
		writeFileSync(path, JSON.stringify(original), { mode: 0o600 });

		expect(removeExactTakonautMcpEntry(cwd)).toBe("not_matching");
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(original);
	});

	it("is a no-op when the project has no MCP config", () => {
		expect(removeExactTakonautMcpEntry(workspace())).toBe("absent");
	});

	it("refuses a config writable by another user", () => {
		const cwd = workspace();
		const path = join(cwd, ".mcp.json");
		const original = JSON.stringify({
			mcpServers: { takonaut: exactTakonautEntry() },
		});
		writeFileSync(path, original, { mode: 0o600 });
		chmodSync(path, 0o666);

		expect(() => removeExactTakonautMcpEntry(cwd)).toThrow(
			"unsafe MCP configuration file",
		);
		expect(readFileSync(path, "utf8")).toBe(original);
	});

	it("refuses a project directory writable by another user", () => {
		const cwd = workspace();
		const path = join(cwd, ".mcp.json");
		writeFileSync(
			path,
			JSON.stringify({ mcpServers: { takonaut: exactTakonautEntry() } }),
			{ mode: 0o600 },
		);
		chmodSync(cwd, 0o777);

		expect(() => removeExactTakonautMcpEntry(cwd)).toThrow(
			"unsafe MCP configuration file",
		);
	});

	it("refuses symlinked MCP config files without changing the target", () => {
		const cwd = workspace();
		const target = join(cwd, "target.json");
		const original = JSON.stringify({
			mcpServers: { takonaut: exactTakonautEntry() },
		});
		writeFileSync(target, original, { mode: 0o600 });
		symlinkSync(target, join(cwd, ".mcp.json"));

		expect(() => removeExactTakonautMcpEntry(cwd)).toThrow(
			"unsafe MCP configuration file",
		);
		expect(readFileSync(target, "utf8")).toBe(original);
	});
});
