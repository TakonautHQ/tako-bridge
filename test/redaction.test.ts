import { describe, expect, it } from "vitest";

import { redactCounting } from "../src/redaction";

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
});
