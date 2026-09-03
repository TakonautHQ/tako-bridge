// Device Authorization Grant client (the onboarding handshake). Pure + injectable so
// the polling logic is unit-tested without a network. Talks to the backend device
// endpoints shipped in slice 9: /api/auth/device/{start,token}.

import {
	normalizeBridgeApiBaseUrl,
	requireSameBridgeOrigin,
} from "./server-url.js";

export interface HttpResult {
	status: number;
	json: any;
}

export interface DeviceDeps {
	fetchJson: (
		method: string,
		path: string,
		body?: unknown,
	) => Promise<HttpResult>;
	sleep: (ms: number) => Promise<void>;
	log: (msg: string) => void;
	/** Optionally open a URL in the developer's browser. */
	openUrl?: (url: string) => void;
}

export interface DeviceLoginResult {
	serverUrl: string;
	apiKey: string;
	orgId: string;
	expiresAt?: string;
	orgName?: string;
}

/**
 * Run the device flow: start → show the user code → poll until approved → return the
 * minted MCP config. Throws on failure or timeout.
 */
export async function runDeviceLogin(
	apiBaseUrl: string,
	deps: DeviceDeps,
	maxPolls = 120,
	label?: string,
): Promise<DeviceLoginResult> {
	const normalizedApiBaseUrl = normalizeBridgeApiBaseUrl(apiBaseUrl);
	const start = await deps.fetchJson("POST", "/api/auth/device/start");
	if (start.status !== 200) {
		throw new Error(`device/start failed: HTTP ${start.status}`);
	}
	const {
		device_code,
		user_code,
		interval,
		verification_uri,
		verification_uri_complete,
	} = start.json;
	const url: string | undefined = verification_uri_complete
		? requireSameBridgeOrigin(
				normalizedApiBaseUrl,
				verification_uri_complete,
				"Device verification URL",
			)
		: undefined;
	const bareVerificationUrl: string | undefined = verification_uri
		? requireSameBridgeOrigin(
				normalizedApiBaseUrl,
				verification_uri,
				"Device verification URL",
			)
		: undefined;

	deps.log("");
	if (url) {
		deps.log(
			"To connect, open this link, review the displayed organization, and confirm:",
		);
		deps.log(`  ${url}`);
		if (bareVerificationUrl) {
			deps.log(
				`Or, on any device, go to ${bareVerificationUrl} and enter code:  ${user_code}`,
			);
		}
		deps.openUrl?.(url);
	} else {
		deps.log("To connect Takonaut:");
		deps.log(`  1. Open ${normalizedApiBaseUrl} and sign in`);
		deps.log("  2. Go to Settings → Connect my agent");
		deps.log(`  3. Enter this code:  ${user_code}`);
	}
	deps.log("");
	deps.log("Waiting for approval…");

	const ms = Math.max(1, Number(interval ?? 5)) * 1000;
	for (let i = 0; i < maxPolls; i++) {
		const tok = await deps.fetchJson("POST", "/api/auth/device/token", {
			device_code,
			label,
		});
		if (tok.status === 200) {
			const cfg = tok.json.mcp_config;
			deps.log("✓ Connected.");
			return {
				serverUrl: requireSameBridgeOrigin(
					normalizedApiBaseUrl,
					cfg.serverUrl,
					"MCP server URL",
				),
				apiKey: cfg.apiKey,
				orgId: cfg.orgId,
				expiresAt: tok.json.expires_at,
				orgName: tok.json.organization_name,
			};
		}
		if (tok.status === 428) {
			await deps.sleep(ms);
			continue;
		}
		throw new Error(
			`device/token failed: HTTP ${tok.status} ${JSON.stringify(tok.json)}`,
		);
	}
	throw new Error("Timed out waiting for approval.");
}
