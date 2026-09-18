import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	BridgeReporter,
	parseReportDraft,
	type ReportUI,
} from "../src/report.js";
import {
	formatReportDiagnostics,
	ReportDiagnostics,
	sanitizeReportText,
} from "../src/report-diagnostics.js";
import {
	canSubmitReport,
	MAX_REPORT_URL_LENGTH,
	openReportUrl,
	REPORT_ISSUES_URL,
	REPORT_REPOSITORY_URL,
	reportFormUrl,
	saveReportDraft,
	submitReport,
	type ReportDraft,
} from "../src/report-transport.js";
import type { CommandResult, CommandRunner } from "../src/git.js";

const ISSUE_URL = `${REPORT_ISSUES_URL}/42`;
const ok = (stdout = ""): CommandResult => ({
	exitCode: 0,
	stdout,
	stderr: "",
});
const fail = (): CommandResult => ({
	exitCode: 1,
	stdout: "",
	stderr: "secret raw diagnostic",
});

function parseUrl(value: string): URL {
	try {
		return new URL(value);
	} catch {
		throw new Error("Report generated an invalid URL");
	}
}

function setup(
	options: { action?: string; diagnostics?: boolean; run?: CommandRunner } = {},
) {
	const run = vi.fn<CommandRunner>(
		options.run ??
			(async (_command, args) => ok(args[0] === "issue" ? ISSUE_URL : "")),
	);
	const open = vi.fn(async (_url: string) => true);
	const save = vi.fn((_draft: ReportDraft) => "/private/report.md");
	const reporter = new BridgeReporter({ run, open, save });
	const ui = {
		input: vi.fn(async () => "Task panel stops refreshing"),
		editor: vi
			.fn(
				async (_title: string, text: string): Promise<string | undefined> =>
					text,
			)
			.mockResolvedValueOnce(
				"## What happened\nThe panel stopped.\n\n## Expected\nIt should refresh.",
			),
		select: vi
			.fn<ReportUI["select"]>()
			.mockResolvedValueOnce("Bug report")
			.mockResolvedValueOnce(
				options.diagnostics ? "Include minimal diagnostics" : "No diagnostics",
			)
			.mockResolvedValueOnce(options.action ?? "Submit with GitHub CLI"),
		confirm: vi.fn(async () => true),
		notify: vi.fn(),
	};
	return { reporter, run, open, save, ui, ctx: { hasUI: true, ui } };
}

function creates(run: ReturnType<typeof setup>["run"]) {
	return run.mock.calls.filter(
		([command, args]) =>
			command === "gh" && args[0] === "issue" && args[1] === "create",
	);
}

