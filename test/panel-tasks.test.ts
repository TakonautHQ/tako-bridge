import { describe, expect, it } from "vitest";
import type { StartableTask } from "../src/client.js";
import { isDoneTask, selectPanelTasks } from "../src/panel-tasks.js";

function task(
	key: string,
	stage: string | undefined,
	startable: boolean,
	reasons: string[] = [],
): StartableTask {
	return {
		task_key: key,
		task_title: key,
		project_key: "PAY",
		stage_group: stage,
		startability: { startable, reasons },
	};
}

const tasks = [
	task("done", "done", false, ["terminal_stage"]),
	task("blocked", "todo", false),
	task("ready", "todo", true),
	task("active-blocked", "in_progress", false),
	task("active-ready", "in_progress", true),
	task("ready-2", undefined, true),
	task("legacy-done", undefined, false, ["terminal_stage"]),
];

const orderedKeys = [
	"active-blocked",
	"active-ready",
	"ready",
	"ready-2",
	"blocked",
	"done",
	"legacy-done",
];

describe("panel task selection", () => {
	it("sorts active, ready, blocked, then done without mutating the input or tie order", () => {
		const original = tasks.slice();
		expect(
			selectPanelTasks(Object.freeze(tasks)).map((item) => item.task_key),
		).toEqual(orderedKeys);
		expect(tasks).toEqual(original);
	});

	it.each([
		["all", orderedKeys],
		["open", ["active-blocked", "active-ready", "ready", "ready-2", "blocked"]],
		["in_progress", ["active-blocked", "active-ready"]],
		["ready", ["active-ready", "ready", "ready-2"]],
		["blocked", ["active-blocked", "blocked"]],
		["done", ["done", "legacy-done"]],
	] as const)("filters %s tasks", (filter, keys) => {
		expect(
			selectPanelTasks(tasks, filter).map((item) => item.task_key),
		).toEqual(keys);
	});

	it("identifies done by group or terminal reason, not custom stage names", () => {
		const done = { ...task("done", "done", true), stage_name: "Shipped" };
		expect(isDoneTask(done)).toBe(true);
		expect(selectPanelTasks([done], "ready")).toEqual([]);
		expect(
			isDoneTask(task("legacy", undefined, false, ["terminal_stage"])),
		).toBe(true);
		expect(
			isDoneTask({ ...task("open", "todo", true), stage_name: "Done" }),
		).toBe(false);
	});

	it("handles an empty task list", () => {
		expect(selectPanelTasks([])).toEqual([]);
	});
});
