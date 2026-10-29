import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clients = vi.hoisted(() => [] as unknown[]);

vi.mock("../src/client", () => ({
	TakonautClient: class {
		constructor(cfg: unknown) {
			clients.push(cfg);
		}
		async listTools() {
			return [];
		}
	},
}));

import planningTurnToolsExtension from "../src/planner-tools-extension";

const ENV_KEYS = [
	"TAKONAUT_PLANNING_SERVER_URL",
	"TAKONAUT_PLANNING_API_KEY",
	"TAKONAUT_PLANNING_DELEGATE_TOKEN",
	"TAKONAUT_PLANNING_ORG_ID",
	"TAKONAUT_PLANNING_ALLOWED_TOOLS",
	"TAKONAUT_PLANNING_WORKTREE",
] as const;

function fakePi() {
	return { registerTool: vi.fn(), getActiveTools: vi.fn(() => []), setActiveTools: vi.fn(), on: vi.fn() };
}

describe("planner-tools-extension with a hosted Grill delegate (Grill v2)", () => {
	const previous: Record<string, string | undefined> = {};

	beforeEach(() => {
		clients.length = 0;
		for (const key of ENV_KEYS) previous[key] = process.env[key];
		for (const key of ENV_KEYS) delete process.env[key];
		process.env.TAKONAUT_PLANNING_SERVER_URL = "https://takonaut.test";
		process.env.TAKONAUT_PLANNING_ORG_ID = "org-1";
		process.env.TAKONAUT_PLANNING_ALLOWED_TOOLS = JSON.stringify(["get_task"]);
		process.env.TAKONAUT_PLANNING_WORKTREE = "/tmp/worktree";
	});

	afterEach(() => {
		for (const key of ENV_KEYS) {
			if (previous[key] === undefined) delete process.env[key];
			else process.env[key] = previous[key];
		}
	});

	it("connects with the delegate when there is no device key", () => {
		process.env.TAKONAUT_PLANNING_DELEGATE_TOKEN = "delegate-xyz";
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(fakePi());

		expect(clients).toEqual([
			{ serverUrl: "https://takonaut.test", apiKey: "", orgId: "org-1", delegateToken: "delegate-xyz" },
		]);
	});

	it("prefers the delegate and drops a device key if both are somehow set", () => {
		process.env.TAKONAUT_PLANNING_DELEGATE_TOKEN = "delegate-xyz";
		process.env.TAKONAUT_PLANNING_API_KEY = "device-secret";
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(fakePi());

		expect(clients).toEqual([
			{ serverUrl: "https://takonaut.test", apiKey: "", orgId: "org-1", delegateToken: "delegate-xyz" },
		]);
	});

	it("still uses the device key for a Grill without a host", () => {
		process.env.TAKONAUT_PLANNING_API_KEY = "device-secret";
		// @ts-expect-error -- fakePi only implements the subset this extension calls.
		planningTurnToolsExtension(fakePi());

		expect(clients).toEqual([{ serverUrl: "https://takonaut.test", apiKey: "device-secret", orgId: "org-1" }]);
	});
});