describe("minimal report diagnostics", () => {
	it("retains allowlisted categories, not raw failures or identities", () => {
		const history = new ReportDiagnostics(() => 1000);
		history.record(
			"command",
			new Error("401: token=private user@example.com /home/me/repo"),
		);
		history.record("command", "401 again");
		expect(history.snapshot()).toEqual([
			{
				source: "command",
				category: "authentication",
				observedAt: new Date(1000).toISOString(),
				count: 2,
			},
		]);
		expect(JSON.stringify(history.snapshot())).not.toMatch(
			/private|example|home/,
		);
		expect(formatReportDiagnostics(history)).toContain("Bridge:");
		expect(formatReportDiagnostics(history)).not.toContain("user@example.com");
	});

	it("bounds, expires, clones and clears history", () => {
		let now = 1000;
		const history = new ReportDiagnostics(() => now);
		for (let i = 0; i < 30; i++)
			history.record(i % 2 ? "panel" : "tool", "network");
		expect(history.snapshot()).toHaveLength(10);
		history.snapshot()[0].count = 900;
		expect(history.snapshot()[0].count).toBe(1);
		now += 60 * 60 * 1000;
		expect(history.snapshot()).toEqual([]);
		history.record("telemetry", "timeout");
		expect(history.snapshot()[0].category).toBe("timeout");
		history.clear();
		expect(history.snapshot()).toEqual([]);
	});

	it("caps repeated occurrences and expires each one on a rolling-hour boundary", () => {
		let now = 0;
		const history = new ReportDiagnostics(() => now);
		for (let i = 0; i < 20; i++) history.record("panel", "network");
		expect(history.snapshot()).toHaveLength(1);
		expect(history.snapshot()[0].count).toBe(10);
		now = 30 * 60 * 1000;
		history.record("panel", "network");
		expect(history.snapshot()[0].count).toBe(10);
		now = 60 * 60 * 1000;
		expect(history.snapshot()[0].count).toBe(1);
		now = 90 * 60 * 1000;
		expect(history.snapshot()).toEqual([]);
	});

	it("preserves ordinary discussion of password/token bugs", () => {
		const prose =
			"Password reset fails. Token validation failed. Please fix login.";
		expect(sanitizeReportText(prose)).toBe(prose);
	});

	it.each([
		["Authorization: Basic c2VjcmV0\nnext", "c2VjcmV0"],
		["Cookie: session=private; other=secret", "private"],
		['{"api_key":"very-private"}', "very-private"],
		["TAKONAUT_API_KEY=private-token", "private-token"],
		['refresh_token: "secret with spaces"', "secret with spaces"],
		['client_secret: "first line\nsecond line"', "second line"],
		['--password "secret with spaces"', "secret with spaces"],
		["ghp_1234567890abcdefghijklmnop", "ghp_"],
		["github_pat_1234567890abcdefghijklmnop", "github_pat_"],
		["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl", "eyJ"],
		["https://user:pass@internal.local/a?code=secret", "internal.local"],
		["postgresql://user:pass@internal.local/db", "pass"],
		["Person user@example.com", "user@example.com"],
		["at /Volumes/External/Users/username/repo/foo.ts:5", "username"],
		["at C:\\Users\\username\\repo\\foo.ts:5", "username"],
		["at /home/username/repo/foo.ts:5", "username"],
		["Bearer \x1b[31msecret\x1b[0m", "secret"],
	])("redacts sensitive user text: %s", (input, sensitive) => {
		const clean = sanitizeReportText(input);
		expect(clean).not.toContain(sensitive);
		expect(sanitizeReportText(clean)).toBe(clean);
	});

	it("rejects high-risk material and oversized reports without quoting them", () => {
		expect(() =>
			sanitizeReportText("-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-value"),
		).toThrow(/Remove private keys/);
		expect(() => sanitizeReportText("a".repeat(33 * 1024))).toThrow(/32 KiB/);
		expect(sanitizeReportText("Panel timed out\nExpected a refresh")).toBe(
			"Panel timed out\nExpected a refresh",
		);
		expect(() => parseReportDraft("# Missing body")).toThrow(/non-empty/);
		expect(() => parseReportDraft(`# ${"a ".repeat(101)}\n\nBody`)).toThrow(
			/200/,
		);
	});
});

