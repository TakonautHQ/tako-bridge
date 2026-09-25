import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrillSearchPicker, safeGrillLabel } from "../src/tako-grill-picker.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

afterEach(() => vi.useRealTimers());

describe("GrillSearchPicker", () => {
	it("lists authorized items and searches the server before selection", async () => {
		vi.useFakeTimers();
		const onSelect = vi.fn();
		const search = vi.fn(async (query: string) => ({
			items: [{ value: "id-2", label: `PRD ${query}` }],
			truncated: false,
		}));
		const picker = new GrillSearchPicker(theme, {
			title: "Work hierarchy",
			initial: {
				items: [{ value: "id-1", label: "Older work" }],
				truncated: true,
			},
			search,
			onSelect,
			onCancel: vi.fn(),
			onChange: vi.fn(),
		});
		expect(picker.render(42).join("\n")).toContain("Older work");
		picker.handleInput("3");
		picker.handleInput("9");
		picker.handleInput("\r"); // Stale initial results cannot be selected during a search.
		expect(onSelect).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(180);
		expect(search).toHaveBeenCalledOnce();
		expect(search.mock.calls[0]?.[0]).toBe("39");
		expect(picker.render(42).join("\n")).toContain("PRD 39");
		picker.handleInput("\r");
		expect(onSelect).toHaveBeenCalledWith("id-2");
		expect(picker.render(42).every((line) => visibleWidth(line) <= 42)).toBe(
			true,
		);
	});

	it("ignores late responses after cancellation and sanitizes untrusted labels", async () => {
		vi.useFakeTimers();
		let finish!: (value: {
			items: Array<{ value: string; label: string }>;
			truncated: boolean;
		}) => void;
		const search = vi.fn(
			() =>
				new Promise<{
					items: Array<{ value: string; label: string }>;
					truncated: boolean;
				}>((resolve) => {
					finish = resolve;
				}),
		);
		const onCancel = vi.fn();
		const picker = new GrillSearchPicker(theme, {
			title: "Projects",
			initial: { items: [], truncated: false },
			search,
			onSelect: vi.fn(),
			onCancel,
			onChange: vi.fn(),
		});
		picker.handleInput("x");
		await vi.advanceTimersByTimeAsync(180);
		picker.handleInput("\u001b");
		finish({ items: [{ value: "invalid", label: "late" }], truncated: false });
		await Promise.resolve();
		expect(onCancel).toHaveBeenCalledOnce();
		expect(picker.render(30).join("\n")).not.toContain("late");
		expect(safeGrillLabel("PRD\u001b[31m 39\nTitle")).not.toContain("\u001b");
	});
});
