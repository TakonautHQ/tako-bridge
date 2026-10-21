import { describe, expect, it, vi } from "vitest";

import {
	LIVE_WATCH_QUEUE_BYTES,
	LiveWatchBroadcaster,
	type LiveEvent,
	messageParts,
	safeText,
} from "../src/live-watch";

function harness(options: { append?: (events: LiveEvent[]) => Promise<any> } = {}) {
	let clock = 1_000_000;
	const sent: LiveEvent[][] = [];
	const append = vi.fn(async (_id: string, events: LiveEvent[]) => {
		sent.push(events);
		return options.append ? options.append(events) : { stop: null, watchers: [] };
	});
	const stop = vi.fn(async () => ({ ended: true }));
	const onWatchers = vi.fn();
	const onRequests = vi.fn();
	const onEnded = vi.fn();
	const broadcaster = new LiveWatchBroadcaster({
		watchId: "w-1",
		transport: { append, stop },
		onWatchers,
		onRequests,
		onEnded,
		now: () => clock,
	});
	return {
		broadcaster,
		sent,
		append,
		stop,
		onWatchers,
		onRequests,
		onEnded,
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const assistant = (text: string, thinking = "") => ({
	role: "assistant",
	content: [
		...(thinking ? [{ type: "thinking", thinking }] : []),
		{ type: "text", text },
		{ type: "toolCall", id: "c1", name: "read", arguments: { path: "/x/secret.ts" } },
	],
});

describe("what is shared", () => {
	it("sends a tool call as one line: file name, never the path or the result", async () => {
		const h = harness();
		h.broadcaster.toolStart("c1", "read", { path: "/home/ada/app/refunds.py" });
		h.advance(120);
		h.broadcaster.toolEnd("c1", "read", false);
		await h.broadcaster.flush();
		const [running, done] = h.sent[0];
		expect(running).toMatchObject({ type: "tool", status: "running", summary: "read refunds.py" });
		expect(done).toMatchObject({ type: "tool", status: "ok", duration_ms: 120 });
		expect(JSON.stringify(h.sent)).not.toContain("/home/ada");
	});

	it("reports a failed tool by status only", async () => {
		const h = harness();
		h.broadcaster.toolStart("c2", "bash", { command: "pytest tests/refunds" });
		h.broadcaster.toolEnd("c2", "bash", true);
		await h.broadcaster.flush();
		const done = h.sent[0][1];
		expect(done).toMatchObject({ status: "error", summary: "bash: pytest tests/refunds" });
		expect(Object.keys(done).sort()).toEqual(["duration_ms", "id", "name", "seq", "status", "summary", "type"]);
	});

	it("redacts commands and prompts", async () => {
		const h = harness();
		const token = `ghp_${"A".repeat(36)}`;
		h.broadcaster.prompt(`use ${token} please`);
		h.broadcaster.toolStart("c3", "bash", { command: `curl -H "Authorization: Bearer ${token}" x` });
		await h.broadcaster.flush();
		expect(JSON.stringify(h.sent)).not.toContain(token);
	});

	it("skips nested tool calls", async () => {
		const h = harness();
		h.broadcaster.toolStart("c4/1", "read", { path: "a.ts" }, "c4");
		h.broadcaster.toolEnd("c4/1", "read", false, "c4");
		h.advance(20_000);
		await h.broadcaster.flush();
		expect(h.sent).toEqual([[]]); // only the keepalive
	});

	it("shares a user message's text and only the number of its images", async () => {
		const h = harness();
		h.broadcaster.userMessage({
			role: "user",
			content: [
				{ type: "text", text: "Why does this fail?" },
				{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
			],
		});
		await h.broadcaster.flush();
		expect(h.sent[0][0]).toMatchObject({ type: "prompt", text: "Why does this fail?", images: 1 });
		expect(JSON.stringify(h.sent)).not.toContain("iVBORw0KGgo");
	});

	it("takes text and thinking from a message, never tool-call arguments", () => {
		expect(messageParts(assistant("Fixing it", "The key is per retry"))).toEqual({
			text: "Fixing it",
			thinking: "The key is per retry",
		});
	});

	it("redacts before clipping so no prefix of a secret survives", () => {
		const token = `ghp_${"B".repeat(36)}`;
		const clipped = safeText(`${"x".repeat(80)} ${token}`, 100);
		expect(clipped).not.toContain("ghp_");
		expect(clipped).toContain("[REDACTED]");
	});
});

describe("streaming", () => {
	it("sends only the newest snapshot of a streaming message per flush", async () => {
		const h = harness();
		h.broadcaster.messageStart();
		h.broadcaster.message(assistant("Fix"), false);
		h.broadcaster.message(assistant("Fixing"), false);
		h.broadcaster.message(assistant("Fixing it"), false);
		await h.broadcaster.flush();
		expect(h.sent[0]).toEqual([
			expect.objectContaining({ type: "message", id: "m1", text: "Fixing it", final: false }),
		]);
		h.broadcaster.message(assistant("Fixing it now."), true);
		await h.broadcaster.flush();
		expect(h.sent[1]).toEqual([
			expect.objectContaining({ type: "message", id: "m1", text: "Fixing it now.", final: true }),
		]);
	});

	it("keeps order: the message so far comes before a tool that starts mid-stream", async () => {
		const h = harness();
		h.broadcaster.messageStart();
		h.broadcaster.message(assistant("Reading"), false);
		h.broadcaster.toolStart("c1", "read", { path: "a.ts" });
		await h.broadcaster.flush();
		expect(h.sent[0].map((e) => e.type)).toEqual(["message", "tool"]);
		const seqs = h.sent[0].map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
	});
});

describe("relay", () => {
	it("sends a keepalive when idle and reports watchers", async () => {
		const watchers = [{ id: "u2", name: "Ben" }];
		const h = harness({ append: async () => ({ stop: null, watchers }) });
		await h.broadcaster.flush();
		expect(h.append).not.toHaveBeenCalled();
		h.advance(15_000);
		await h.broadcaster.flush();
		expect(h.sent).toEqual([[]]);
		expect(h.onWatchers).toHaveBeenCalledWith(watchers);
	});

	it("ends when Takonaut says so and sends nothing more", async () => {
		const h = harness({ append: async () => ({ stop: "disabled", watchers: [] }) });
		h.broadcaster.prompt("hi");
		await h.broadcaster.flush();
		expect(h.onEnded).toHaveBeenCalledWith("disabled", true);
		h.broadcaster.prompt("again");
		h.advance(60_000);
		await h.broadcaster.flush();
		expect(h.append).toHaveBeenCalledTimes(1);
		expect(h.broadcaster.live).toBe(false);
	});

	it("ends on a final server error", async () => {
		const h = harness({
			append: async () => {
				throw new Error("live_watch:watch_not_found");
			},
		});
		h.broadcaster.prompt("hi");
		await h.broadcaster.flush();
		expect(h.onEnded).toHaveBeenCalledWith("watch_not_found", true);
	});

	it("keeps events after a transient failure and sends them next time", async () => {
		let fail = true;
		const h = harness({
			append: async () => {
				if (fail) throw new Error("network");
				return { stop: null, watchers: [] };
			},
		});
		h.broadcaster.prompt("first");
		await h.broadcaster.flush();
		fail = false;
		h.broadcaster.prompt("second");
		await h.broadcaster.flush();
		expect(h.sent[1].map((e) => (e.type === "prompt" ? e.text : ""))).toEqual(["first", "second"]);
	});

	it("drops the oldest events past the queue limit and marks a gap", async () => {
		const h = harness({
			append: async () => {
				throw new Error("network");
			},
		});
		for (let i = 0; i < 40; i += 1) h.broadcaster.prompt(`${i} ${"x".repeat(15_000)}`);
		await h.broadcaster.flush();
		const queued = JSON.stringify(h.sent[0]).length;
		expect(queued).toBeLessThanOrEqual(LIVE_WATCH_QUEUE_BYTES + 1024);
		expect(h.sent[0][0]).toMatchObject({ type: "status", state: "gap" });
	});

	it("splits batches at the event limit", async () => {
		const h = harness();
		for (let i = 0; i < 250; i += 1) h.broadcaster.status("working");
		await h.broadcaster.flush();
		await h.broadcaster.flush();
		expect(h.sent.map((batch) => batch.length)).toEqual([200, 50]);
	});

	it("stop tells Takonaut once and ends locally", async () => {
		const h = harness();
		await h.broadcaster.stop("shutdown");
		await h.broadcaster.stop("shutdown");
		expect(h.stop).toHaveBeenCalledTimes(1);
		expect(h.stop).toHaveBeenCalledWith("w-1", "shutdown");
		expect(h.onEnded).toHaveBeenCalledWith("shutdown", false);
	});
});

describe("requests to watch", () => {
	it("hands on the server's pending requests after each relay", async () => {
		const requests = [{ id: "r-1", requester: { id: "u3", name: "Ana" } }];
		const h = harness({ append: async () => ({ stop: null, watchers: [], requests }) });
		h.broadcaster.status("idle");
		await h.broadcaster.flush();
		expect(h.onRequests).toHaveBeenCalledWith(requests);
	});
});
