import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
	type Focusable,
} from "@earendil-works/pi-tui";

import type { PanelSettings } from "./config.js";

interface PanelSettingsCallbacks {
	onSettingsChange: (settings: PanelSettings) => void;
	onRefresh: () => void;
	onDone: () => void;
	onChange: () => void;
}

const TASK_LIMITS: PanelSettings["taskLimit"][] = [1, 3, 5, 10];
const REFRESH_INTERVALS: PanelSettings["refreshSeconds"][] = [0, 15, 30, 60];
const ROW_COUNT = 10;

function cycleValue<T>(values: T[], current: T, direction: -1 | 1): T {
	const currentIndex = Math.max(0, values.indexOf(current));
	return values[(currentIndex + direction + values.length) % values.length];
}

export class PanelSettingsView implements Component, Focusable {
	private selectedIndex = 0;
	private _focused = false;
	private settings: PanelSettings;
	private readonly projectChoices: Array<string | undefined>;

	constructor(
		settings: PanelSettings,
		projects: string[],
		private readonly theme: Theme,
		private readonly callbacks: PanelSettingsCallbacks,
	) {
		this.settings = { ...settings };
		this.projectChoices = [
			undefined,
			...new Set(
				[settings.standupProjectKey, ...projects].filter(
					(project): project is string => Boolean(project),
				),
			),
		];
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	private commit(next: PanelSettings): void {
		this.settings = next;
		this.callbacks.onSettingsChange({ ...next });
		this.callbacks.onChange();
	}

	private adjust(direction: -1 | 1): void {
		switch (this.selectedIndex) {
			case 0:
				this.commit({ ...this.settings, visible: !this.settings.visible });
				break;
			case 1:
				this.commit({ ...this.settings, showRun: !this.settings.showRun });
				break;
			case 2:
				this.commit({ ...this.settings, showTasks: !this.settings.showTasks });
				break;
			case 3:
				this.commit({
					...this.settings,
					showStandup: !this.settings.showStandup,
				});
				break;
			case 4: {
				const standupProjectKey = cycleValue(
					this.projectChoices,
					this.settings.standupProjectKey,
					direction,
				);
				const { standupProjectKey: _currentProject, ...settings } =
					this.settings;
				this.commit(
					standupProjectKey ? { ...settings, standupProjectKey } : settings,
				);
				break;
			}
			case 5:
				this.commit({
					...this.settings,
					taskLimit: cycleValue(
						TASK_LIMITS,
						this.settings.taskLimit,
						direction,
					),
				});
				break;
			case 6:
				this.commit({
					...this.settings,
					refreshSeconds: cycleValue(
						REFRESH_INTERVALS,
						this.settings.refreshSeconds,
						direction,
					),
				});
				break;
			case 7:
				this.commit({ ...this.settings, debug: !this.settings.debug });
				break;
			case 8:
				this.callbacks.onRefresh();
				break;
			case 9:
				this.callbacks.onDone();
				break;
			default:
				break;
		}
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.callbacks.onDone();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.callbacks.onChange();
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(ROW_COUNT - 1, this.selectedIndex + 1);
			this.callbacks.onChange();
			return;
		}
		if (matchesKey(data, Key.left)) {
			this.adjust(-1);
			return;
		}
		if (matchesKey(data, Key.right) || matchesKey(data, Key.enter)) {
			this.adjust(1);
		}
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

	private toggleLabel(enabled: boolean, label: string): string {
		return `${enabled ? "[on] " : "[off]"} ${label}`;
	}

	render(width: number): string[] {
		const resolvedWidth = Math.max(20, width);
		const refresh =
			this.settings.refreshSeconds === 0
				? "Manual"
				: `${this.settings.refreshSeconds} seconds`;
		const rows = [
			this.toggleLabel(this.settings.visible, "Panel visible"),
			this.toggleLabel(this.settings.showRun, "Run status"),
			this.toggleLabel(this.settings.showTasks, "Assigned tasks"),
			this.toggleLabel(this.settings.showStandup, "Standup status"),
			`      Standup Project  ${this.settings.standupProjectKey ?? "Not selected"}`,
			`      Task rows        ${this.settings.taskLimit}`,
			`      Refresh          ${refresh}`,
			this.toggleLabel(this.settings.debug, "Debug details"),
			"      Refresh now",
			"      Done",
		];
		const lines = [
			this.theme.fg(
				"borderMuted",
				`╭${"─".repeat(Math.max(0, resolvedWidth - 2))}╮`,
			),
			this.framedLine(
				` ${this.theme.fg("accent", this.theme.bold("TAKO BRIDGE PANEL"))}`,
				resolvedWidth,
			),
			this.theme.fg(
				"borderMuted",
				`├${"─".repeat(Math.max(0, resolvedWidth - 2))}┤`,
			),
		];
		for (const [index, row] of rows.entries()) {
			const content = ` ${index === this.selectedIndex ? "›" : " "} ${row}`;
			lines.push(
				this.framedLine(
					index === this.selectedIndex
						? this.theme.bg("selectedBg", this.theme.fg("text", content))
						: this.theme.fg("muted", content),
					resolvedWidth,
				),
			);
		}
		lines.push(
			this.framedLine(
				` ${this.theme.fg("dim", "↑↓ navigate · Enter toggle/change · ←→ adjust · Esc done")}`,
				resolvedWidth,
			),
			this.theme.fg(
				"borderMuted",
				`╰${"─".repeat(Math.max(0, resolvedWidth - 2))}╯`,
			),
		);
		return lines;
	}

	invalidate(): void {}
}
