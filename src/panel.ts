import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { StartableTask } from "./client.js";

const WIDE_PANEL_MIN_WIDTH = 100;
const MEDIUM_PANEL_MIN_WIDTH = 72;

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
	projectKey?: string;
	executorPhase: string;
	status?: string;
}

export type SyncDebugState = "idle" | "running" | "ok" | "error" | "timeout";

export interface SyncOperationDebug {
	state: SyncDebugState;
	attempt: number;
	startedAt: string | null;
	durationMs: number | null;
	skipped: number;
	errorCode: string | null;
	sequence?: number;
}

export interface BridgePanelDebugData {
	panel: SyncOperationDebug;
	telemetry: SyncOperationDebug;
	reconcile: SyncOperationDebug;
	nextRefreshSeconds: number | null;
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
	debug?: BridgePanelDebugData;
}

interface PanelSegment {
	text: string;
	tone: PanelTone;
	strong?: boolean;
}

interface PanelSection {
	label: string;
	weight: number;
	primary: PanelSegment[];
	secondary: PanelSegment[];
}

function panelWidth(width: number): number {
	return Math.max(1, Math.floor(width));
}

function renderSegments(theme: PanelTheme, segments: PanelSegment[]): string {
	return segments
		.map((segment) => {
			const content = segment.strong ? theme.bold(segment.text) : segment.text;
			return theme.fg(segment.tone, content);
		})
		.join("");
}

function fit(text: string, width: number, ellipsis = "…"): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, ellipsis, true);
}

function border(theme: PanelTheme, text: string): string {
	return theme.fg("borderMuted", text);
}

function framedLine(
	theme: PanelTheme,
	width: number,
	segments: PanelSegment[],
): string {
	const resolvedWidth = panelWidth(width);
	if (resolvedWidth === 1) return border(theme, "│");
	const content = fit(renderSegments(theme, segments), resolvedWidth - 2);
	return `${border(theme, "│")}${content}${border(theme, "│")}`;
}

function framedSplitLine(
	theme: PanelTheme,
	width: number,
	left: PanelSegment[],
	right: PanelSegment[],
): string {
	const resolvedWidth = panelWidth(width);
	if (resolvedWidth === 1) return border(theme, "│");
	const innerWidth = resolvedWidth - 2;
	const leftText = renderSegments(theme, left);
	const rightText = renderSegments(theme, right);
	const gap = innerWidth - visibleWidth(leftText) - visibleWidth(rightText);
	const content =
		gap >= 1
			? `${leftText}${" ".repeat(gap)}${rightText}`
			: fit(`${leftText} ${rightText}`, innerWidth);
	return `${border(theme, "│")}${fit(content, innerWidth)}${border(theme, "│")}`;
}

function framedRule(
	theme: PanelTheme,
	width: number,
	leftGlyph: string,
	rightGlyph: string,
	left: PanelSegment[],
	right: PanelSegment[] = [],
): string {
	const resolvedWidth = panelWidth(width);
	if (resolvedWidth === 1) return border(theme, leftGlyph);
	const innerWidth = resolvedWidth - 2;
	const leftText = renderSegments(theme, left);
	const rightText = renderSegments(theme, right);
	const fillWidth =
		innerWidth - visibleWidth(leftText) - visibleWidth(rightText);
	const content =
		fillWidth >= 0
			? `${leftText}${border(theme, "─".repeat(fillWidth))}${rightText}`
			: fit(`${leftText}${rightText}`, innerWidth);
	return `${border(theme, leftGlyph)}${fit(content, innerWidth, "")}${border(theme, rightGlyph)}`;
}

function separator(
	theme: PanelTheme,
	width: number,
	columnWidths?: number[],
	junction = "┴",
): string {
	const resolvedWidth = panelWidth(width);
	if (resolvedWidth === 1) return border(theme, "├");
	if (!columnWidths?.length) {
		return border(theme, `├${"─".repeat(resolvedWidth - 2)}┤`);
	}
	return border(
		theme,
		`├${columnWidths.map((cellWidth) => "─".repeat(cellWidth)).join(junction)}┤`,
	);
}

function allocateColumnWidths(
	innerWidth: number,
	sections: PanelSection[],
): number[] {
	const available = Math.max(0, innerWidth - (sections.length - 1));
	const totalWeight = sections.reduce(
		(sum, section) => sum + section.weight,
		0,
	);
	const widths = sections.map((section) =>
		Math.max(1, Math.floor((available * section.weight) / totalWeight)),
	);
	let difference = available - widths.reduce((sum, width) => sum + width, 0);
	for (let index = 0; difference !== 0; index = (index + 1) % widths.length) {
		if (difference > 0) {
			widths[index]++;
			difference--;
		} else if (widths[index] > 1) {
			widths[index]--;
			difference++;
		}
	}
	return widths;
}

