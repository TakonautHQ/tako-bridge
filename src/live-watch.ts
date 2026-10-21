import { describeToolCall } from "./agent-metrics";
import { redactSensitiveValues } from "./redaction";

/**
 * Live watch: a read-only broadcast of this Pi session to teammates the
 * author chose (`/tako-watch`). Bridge sends prompts, the agent's replies and
 * thinking, one line per tool call (tool, file name, redacted command,
 * status) and turn usage. Tool results, file contents, command output and
 * tool error text never leave the machine: no event below has a field for
 * them. Takonaut redacts every string again and keeps content only in a short
 * relay buffer while the broadcast is live.
 */

export const LIVE_WATCH_FLUSH_MS = 1_000;
export const LIVE_WATCH_QUEUE_BYTES = 256 * 1024;

export interface LiveWatchLimits {
	batch_bytes: number;
	batch_events: number;
	message_chars: number;
	thinking_chars: number;
	prompt_chars: number;
	keepalive_seconds: number;
	max_seconds: number;
}

export const DEFAULT_LIVE_WATCH_LIMITS: LiveWatchLimits = {
	batch_bytes: 256 * 1024,
	batch_events: 200,
	message_chars: 32 * 1024,
	thinking_chars: 8 * 1024,
	prompt_chars: 16 * 1024,
	keepalive_seconds: 15,
	max_seconds: 8 * 60 * 60,
};

export interface Watcher {
	id: string;
	name: string;
}

export type LiveEvent =
	| { seq: number; type: "prompt"; text: string; images: number }
	| {
			seq: number;
			type: "message";
			id: string;
			text: string;
			thinking: string;
			final: boolean;
	  }
	| {
			seq: number;
			type: "tool";
			id: string;
			name: string;
			summary: string;
			status: "running" | "ok" | "error";
			duration_ms: number;
	  }
	| {
			seq: number;
			type: "turn";
			model: string;
			tokens_in: number;
			tokens_out: number;
			cost_usd: number;
	  }
	| {
			seq: number;
			type: "status";
			state: "working" | "idle" | "compacted" | "gap";
			detail: string;
	  };

export interface LiveWatchTransport {
	append(
		watchId: string,
		events: LiveEvent[],
	): Promise<{ stop: string | null; watchers: Watcher[]; requests?: unknown[] }>;
	stop(watchId: string, reason: string): Promise<unknown>;
}

export interface BroadcasterOptions {
	watchId: string;
	transport: LiveWatchTransport;
	limits?: LiveWatchLimits;
	/** Who is watching changed (also called on every successful flush). */
	onWatchers?(watchers: Watcher[]): void;
	/** Teammates' pending requests to watch (the server's current list). */
	onRequests?(requests: unknown[]): void;
	/** The broadcast ended: stopped here, or by Takonaut with its reason. */
	onEnded?(reason: string, byServer: boolean): void;
	now?(): number;
	flushMs?: number;
}

const TRUNCATED = "\n[truncated]";
// Server error codes that mean the broadcast is gone for good.
const FINAL_ERRORS = /live_watch:(watch_not_found|watch_ended|live_watch_disabled)/;

/** Redact first, then clip: clipping first could cut a secret so it no
 * longer matches a redaction pattern. */
export function safeText(value: unknown, limit: number): string {
	const text = redactSensitiveValues(typeof value === "string" ? value : "");
	return text.length > limit
		? `${text.slice(0, Math.max(0, limit - TRUNCATED.length))}${TRUNCATED}`
		: text;
}

interface ContentBlock {
	type?: string;
	text?: unknown;
	thinking?: unknown;
}

/** The visible text and the thinking of an assistant message's content. */
export function messageParts(message: unknown): {
	text: string;
	thinking: string;
} {
	const content = (message as { content?: unknown } | null)?.content;
	const blocks: ContentBlock[] = Array.isArray(content) ? content : [];
	const join = (kind: "text" | "thinking") =>
		blocks
			.filter((block) => block?.type === kind)
			.map((block) => (typeof block[kind] === "string" ? block[kind] : ""))
			.join("");
	return { text: join("text"), thinking: join("thinking") };
}

