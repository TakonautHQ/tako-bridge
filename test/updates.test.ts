import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	BridgeUpdates,
	UPDATE_API_URL,
	UPDATE_INTERVAL_MS,
	bridgeReleaseUrl,
	bridgeUpgradeCommand,
	isNewerBridgeRelease,
	parseBridgeRelease,
} from "../src/updates.js";
import {
	createUpdateStorage,
	type UpdateStorage,
} from "../src/update-storage.js";
import {
	BridgeUpdateCommand,
	bridgeInstallScope,
} from "../src/update-command.js";
import type { ReportUI } from "../src/report.js";

const NOW = Date.parse("2030-01-01T00:00:00Z");
const managers: BridgeUpdates[] = [];
const directories: string[] = [];
const wire = (tag = "v0.4.21") => ({
	tag_name: tag,
	body: "Reviewed release notes",
	draft: false,
	prerelease: false,
	html_url: "https://evil.test/untrusted",
});
function fixture(
	options: {
		settings?: unknown;
		cache?: unknown;
		fetcher?: typeof fetch;
		version?: string;
	} = {},
) {
	let settings: unknown = options.settings;
	let cache: unknown = options.cache;
	const storage = {
		readSettings: vi.fn(() => settings),
		writeSettings: vi.fn((value: unknown) => {
			settings = value;
		}),
		readCache: vi.fn(() => cache),
		writeCache: vi.fn((value: unknown) => {
			cache = value;
		}),
	} satisfies UpdateStorage;
	const fetcher = vi.fn<typeof fetch>(
		options.fetcher ?? (async () => Response.json(wire())),
	);
	const updates = new BridgeUpdates({
		storage,
		fetch: fetcher,
		version: options.version ?? "0.4.20",
	});
	managers.push(updates);
	return { updates, storage, fetcher };
}
function temp() {
	const path = mkdtempSync(join(tmpdir(), "bridge-updates-test-"));
	directories.push(path);
	return path;
}
function ui() {
	return {
		input: vi.fn<ReportUI["input"]>(),
		select: vi.fn<ReportUI["select"]>().mockResolvedValue("Close"),
		editor: vi.fn<ReportUI["editor"]>().mockResolvedValue(undefined),
		confirm: vi.fn<ReportUI["confirm"]>().mockResolvedValue(true),
		notify: vi.fn(),
	};
}
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});
afterEach(() => {
	for (const manager of managers.splice(0)) manager.stop();
	vi.useRealTimers();
	for (const path of directories.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("stable release trust boundary", () => {
	it.each([
		["v1.10.0", "1.9.9", true],
		["v1.2.0", "1.2.0", false],
		["v1.2.0", "1.2.0-beta.1", true],
		["v1.2.0", "1.2.0+build.1", false],
		["v0.4.20", "0.4.21", false],
		["v0.4.21-beta", "0.4.20", false],
		["v01.2.3", "0.4.20", false],
		["v1.2.3;evil", "0.4.20", false],
		["v1.2.3", "unknown", false],
		["v2.0.0", "1.99.99", true],
	])("compares %s against %s", (tag, current, expected) =>
		expect(isNewerBridgeRelease(tag, current)).toBe(expected),
	);

	it("accepts only published stable releases and constructs fixed-host URLs/commands", () => {
		expect(parseBridgeRelease({ ...wire(), draft: true })).toBeNull();
		expect(parseBridgeRelease({ ...wire(), prerelease: true })).toBeNull();
		expect(parseBridgeRelease({ tag_name: "v0.4.21" })).toBeNull();
		expect(parseBridgeRelease(wire("$(curl evil)"))).toBeNull();
		const release = parseBridgeRelease(wire())!;
		expect(bridgeReleaseUrl(release)).toBe(
			"https://github.com/TakonautHQ/tako-bridge/releases/tag/v0.4.21",
		);
		expect(bridgeUpgradeCommand(release, "project")).toBe(
			"pi install git:github.com/TakonautHQ/tako-bridge@v0.4.21 -l",
		);
		expect(bridgeUpgradeCommand(release, "user")).not.toContain(" -l");
		expect(() =>
			bridgeUpgradeCommand({ ...release, tag: "v1.2.3;evil" }, "user"),
		).toThrow();
	});

	it("bounds and strips terminal-control payloads from untrusted notes", () => {
		const release = parseBridgeRelease({
			...wire(),
			body: "\x1b[31mnote\x1b[0m\u202e" + "x".repeat(9000),
		})!;
		expect(release.notes).toHaveLength(6000);
		expect(release.notes).not.toMatch(/[\x1b\u202e]/);
	});
});

describe("cached background checks", () => {
	it("does nothing in the factory; startup checks without credentials and repeats every six hours", async () => {
		const { updates, fetcher } = fixture();
		const changed = vi.fn();
		expect(fetcher).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
		updates.start(changed);
		await updates.check();
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(fetcher.mock.calls[0][0]).toBe(UPDATE_API_URL);
		expect(fetcher.mock.calls[0][1]).toMatchObject({
			credentials: "omit",
			redirect: "error",
		});
		expect(JSON.stringify(fetcher.mock.calls)).not.toMatch(
			/Authorization|orgId|apiKey|repoRoot/,
		);
		expect(updates.snapshot().availableVersion).toBe("0.4.21");
		await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS - 1);
		expect(fetcher).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(fetcher).toHaveBeenCalledTimes(2);
		updates.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("reuses the persisted cache across restarts and expires exactly at the next check", async () => {
		const options = {
			cache: {
				version: 1,
				checkedAt: NOW - 1000,
				nextCheckAt: NOW + 5000,
				retryAfter: 0,
				release: { tag: "v0.4.21", version: "0.4.21", notes: "cached" },
			},
		};
		const { updates, fetcher } = fixture(options);
		updates.start(vi.fn());
		await updates.check();
		expect(fetcher).not.toHaveBeenCalled();
		expect(updates.snapshot().availableVersion).toBe("0.4.21");
		await vi.advanceTimersByTimeAsync(5000);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it("coalesces concurrent checks into a single request", async () => {
		let resolve!: (value: Response) => void;
		const { updates, fetcher } = fixture({
			fetcher: () =>
				new Promise((r) => {
					resolve = r;
				}),
		});
		const first = updates.check();
		const second = updates.check(true);
		resolve(Response.json(wire()));
		await Promise.all([first, second]);
		expect(fetcher).toHaveBeenCalledOnce();
	});

	it.each(["offline", "bad-json", "prerelease", "oversized"])(
		"fails quietly with six-hour backoff for %s",
		async (failure) => {
			const fetcher: typeof fetch = async () => {
				if (failure === "offline") throw new Error("private network error");
				if (failure === "bad-json") return new Response("not json");
				if (failure === "oversized") return new Response("x".repeat(70 * 1024));
				return Response.json({ ...wire(), prerelease: true });
			};
			const f = fixture({ fetcher });
			f.updates.start(vi.fn());
			await f.updates.check();
			expect(f.updates.snapshot().availableVersion).toBeUndefined();
			expect(f.updates.snapshot().unavailable).toBe(true);
			await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS - 1);
			expect(f.fetcher).toHaveBeenCalledOnce();
		},
	);

	it("times out without entering a tight retry loop", async () => {
		const f = fixture({
			fetcher: (_url, options) =>
				new Promise((_resolve, reject) => {
					options?.signal?.addEventListener("abort", () =>
						reject(new Error("aborted")),
					);
				}),
		});
		f.updates.start(vi.fn());
		await vi.advanceTimersByTimeAsync(10_000);
		expect(f.updates.snapshot().unavailable).toBe(true);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(f.fetcher).toHaveBeenCalledOnce();
	});

	it.each([403, 429])(
		"honours rate limiting (%s), including explicit check requests",
		async (status) => {
			const f = fixture({
				fetcher: async () =>
					new Response("limited", {
						status,
						headers: { "retry-after": String(12 * 3600) },
					}),
			});
			await f.updates.check();
			await f.updates.check(true);
			await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
			await f.updates.check(true);
			expect(f.fetcher).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
			await f.updates.check(true);
			expect(f.fetcher).toHaveBeenCalledTimes(2);
		},
	);

	it("keeps a last-known release on transient failure, labelled stale, then ages it out", async () => {
		const f = fixture();
		await f.updates.check();
		f.fetcher.mockRejectedValue(new Error("offline"));
		await vi.advanceTimersByTimeAsync(UPDATE_INTERVAL_MS);
		await f.updates.check();
		expect(f.updates.snapshot()).toMatchObject({
			availableVersion: "0.4.21",
			stale: true,
			unavailable: true,
			checkedAt: NOW,
		});
		await vi.advanceTimersByTimeAsync(7 * 24 * 3600 * 1000);
		expect(f.updates.snapshot().release).toBeNull();
	});

	it("ignores corrupted/future-dated cache and does not downgrade installed versions", async () => {
		const f = fixture({
			version: "0.5.0",
			cache: {
				version: 1,
				checkedAt: NOW + 1000,
				nextCheckAt: NOW + 999999999999,
				retryAfter: 0,
			},
		});
		await f.updates.check();
		expect(f.fetcher).toHaveBeenCalledOnce();
		expect(f.updates.snapshot().availableVersion).toBeUndefined();
	});

	it("opt-out is persistent, cancels in-flight checks, and cannot be overwritten by a late response", async () => {
		let resolve!: (value: Response) => void;
		const f = fixture({
			fetcher: () =>
				new Promise((r) => {
					resolve = r;
				}),
		});
		const request = f.updates.check();
		f.updates.setEnabled(false);
		resolve(Response.json(wire()));
		await request;
		expect(f.storage.writeSettings).toHaveBeenCalledWith({
			version: 1,
			enabled: false,
		});
		expect(f.storage.writeCache).not.toHaveBeenCalled();
		expect(f.updates.snapshot().availableVersion).toBeUndefined();
		await f.updates.check();
		expect(f.fetcher).toHaveBeenCalledOnce();
		const restarted = new BridgeUpdates({
			storage: f.storage,
			fetch: f.fetcher,
		});
		managers.push(restarted);
		restarted.start(vi.fn());
		await restarted.check();
		expect(f.fetcher).toHaveBeenCalledOnce();
	});

	it("manual one-shot checks while disabled do not re-enable automatic checks", async () => {
		const f = fixture({ settings: { version: 1, enabled: false } });
		f.updates.start(vi.fn());
		await f.updates.check();
		expect(f.fetcher).not.toHaveBeenCalled();
		await f.updates.check(true);
		expect(f.fetcher).toHaveBeenCalledOnce();
		expect(f.updates.snapshot()).toMatchObject({
			enabled: false,
			release: { version: "0.4.21" },
		});
		expect(f.storage.writeSettings).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("unsafe settings fail closed; failed cache persistence still throttles in memory", async () => {
		const f = fixture();
		f.storage.readSettings.mockImplementation(() => {
			throw new Error("unsafe path");
		});
		await f.updates.check();
		expect(f.fetcher).not.toHaveBeenCalled();
		f.storage.readSettings.mockReturnValue(undefined);
		f.storage.writeCache.mockImplementation(() => {
			throw new Error("disk full");
		});
		await f.updates.check();
		await f.updates.check();
		expect(f.fetcher).toHaveBeenCalledOnce();
	});

	it("shutdown ignores late responses and tears down timers and callbacks", async () => {
		let resolve!: (value: Response) => void;
		const f = fixture({
			fetcher: () =>
				new Promise((r) => {
					resolve = r;
				}),
		});
		const changed = vi.fn();
		f.updates.start(changed);
		const pending = f.updates.check();
		f.updates.stop();
		changed.mockClear();
		resolve(Response.json(wire()));
		await pending;
		expect(changed).not.toHaveBeenCalled();
		expect(f.storage.writeCache).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});
});

describe("owner-only separate settings and cache", () => {
	it("persists independently without changing the opt-out during cache writes", () => {
		const directory = temp();
		const storage = createUpdateStorage(directory);
		expect(storage.readSettings()).toBeUndefined();
		storage.writeSettings({ version: 1, enabled: false });
		storage.writeCache({ version: 1, latest: "v1.2.3" });
		expect(storage.readSettings()).toEqual({ version: 1, enabled: false });
		for (const file of [
			"bridge-update-settings.json",
			"bridge-update-cache.json",
		])
			expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
	});
	it("refuses symlinks, malformed and oversized state", () => {
		const directory = temp();
		const outside = join(temp(), "outside.json");
		writeFileSync(outside, "unchanged", { mode: 0o600 });
		symlinkSync(outside, join(directory, "bridge-update-settings.json"));
		const storage = createUpdateStorage(directory);
		expect(() => storage.readSettings()).toThrow();
		expect(() => storage.writeSettings({ enabled: true })).toThrow();
		expect(readFileSync(outside, "utf8")).toBe("unchanged");
		writeFileSync(
			join(directory, "bridge-update-cache.json"),
			"x".repeat(33000),
			{ mode: 0o600 },
		);
		expect(() => storage.readCache()).toThrow();
	});
});

describe("reviewed manual upgrade command", () => {
	it.each(["project", "user"] as const)(
		"preserves %s scope and does not execute installation",
		async (scope) => {
			const f = fixture();
			const view = ui();
			view.select.mockResolvedValueOnce("Show upgrade command");
			const command = new BridgeUpdateCommand(f.updates, () => scope);
			await command.run({ hasUI: true, ui: view });
			expect(view.confirm).toHaveBeenCalledWith(
				"Review upgrade command",
				expect.stringContaining(
					scope === "project" ? "v0.4.21 -l" : "v0.4.21\n",
				),
			);
			expect(view.notify).toHaveBeenCalledWith(
				expect.stringContaining("No installation was performed"),
				"info",
			);
		},
	);
	it("requires an explicit scope for unknown/local installs and honours cancellation", async () => {
		const f = fixture();
		const view = ui();
		view.select
			.mockResolvedValueOnce("Show upgrade command")
			.mockResolvedValueOnce("Cancel");
		await new BridgeUpdateCommand(f.updates, () => null).run({
			hasUI: true,
			ui: view,
		});
		expect(view.confirm).not.toHaveBeenCalled();
		expect(view.notify).not.toHaveBeenCalled();
	});
	it("shows bounded notes as data and ignores their edits", async () => {
		const f = fixture();
		const view = ui();
		view.select.mockResolvedValueOnce("View release notes");
		view.editor.mockResolvedValue("run evil shell command");
		await new BridgeUpdateCommand(f.updates, () => "project").run({
			hasUI: true,
			ui: view,
		});
		expect(view.editor).toHaveBeenCalledWith(
			expect.stringContaining("untrusted"),
			expect.stringContaining("Reviewed release notes"),
		);
		expect(view.confirm).not.toHaveBeenCalled();
	});
	it("confirms preference changes, including direct off command", async () => {
		const f = fixture();
		const view = ui();
		view.confirm.mockResolvedValueOnce(false);
		const command = new BridgeUpdateCommand(f.updates, () => "project");
		await command.run({ hasUI: true, ui: view }, "off");
		expect(f.storage.writeSettings).not.toHaveBeenCalled();
		await command.run({ hasUI: true, ui: view }, "off");
		expect(f.storage.writeSettings).toHaveBeenCalledWith({
			version: 1,
			enabled: false,
		});
		expect(f.fetcher).not.toHaveBeenCalled();
	});
	it("does not show a command after declined confirmation or shutdown", async () => {
		const f = fixture();
		const view = ui();
		view.select.mockResolvedValueOnce("Show upgrade command");
		view.confirm.mockImplementation(async () => {
			f.updates.stop();
			return true;
		});
		await new BridgeUpdateCommand(f.updates, () => "project").run({
			hasUI: true,
			ui: view,
		});
		expect(view.notify).not.toHaveBeenCalled();
	});
	it("avoids network and dialogs in noninteractive mode", async () => {
		const f = fixture();
		const view = ui();
		await new BridgeUpdateCommand(f.updates, () => "user").run({
			hasUI: false,
			ui: view,
		});
		expect(f.fetcher).not.toHaveBeenCalled();
		expect(view.select).not.toHaveBeenCalled();
	});
	it("only infers scope from this exact loaded official package's provenance", () => {
		const path = join(temp(), "index.ts");
		writeFileSync(path, "");
		const entry = {
			name: "tako-update",
			source: "extension",
			sourceInfo: {
				path,
				origin: "package",
				source: "git:github.com/TakonautHQ/tako-bridge@v0.4.20",
				scope: "project",
			},
		};
		expect(bridgeInstallScope([entry], pathToFileURL(path).href)).toBe(
			"project",
		);
		expect(
			bridgeInstallScope(
				[{ ...entry, sourceInfo: { ...entry.sourceInfo, scope: "user" } }],
				pathToFileURL(path).href,
			),
		).toBe("user");
		expect(
			bridgeInstallScope(
				[
					{
						...entry,
						sourceInfo: { ...entry.sourceInfo, source: "/local/checkout" },
					},
				],
				pathToFileURL(path).href,
			),
		).toBeNull();
		expect(
			bridgeInstallScope([entry, entry], pathToFileURL(path).href),
		).toBeNull();
	});
});