function renderCell(
	theme: PanelTheme,
	width: number,
	segments: PanelSegment[],
): string {
	if (width <= 0) return "";
	if (width === 1) return " ";
	return fit(` ${renderSegments(theme, segments)}`, width);
}

function renderColumns(
	theme: PanelTheme,
	width: number,
	sections: PanelSection[],
): { lines: string[]; widths: number[] } {
	const resolvedWidth = panelWidth(width);
	const innerWidth = Math.max(1, resolvedWidth - 2);
	const widths = allocateColumnWidths(innerWidth, sections);
	const row = (content: (section: PanelSection) => PanelSegment[]) =>
		`${border(theme, "│")}${sections
			.map((section, index) =>
				renderCell(theme, widths[index], content(section)),
			)
			.join(border(theme, "│"))}${border(theme, "│")}`;
	return {
		widths,
		lines: [
			row((section) => [{ text: section.label, tone: "dim", strong: true }]),
			row((section) => section.primary),
			row((section) => section.secondary),
		],
	};
}

function humanize(value: string): string {
	return value.replaceAll("_", " ");
}

function buildSections(
	data: BridgePanelData,
	ready: number,
	blocked: number,
): PanelSection[] {
	const sections: PanelSection[] = [];
	if (data.showRun) {
		const runDetail = data.run
			? [data.run.projectKey, humanize(data.run.executorPhase), data.run.status]
					.filter(
						(value, index, values) => value && values.indexOf(value) === index,
					)
					.join(" · ")
			: "No active delivery";
		sections.push({
			label: "RUN",
			weight: 45,
			primary: [
				{
					text: data.run?.taskKey ?? "Idle",
					tone: data.run ? "accent" : "muted",
					strong: Boolean(data.run),
				},
			],
			secondary: [{ text: runDetail, tone: data.run ? "text" : "muted" }],
		});
	}
	if (data.showTasks) {
		const stageCounts = new Map<string, number>();
		for (const task of data.tasks) {
			const stageName = task.stage_name ?? "Unknown Stage";
			stageCounts.set(stageName, (stageCounts.get(stageName) ?? 0) + 1);
		}
		const stageSummary = [...stageCounts]
			.map(([stageName, count]) => `${stageName} ${count}`)
			.join(" · ");
		sections.push({
			label: "WORK",
			weight: 35,
			primary: [
				{ text: `${ready} ready`, tone: ready ? "success" : "muted" },
				{ text: " · ", tone: "dim" },
				{ text: `${blocked} blocked`, tone: blocked ? "warning" : "muted" },
			],
			secondary: [
				{
					text: stageSummary || "No current work",
					tone: stageSummary ? "text" : "muted",
				},
			],
		});
	}
	if (data.showStandup) {
		let standupState = "Use /tako-panel";
		if (data.standupProjectKey) {
			if (data.standupStatus === "submitted") {
				standupState = "Submitted";
			} else if (data.standupStatus === "pending") {
				standupState = "Pending";
			} else {
				standupState = "Unavailable";
			}
		}
		sections.push({
			label: "STANDUP",
			weight: 20,
			primary: [
				{
					text: data.standupProjectKey ?? "Not set",
					tone: data.standupProjectKey ? "accent" : "muted",
					strong: Boolean(data.standupProjectKey),
				},
			],
			secondary: [
				{
					text: standupState,
					tone: data.standupStatus === "submitted" ? "success" : "muted",
				},
			],
		});
	}
	return sections;
}

function stackedSection(
	theme: PanelTheme,
	width: number,
	section: PanelSection,
) {
	return framedLine(theme, width, [
		{ text: ` ${section.label}  `, tone: "dim", strong: true },
		...section.primary,
		{ text: " · ", tone: "dim" },
		...section.secondary,
	]);
}

function debugTone(state: SyncDebugState): PanelTone {
	if (state === "ok") return "success";
	if (state === "running") return "accent";
	if (state === "error" || state === "timeout") return "warning";
	return "muted";
}

