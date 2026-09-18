import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "./git.js";

export const REPORT_REPOSITORY = "TakonautHQ/tako-bridge";
export const REPORT_REPOSITORY_URL = `https://github.com/${REPORT_REPOSITORY}`;
export const REPORT_ISSUES_URL = `${REPORT_REPOSITORY_URL}/issues`;
export const MAX_REPORT_URL_LENGTH = 1800;

export interface ReportDraft {
	title: string;
	body: string;
}

async function safeRun(
	run: CommandRunner,
	command: string,
	args: string[],
	timeout: number,
): Promise<CommandResult> {
	try {
		return await run(command, args, { timeout });
	} catch {
		// Command output and thrown errors can contain credentials. Never display them.
		return { stdout: "", stderr: "", exitCode: 1 };
	}
}

export async function canSubmitReport(run: CommandRunner): Promise<boolean> {
	const version = await safeRun(run, "gh", ["--version"], 5_000);
	if (version.exitCode !== 0 || version.timedOut) return false;
	const auth = await safeRun(
		run,
		"gh",
		["auth", "status", "--hostname", "github.com", "--active"],
		10_000,
	);
	return auth.exitCode === 0 && !auth.timedOut;
}

/** Owner-only file outside the repository. Caller chooses whether to retain it. */
export function saveReportDraft(draft: ReportDraft): string {
	const directory = mkdtempSync(join(tmpdir(), "tako-report-"));
	try {
		chmodSync(directory, 0o700);
		const path = join(directory, "report.md");
		writeFileSync(path, `# ${draft.title}\n\n${draft.body}\n`, {
			mode: 0o600,
			flag: "wx",
		});
		return path;
	} catch {
		rmSync(directory, { recursive: true, force: true });
		throw new Error("Report draft could not be saved.");
	}
}

/** One attempt only. A failure may mean GitHub accepted the write but the reply was lost. */
export async function submitReport(
	run: CommandRunner,
	draft: ReportDraft,
): Promise<string | null> {
	const directory = mkdtempSync(join(tmpdir(), "tako-report-submit-"));
	try {
		chmodSync(directory, 0o700);
		const path = join(directory, "body.md");
		writeFileSync(path, draft.body, { mode: 0o600, flag: "wx" });
		const result = await safeRun(
			run,
			"gh",
			[
				"issue",
				"create",
				"--repo",
				REPORT_REPOSITORY_URL,
				"--title",
				draft.title,
				"--body-file",
				path,
			],
			30_000,
		);
		const url = result.stdout.trim();
		return result.exitCode === 0 &&
			!result.timedOut &&
			/^https:\/\/github\.com\/TakonautHQ\/tako-bridge\/issues\/[1-9]\d*$/i.test(
				url,
			)
			? url
			: null;
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export function reportFormUrl(draft: ReportDraft): {
	url: string;
	bodyIncluded: boolean;
} {
	const params = new URLSearchParams({ title: draft.title, body: draft.body });
	const base = `${REPORT_ISSUES_URL}/new`;
	const full = `${base}?${params}`;
	if (full.length <= MAX_REPORT_URL_LENGTH)
		return { url: full, bodyIncluded: true };
	params.delete("body");
	const titleOnly = `${base}?${params}`;
	return {
		url: titleOnly.length <= MAX_REPORT_URL_LENGTH ? titleOnly : base,
		bodyIncluded: false,
	};
}

/** No shell interpolation (including Windows); never open URLs on a remote/headless host. */
export async function openReportUrl(
	run: CommandRunner,
	url: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	if (
		env.SSH_CONNECTION ||
		env.SSH_TTY ||
		(platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY)
	)
		return false;
	// Keep the browser adapter scoped to the fixed public issue destination.
	try {
		const parsed = new URL(url);
		if (
			parsed.origin !== "https://github.com" ||
			parsed.username ||
			parsed.password ||
			![
				`/${REPORT_REPOSITORY}/issues`,
				`/${REPORT_REPOSITORY}/issues/new`,
			].includes(parsed.pathname)
		)
			return false;
	} catch {
		return false;
	}
	const command =
		platform === "darwin"
			? "open"
			: platform === "win32"
				? "rundll32.exe"
				: "xdg-open";
	const args =
		platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
	const result = await safeRun(run, command, args, 10_000);
	return result.exitCode === 0 && !result.timedOut;
}
