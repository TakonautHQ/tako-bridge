import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

import type { PanelSettings } from "../src/config.js";
import { PanelSettingsView } from "../src/panel-settings";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const settings: PanelSettings = {
	visible: true,
	showRun: true,
	showTasks: true,
	showStandup: true,
	debug: false,
	taskLimit: 3,
	refreshSeconds: 30,
	standupProjectKey: "PAY",
};

describe("PanelSettingsView", () => {
	it("toggles settings in place without closing the settings view", () => {
		const changed = vi.fn();
		const done = vi.fn();
		const view = new PanelSettingsView(settings, ["PAY", "WEB"], theme, {
			onSettingsChange: changed,
			onRefresh: vi.fn(),
			onDone: done,
			onChange: vi.fn(),
		});

		expect(view.render(72).join("\n")).toContain("[on]  Panel visible");
		view.handleInput("\r");

		expect(changed).toHaveBeenCalledWith(
			expect.objectContaining({ visible: false }),
		);
		expect(done).not.toHaveBeenCalled();
		expect(view.render(72).join("\n")).toContain("[off] Panel visible");
	});

	it("cycles task rows and refresh interval without nested menus", () => {
		const changed = vi.fn();
		const view = new PanelSettingsView(settings, ["PAY", "WEB"], theme, {
			onSettingsChange: changed,
			onRefresh: vi.fn(),
			onDone: vi.fn(),
			onChange: vi.fn(),
		});

		for (let index = 0; index < 5; index += 1) view.handleInput("\u001b[B");
		view.handleInput("\u001b[C");
		expect(changed).toHaveBeenLastCalledWith(
			expect.objectContaining({ taskLimit: 5 }),
		);

		view.handleInput("\u001b[B");
		view.handleInput("\u001b[C");
		expect(changed).toHaveBeenLastCalledWith(
			expect.objectContaining({ refreshSeconds: 60 }),
		);
		expect(
			view.render(48).every((line: string) => visibleWidth(line) <= 48),
		).toBe(true);
	});
});
