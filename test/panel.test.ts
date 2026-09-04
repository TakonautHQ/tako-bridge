import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	createBridgePanelErrorWidget,
	createBridgePanelWidget,
	type BridgePanelData,
} from "../src/panel.js";

const theme = {
	fg: (tone: string, text: string) =>
		`\u001b[3${tone.length % 8}m${text}\u001b[0m`,
	bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
};

const panelData: BridgePanelData = {
	run: { taskKey: "PAY-142", executorPhase: "executing" },
	showRun: true,
	showStandup: true,
	showTasks: true,
	standupProjectKey: "PAY",
	standupStatus: "pending",
	taskLimit: 3,
	tasks: [
		{
			task_key: "PAY-155",
			task_title: "Audit token expiry",
			project_key: "PAY",
			startability: { startable: true, reasons: [] },
		},
		{
			task_key: "PAY-162",
			task_title: "Retry failed events",
			project_key: "PAY",
			startability: { startable: true, reasons: [] },
		},
		{
			task_key: "PAY-143",
			task_title: "Rotate credentials",
			project_key: "PAY",
			startability: {
				startable: false,
				reasons: ["project_agent_playbook_required"],
			},
		},
	],
};

function render(width: number, data: BridgePanelData = panelData) {
	return createBridgePanelWidget(data, theme).render(width);
}

function plain(lines: string[]) {
	return lines.map(stripTerminalSequences);
}

function expectFullWidth(lines: string[], width: number) {
	expect(lines.length).toBeGreaterThan(0);
	for (const line of lines) expect(visibleWidth(line)).toBe(width);
}

describe("Tako Bridge responsive panel", () => {
	it("uses a full-width three-column pulse layout on wide terminals", () => {
		const width = 120;
		const lines = render(width);
		const text = plain(lines);

		expectFullWidth(lines, width);
		expect(text[0]).toMatch(/^╭─ TAKO BRIDGE .*● LIVE ─╮$/);
		expect(text[1]).toMatch(/│ RUN\s+│ WORK\s+│ STANDUP\s+│/);
		expect(
			text.some(
				(line) => line.includes("NEXT") && line.includes("/tako-status"),
			),
		).toBe(true);
		expect(text).toEqual(
			expect.arrayContaining([
				expect.stringContaining("◆ PAY-155  Audit token expiry"),
				expect.stringContaining("◇ PAY-143  Rotate credentials"),
			]),
		);
		expect(text.at(-1)).toMatch(/^╰─ .*\/tako-panel.*─╯$/);
	});

	it("moves Standup below the Run and Work columns at medium widths", () => {
		const width = 84;
		const lines = render(width);
		const text = plain(lines);

		expectFullWidth(lines, width);
		const headings = text.find(
			(line) => line.includes("RUN") && line.includes("WORK"),
		);
		expect(headings).toBeDefined();
		expect(headings).not.toContain("STANDUP");
		expect(
			text.some((line) => line.startsWith("│ STANDUP") && line.endsWith("│")),
		).toBe(true);
	});

	it("stacks every section while retaining the full-width frame on narrow terminals", () => {
		const width = 52;
		const lines = render(width);
		const text = plain(lines);

		expectFullWidth(lines, width);
		for (const label of ["RUN", "WORK", "STANDUP"]) {
			expect(text.some((line) => line.startsWith(`│ ${label}`))).toBe(true);
		}
		expect(
			text.some(
				(line) =>
					["RUN", "WORK", "STANDUP"].filter((label) => line.includes(label))
						.length > 1,
			),
		).toBe(false);
	});

	it("measures ANSI styling and wide characters by terminal columns", () => {
		const width = 58;
		const lines = render(width, {
			...panelData,
			tasks: [
				{
					task_key: "PAY-200",
					task_title: "修复 credential rotation 🔐",
					project_key: "PAY",
					startability: { startable: true, reasons: [] },
				},
			],
		});

		expectFullWidth(lines, width);
		expect(plain(lines).join("\n")).toContain("PAY-200");
	});

	it("renders delayed state as a complete full-width frame", () => {
		const width = 72;
		const lines = createBridgePanelErrorWidget(
			"Connection timed out",
			theme,
		).render(width);
		const text = plain(lines);

		expectFullWidth(lines, width);
		expect(text[0]).toMatch(/^╭─ TAKO BRIDGE .*◇ DELAYED ─╮$/);
		expect(text[1]).toContain("Connection timed out");
		expect(text.at(-1)).toMatch(/^╰─ .*\/tako-status.*─╯$/);
	});
});
