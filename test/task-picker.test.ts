import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import { TaskPicker } from "../src/task-picker.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const tasks = [
	{
		task_key: "PAY-142",
		task_title: "Handle expired sessions",
		project_key: "PAY",
		task_path: "/projects/PAY/items/task-1",
		workflow_mode: "sprint" as const,
		sprint_name: "Current Sprint",
		stage_name: "Development",
		stage_group: "in_progress",
		startability: { startable: true, reasons: [] },
	},
	{
		task_key: "PAY-143",
		task_title: "Rotate credentials",
		project_key: "PAY",
		task_path: "/projects/PAY/items/task-2",
		workflow_mode: "kanban" as const,
		sprint_name: null,
		stage_name: "Review",
		stage_group: "in_progress",
		startability: {
			startable: false,
			reasons: ["project_agent_playbook_required"],
		},
	},
];

describe("TaskPicker", () => {
	it("searches task key, title, Project, Sprint, and Stage before selection", () => {
		const selected = vi.fn();
		const changed = vi.fn();
		const picker = new TaskPicker(tasks, theme, {
			onSelect: selected,
			onCancel: vi.fn(),
			onChange: changed,
		});

		for (const character of "review") picker.handleInput(character);
		const lines = picker.render(80);

		expect(lines.join("\n")).toContain("PAY-143");
		expect(lines.join("\n")).not.toContain("PAY-142");
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		expect(changed).toHaveBeenCalled();

		picker.handleInput("\r");
		expect(selected).toHaveBeenCalledWith("PAY-143");
	});

	it("keeps keyboard selection visible while scrolling beyond ten results", () => {
		const manyTasks = Array.from({ length: 12 }, (_, index) => ({
			...tasks[0],
			task_key: `PAY-${String(index + 1).padStart(3, "0")}`,
			task_title: `Task ${index + 1}`,
			task_path: `/projects/PAY/items/task-${index + 1}`,
		}));
		const picker = new TaskPicker(manyTasks, theme, {
			onSelect: vi.fn(),
			onCancel: vi.fn(),
			onChange: vi.fn(),
		});

		for (let index = 0; index < 11; index += 1) {
			picker.handleInput("\u001b[B");
		}
		const text = picker.render(80).join("\n");

		expect(text).toContain("› ◆ PAY-012");
		expect(text).not.toContain("PAY-001");
	});

	it("cancels the popup with Escape", () => {
		const cancelled = vi.fn();
		const picker = new TaskPicker(tasks, theme, {
			onSelect: vi.fn(),
			onCancel: cancelled,
			onChange: vi.fn(),
		});

		picker.handleInput("\u001b");

		expect(cancelled).toHaveBeenCalledOnce();
	});
});
