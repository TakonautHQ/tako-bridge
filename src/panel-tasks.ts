import type { StartableTask } from "./client.js";

export const PANEL_TASK_FILTERS = [
	"all",
	"open",
	"in_progress",
	"ready",
	"blocked",
	"done",
] as const;

export type PanelTaskFilter = (typeof PANEL_TASK_FILTERS)[number];

export const PANEL_TASK_FILTER_LABELS: Record<PanelTaskFilter, string> = {
	all: "All",
	open: "Open",
	in_progress: "In progress",
	ready: "Ready",
	blocked: "Blocked",
	done: "Done",
};

export function isDoneTask(task: StartableTask): boolean {
	return (
		task.stage_group === "done" ||
		task.startability.reasons.includes("terminal_stage")
	);
}

function matchesFilter(task: StartableTask, filter: PanelTaskFilter): boolean {
	if (filter === "all") return true;
	if (filter === "done") return isDoneTask(task);
	if (isDoneTask(task)) return false;
	switch (filter) {
		case "open":
			return true;
		case "in_progress":
			return task.stage_group === "in_progress";
		case "ready":
			return task.startability.startable;
		case "blocked":
			return !task.startability.startable;
	}
}

function taskRank(task: StartableTask): number {
	if (isDoneTask(task)) return 3;
	if (task.stage_group === "in_progress") return 0;
	return task.startability.startable ? 1 : 2;
}

/** Filter before limiting rows; stable sorting preserves server order within groups. */
export function selectPanelTasks(
	tasks: readonly StartableTask[],
	filter: PanelTaskFilter = "all",
): StartableTask[] {
	return tasks
		.filter((task) => matchesFilter(task, filter))
		.sort((left, right) => taskRank(left) - taskRank(right));
}