describe("report transport", () => {
	it.each(["missing", "unauthenticated", "timeout"])(
		"falls back when gh is %s",
		async (failure) => {
			const run = vi.fn<CommandRunner>(async (_command, args) => {
				if (failure === "timeout") return { ...ok(), timedOut: true };
				return failure === "missing" || args[0] === "auth" ? fail() : ok();
			});
			expect(await canSubmitReport(run)).toBe(false);
			expect(run).toHaveBeenCalledWith("gh", ["--version"], { timeout: 5000 });
			if (failure === "unauthenticated")
				expect(run).toHaveBeenLastCalledWith(
					"gh",
					["auth", "status", "--hostname", "github.com", "--active"],
					{ timeout: 10000 },
				);
		},
	);

	it("uses an explicit github.com repository, literal argv, private body file, and cleanup", async () => {
		const draft = {
			title: "$(touch /tmp/never); & issue",
			body: "Body exactly as reviewed\n",
		};
		let bodyPath = "";
		const run = vi.fn<CommandRunner>(async (command, args, options) => {
			expect(command).toBe("gh");
			expect(args.slice(0, 6)).toEqual([
				"issue",
				"create",
				"--repo",
				REPORT_REPOSITORY_URL,
				"--title",
				draft.title,
			]);
			bodyPath = args[7];
			expect(args[6]).toBe("--body-file");
			expect(readFileSync(bodyPath, "utf8")).toBe(draft.body);
			expect(statSync(bodyPath).mode & 0o777).toBe(0o600);
			expect(statSync(dirname(bodyPath)).mode & 0o777).toBe(0o700);
			expect(options?.timeout).toBe(30000);
			return ok(ISSUE_URL + "\n");
		});
		expect(await submitReport(run, draft)).toBe(ISSUE_URL);
		expect(existsSync(dirname(bodyPath))).toBe(false);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it.each([
		fail(),
		{ ...ok(ISSUE_URL), timedOut: true },
		ok("https://evil.test/issues/42"),
		ok("Created! " + ISSUE_URL),
	])("never confirms creation for uncertain output", async (result) => {
		const run = vi.fn<CommandRunner>(async () => result);
		expect(
			await submitReport(run, { title: "Report", body: "Body" }),
		).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("saves owner-only drafts outside the repository", () => {
		const path = saveReportDraft({ title: "Title", body: "Reviewed body" });
		try {
			expect(statSync(path).mode & 0o777).toBe(0o600);
			expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
			expect(readFileSync(path, "utf8")).toBe("# Title\n\nReviewed body\n");
		} finally {
			rmSync(dirname(path), { recursive: true, force: true });
		}
	});

	it("encodes URL data and omits oversized bodies without truncating the draft", () => {
		const draft = { title: "A & B # 😀", body: "line one\nline two?" };
		const short = reportFormUrl(draft);
		expect(short.bodyIncluded).toBe(true);
		const parsed = parseUrl(short.url);
		expect(parsed.searchParams.get("title")).toBe(draft.title);
		expect(parsed.searchParams.get("body")).toBe(draft.body);
		const long = reportFormUrl({ ...draft, body: "😀".repeat(2000) });
		expect(long.bodyIncluded).toBe(false);
		expect(long.url.length).toBeLessThanOrEqual(MAX_REPORT_URL_LENGTH);
		expect(parseUrl(long.url).searchParams.has("body")).toBe(false);
	});

	it.each(["darwin", "linux", "win32"] as const)(
		"opens without a shell on %s",
		async (platform) => {
			const run = vi.fn<CommandRunner>(async () => ok());
			const url = reportFormUrl({ title: "A & B", body: "body" }).url;
			expect(await openReportUrl(run, url, platform, { DISPLAY: ":0" })).toBe(
				true,
			);
			const [command, args] = run.mock.calls[0];
			expect(command).toBe(
				platform === "darwin"
					? "open"
					: platform === "win32"
						? "rundll32.exe"
						: "xdg-open",
			);
			expect(args.at(-1)).toBe(url);
			expect(command).not.toBe("cmd");
		},
	);

	it("does not launch on remote/headless hosts or accept unexpected URLs", async () => {
		const run = vi.fn<CommandRunner>(async () => ok());
		expect(
			await openReportUrl(run, REPORT_ISSUES_URL, "darwin", {
				SSH_CONNECTION: "remote",
			}),
		).toBe(false);
		expect(await openReportUrl(run, REPORT_ISSUES_URL, "linux", {})).toBe(
			false,
		);
		for (const url of [
			"invalid",
			"https://evil.test/",
			"https://github.com/elsewhere/repo/issues",
			"https://x:y@github.com/TakonautHQ/tako-bridge/issues",
		]) {
			expect(await openReportUrl(run, url, "darwin", {})).toBe(false);
		}
		expect(run).not.toHaveBeenCalled();
	});
});

describe("reviewed reporting flow", () => {
	it("collects questions, previews an exact sanitised report and requires confirmation before create", async () => {
		let published = "";
		const fixture = setup({
			diagnostics: true,
			run: async (_command, args) => {
				if (args[0] === "issue") {
					expect(fixture.ui.confirm).toHaveBeenCalledOnce();
					published = readFileSync(args[7], "utf8");
					return ok(ISSUE_URL);
				}
				return ok();
			},
		});
		fixture.reporter.diagnostics.record(
			"panel",
			new Error("timeout for patient-secret"),
		);
		await fixture.reporter.run(fixture.ctx);
		expect(published).toContain("panel: timeout");
		expect(published).not.toContain("patient-secret");
		const preview = fixture.ui.editor.mock.calls.at(-1)?.[1];
		expect(preview).toBe(`# Task panel stops refreshing\n\n${published}`);
		expect(fixture.ui.notify).toHaveBeenCalledWith(
			`Issue created: ${ISSUE_URL}`,
			"info",
		);
		expect(fixture.open).not.toHaveBeenCalled();
	});

	it("omits all automatic diagnostics when declined", async () => {
		const fixture = setup({ action: "Save locally" });
		fixture.reporter.diagnostics.record("panel", "timeout");
		await fixture.reporter.run(fixture.ctx);
		const draft = fixture.save.mock.calls[0][0];
		expect(JSON.stringify(draft)).not.toMatch(/timeout|Platform|Node|Bridge:/);
		expect(creates(fixture.run)).toHaveLength(0);
	});

	it("re-previews secrets introduced by editing, without publishing the unreviewed replacement", async () => {
		const fixture = setup({ action: "Save locally" });
		fixture.ui.editor.mockResolvedValueOnce(
			"# Changed title\n\nCookie: private-session\nReproduction here",
		);
		await fixture.reporter.run(fixture.ctx);
		expect(fixture.ui.editor).toHaveBeenCalledTimes(3);
		expect(fixture.ui.editor.mock.calls[2][1]).toContain("[REDACTED HEADER]");
		expect(JSON.stringify(fixture.save.mock.calls)).not.toContain(
			"private-session",
		);
		expect(fixture.save.mock.calls[0][0].title).toBe("Changed title");
	});

	it.each([
		"type",
		"title",
		"description",
		"diagnostics",
		"preview",
		"delivery",
		"confirmation",
	])("cancels safely at %s", async (stage) => {
		const fixture = setup();
		if (stage === "type")
			fixture.ui.select.mockReset().mockResolvedValue(undefined);
		if (stage === "title") fixture.ui.input.mockResolvedValueOnce("");
		if (stage === "description")
			fixture.ui.editor.mockReset().mockResolvedValue(undefined);
		if (stage === "diagnostics")
			fixture.ui.select
				.mockReset()
				.mockResolvedValueOnce("Bug report")
				.mockResolvedValue(undefined);
		if (stage === "preview") fixture.ui.editor.mockResolvedValueOnce(undefined);
		if (stage === "delivery")
			fixture.ui.select
				.mockReset()
				.mockResolvedValueOnce("Bug report")
				.mockResolvedValueOnce("No diagnostics")
				.mockResolvedValue(undefined);
		if (stage === "confirmation") fixture.ui.confirm.mockResolvedValue(false);
		await fixture.reporter.run(fixture.ctx);
		expect(creates(fixture.run)).toHaveLength(0);
		expect(fixture.open).not.toHaveBeenCalled();
		expect(fixture.save).not.toHaveBeenCalled();
	});

	it.each(["missing", "unauthenticated"])(
		"uses the reviewed browser fallback with gh %s",
		async (failure) => {
			const fixture = setup({
				action: "Open GitHub form",
				run: async (_command, args) =>
					failure === "missing" || args[0] === "auth" ? fail() : ok(),
			});
			await fixture.reporter.run(fixture.ctx);
			expect(creates(fixture.run)).toHaveLength(0);
			expect(fixture.open).toHaveBeenCalledOnce();
			expect(fixture.ui.confirm).toHaveBeenCalledWith(
				"Open the reviewed report on GitHub?",
				expect.stringContaining("browser history"),
			);
			expect(fixture.ui.notify).toHaveBeenCalledWith(
				expect.stringContaining("no issue has been created by Bridge"),
				"info",
			);
			expect(JSON.stringify(fixture.ui.notify.mock.calls)).not.toContain(
				"secret raw diagnostic",
			);
		},
	);

	it("saves a full copy for long browser reports and never claims creation", async () => {
		const fixture = setup({ action: "Open GitHub form" });
		fixture.ui.editor
			.mockReset()
			.mockImplementation(async (_title, value) => value)
			.mockResolvedValueOnce("A useful reproduction. ".repeat(200));
		await fixture.reporter.run(fixture.ctx);
		expect(fixture.save).toHaveBeenCalledOnce();
		expect(fixture.save.mock.calls[0][0].body).toContain(
			"A useful reproduction. ".repeat(199),
		);
		expect(
			parseUrl(fixture.open.mock.calls[0][0]).searchParams.has("body"),
		).toBe(false);
		expect(fixture.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Copy the description"),
			"info",
		);
	});

	it("provides a manual link and local copy when no browser can be launched", async () => {
		const fixture = setup({ action: "Open GitHub form" });
		fixture.open.mockResolvedValue(false);
		await fixture.reporter.run(fixture.ctx);
		expect(fixture.save).toHaveBeenCalledOnce();
		expect(fixture.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Open this form manually"),
			"info",
		);
	});

	it("does not auto-retry or open a create form after an ambiguous gh write failure", async () => {
		const fixture = setup({
			run: async (_command, args) => (args[0] === "issue" ? fail() : ok()),
		});
		await fixture.reporter.run(fixture.ctx);
		expect(creates(fixture.run)).toHaveLength(1);
		expect(fixture.open).not.toHaveBeenCalled();
		expect(fixture.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("MAY already exist"),
			"warning",
		);
		expect(JSON.stringify(fixture.ui.notify.mock.calls)).not.toContain(
			"secret raw diagnostic",
		);
	});

	it("routes security reports privately, without commands or public submission", async () => {
		const fixture = setup();
		fixture.ui.select
			.mockReset()
			.mockResolvedValueOnce("Security vulnerability (private)");
		await fixture.reporter.run(fixture.ctx);
		expect(fixture.run).not.toHaveBeenCalled();
		expect(fixture.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("security@takonaut.com"),
			"warning",
		);
	});

	it("supports feature requests without a captured failure", async () => {
		const fixture = setup();
		fixture.ui.select
			.mockReset()
			.mockResolvedValueOnce("Feature request")
			.mockResolvedValueOnce("No diagnostics")
			.mockResolvedValueOnce("Save locally");
		await fixture.reporter.run(fixture.ctx, "Add task search");
		expect(fixture.ui.input).not.toHaveBeenCalled();
		expect(fixture.ui.editor.mock.calls[0][1]).toContain(
			"What problem would this solve?",
		);
		expect(fixture.save.mock.calls[0][0].title).toBe("Add task search");
	});

	it("refuses non-interactive reporting without filesystem or network effects", async () => {
		const fixture = setup();
		await fixture.reporter.run({ ...fixture.ctx, hasUI: false });
		expect(fixture.run).not.toHaveBeenCalled();
		expect(fixture.ui.select).not.toHaveBeenCalled();
		expect(fixture.save).not.toHaveBeenCalled();
	});

	it("invalidates an in-flight confirmation on lifecycle reset and rejects concurrent flows", async () => {
		const fixture = setup();
		let confirm!: (value: boolean) => void;
		fixture.ui.confirm.mockImplementation(
			() =>
				new Promise((resolve) => {
					confirm = resolve;
				}),
		);
		const pending = fixture.reporter.run(fixture.ctx);
		await vi.waitFor(() => expect(fixture.ui.confirm).toHaveBeenCalledOnce());
		await fixture.reporter.run(fixture.ctx);
		expect(fixture.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("already being reviewed"),
			"warning",
		);
		fixture.reporter.reset();
		confirm(true);
		await pending;
		expect(creates(fixture.run)).toHaveLength(0);
	});
});
