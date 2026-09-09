import { describe, expect, it, vi } from "vitest";

import { TakonautToolCatalog } from "../src/catalog";

// Fixtures mirror the caller-filtered descriptors returned by Takonaut's MCP server.
function parseResult(text: string): Record<string, unknown> {
	try {
		return JSON.parse(text) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Expected JSON tool result: ${String(error)}`);
	}
}

function remoteTool(name: string) {
	return {
		name,
		description: `Remote ${name}`,
		inputSchema: {
			type: "object",
			properties: { project_key: { type: "string" } },
			additionalProperties: false,
		},
	};
}

function harness() {
	const definitions = new Map<string, any>();
	let active = ["read", "unrelated_mcp_tool", "tako_search_capabilities"];
	const pi = {
		registerTool: vi.fn((definition: any) => {
			definitions.set(definition.name, definition);
		}),
		getActiveTools: vi.fn(() => [...active]),
		setActiveTools: vi.fn((names: string[]) => {
			active = [...names];
		}),
	};
	const client = {
		listTools: vi.fn(),
		callTool: vi.fn(),
	};
	const catalog = new TakonautToolCatalog(pi as any, () => client as any);
	return { catalog, client, definitions, pi, active: () => active };
}

describe("TakonautToolCatalog", () => {
	it("registers the authenticated catalog under stable names and preserves unrelated active tools", async () => {
		const { catalog, client, definitions, active } = harness();
		client.listTools.mockResolvedValue([
			remoteTool("list_tasks"),
			remoteTool("create_task"),
		]);

		await catalog.refresh();

		expect([...definitions.keys()]).toEqual([
			"tako_mcp_list_tasks",
			"tako_mcp_create_task",
		]);
		expect(active()).toEqual([
			"read",
			"unrelated_mcp_tool",
			"tako_search_capabilities",
			"tako_mcp_list_tasks",
			"tako_mcp_create_task",
		]);
	});

	it("routes a dynamic tool directly without an extra confirmation", async () => {
		const { catalog, client, definitions } = harness();
		client.listTools.mockResolvedValue([remoteTool("create_task")]);
		client.callTool.mockResolvedValue({ task_key: "PAY-2" });
		await catalog.refresh();

		const result = await definitions
			.get("tako_mcp_create_task")
			.execute(
				"call-1",
				{ project_key: "PAY", title: "Ship catalog" },
				undefined,
				undefined,
				{ hasUI: false },
			);

		expect(client.callTool).toHaveBeenCalledWith("create_task", {
			project_key: "PAY",
			title: "Ship catalog",
		});
		expect(parseResult(result.content[0].text)).toEqual({ task_key: "PAY-2" });
	});

	it("disables removed tools and refuses stale handlers locally", async () => {
		const { catalog, client, definitions, active } = harness();
		client.listTools.mockResolvedValueOnce([remoteTool("list_tasks")]);
		await catalog.refresh();
		const stale = definitions.get("tako_mcp_list_tasks");

		client.listTools.mockResolvedValueOnce([remoteTool("get_task")]);
		await catalog.refresh();
		const result = await stale.execute("call-2", {}, undefined, undefined, {
			hasUI: false,
		});

		expect(active()).not.toContain("tako_mcp_list_tasks");
		expect(active()).toContain("tako_mcp_get_task");
		expect(client.callTool).not.toHaveBeenCalled();
		expect(parseResult(result.content[0].text)).toEqual({
			error: "capability_unavailable",
		});
	});

	it("fails closed and disables stale tools when refresh fails", async () => {
		const { catalog, client, definitions, active } = harness();
		client.listTools.mockResolvedValueOnce([remoteTool("list_tasks")]);
		await catalog.refresh();
		const stale = definitions.get("tako_mcp_list_tasks");
		client.listTools.mockRejectedValueOnce(new Error("catalog unavailable"));

		await expect(catalog.refresh()).rejects.toThrow("catalog unavailable");
		expect(active()).not.toContain("tako_mcp_list_tasks");
		const result = await stale.execute("call-stale", {}, undefined);
		expect(parseResult(result.content[0].text)).toEqual({
			error: "capability_unavailable",
		});
	});

	it("keeps a partially registered catalog inactive", async () => {
		const { catalog, client, pi, active } = harness();
		client.listTools.mockResolvedValue([
			remoteTool("list_tasks"),
			remoteTool("create_task"),
		]);
		pi.registerTool
			.mockImplementationOnce(() => undefined)
			.mockImplementationOnce(() => {
				throw new Error("registration failed");
			});

		await expect(catalog.refresh()).rejects.toThrow("registration failed");
		expect(active()).not.toContain("tako_mcp_list_tasks");
		expect(active()).not.toContain("tako_mcp_create_task");
	});

	it("keeps the final Pi-visible result within 8 KB", async () => {
		const { catalog, client, definitions } = harness();
		client.listTools.mockResolvedValue([remoteTool("get_task")]);
		client.callTool.mockResolvedValue({ preview: '"'.repeat(8_192) });
		await catalog.refresh();

		const result = await definitions
			.get("tako_mcp_get_task")
			.execute("call-large", {}, undefined);

		expect(
			Buffer.byteLength(result.content[0].text, "utf8"),
		).toBeLessThanOrEqual(8_192);
	});

	it("does not register the same dynamic name twice across refreshes", async () => {
		const { catalog, client, pi } = harness();
		client.listTools.mockResolvedValue([remoteTool("list_tasks")]);

		await catalog.refresh();
		await catalog.refresh();

		expect(pi.registerTool).toHaveBeenCalledTimes(1);
	});
});
