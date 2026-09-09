import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";

import type { StartableTask } from "./client.js";

interface TaskPickerCallbacks {
	onSelect: (taskKey: string) => void;
	onCancel: () => void;
	onChange: () => void;
}

function searchableTaskText(task: StartableTask): string {
	return [
		task.task_key,
		task.task_title,
		task.project_key,
		task.workflow_mode,
		task.sprint_name,
		task.stage_name,
		task.stage_group,
	]
		.filter(Boolean)
		.join(" ")
		.toLocaleLowerCase();
}

export class TaskPicker implements Component, Focusable {
	private readonly searchInput = new Input();
	private selectedIndex = 0;
	private _focused = false;

	constructor(
		private readonly tasks: StartableTask[],
		private readonly theme: Theme,
		private readonly callbacks: TaskPickerCallbacks,
	) {}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	private filteredTasks(): StartableTask[] {
		const query = this.searchInput.getValue().trim().toLocaleLowerCase();
		if (!query) return this.tasks;
		return this.tasks.filter((task) =>
			searchableTaskText(task).includes(query),
		);
	}

	handleInput(data: string): void {
		const tasks = this.filteredTasks();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.callbacks.onCancel();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.callbacks.onChange();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(
				Math.max(0, tasks.length - 1),
				this.selectedIndex + 1,
			);
			this.callbacks.onChange();
			return;
		}
		if (matchesKey(data, Key.enter)) {
			const selected = tasks[this.selectedIndex];
			if (selected) this.callbacks.onSelect(selected.task_key);
			return;
		}
		this.searchInput.handleInput(data);
		this.selectedIndex = 0;
		this.callbacks.onChange();
	}

	private framedLine(content: string, width: number): string {
		const innerWidth = Math.max(1, width - 2);
		const clipped = truncateToWidth(content, innerWidth);
		const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(clipped)));
		return (
			this.theme.fg("borderMuted", "│") +
			clipped +
			padding +
			this.theme.fg("borderMuted", "│")
		);
	}

	render(width: number): string[] {
		const resolvedWidth = Math.max(20, width);
		const innerWidth = resolvedWidth - 2;
		const tasks = this.filteredTasks();
		this.selectedIndex = Math.min(
			this.selectedIndex,
			Math.max(0, tasks.length - 1),
		);
		const searchWidth = Math.max(1, innerWidth - 10);
		const search = this.searchInput.render(searchWidth)[0] ?? "";
		const lines = [
			this.theme.fg(
				"borderMuted",
				`╭${"─".repeat(Math.max(0, resolvedWidth - 2))}╮`,
			),
			this.framedLine(
				` ${this.theme.fg("accent", this.theme.bold("CURRENT WORK"))}`,
				resolvedWidth,
			),
			this.framedLine(
				` ${this.theme.fg("dim", "Search:")} ${search}`,
				resolvedWidth,
			),
			this.theme.fg(
				"borderMuted",
				`├${"─".repeat(Math.max(0, resolvedWidth - 2))}┤`,
			),
		];
		if (tasks.length === 0) {
			lines.push(
				this.framedLine(
					` ${this.theme.fg("muted", "No matching current work")}`,
					resolvedWidth,
				),
			);
		} else {
			const maxVisible = 10;
			const startIndex = Math.max(
				0,
				Math.min(
					this.selectedIndex - Math.floor(maxVisible / 2),
					tasks.length - maxVisible,
				),
			);
			const visibleTasks = tasks.slice(startIndex, startIndex + maxVisible);
			for (const [offset, task] of visibleTasks.entries()) {
				const index = startIndex + offset;
				const marker = task.startability.startable ? "◆" : "◇";
				const scope =
					task.workflow_mode === "kanban"
						? "Kanban"
						: (task.sprint_name ?? "Sprint");
				const row = ` ${index === this.selectedIndex ? "›" : " "} ${marker} ${task.task_key}  [${task.stage_name ?? "Unknown Stage"}]  ${task.task_title}  · ${task.project_key} · ${scope}`;
				const content =
					index === this.selectedIndex
						? this.theme.bg("selectedBg", this.theme.fg("text", row))
						: this.theme.fg("muted", row);
				lines.push(this.framedLine(content, resolvedWidth));
			}
			if (tasks.length > maxVisible) {
				lines.push(
					this.framedLine(
						` ${this.theme.fg("dim", `${this.selectedIndex + 1}/${tasks.length}`)}`,
						resolvedWidth,
					),
				);
			}
		}
		lines.push(
			this.framedLine(
				` ${this.theme.fg("dim", "↑↓ navigate · Enter open in browser · Esc close")}`,
				resolvedWidth,
			),
			this.theme.fg(
				"borderMuted",
				`╰${"─".repeat(Math.max(0, resolvedWidth - 2))}╯`,
			),
		);
		return lines;
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}
}
