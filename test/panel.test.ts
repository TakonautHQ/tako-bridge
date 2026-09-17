import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	createBridgePanelErrorWidget,
	createBridgePanelLoginWidget,
	createBridgePanelWidget,
	type BridgePanelData,
} from "../src/panel.js";
import { BRIDGE_VERSION } from "../src/version.js";

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
			stage_name: "Development",
			startability: { startable: true, reasons: [] },
		},
		{
			task_key: "PAY-162",
			task_title: "Retry failed events",
			project_key: "PAY",
			stage_name: "Development",
			startability: { startable: true, reasons: [] },
		},
		{
			task_key: "PAY-143",
			task_title: "Rotate credentials",
			project_key: "PAY",
			stage_name: "Review",
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
	it("shows the package version after the title in every panel state", () => {
		const width = 72;
		const headers = [
			createBridgePanelWidget(panelData, theme).render(width)[0],
			createBridgePanelLoginWidget(theme).render(width)[0],
			createBridgePanelErrorWidget("Connection timed out", theme).render(
				width,
			)[0],
		];

		for (const header of headers) {
			expect(stripTerminalSequences(header)).toContain(
				`TAKO BRIDGE v${BRIDGE_VERSION}`,
			);
			expect(visibleWidth(header)).toBe(width);
		}
	});

	it("uses a full-width three-column pulse layout on wide terminals", () => {
		const width = 120;
		const lines = render(width);
		const text = plain(lines);

		expectFullWidth(lines, width);
		expect(text[0]).toMatch(/^╭─ TAKO BRIDGE .*● LIVE ─╮$/);
		expect(text[1]).toMatch(/│ RUN\s+│ WORK\s+│ STANDUP\s+│/);
		expect(text.some((line) => line.includes("Development 2 · Review 1"))).toBe(
			true,
		);
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

	it("shows detailed safe synchronization diagnostics when Debug mode is enabled", () => {
		const width = 120;
		const lines = render(width, {
			...panelData,
			debug: {
				panel: {
					state: "running",
					attempt: 3,
					startedAt: "2026-09-04T18:50:00.000Z",
					durationMs: null,
					skipped: 1,
					errorCode: null,
				},
				telemetry: {
					state: "timeout",
					attempt: 8,
					startedAt: "2026-09-04T18:49:45.000Z",
					durationMs: 10_000,
					skipped: 0,
					errorCode: "telemetry_timeout",
					sequence: 7,
				},
				reconcile: {
					state: "ok",
					attempt: 2,
					startedAt: "2026-09-04T18:48:00.000Z",
					durationMs: 84,
					skipped: 0,
					errorCode: null,
				},
				nextRefreshSeconds: 12,
			},
		} as BridgePanelData);
		const text = plain(lines);

		expectFullWidth(lines, width);
		expect(text.some((line) => line.includes("DEBUG SYNC"))).toBe(true);
		expect(
			text.some(
				(line) =>
					line.includes("PANEL") &&
					line.includes("running") &&
					line.includes("attempt 3") &&
					line.includes("skipped 1"),
			),
		).toBe(true);
		expect(
			text.some(
				(line) =>
					line.includes("TELEMETRY") &&
					line.includes("timeout") &&
					line.includes("seq 7"),
			),
		).toBe(true);
		expect(
			text.some(
				(line) =>
					line.includes("RECONCILE") &&
					line.includes("ok") &&
					line.includes("84ms"),
			),
		).toBe(true);
		expect(text.some((line) => line.includes("NEXT REFRESH  12s"))).toBe(true);
		expect(
			text.some((line) => line.includes("LAST ERROR  telemetry_timeout")),
		).toBe(true);
	});

	it("puts completed tasks last and does not count them as blocked", () => {
		const done = {
			...panelData.tasks[0],
			task_key: "PAY-999",
			stage_name: "Shipped",
			stage_group: "done",
			startability: { startable: false, reasons: ["terminal_stage"] },
		};
		const data = {
			...panelData,
			showRun: false,
			showStandup: false,
			tasks: [done, ...panelData.tasks],
			taskLimit: 10,
		};
		const lines = render(120, data);
		const rows = plain(lines).filter((line) => /[◆◇✓] PAY-/.test(line));
		expect(rows.at(-1)).toContain("✓ PAY-999");
		expect(plain(lines).join("\n")).toContain("2 ready · 1 blocked · 1 done");
		expectFullWidth(lines, 120);
	});

	it("applies the filter and ordering before the row limit and NEXT recommendation", () => {
		const active = { ...panelData.tasks[1], stage_group: "in_progress" };
		const data: BridgePanelData = {
			...panelData,
			run: null,
			showRun: false,
			showStandup: false,
			taskFilter: "ready",
			taskLimit: 1,
			tasks: [panelData.tasks[2], panelData.tasks[0], active],
		};
		const text = plain(render(120, data)).join("\n");
		expect(text).toContain("WORK · Ready");
		expect(text).toContain("2 ready · 0 blocked");
		expect(text).toContain("◆ PAY-162");
		expect(text).toContain("/tako-start PAY-162");
		expect(text).not.toContain("PAY-155");
		expect(text).not.toContain("PAY-143");
		expect(text).toContain("+1 more · 1 filtered");
	});

	it("does not recommend a filtered-out ready task", () => {
		const text = plain(
			render(120, {
				...panelData,
				run: null,
				showStandup: false,
				taskFilter: "blocked",
			}),
		).join("\n");
		expect(text).toContain("◇ PAY-143");
		expect(text).not.toContain("/tako-start");
		expect(text).not.toContain("PAY-155");
	});

	it.each([24, 52, 84, 120])(
		"shows an empty filtered state at width %s",
		(width) => {
			const lines = render(width, {
				...panelData,
				run: null,
				showRun: false,
				showStandup: false,
				taskFilter: "done",
			});
			expectFullWidth(lines, width);
			const text = plain(lines).join("\n");
			expect(text).toContain("WORK · Done");
			expect(text).not.toContain("PAY-");
			if (width >= 84) expect(text).toContain("No matching tasks");
		},
	);

	it("does not advertise hidden task rows when tasks are switched off", () => {
		const text = plain(
			render(120, {
				...panelData,
				showTasks: false,
				taskLimit: 1,
				taskFilter: "ready",
			}),
		).join("\n");
		expect(text).not.toContain("more");
		expect(text).not.toContain("filtered");
		expect(text).not.toContain("WORK");
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