function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function number(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: 0;
}

export class LiveWatchBroadcaster {
	private queue: LiveEvent[] = [];
	private queueBytes = 0;
	// The newest unsent snapshot of the streaming message: materialized at
	// flush (or before any later event), so per-token updates stay cheap.
	private streaming: { id: string; message: unknown } | null = null;
	private seq = 0;
	private messages = 0;
	private currentMessage: string | null = null;
	private readonly toolStarts = new Map<
		string,
		{ at: number; name: string; args: unknown }
	>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private flushing = false;
	private ended = false;
	private lastSent: number;
	private gapPending = false;
	private readonly limits: LiveWatchLimits;
	private readonly now: () => number;

	constructor(private readonly options: BroadcasterOptions) {
		this.limits = options.limits ?? DEFAULT_LIVE_WATCH_LIMITS;
		this.now = options.now ?? Date.now;
		this.lastSent = this.now();
	}

	get watchId(): string {
		return this.options.watchId;
	}

	get live(): boolean {
		return !this.ended;
	}

	start(): void {
		if (this.timer || this.ended) return;
		this.timer = setInterval(
			() => void this.flush(),
			this.options.flushMs ?? LIVE_WATCH_FLUSH_MS,
		);
		this.timer.unref?.();
	}

	// ------------------------------------------------------------- capture

	/** A user message as the agent receives it (typed, steered or queued). */
	userMessage(message: unknown): void {
		const content = (message as { content?: unknown } | null)?.content;
		if (typeof content === "string") {
			this.prompt(content);
			return;
		}
		const blocks: ContentBlock[] = Array.isArray(content) ? content : [];
		const text = blocks
			.filter((block) => block?.type === "text" && typeof block.text === "string")
			.map((block) => block.text as string)
			.join("");
		this.prompt(text, blocks.filter((block) => block?.type === "image").length);
	}

	prompt(text: string, images = 0): void {
		this.push({
			seq: 0,
			type: "prompt",
			text: safeText(text, this.limits.prompt_chars),
			images: number(images),
		});
	}

	messageStart(): void {
		this.messages += 1;
		this.currentMessage = `m${this.messages}`;
	}

	/** A streamed (or final) snapshot of the current assistant message. */
	message(message: unknown, final: boolean): void {
		if (this.ended) return;
		if (!this.currentMessage) this.messageStart();
		const id = this.currentMessage as string;
		if (!final) {
			this.streaming = { id, message };
			return;
		}
		this.streaming = null;
		this.pushMessage(id, message, true);
		this.currentMessage = null;
	}

	private pushMessage(id: string, message: unknown, final: boolean): void {
		const parts = messageParts(message);
		this.enqueue({
			seq: 0,
			type: "message",
			id,
			text: safeText(parts.text, this.limits.message_chars),
			thinking: safeText(parts.thinking, this.limits.thinking_chars),
			final,
		});
	}

	private materializeStreaming(): void {
		const pending = this.streaming;
		if (!pending) return;
		this.streaming = null;
		this.pushMessage(pending.id, pending.message, false);
	}

	toolStart(id: string, name: string, args: unknown, parentId?: string): void {
		if (parentId) return; // nested calls (e.g. codemode) are not shown
		this.toolStarts.set(id, { at: this.now(), name, args });
		this.push({
			seq: 0,
			type: "tool",
			id,
			name: safeText(name, 80),
			summary: safeText(describeToolCall(name, args), 200),
			status: "running",
			duration_ms: 0,
		});
	}

	/** Only the outcome: the result and any error text stay local. */
	toolEnd(id: string, name: string, isError: boolean, parentId?: string): void {
		if (parentId) return;
		const started = this.toolStarts.get(id);
		this.toolStarts.delete(id);
		this.push({
			seq: 0,
			type: "tool",
			id,
			name: safeText(started?.name ?? name, 80),
			summary: safeText(describeToolCall(started?.name ?? name, started?.args), 200),
			status: isError ? "error" : "ok",
			duration_ms: started ? Math.max(0, this.now() - started.at) : 0,
		});
	}