function debugOperationSegments(
	label: string,
	operation: SyncOperationDebug,
): PanelSegment[] {
	const startedAt = operation.startedAt?.slice(11, 19) ?? "never";
	const details = [
		`attempt ${operation.attempt}`,
		`started ${startedAt}`,
		...(operation.durationMs === null ? [] : [`${operation.durationMs}ms`]),
		...(operation.sequence === undefined ? [] : [`seq ${operation.sequence}`]),
		`skipped ${operation.skipped}`,
	];
	return [
		{ text: ` ${label.padEnd(11)} `, tone: "dim", strong: true },
		{ text: operation.state, tone: debugTone(operation.state), strong: true },
		{ text: ` · ${details.join(" · ")}`, tone: "muted" },
	];
}

function renderDebugBlock(
	theme: PanelTheme,
	width: number,
	debug: BridgePanelDebugData,
): string[] {
	const errors = [debug.panel, debug.telemetry, debug.reconcile]
		.map((operation) => operation.errorCode)
		.filter((errorCode): errorCode is string => Boolean(errorCode));
	const lines = [
		separator(theme, width),
		framedLine(theme, width, [
			{ text: " DEBUG SYNC", tone: "accent", strong: true },
		]),
		framedLine(theme, width, debugOperationSegments("PANEL", debug.panel)),
		framedLine(
			theme,
			width,
			debugOperationSegments("TELEMETRY", debug.telemetry),
		),
		framedLine(
			theme,
			width,
			debugOperationSegments("RECONCILE", debug.reconcile),
		),
		framedLine(theme, width, [
			{ text: " NEXT REFRESH  ", tone: "dim", strong: true },
			{
				text:
					debug.nextRefreshSeconds === null
						? "manual"
						: `${debug.nextRefreshSeconds}s`,
				tone: "muted",
			},
		]),
	];
	if (errors.length > 0) {
		lines.push(
			framedLine(theme, width, [
				{ text: " LAST ERROR  ", tone: "dim", strong: true },
				{ text: errors[0], tone: "warning" },
			]),
		);
	}
	return lines;
}

function nextAction(data: BridgePanelData): {
	message: PanelSegment[];
	command: PanelSegment[];
} {
	if (data.run) {
		return {
			message: [{ text: ` Inspect ${data.run.taskKey}`, tone: "text" }],
			command: [{ text: "/tako-status ", tone: "accent", strong: true }],
		};
	}
	const readyTask = data.tasks.find((task) => task.startability.startable);
	if (data.showTasks && readyTask) {
		return {
			message: [{ text: ` Start ${readyTask.task_key}`, tone: "text" }],
			command: [
				{
					text: `/tako-start ${readyTask.task_key} `,
					tone: "accent",
					strong: true,
				},
			],
		};
	}
	if (data.showStandup && data.standupStatus === "pending") {
		return {
			message: [{ text: " Prepare Standup", tone: "text" }],
			command: [{ text: "/tako-standup ", tone: "accent", strong: true }],
		};
	}
	return {
		message: [{ text: " Review Bridge status", tone: "text" }],
		command: [{ text: "/tako-panel ", tone: "accent", strong: true }],
	};
}

