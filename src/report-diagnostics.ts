import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { BRIDGE_VERSION } from "./version.js";

const SOURCES = [
	"command",
	"panel",
	"telemetry",
	"connection",
	"tool",
] as const;
type ReportSource = (typeof SOURCES)[number];
type ErrorCategory =
	| "timeout"
	| "authentication"
	| "permission"
	| "network"
	| "failure";
export interface ReportDiagnostic {
	source: ReportSource;
	category: ErrorCategory;
	observedAt: string;
	count: number;
}

const MAX_EVENTS = 10;
const MAX_AGE_MS = 60 * 60 * 1000;

/** Memory-only, allowlisted metadata. Raw errors never enter the retained history. */
export class ReportDiagnostics {
	private events: ReportDiagnostic[] = [];
	constructor(private readonly now: () => number = Date.now) {}

	record(source: ReportSource, error?: unknown): void {
		if (!SOURCES.includes(source)) return;
		const message =
			typeof error === "string"
				? error
				: error instanceof Error
					? error.message
					: "";
		const category: ErrorCategory = /timeout|timed out/i.test(message)
			? "timeout"
			: /unauthori[sz]ed|authentication|\b401\b/i.test(message)
				? "authentication"
				: /forbidden|permission|\b403\b/i.test(message)
					? "permission"
					: /ECONN|ENOTFOUND|network|fetch failed/i.test(message)
						? "network"
						: "failure";
		this.expire();
		this.events.push({
			source,
			category,
			observedAt: new Date(this.now()).toISOString(),
			count: 1,
		});
		this.events = this.events.slice(-MAX_EVENTS);
	}

	private expire(): void {
		const now = this.now();
		this.events = this.events.filter((event) => {
			const age = now - Date.parse(event.observedAt);
			return age >= 0 && age < MAX_AGE_MS;
		});
	}

	snapshot(): ReportDiagnostic[] {
		this.expire();
		// Aggregate for display only, after independently expiring each occurrence.
		const groups: ReportDiagnostic[] = [];
		for (const event of this.events) {
			const last = groups.at(-1);
			if (last?.source === event.source && last.category === event.category) {
				last.count += 1;
				last.observedAt = event.observedAt;
			} else groups.push({ ...event });
		}
		return groups;
	}

	clear(): void {
		this.events = [];
	}
}

export class ReportInputError extends Error {}

/** Defence in depth for user-authored text; human review remains mandatory. */
export function sanitizeReportText(value: string): string {
	if (Buffer.byteLength(value, "utf8") > 32 * 1024) {
		throw new ReportInputError(
			"Report text must be at most 32 KiB. Shorten it and run /tako-report again.",
		);
	}
	let text = value
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(
			/[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
			"",
		);
	if (/-----BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)-----/i.test(text)) {
		throw new ReportInputError(
			"Remove private keys and certificates before reporting. Use security@takonaut.com for vulnerabilities.",
		);
	}
	text = text
		.replace(
			/\b(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=][^\n]*/gi,
			"[REDACTED HEADER]",
		)
		.replace(/\b(?:bearer|basic)\s+[^\s,;]+/gi, "[REDACTED AUTH]")
		.replace(
			/\b(?:[a-z][a-z0-9_-]*(?:token|secret|password|api[_-]?key)|password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\n]+)/gi,
			"[REDACTED SECRET]",
		)
		.replace(
			/--(?:[a-z][a-z0-9_-]*(?:token|secret|password|api[_-]?key)|password|passwd|secret|token|api[_-]?key)\s+(?:"[^"]*"|'[^']*'|\S+)/gi,
			"[REDACTED SECRET]",
		)
		.replace(
			/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|(?:AKIA|ASIA)[A-Z0-9]{16})\b/g,
			"[REDACTED TOKEN]",
		)
		.replace(
			/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
			"[REDACTED JWT]",
		)
		.replace(
			/\b(?:https?|wss?|postgres(?:ql)?|mysql|redis|mongodb(?:\+srv)?):\/\/[^\s<>"']+/gi,
			"[REDACTED URL]",
		)
		.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED EMAIL]")
		.replace(
			/(?:\/(?:Users|home|Volumes|private|tmp|var|opt|workspace)\/|~\/|\b[A-Z]:[\\/])[^\s<>"'`]+/gi,
			"[LOCAL PATH]",
		)
		.replace(/\b[A-Za-z0-9_+-]{40,}\b/g, "[REDACTED VALUE]");
	return text;
}

function piVersion(): string {
	try {
		const require = createRequire(import.meta.url);
		const value = JSON.parse(
			readFileSync(
				require.resolve("@earendil-works/pi-coding-agent/package.json"),
				"utf8",
			),
		).version;
		return typeof value === "string" &&
			/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(value)
			? value
			: "unavailable";
	} catch {
		return "unavailable";
	}
}

export function formatReportDiagnostics(history: ReportDiagnostics): string {
	const events = history.snapshot();
	return [
		"## Optional minimal diagnostics",
		`- Bridge: ${BRIDGE_VERSION}`,
		`- Pi: ${piVersion()}`,
		`- Platform: ${process.platform} / ${process.arch}`,
		`- Node: ${process.version}`,
		"",
		"Observed categories only; not a root-cause diagnosis. No raw errors, payloads, paths, identities, or conversation were collected.",
		...(events.length
			? events.map(
					(event) =>
						`- ${event.observedAt} — ${event.source}: ${event.category} (${event.count} occurrence(s))`,
				)
			: ["No recent Bridge failures were captured in this session."]),
	].join("\n");
}
