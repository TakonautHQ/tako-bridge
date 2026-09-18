import type { CommandRunner } from "./git.js";
import {
	formatReportDiagnostics,
	ReportDiagnostics,
	ReportInputError,
	sanitizeReportText,
} from "./report-diagnostics.js";
import {
	canSubmitReport,
	openReportUrl,
	REPORT_ISSUES_URL,
	REPORT_REPOSITORY,
	reportFormUrl,
	saveReportDraft,
	submitReport,
	type ReportDraft,
} from "./report-transport.js";

export interface ReportUI {
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor(title: string, value: string): Promise<string | undefined>;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}
interface ReportContext {
	hasUI: boolean;
	ui: ReportUI;
}
interface ReportDependencies {
	run: CommandRunner;
	open?: (url: string) => Promise<boolean>;
	save?: (draft: ReportDraft) => string;
}

const BUG_TEMPLATE =
	"## What were you trying to do?\n\n\n## What happened?\n\n\n## What did you expect?\n\n\n## Steps to reproduce (or say unknown)\n\n";
const FEATURE_TEMPLATE =
	"## What problem would this solve?\n\n\n## What would you like Bridge to do?\n\n";
const SAVE = "Save locally";
const BROWSER = "Open GitHub form";
const SUBMIT = "Submit with GitHub CLI";
const EDIT = "Edit report";
const CANCEL = "Cancel";

function serializeDraft(draft: ReportDraft): string {
	return `# ${draft.title}\n\n${draft.body}`;
}