export function createBridgePanelWidget(
	data: BridgePanelData,
	theme: PanelTheme,
) {
	return {
		render(width: number): string[] {
			const resolvedWidth = panelWidth(width);
			const ready = data.tasks.filter(
				(task) => task.startability.startable,
			).length;
			const blocked = data.tasks.length - ready;
			const sections = buildSections(data, ready, blocked);
			const lines = [
				framedRule(
					theme,
					resolvedWidth,
					"╭",
					"╮",
					[
						{ text: "─ ", tone: "borderMuted" },
						{ text: "TAKO BRIDGE", tone: "accent", strong: true },
						{ text: " ", tone: "borderMuted" },
					],
					[
						{ text: "● LIVE", tone: "success", strong: true },
						{ text: " ─", tone: "borderMuted" },
					],
				),
			];

			if (resolvedWidth >= WIDE_PANEL_MIN_WIDTH && sections.length >= 2) {
				const grid = renderColumns(theme, resolvedWidth, sections);
				lines.push(...grid.lines, separator(theme, resolvedWidth, grid.widths));
			} else if (
				resolvedWidth >= MEDIUM_PANEL_MIN_WIDTH &&
				sections.length >= 2
			) {
				const gridSections = sections.slice(0, 2);
				const grid = renderColumns(theme, resolvedWidth, gridSections);
				lines.push(...grid.lines, separator(theme, resolvedWidth, grid.widths));
				for (const section of sections.slice(2)) {
					lines.push(stackedSection(theme, resolvedWidth, section));
				}
				if (sections.length > 2) lines.push(separator(theme, resolvedWidth));
			} else {
				for (const section of sections) {
					lines.push(stackedSection(theme, resolvedWidth, section));
				}
				if (sections.length > 0) lines.push(separator(theme, resolvedWidth));
			}

			const action = nextAction(data);
			lines.push(
				framedSplitLine(
					theme,
					resolvedWidth,
					[{ text: " NEXT", tone: "dim", strong: true }, ...action.message],
					action.command,
				),
			);

			if (data.showTasks) {
				for (const task of data.tasks.slice(0, data.taskLimit)) {
					const startable = task.startability.startable;
					lines.push(
						framedLine(theme, resolvedWidth, [
							{ text: " ", tone: "borderMuted" },
							{
								text: startable ? "◆ " : "◇ ",
								tone: startable ? "success" : "warning",
							},
							{ text: `${task.task_key}  `, tone: "accent", strong: true },
							{ text: task.task_title, tone: "text" },
							{
								text: task.stage_name ? ` · ${task.stage_name}` : "",
								tone: "muted",
							},
						]),
					);
				}
			}

			if (data.debug) {
				lines.push(...renderDebugBlock(theme, resolvedWidth, data.debug));
			}

			const hiddenTasks = Math.max(0, data.tasks.length - data.taskLimit);
			const footerPrefix = hiddenTasks ? `+${hiddenTasks} more · ` : "";
			lines.push(
				framedRule(
					theme,
					resolvedWidth,
					"╰",
					"╯",
					[
						{ text: `─ ${footerPrefix}`, tone: "borderMuted" },
						{
							text: "/tako-status · /tako-tasks · /tako-standup · /tako-panel",
							tone: "dim",
						},
						{ text: " ", tone: "borderMuted" },
					],
					[{ text: "─", tone: "borderMuted" }],
				),
			);
			return lines;
		},
		invalidate() {},
	};
}

export function createBridgePanelLoginWidget(theme: PanelTheme) {
	return {
		render(width: number): string[] {
			const resolvedWidth = panelWidth(width);
			return [
				framedRule(
					theme,
					resolvedWidth,
					"╭",
					"╮",
					[
						{ text: "─ ", tone: "borderMuted" },
						{ text: "TAKO BRIDGE", tone: "accent", strong: true },
						{ text: " ", tone: "borderMuted" },
					],
					[
						{ text: "○ SIGN IN", tone: "warning", strong: true },
						{ text: " ─", tone: "borderMuted" },
					],
				),
				framedLine(theme, resolvedWidth, [
					{ text: " Connect Takonaut to see your work here.", tone: "muted" },
				]),
				framedSplitLine(
					theme,
					resolvedWidth,
					[
						{ text: " NEXT", tone: "dim", strong: true },
						{ text: "  Start secure device login", tone: "text" },
					],
					[{ text: "/tako-login", tone: "accent", strong: true }],
				),
				framedRule(
					theme,
					resolvedWidth,
					"╰",
					"╯",
					[{ text: "─ ", tone: "borderMuted" }],
					[{ text: "─", tone: "borderMuted" }],
				),
			];
		},
		invalidate() {},
	};
}

export function createBridgePanelErrorWidget(
	message: string,
	theme: PanelTheme,
	debug?: BridgePanelDebugData,
) {
	return {
		render(width: number): string[] {
			const resolvedWidth = panelWidth(width);
			const lines = [
				framedRule(
					theme,
					resolvedWidth,
					"╭",
					"╮",
					[
						{ text: "─ ", tone: "borderMuted" },
						{ text: "TAKO BRIDGE", tone: "accent", strong: true },
						{ text: " ", tone: "borderMuted" },
					],
					[
						{ text: "◇ DELAYED", tone: "warning", strong: true },
						{ text: " ─", tone: "borderMuted" },
					],
				),
				framedLine(theme, resolvedWidth, [
					{ text: ` ${message}`, tone: "muted" },
				]),
			];
			if (debug) lines.push(...renderDebugBlock(theme, resolvedWidth, debug));
			lines.push(
				framedRule(
					theme,
					resolvedWidth,
					"╰",
					"╯",
					[
						{ text: "─ ", tone: "borderMuted" },
						{ text: "/tako-status", tone: "dim" },
						{ text: " ", tone: "borderMuted" },
					],
					[{ text: "─", tone: "borderMuted" }],
				),
			);
			return lines;
		},
		invalidate() {},
	};
}