	turn(message: unknown): void {
		const m = (message ?? {}) as {
			model?: unknown;
			usage?: { input?: unknown; output?: unknown; cost?: { total?: unknown } };
		};
		this.push({
			seq: 0,
			type: "turn",
			model: safeText(m.model, 120),
			tokens_in: number(m.usage?.input),
			tokens_out: number(m.usage?.output),
			cost_usd: number(m.usage?.cost?.total),
		});
	}

	status(state: "working" | "idle" | "compacted", detail = ""): void {
		this.push({ seq: 0, type: "status", state, detail: safeText(detail, 200) });
	}

	private push(event: LiveEvent): void {
		if (this.ended) return;
		// Keep order: the streaming message so far comes before this event.
		this.materializeStreaming();
		this.enqueue(event);
	}

	private enqueue(event: LiveEvent): void {
		this.seq += 1;
		const numbered = { ...event, seq: this.seq } as LiveEvent;
		this.queue.push(numbered);
		this.queueBytes += bytes(numbered);
		this.enforceQueueLimit();
	}

	private shift(): LiveEvent | undefined {
		const first = this.queue.shift();
		if (first) this.queueBytes -= bytes(first);
		return first;
	}

	/** Never block the session: past the limit, drop the oldest events and
	 * tell watchers something is missing. */
	private enforceQueueLimit(): void {
		while (this.queueBytes > LIVE_WATCH_QUEUE_BYTES && this.queue.length > 1) {
			this.shift();
			this.gapPending = true;
		}
	}

	// -------------------------------------------------------------- relay

	private takeBatch(): LiveEvent[] {
		const batch: LiveEvent[] = [];
		let size = 2;
		while (this.queue.length && batch.length < this.limits.batch_events) {
			const next = this.queue[0];
			const nextSize = bytes(next) + 1;
			if (batch.length && size + nextSize > this.limits.batch_bytes) break;
			batch.push(next);
			size += nextSize;
			this.shift();
		}
		return batch;
	}

	async flush(): Promise<void> {
		if (this.flushing || this.ended) return;
		this.materializeStreaming();
		if (this.gapPending) {
			this.gapPending = false;
			this.seq += 1;
			const gap: LiveEvent = {
				seq: this.seq,
				type: "status",
				state: "gap",
				detail: "Some events could not be sent.",
			};
			this.queue.unshift(gap);
			this.queueBytes += bytes(gap);
		}
		const keepaliveDue =
			this.now() - this.lastSent >= this.limits.keepalive_seconds * 1000;
		if (!this.queue.length && !keepaliveDue) return;
		this.flushing = true;
		const batch = this.takeBatch();
		try {
			const result = await this.options.transport.append(this.watchId, batch);
			this.lastSent = this.now();
			if (result.stop) {
				this.finish(result.stop, true);
				return;
			}
			this.options.onWatchers?.(result.watchers ?? []);
			this.options.onRequests?.(result.requests ?? []);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (FINAL_ERRORS.test(message)) {
				this.finish(FINAL_ERRORS.exec(message)?.[1] ?? "ended", true);
				return;
			}
			// Try again on the next tick; the queue limit bounds what we keep.
			this.queue = [...batch, ...this.queue];
			for (const event of batch) this.queueBytes += bytes(event);
			this.enforceQueueLimit();
		} finally {
			this.flushing = false;
		}
	}

	/** Stop broadcasting from this side (command, session end or switch). */
	async stop(reason: "stopped" | "shutdown" | "session_switch"): Promise<void> {
		if (this.ended) return;
		this.finish(reason, false);
		try {
			await this.options.transport.stop(this.watchId, reason);
		} catch {
			// Takonaut also ends a silent broadcast within two minutes.
		}
	}

	private finish(reason: string, byServer: boolean): void {
		this.ended = true;
		this.queue = [];
		this.queueBytes = 0;
		this.streaming = null;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.options.onEnded?.(reason, byServer);
	}
}
