function isLoopback(hostname: string): boolean {
	return (
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
	);
}

export function bridgeServerUrl(
	value: string,
	label = "Takonaut server URL",
): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error(`${label} must be a valid HTTPS URL`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`${label} must be a valid HTTPS URL`);
	}
	if (parsed.username || parsed.password) {
		throw new Error(`${label} must not include credentials`);
	}
	if (parsed.protocol === "http:" && !isLoopback(parsed.hostname)) {
		throw new Error(`${label} requires HTTPS except for loopback development`);
	}
	return parsed;
}

export function normalizeBridgeApiBaseUrl(value: string): string {
	return bridgeServerUrl(value, "Takonaut API URL")
		.toString()
		.replace(/\/+$/, "");
}

export function requireSameBridgeOrigin(
	baseUrl: string,
	value: string,
	label: string,
): string {
	const base = bridgeServerUrl(baseUrl, "Takonaut API URL");
	const candidate = bridgeServerUrl(value, label);
	if (candidate.origin !== base.origin) {
		throw new Error(`${label} must use the same origin as the Takonaut API`);
	}
	return candidate.toString();
}
