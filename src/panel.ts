import type { StartableTask } from "./client.js";

const PANEL_TONES = [
	"accent",
	"borderMuted",
	"dim",
	"muted",
	"success",
	"text",
	"warning",
] as const;

type PanelTone = (typeof PANEL_TONES)[number];

interface PanelTheme {
	fg(tone: PanelTone, text: string): string;
	bold(text: string): string;
}

interface PanelRun {
	taskKey: string;
	executorPhase: string;
}

export interface BridgePanelData {
	run: PanelRun | null;
	showRun: boolean;
	showStandup: boolean;
	showTasks: boolean;
	standupProjectKey?: string;
	standupStatus: "pending" | "submitted" | null;
	tasks: StartableTask[];
	taskLimit: number;
}

interface PanelSegment {
	text: string;
	tone: PanelTone;
	strong?: boolean;
}

function paintLine(
	theme: PanelTheme,
	width: number,
	segments: PanelSegment[],
): string {
	let remaining = Math.max(1, width);
	const rendered: string[] = [];
	for (const segment of segments) {
		if (remaining <= 0) break;
		const clipped =
			segment.text.length <= remaining
				? segment.text
				: remaining === 1
					? "…"
					: `${segment.text.slice(0, remaining - 1)}…`;
		const content = segment.strong ? theme.bold(clipped) : clipped;
		rendered.push(theme.fg(segment.tone, content));
		remaining -= clipped.length;
		if (clipped.length < segment.text.length) break;
	}
	return rendered.join("");
}

export function createBridgePanelWidget(
	data: BridgePanelData,
	theme: PanelTheme,
) {
	return {
		render(width: number): string[] {
			const paint = (segments: PanelSegment[]) =>
				paintLine(theme, width, segments);
			const ready = data.tasks.filter(
				(task) => task.startability.startable,
			).length;
			const blocked = data.tasks.length - ready;
			const lines = [
				paint([
					{ text: "╭─ ", tone: "borderMuted" },
					{ text: "TAKO BRIDGE", tone: "accent", strong: true },
					{ text: "  ", tone: "dim" },
					{ text: "● Connected", tone: "success" },
				]),
			];

			const info: PanelSegment[] = [{ text: "│ ", tone: "borderMuted" }];
			if (data.showRun) {
				const runState = data.run
					? `${data.run.taskKey} · ${data.run.executorPhase.replaceAll("_", " ")}`
					: "Idle";
				info.push(
					{ text: "Run  ", tone: "dim" },
					{ text: runState, tone: data.run ? "accent" : "muted" },
				);
			}
			if (data.showStandup) {
				if (data.showRun) info.push({ text: "  ·  ", tone: "dim" });
				const standupState = !data.standupProjectKey
					? "Not set"
					: !data.standupStatus
						? `${data.standupProjectKey} · Unavailable`
						: `${data.standupProjectKey} · ${data.standupStatus === "submitted" ? "Submitted" : "Pending"}`;
				info.push(
					{ text: "Standup  ", tone: "dim" },
					{
						text: standupState,
						tone: data.standupStatus === "submitted" ? "success" : "muted",
					},
				);
			}
			if (info.length > 1) lines.push(paint(info));

			if (data.showTasks) {
				lines.push(
					paint([
						{ text: "│ ", tone: "borderMuted" },
						{ text: "Work  ", tone: "dim" },
						{ text: `${ready} ready`, tone: "success" },
						{ text: "  ·  ", tone: "dim" },
						{
							text: `${blocked} blocked`,
							tone: blocked ? "warning" : "muted",
						},
					]),
				);
				for (const task of data.tasks.slice(0, data.taskLimit)) {
					const startable = task.startability.startable;
					lines.push(
						paint([
							{ text: "│ ", tone: "borderMuted" },
							{
								text: startable ? "◆ " : "◇ ",
								tone: startable ? "success" : "warning",
							},
							{ text: `${task.task_key}  `, tone: "accent", strong: true },
							{ text: task.task_title, tone: "text" },
						]),
					);
				}
			}

			const hiddenTasks = Math.max(0, data.tasks.length - data.taskLimit);
			const taskHint = hiddenTasks
				? `${hiddenTasks} more · /tako-tasks`
				: "/tako-tasks details";
			const footer: PanelSegment[] = [
				{ text: "╰─ ", tone: "borderMuted" },
				{
					text: data.showTasks ? taskHint : "/tako-panel settings",
					tone: "dim",
				},
			];
			if (data.showTasks) {
				footer.push(
					{ text: "  ·  ", tone: "dim" },
					{ text: "/tako-panel settings", tone: "dim" },
				);
			}
			lines.push(paint(footer));
			return lines;
		},
		invalidate() {},
	};
}

export function createBridgePanelErrorWidget(
	message: string,
	theme: PanelTheme,
) {
	return {
		render(width: number): string[] {
			const clip = (text: string) =>
				text.length <= width
					? text
					: `${text.slice(0, Math.max(0, width - 1))}…`;
			return [
				theme.fg("warning", clip("╭─ TAKO BRIDGE  ◇ Delayed")),
				theme.fg("muted", clip(`│ ${message}`)),
				theme.fg("dim", clip("╰─ /tako-status")),
			];
		},
		invalidate() {},
	};
}
