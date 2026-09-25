import { describe, expect, it, vi } from "vitest";
import {
	chooseGrillParent,
	listGrillParents,
	listGrillProjects,
} from "../src/tako-grill-discovery.js";

const id = "5228dbb1-60a7-4ea8-aa12-4b6876df7894";

function rpcUi(
	choices: Array<string | undefined>,
	queries: Array<string | undefined> = [],
) {
	return {
		mode: "rpc" as const,
		ui: {
			select: vi.fn(async () => choices.shift()),
			input: vi.fn(async () => queries.shift()),
		},
	} as any;
}

describe("Tako Grill discovery", () => {
	it("browses Projects then searches the server beyond a truncated Work hierarchy list", async () => {
		const ui = rpcUi(
			[
				"Cureocity · CC",
				"Search tako grill work hierarchy…",
				`PRD 39 · Brief · ${id}`,
			],
			["PRD 39"],
		);
		const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
			if (name === "list_projects") return [{ key: "CC", name: "Cureocity" }];
			if (name === "list_tako_grill_parents")
				return args.query === ""
					? { project_key: "CC", items: [], truncated: true }
					: {
							project_key: "CC",
							items: [{ id, title: "PRD 39", level_name: "Brief" }],
							truncated: false,
						};
			throw new Error("Unexpected tool");
		});
		await expect(chooseGrillParent({ query: null, call, ui })).resolves.toEqual(
			{ projectKey: "CC", parentId: id },
		);
		expect(call).toHaveBeenCalledWith(
			"list_tako_grill_parents",
			{ project_key: "CC", query: "PRD 39", limit: 50 },
			expect.any(AbortSignal),
		);
	});

	it("keeps search available when the initial Project and hierarchy responses exceed the Bridge cap", async () => {
		const ui = rpcUi(
			[
				"Search tako grill project…",
				"Cureocity · CC",
				"Search tako grill work hierarchy…",
				`PRD 39 · Brief · ${id}`,
			],
			["Cureocity", "PRD 39"],
		);
		const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
			if (name === "list_projects")
				return args.query
					? [{ key: "CC", name: "Cureocity" }]
					: { truncated: true, preview: "[..." };
			if (name === "list_tako_grill_parents")
				return args.query
					? {
							project_key: "CC",
							items: [{ id, title: "PRD 39", level_name: "Brief" }],
							truncated: false,
						}
					: { truncated: true, preview: "{..." };
			throw new Error("Unexpected tool");
		});
		await expect(chooseGrillParent({ query: null, call, ui })).resolves.toEqual(
			{ projectKey: "CC", parentId: id },
		);
	});

	it("does not invent a Project or silently bind malformed or mismatched results", async () => {
		await expect(
			listGrillProjects(async () => [{ key: "CC;rm -rf", name: "Bad" }]),
		).rejects.toThrow("invalid Project");
		await expect(
			listGrillParents(
				async () => ({ project_key: "OTHER", items: [], truncated: false }),
				"CC",
			),
		).rejects.toThrow("invalid Work hierarchy list");
		const ui = rpcUi(["Invented · NOPE"]);
		const call = vi.fn(async () => [{ key: "CC", name: "Cureocity" }]);
		await expect(chooseGrillParent({ query: null, call, ui })).rejects.toThrow(
			"cancelled",
		);
		// Only the authorized Project catalog was queried: no session can start.
		expect(call).toHaveBeenCalledTimes(1);
	});

	it("does not discard matches in unsearched Projects and skips only explicit Grill denials", async () => {
		const ui = rpcUi([`PRD 39 · Brief · CC · ${id}`]);
		const call = vi.fn(async (name: string, args: Record<string, unknown>) => {
			if (name === "list_projects")
				return [
					{ key: "ATL", name: "Atlanta" },
					{ key: "CC", name: "Cureocity" },
				];
			if (args.project_key === "ATL")
				throw new Error("Tako Grill is unavailable");
			return {
				project_key: "CC",
				items: [{ id, title: "PRD 39", level_name: "Brief" }],
				truncated: false,
			};
		});
		await expect(
			chooseGrillParent({ query: "PRD 39", call, ui }),
		).resolves.toEqual({ projectKey: "CC", parentId: id });
		expect(call.mock.calls.map(([name]) => name)).toEqual([
			"list_projects",
			"list_tako_grill_parents",
			"list_tako_grill_parents",
		]);
	});
});