export function parseReportDraft(text: string): ReportDraft {
	const clean = sanitizeReportText(text).trim();
	const newline = clean.indexOf("\n");
	const title = clean
		.slice(0, newline < 0 ? clean.length : newline)
		.replace(/^#\s+/, "")
		.trim();
	const body = newline < 0 ? "" : clean.slice(newline + 1).trim();
	if (!title || title.length > 200 || !body) {
		throw new ReportInputError(
			"Reports need a title of 1–200 characters and a non-empty description. Run /tako-report again.",
		);
	}
	return { title, body };
}

/** User-only flow: no model calls, session transcript reads, or automatic publication. */
export class BridgeReporter {
	readonly diagnostics = new ReportDiagnostics();
	private busy = false;
	private generation = 0;
	constructor(private readonly deps: ReportDependencies) {}

	reset(): void {
		this.generation += 1;
		this.diagnostics.clear();
	}

	async run(ctx: ReportContext, args = ""): Promise<void> {
		const ui = ctx.ui;
		if (!ctx.hasUI) {
			ui.notify?.(
				"/tako-report requires interactive preview and confirmation. No report was submitted.",
				"warning",
			);
			return;
		}
		if (this.busy) {
			ui.notify?.(
				"A report is already being reviewed. Finish or cancel it first.",
				"warning",
			);
			return;
		}
		this.busy = true;
		const generation = this.generation;
		const current = () => generation === this.generation;
		try {
			await this.collectAndReview(ui, args, current);
		} catch (error) {
			if (current())
				ui.notify?.(
					error instanceof ReportInputError
						? error.message
						: "Reporting could not finish. No raw error was exposed. If submission had started, check the GitHub issues list before retrying.",
					"error",
				);
		} finally {
			this.busy = false;
		}
	}

	private async collectAndReview(
		ui: ReportUI,
		args: string,
		current: () => boolean,
	): Promise<void> {
		const kind = await ui.select(
			"Report a Bridge issue — public GitHub, not private customer support",
			[
				"Bug report",
				"Feature request",
				"Security vulnerability (private)",
				CANCEL,
			],
		);
		if (!current() || !kind || kind === CANCEL) return;
		if (kind === "Security vulnerability (private)") {
			ui.notify?.(
				"Do not open a public issue. Email security@takonaut.com with a minimal reproduction; omit credentials, customer source code, and raw transcripts.",
				"warning",
			);
			return;
		}
		if (kind !== "Bug report" && kind !== "Feature request") return;
		const title =
			args.trim() ||
			(await ui.input(
				"Short issue title (no credentials or customer details)",
			));
		if (!current() || !title?.trim()) return;
		const template = kind === "Bug report" ? BUG_TEMPLATE : FEATURE_TEMPLATE;
		const description = await ui.editor(
			"What happened? Fill in the report; omit private data. Escape cancels.",
			template,
		);
		if (!current() || description === undefined) return;
		if (!description.trim() || description.trim() === template.trim()) {
			ui.notify?.(
				"Add a description before reporting. No report was submitted.",
				"warning",
			);
			return;
		}
		const diagnostics = await ui.select(
			"Include optional minimal diagnostics? Versions, OS/architecture, and recent error categories only.",
			["No diagnostics", "Include minimal diagnostics", CANCEL],
		);
		if (!current() || !diagnostics || diagnostics === CANCEL) return;
		if (
			diagnostics !== "No diagnostics" &&
			diagnostics !== "Include minimal diagnostics"
		)
			return;
		const initial = parseReportDraft(
			serializeDraft({
				title,
				body: `${description.trim()}${diagnostics === "Include minimal diagnostics" ? `\n\n${formatReportDiagnostics(this.diagnostics)}` : ""}`,
			}),
		);
		let draft = initial;
		while (current()) {
			const reviewed = await ui.editor(
				`Review/edit exact report for ${REPORT_REPOSITORY} (PUBLIC). Redaction is best-effort; remove all private data.`,
				serializeDraft(draft),
			);
			if (!current() || reviewed === undefined) return;
			draft = parseReportDraft(reviewed);
			if (serializeDraft(draft) !== reviewed.trim()) {
				ui.notify?.(
					"The report was sanitised or normalised. Review the changed text again before continuing.",
					"warning",
				);
				continue;
			}
			const ghReady = await canSubmitReport(this.deps.run);
			if (!current()) return;
			const action = await ui.select(
				ghReady
					? "Report reviewed — choose delivery"
					: "GitHub CLI unavailable or not authenticated on github.com — use browser or save locally",
				[...(ghReady ? [SUBMIT] : []), BROWSER, SAVE, EDIT, CANCEL],
			);
			if (!current() || !action || action === CANCEL) return;
			if (action === EDIT) continue;
			if (action === SUBMIT && ghReady) {
				if (
					!(await ui.confirm(
						"Publish this issue publicly?",
						`Create the exact reviewed report in ${REPORT_REPOSITORY} using your authenticated GitHub CLI account?\nTitle: ${draft.title}\nThis publishes immediately. Takonaut login is separate from GitHub login.`,
					)) ||
					!current()
				)
					return;
				await this.publish(ui, draft, current);
				return;
			}
			if (action === BROWSER) {
				if (
					!(await ui.confirm(
						"Open the reviewed report on GitHub?",
						`Destination: ${REPORT_REPOSITORY} (PUBLIC)\nTitle: ${draft.title}\nThe reviewed text will be put in the browser URL and may remain in browser history. Long reports or browser failures get an owner-only local copy instead. You must sign in and click Submit new issue yourself.`,
					)) ||
					!current()
				)
					return;
				await this.browser(ui, draft, current);
				return;
			}
			if (action === SAVE) {
				if (
					(await ui.confirm(
						"Save report locally?",
						"Save the exact reviewed report to an owner-only temporary Markdown file outside your repository? Nothing will be published.",
					)) &&
					current()
				) {
					ui.notify?.(
						`Report saved locally: ${this.save(draft)}\nNo issue was created. Temporary files may be removed by your OS.`,
						"info",
					);
				}
				return;
			}
			return;
		}
	}

	private save(draft: ReportDraft): string {
		return (this.deps.save ?? saveReportDraft)(draft);
	}
	private open(url: string): Promise<boolean> {
		return (
			this.deps.open ?? ((target) => openReportUrl(this.deps.run, target))
		)(url);
	}

	private async publish(
		ui: ReportUI,
		draft: ReportDraft,
		current: () => boolean,
	): Promise<void> {
		let url: string | null = null;
		try {
			url = await submitReport(this.deps.run, draft);
		} catch {
			/* Outcome may be unknown; never retry automatically. */
		}
		if (!current()) return;
		if (url) {
			ui.notify?.(`Issue created: ${url}`, "info");
			return;
		}
		ui.notify?.(
			`GitHub submission could not be confirmed. The issue MAY already exist. Check ${REPORT_ISSUES_URL} before retrying; no automatic retry or new-issue browser fallback was attempted.`,
			"warning",
		);
		const action = await ui.select(
			"Keep the reviewed draft or check existing issues?",
			[SAVE, "Open existing issues", CANCEL],
		);
		if (!current()) return;
		if (
			action === SAVE &&
			(await ui.confirm(
				"Save reviewed draft?",
				"Keep an owner-only local copy? Check GitHub before resubmitting.",
			)) &&
			current()
		) {
			ui.notify?.(`Draft saved: ${this.save(draft)}`, "info");
		} else if (
			action === "Open existing issues" &&
			(await ui.confirm("Open existing issues?", REPORT_ISSUES_URL)) &&
			current()
		) {
			const opened = await this.open(REPORT_ISSUES_URL);
			if (current())
				ui.notify?.(
					`${opened ? "Issues page opened" : "Open manually"}: ${REPORT_ISSUES_URL}`,
					"info",
				);
		}
	}

	private async browser(
		ui: ReportUI,
		draft: ReportDraft,
		current: () => boolean,
	): Promise<void> {
		const form = reportFormUrl(draft);
		let path = form.bodyIncluded ? undefined : this.save(draft);
		let opened = false;
		try {
			opened = await this.open(form.url);
		} catch {
			/* Remote/headless users can use the manual link. */
		}
		if (!current()) return;
		if (!opened && !path) path = this.save(draft);
		ui.notify?.(
			[
				opened
					? "GitHub issue form opened; no issue has been created by Bridge."
					: "Could not open a local browser. Open this form manually; no issue has been created by Bridge.",
				form.url,
				...(path
					? [
							`Reviewed report: ${path}`,
							"Copy the description from this Markdown file if the form is not prefilled. The file is temporary; retain it if needed.",
						]
					: []),
				"Sign into GitHub and click Submit new issue to publish. Without a GitHub account, keep the local draft instead.",
			].join("\n"),
			"info",
		);
	}
}
