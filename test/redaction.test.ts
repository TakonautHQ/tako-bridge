import { describe, expect, it } from "vitest";

import { prepareDiagnosticContent } from "../src/diagnostics";
import { PROVIDER_TOKEN_PATTERNS, redactCounting } from "../src/redaction";
import { sanitizeReportText } from "../src/report-diagnostics";

describe("redaction", () => {
	it.each([
		"AWS_SECRET_ACCESS_KEY=abcdEFGH1234ijkl",
		"DATABASE_PASSWORD: hunter2hunter2",
		"GITHUB_TOKEN=ghx_notaprefixbutlong",
		`github_pat_${"A1".repeat(20)}`,
		`sk_live_${"a".repeat(24)}`,
		"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
		"xoxb-123456789012-abcdefghij",
		`AIza${"B".repeat(35)}`,
		"redis://user:s3cretpass@cache.internal:6379",
		"password=hunter2hunter2",
		"--token abcdef123456",
	])("redacts %s", (secret) => {
		const { text, count } = redactCounting(`before ${secret} after`);
		expect(count).toBe(1);
		expect(text).toBe("before [REDACTED] after");
	});

	it("leaves ordinary prose alone", () => {
		const prose =
			"We fixed the token refresh logic, the password validation flow, bearer tokens and secret rotation.";
		expect(redactCounting(prose)).toEqual({ text: prose, count: 0 });
	});

	// Kept in step with backend tests/core/test_secret_tokens.py.
	const GH = `ghp_${"A1b2".repeat(9)}`;
	const glued = [
		`x${GH}`,
		`9${GH}`,
		`MY_${GH}`,
		`${GH}_suffix`,
		`abcgithub_pat_${"Z9".repeat(15)}`,
		"keyAKIAABCDEFGHIJ234567",
		"zASIAABCDEFGHIJ234567",
		"keysk-proj-abcDEF123456789xyz",
		`xsk-${"a1B2".repeat(9)}`,
		"1sk-abcdefghijklmnop",
		`_sk_live_${"a1B2".repeat(4)}`,
		`desksk_live_${"a1B2".repeat(7)}`,
		"slackxoxb-1234567890-abcdef",
		`gAIza${"B".repeat(35)}`,
		"tokeyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlX2hlcmU",
		"_eyJhbGciOiJIUzI1NiJ9.abcdefghijklmn.c2lnbmF0dXJl",
	];
	const ordinary = [
		"feat/task-handoff-improvements-v2 is merged",
		"the disk-utilization-dashboard-panel1 rendered",
		"desk_test_fixturesfor2024run passed",
		"self.monkeyJumpingAround.someLongMethodName.call()",
		"highs_and_lows of ASIA_PACIFIC_REGION",
	];

	it.each(glued)("redacts a token glued to other text: %s", (token) => {
		const { text, count } = redactCounting(`see ${token} here`);
		expect(count).toBeGreaterThanOrEqual(1);
		expect(PROVIDER_TOKEN_PATTERNS.some((p) => new RegExp(p).test(text))).toBe(false);
		expect(prepareDiagnosticContent(`see ${token} here`).content).toContain("[REDACTED]");
		expect(sanitizeReportText(`see ${token} here`)).toContain("[REDACTED");
	});

	it.each(ordinary)("keeps ordinary text: %s", (text) => {
		expect(redactCounting(text)).toEqual({ text, count: 0 });
		expect(prepareDiagnosticContent(text).content).toBe(text);
	});
});
