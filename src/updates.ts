import { createUpdateStorage, type UpdateStorage } from "./update-storage.js";
import { BRIDGE_VERSION } from "./version.js";

export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const UPDATE_API_URL =
	"https://api.github.com/repos/TakonautHQ/tako-bridge/releases/latest";
const STABLE_TAG = /^v?(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export interface BridgeRelease {
	tag: string;
	version: string;
	notes: string;
}
interface UpdateCache {
	checkedAt: number;
	nextCheckAt: number;
	retryAfter: number;
	release: BridgeRelease | null;
}
export interface UpdateSnapshot {
	enabled: boolean;
	release: BridgeRelease | null;
	availableVersion?: string;
	checkedAt: number | null;
	stale: boolean;
	unavailable: boolean;
}
interface UpdateDependencies {
	fetch?: typeof fetch;
	storage?: UpdateStorage;
	now?: () => number;
	version?: string;
}
function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function cleanNotes(text: string): string {
	return text
		.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "")
		.replace(
			/[\x00-\x08\x0b-\x1f\x7f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
			"",
		)
		.slice(0, 6000);
}
export function parseBridgeRelease(value: unknown): BridgeRelease | null {
	if (
		!record(value) ||
		value.draft !== false ||
		value.prerelease !== false ||
		typeof value.tag_name !== "string" ||
		!STABLE_TAG.test(value.tag_name)
	)
		return null;
	return {
		tag: value.tag_name,
		version: value.tag_name.replace(/^v/, ""),
		notes: typeof value.body === "string" ? cleanNotes(value.body) : "",
	};
}
export function isNewerBridgeRelease(tag: string, installed: string): boolean {
	const next = STABLE_TAG.exec(tag);
	const current =
		/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(
			installed,
		);
	if (!next || !current) return false;
	for (let i = 1; i <= 3; i++) {
		if (Number(next[i]) !== Number(current[i]))
			return Number(next[i]) > Number(current[i]);
	}
	return Boolean(current[4]); // stable is newer than a prerelease of the same version
}
export function bridgeReleaseUrl(release: BridgeRelease): string {
	if (!STABLE_TAG.test(release.tag)) throw new Error("Invalid release tag");
	return `https://github.com/TakonautHQ/tako-bridge/releases/tag/${release.tag}`;
}
export function bridgeUpgradeCommand(
	release: BridgeRelease,
	scope: "project" | "user",
): string {
	if (!STABLE_TAG.test(release.tag)) throw new Error("Invalid release tag");
	return `pi install git:github.com/TakonautHQ/tako-bridge@${release.tag}${scope === "project" ? " -l" : ""}`;
}

async function boundedReleaseBody(response: Response): Promise<unknown> {
	if (
		!response.body ||
		Number(response.headers.get("content-length")) > 64 * 1024
	) {
		await response.body?.cancel();
		throw new Error("Invalid release response");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.length;
			if (size > 64 * 1024) throw new Error("Oversized release response");
			chunks.push(next.value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

/** Background read-only release discovery. Never calls gh, a model, or an installer. */
export class BridgeUpdates {
	private readonly storage: UpdateStorage;
	private readonly fetcher: typeof fetch;
	private readonly now: () => number;
	private readonly version: string;
	private cache: UpdateCache = {
		checkedAt: 0,
		nextCheckAt: 0,
		retryAfter: 0,
		release: null,
	};
	private enabled = true;
	private unavailable = false;
	private initialized = false;
	private active = false;
	private generation = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private abort?: AbortController;
	private pending?: Promise<void>;
	private changed?: () => void;

	constructor(deps: UpdateDependencies = {}) {
		this.storage = deps.storage ?? createUpdateStorage();
		this.fetcher = deps.fetch ?? ((...args) => fetch(...args));
		this.now = deps.now ?? Date.now;
		this.version = deps.version ?? BRIDGE_VERSION;
	}
	get epoch(): number {
		return this.generation;
	}
	get installedVersion(): string {
		return this.version;
	}

	private readEnabled(): boolean {
		try {
			const value = this.storage.readSettings();
			if (value === undefined) return true;
			if (
				record(value) &&
				value.version === 1 &&
				typeof value.enabled === "boolean"
			)
				return value.enabled;
		} catch {
			/* Unsafe/unreadable settings fail closed, without network access. */
		}
		this.unavailable = true;
		return false;
	}

	private initialize(): void {
		if (this.initialized) return;
		this.initialized = true;
		this.enabled = this.readEnabled();
		try {
			const value = this.storage.readCache();
			const now = this.now();
			if (
				!record(value) ||
				value.version !== 1 ||
				![value.checkedAt, value.nextCheckAt, value.retryAfter].every(
					(n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
				) ||
				Number(value.checkedAt) > now ||
				Number(value.nextCheckAt) > now + MAX_BACKOFF_MS ||
				Number(value.retryAfter) > now + MAX_BACKOFF_MS
			)
				return;
			let release: BridgeRelease | null = null;
			if (record(value.release))
				release = parseBridgeRelease({
					tag_name: value.release.tag,
					body: value.release.notes,
					draft: false,
					prerelease: false,
				});
			this.cache = {
				checkedAt: Number(value.checkedAt),
				nextCheckAt: Number(value.nextCheckAt),
				retryAfter: Number(value.retryAfter),
				release,
			};
		} catch {
			/* Corrupt cache is expendable. Settings are stored separately. */
		}
	}

	snapshot(): UpdateSnapshot {
		this.initialize();
		const release =
			this.cache.release && this.now() - this.cache.checkedAt < MAX_CACHE_AGE_MS
				? { ...this.cache.release }
				: null;
		return {
			enabled: this.enabled,
			release,
			...(this.enabled &&
			release &&
			isNewerBridgeRelease(release.tag, this.version)
				? { availableVersion: release.version }
				: {}),
			checkedAt: this.cache.checkedAt || null,
			stale: this.now() - this.cache.checkedAt >= UPDATE_INTERVAL_MS,
			unavailable: this.unavailable,
		};
	}

	start(changed: () => void): void {
		this.stop();
		this.active = true;
		this.initialized = false;
		this.changed = changed;
		this.initialize();
		this.notify();
		void this.check();
	}
	stop(): void {
		this.generation += 1;
		this.active = false;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.abort?.abort();
		this.abort = undefined;
		this.pending = undefined;
		this.changed = undefined;
	}
	private notify(): void {
		try {
			this.changed?.();
		} catch {
			/* Panel failures cannot fail a version check. */
		}
	}
	private schedule(): void {
		clearTimeout(this.timer);
		if (!this.active || !this.enabled) return;
		this.timer = setTimeout(
			() => void this.check(),
			Math.max(1000, this.cache.nextCheckAt - this.now()),
		);
		this.timer.unref?.();
	}

	setEnabled(enabled: boolean): void {
		this.initialize();
		// Only explicit user actions write settings, never a background cache write.
		this.storage.writeSettings({ version: 1, enabled });
		this.enabled = enabled;
		this.generation += 1;
		this.abort?.abort();
		this.pending = undefined;
		clearTimeout(this.timer);
		this.notify();
		if (enabled) void this.check();
	}

	/** force is an explicit one-shot request; it does not enable background checks. */
	async check(force = false): Promise<void> {
		this.initialize();
		this.enabled = this.readEnabled();
		if ((!this.enabled && !force) || this.now() < this.cache.retryAfter) {
			this.schedule();
			this.notify();
			return;
		}
		if (!force && this.cache.nextCheckAt > this.now()) {
			this.schedule();
			return;
		}
		if (this.pending) return this.pending;
		const epoch = this.generation;
		const job = this.request(epoch);
		this.pending = job;
		try {
			await job;
		} finally {
			if (epoch === this.generation) {
				this.pending = undefined;
				this.schedule();
			}
		}
	}

	private async request(epoch: number): Promise<void> {
		const abort = new AbortController();
		this.abort = abort;
		const timeout = setTimeout(() => abort.abort(), 10_000);
		timeout.unref?.();
		let release: BridgeRelease | null = null;
		let retryAfter = 0;
		try {
			const response = await this.fetcher(UPDATE_API_URL, {
				signal: abort.signal,
				redirect: "error",
				credentials: "omit",
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});
			if (response.status === 403 || response.status === 429) {
				const header = response.headers.get("retry-after") ?? "";
				const seconds = Number(header);
				const retryAt = Number.isFinite(seconds)
					? this.now() + seconds * 1000
					: Date.parse(header);
				const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
				retryAfter = Math.min(
					this.now() + MAX_BACKOFF_MS,
					Math.max(
						this.now() + UPDATE_INTERVAL_MS,
						Number.isFinite(retryAt) ? retryAt : 0,
						Number.isFinite(reset) ? reset : 0,
					),
				);
			}
			if (!response.ok) {
				await response.body?.cancel();
				throw new Error("Release unavailable");
			}
			release = parseBridgeRelease(await boundedReleaseBody(response));
		} catch {
			/* Offline, denied, malformed and timed-out checks are quiet. */
		} finally {
			clearTimeout(timeout);
		}
		if (epoch !== this.generation) return;
		if (abort.signal.aborted) release = null;
		this.unavailable = !release;
		const now = this.now();
		this.cache = {
			checkedAt: release ? now : this.cache.checkedAt,
			nextCheckAt: Math.max(now + UPDATE_INTERVAL_MS, retryAfter),
			retryAfter,
			release: release ?? this.cache.release,
		};
		try {
			this.storage.writeCache({ version: 1, ...this.cache });
		} catch {
			/* An in-memory cache still avoids a retry loop. */
		}
		this.notify();
	}
}
