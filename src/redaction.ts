/**
 * Provider token shapes, shared by every Bridge redactor. Mirrors the
 * server's src/core/secret_tokens.py; keep the two in step.
 *
 * Tokens match wherever they sit, including glued to other text (xghp_…,
 * MY_ghp_…, ghp_…_suffix). Prefixes that also occur inside ordinary words
 * (sk- in task-, sk_test_ in desk_test_, eyJ in keyJ) only match after a
 * non-letter, unless the rest has a shape no prose has (a long unbroken
 * run, a known key kind, a JWT's second eyJ).
 */
export const PROVIDER_TOKEN_PATTERNS: readonly RegExp[] = [
	// GitHub, AWS, Slack, Google: distinctive prefixes.
	/gh[pousr]_[A-Za-z0-9]{20,}/g,
	/github_pat_[A-Za-z0-9_]{20,}/g,
	/(?:AKIA|ASIA)[0-9A-Z]{16}/g,
	/xox[abprs]-[A-Za-z0-9-]{10,}/g,
	/AIza[0-9A-Za-z_-]{35}/g,
	// OpenAI-style and Anthropic keys.
	/(?<![A-Za-z])sk-[A-Za-z0-9_-]{16,}/g,
	/sk-(?:proj|ant|svcacct|admin)-[A-Za-z0-9_-]{16,}/g,
	/sk-[A-Za-z0-9]{32,}/g,
	// Stripe.
	/(?<![A-Za-z])[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
	/[rs]k_(?:live|test)_[A-Za-z0-9]{24,}/g,
	// JWTs.
	/(?<![A-Za-z])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
	/eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{7,}\.[A-Za-z0-9_-]{5,}/g,
];

/** Secret-looking values Bridge never sends or shows: replaced by [REDACTED]. */
const SENSITIVE_VALUE_PATTERNS = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,
	...PROVIDER_TOKEN_PATTERNS,
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
