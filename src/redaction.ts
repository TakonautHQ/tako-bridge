/** Secret-looking values Bridge never sends or shows: replaced by [REDACTED]. */
const SENSITIVE_VALUE_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
	// Provider tokens: GitHub, OpenAI-style, AWS, Stripe, Slack, Google, JWT.
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})\b/g,
	/\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAIza[0-9A-Za-z_-]{35}\b/g,
	/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
	/\b(?:authorization:\s*bearer|bearer)\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
	// Assignments: KEY=value / key: value (env-style names included).
	/(?<![A-Za-z0-9])[A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_]*\s*[=:]\s*["']?[^\s"']{6,}["']?/gi,
	// Command-line flags: --token value, --password=value.
	/--(?:password|passwd|secret|token|api-?key)(?:[ =])\s*["']?[^\s"']{6,}["']?/gi,
	// Credentials in URLs: scheme://user:password@host.
	/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@\S+/gi,
];

export function redactSensitiveValues(value: string): string {
	return SENSITIVE_VALUE_PATTERNS.reduce(
		(redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
		value,
	);
}

/** The redacted value and how many secrets were replaced. */
export function redactCounting(value: string): { text: string; count: number } {
	let count = 0;
	const text = SENSITIVE_VALUE_PATTERNS.reduce(
		(redacted, pattern) =>
			redacted.replace(pattern, (match) => {
				// A later pattern may match an earlier redaction: count once.
				if (!match.includes("[REDACTED]")) count += 1;
				return "[REDACTED]";
			}),
		value,
	);
	return { text, count };
}

export function containsSensitiveValue(value: string): boolean {
	return redactSensitiveValues(value) !== value;
}
