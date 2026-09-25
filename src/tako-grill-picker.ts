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

export interface GrillPickerItem {
	value: string;
	label: string;
	description?: string;
}

export interface GrillPickerPage {
	items: GrillPickerItem[];
	truncated: boolean;
}

interface GrillPickerOptions {
	title: string;
	initial: GrillPickerPage;
	search: (query: string, signal: AbortSignal) => Promise<GrillPickerPage>;
	onSelect: (value: string) => void;
	onCancel: () => void;
	onChange: () => void;
}

/** Only display text from server discovery is sanitized; IDs never come from labels. */
export function safeGrillLabel(text: string): string {
	return text.replace(
		/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
		" ",
	);
}

export class GrillSearchPicker implements Component, Focusable {
	private readonly input = new Input();
	private page: GrillPickerPage;
	private selected = 0;
	private loading = false;
	private error = false;
	private generation = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private request: AbortController | undefined;
	private closed = false;
	private _focused = false;

	constructor(
		private readonly theme: Theme,
		private readonly options: GrillPickerOptions,
	) {
		this.page = options.initial;
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	dispose(): void {
		this.closed = true;
		this.generation++;
		if (this.timer) clearTimeout(this.timer);
		this.request?.abort();
	}

	private search(query: string): void {
		this.generation++;
		const generation = this.generation;
		if (this.timer) clearTimeout(this.timer);
		this.request?.abort();
		this.page = { items: [], truncated: false };
		this.selected = 0;
		this.error = false;
		this.loading = true;
		this.options.onChange();
		if (query.length > 200) {
			this.loading = false;
			this.error = true;
			this.options.onChange();
			return;
		}
		this.timer = setTimeout(() => {
			const request = new AbortController();
			this.request = request;
			void this.options.search(query, request.signal).then(
				(page) => {
					if (this.closed || generation !== this.generation) return;
					this.page = page;
					this.loading = false;
					this.options.onChange();
				},
				() => {
					if (this.closed || generation !== this.generation) return;
					this.error = true;
					this.loading = false;
					this.options.onChange();
				},
			);
		}, 180);
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.dispose();
			this.options.onCancel();
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.selected = Math.max(0, this.selected - 1);
		} else if (matchesKey(data, Key.down)) {
			this.selected = Math.max(
				0,
				Math.min(this.page.items.length - 1, this.selected + 1),
			);
		} else if (matchesKey(data, Key.enter)) {
			const selected =
				!this.loading && !this.error
					? this.page.items[this.selected]
					: undefined;
			if (selected) {
				this.dispose();
				this.options.onSelect(selected.value);
			}
			return;
		} else {
			const before = this.input.getValue();
			this.input.handleInput(data);
			if (before !== this.input.getValue())
				this.search(this.input.getValue().trim());
		}
		this.options.onChange();
	}

	private line(content: string, width: number): string {
		const clipped = truncateToWidth(content, Math.max(1, width - 2));
		const spaces = " ".repeat(Math.max(0, width - 2 - visibleWidth(clipped)));
		return (
			this.theme.fg("borderMuted", "│") +
			clipped +
			spaces +
			this.theme.fg("borderMuted", "│")
		);
	}

	render(width: number): string[] {
		const w = Math.max(2, width);
		const border = (left: string, right: string) =>
			this.theme.fg("borderMuted", left + "─".repeat(w - 2) + right);
		const lines = [
			border("╭", "╮"),
			this.line(
				` ${this.theme.fg("accent", this.theme.bold(this.options.title))}`,
				w,
			),
			this.line(
				` ${this.theme.fg("dim", "Search:")} ${this.input.render(Math.max(1, w - 12))[0] ?? ""}`,
				w,
			),
			border("├", "┤"),
		];
		if (this.loading || this.error || !this.page.items.length) {
			lines.push(
				this.line(
					` ${this.theme.fg(this.error ? "warning" : "muted", this.error ? "Search unavailable or too long" : this.loading ? "Searching…" : "No matching options")}`,
					w,
				),
			);
		} else {
			const start = Math.max(
				0,
				Math.min(this.selected - 4, this.page.items.length - 10),
			);
			this.page.items.slice(start, start + 10).forEach((item, offset) => {
				const index = start + offset;
				const text = ` ${index === this.selected ? "›" : " "} ${safeGrillLabel(item.label)}${item.description ? ` · ${safeGrillLabel(item.description)}` : ""}`;
				lines.push(
					this.line(
						index === this.selected
							? this.theme.bg("selectedBg", this.theme.fg("text", text))
							: this.theme.fg("muted", text),
						w,
					),
				);
			});
		}
		if (this.page.truncated)
			lines.push(
				this.line(
					` ${this.theme.fg("dim", "Showing first 50 — type to narrow results")}`,
					w,
				),
			);
		lines.push(
			this.line(
				` ${this.theme.fg("dim", "↑↓ navigate · Enter select · Esc cancel")}`,
				w,
			),
			border("╰", "╯"),
		);
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}
}
