import { describe, expect, it, vi } from "vitest";

import {
	LIVE_WATCH_DISCLOSURE,
	registerLiveWatchCommands,
} from "../src/live-watch-commands";

type Handler = (args: string, ctx: unknown) => Promise<void>;

function harness(
	options: {
		start?: (args: Record<string, unknown>) => unknown;
		confirm?: boolean;
		select?: string[];
		input?: (string | undefined)[];
		hasUI?: boolean;
		appendRequests?: unknown[];
		decide?: (args: Record<string, unknown>) => unknown;
	} = {},
) {
	const commands = new Map<string, Handler>();
	const events = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			events.set(name, handler),
		registerCommand: (name: string, definition: { handler: Handler }) =>
			commands.set(name, definition.handler),
	};
	const appended: unknown[][] = [];
	const callTool = vi.fn(async (name: string, args: Record<string, unknown>) => {
		if (name === "start_live_watch") {
			if (options.start) return options.start(args);
			return {
				watch_id: "w-1",
				watch_url: "https://takonaut.app/bridge/watch/w-1",
				project_key: "PAY",
				task_key: "PAY-12",
			};
		}
		if (name === "append_live_watch_events") {
			appended.push(args.events as unknown[]);
			return {
				stop: null,
				watchers: [{ id: "u2", name: "Ben" }],
				requests: options.appendRequests ?? [],
			};
		}
		if (name === "decide_live_watch_request") {
			if (options.decide) return options.decide(args);
			return { status: args.decision === "decline" ? "declined" : "allowed" };
		}
		if (name === "set_live_watch_viewers") return { watchers: [] };
		if (name === "stop_live_watch") return { ended: true };
		throw new Error(`unexpected ${name}`);
	});
	let session = "pi-1";
	const liveWatch = registerLiveWatchCommands(pi as never, {
		connection: () => ({ callTool }) as never,
		sessionKey: () => session,
		run: async (_command: string, args: string[]) => {
			const stdout = args.includes("--abbrev-ref")
				? "feat/pay-12\n"
				: args.includes("HEAD")
					? `${"a".repeat(40)}\n`
					: "";
			return { stdout, stderr: "", exitCode: 0 };
		},
		cwd: () => "/tmp",
	});
	const selects = [...(options.select ?? ["Everyone in the Project"])];
	const inputs = [...(options.input ?? [])];
	const ctx = {
		hasUI: options.hasUI ?? true,
		model: { id: "claude-test" },
		ui: {
			notify: vi.fn(),
			setStatus: vi.fn(),
			confirm: vi.fn(async () => options.confirm ?? true),
			select: vi.fn(async () => selects.shift()),
			input: vi.fn(async () => inputs.shift()),
		},
	};
	const emit = (name: string, event: unknown = {}) => events.get(name)?.(event, ctx);
	return {
		run: (args = "") => commands.get("tako-watch")?.(args, ctx) as Promise<void>,
		emit,
		receive: (requests: unknown, key = session) => liveWatch.receiveRequests(key, requests),
		ctx,
		callTool,
		appended,
		switchSession: (key: string) => {
			session = key;
		},
		calls: (name: string) => callTool.mock.calls.filter(([n]) => n === name).map(([, a]) => a),
	};
}

async function flushViaIdle(h: ReturnType<typeof harness>) {
	await h.emit("agent_end");
	await vi.waitFor(() => expect(h.appended.length).toBeGreaterThan(0));
}

describe("/tako-watch", () => {
	it("discloses what is shared before anything starts", async () => {
		const h = harness({ confirm: false });
		await h.run();
		expect(h.ctx.ui.confirm).toHaveBeenCalledWith("Broadcast this session live?", LIVE_WATCH_DISCLOSURE);
		expect(LIVE_WATCH_DISCLOSURE).toContain("Not shared: tool output, file contents");
		expect(h.calls("start_live_watch")).toEqual([]);
	});

	it("starts for the whole Project with branch and model, and shows it in the footer", async () => {
		const h = harness();
		await h.run();
		expect(h.calls("start_live_watch")).toEqual([
			{
				pi_session_id: "pi-1",
				project_key: "",
				visibility: "project",
				recipient_emails: [],
				branch_name: "feat/pay-12",
				model: "claude-test",
			},
		]);
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("tako-watch", "● Live · 0 watching");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("https://takonaut.app/bridge/watch/w-1"),
			"info",
		);
		await h.run("stop");
	});

	it("names people when asked", async () => {
		const h = harness({ select: ["Specific people"], input: ["Ana@Takonaut.test, bo@takonaut.test"] });
		await h.run();
		expect(h.calls("start_live_watch")[0]).toMatchObject({
			visibility: "people",
			recipient_emails: ["ana@takonaut.test", "bo@takonaut.test"],
		});
		await h.run("stop");
	});

	it("asks for a Project when the session has no linked Task", async () => {
		let first = true;
		const h = harness({
			input: ["PAY"],
			start: (args) => {
				if (first) {
					first = false;
					throw new Error("live_watch:project_required");
				}
				return { watch_id: "w-2", watch_url: "u", project_key: args.project_key, task_key: null };
			},
		});
		await h.run();
		expect(h.calls("start_live_watch").map((a) => a.project_key)).toEqual(["", "PAY"]);
		await h.run("stop");
	});

	it("explains a disabled Project", async () => {
		const h = harness({
			start: () => {
				throw new Error("live_watch:live_watch_disabled");
			},
		});
		await h.run("--project PAY");
		expect(h.calls("start_live_watch")[0].project_key).toBe("PAY");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Live watch is off"), "error");
	});

	it("refuses without an interactive UI", async () => {
		const h = harness({ hasUI: false });
		await h.run();
		expect(h.calls("start_live_watch")).toEqual([]);
	});

	it("relays only while live, and reports who joined", async () => {
		const h = harness();
		await h.emit("message_start", { message: { role: "user", content: "before" } });
		await h.run();
		await h.emit("message_start", { message: { role: "user", content: "make refunds idempotent" } });
		await h.emit("tool_execution_start", { toolCallId: "c1", toolName: "read", args: { path: "/a/refunds.py" } });
		await h.emit("tool_execution_end", { toolCallId: "c1", toolName: "read", isError: false, result: { content: "SECRET BODY" } });
		await flushViaIdle(h);
		const sent = JSON.stringify(h.appended);
		expect(sent).toContain("make refunds idempotent");
		expect(sent).toContain("read refunds.py");
		expect(sent).not.toContain("before");
		expect(sent).not.toContain("SECRET BODY");
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Now watching: Ben", "info");
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("tako-watch", "● Live · 1 watching");
		await h.run("stop");
		expect(h.calls("stop_live_watch")).toEqual([{ watch_id: "w-1", reason: "stopped" }]);
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("tako-watch", undefined);
	});

	it("manages a live broadcast: change who may watch, then stop", async () => {
		const h = harness({ select: ["Everyone in the Project", "Change who may watch", "Specific people", "Stop broadcasting"], input: ["ana@takonaut.test"] });
		await h.run();
		await h.run();
		expect(h.calls("set_live_watch_viewers")).toEqual([
			{ watch_id: "w-1", visibility: "people", recipient_emails: ["ana@takonaut.test"] },
		]);
		await h.run();
		expect(h.calls("stop_live_watch")).toHaveLength(1);
	});

	it("ends when the session switches or shuts down", async () => {
		const h = harness();
		await h.run();
		h.switchSession("pi-2");
		await h.emit("session_start", {});
		expect(h.calls("stop_live_watch")).toEqual([{ watch_id: "w-1", reason: "session_switch" }]);
		const again = harness();
		await again.run();
		await again.emit("session_shutdown", { reason: "quit" });
		expect(again.calls("stop_live_watch")).toEqual([{ watch_id: "w-1", reason: "shutdown" }]);
	});
});

const ANA = {
	id: "r-1",
	requester: { id: "u3", name: "Ana" },
	project_key: "PAY",
	expires_at: "2026-10-21T10:10:00Z",
};

describe("requests to watch", () => {
	it("tells the author at once, and asks only when the agent pauses", async () => {
		const h = harness({ select: ["Allow Ana"] });
		await h.emit("session_start");
		h.receive([ANA]);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			"Ana asks to watch this session live. You'll be asked when the agent pauses, or run /tako-watch.",
			"info",
		);
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("tako-watch", "1 asking to watch · /tako-watch");
		expect(h.ctx.ui.select).not.toHaveBeenCalled();
		h.receive([ANA]); // the next heartbeat: no second notice
		expect(h.ctx.ui.notify).toHaveBeenCalledTimes(1);

		await h.emit("agent_end");
		await vi.waitFor(() => expect(h.calls("start_live_watch")).toHaveLength(1));
		expect(h.ctx.ui.select).toHaveBeenCalledWith("Ana asks to watch this session live, read-only.", [
			"Allow Ana",
			"Allow everyone in the Project",
			"Decline",
			"Decide later",
		]);
		// Not live yet: the same disclosure as /tako-watch, then a broadcast for her.
		expect(h.ctx.ui.confirm).toHaveBeenCalledWith("Broadcast this session live to Ana?", LIVE_WATCH_DISCLOSURE);
		expect(h.calls("start_live_watch")[0]).toMatchObject({
			pi_session_id: "pi-1",
			project_key: "PAY",
			visibility: "people",
			recipient_emails: [],
			request_id: "r-1",
		});
		expect(h.calls("decide_live_watch_request")).toEqual([]);
		await vi.waitFor(() =>
			expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("tako-watch", "● Live · 0 watching"),
		);
	});

	it("declining sends the decision and clears the footer", async () => {
		const h = harness({ select: ["Decline"] });
		await h.emit("session_start");
		h.receive([ANA]);
		await h.run();
		expect(h.calls("decide_live_watch_request")).toEqual([{ request_id: "r-1", decision: "decline" }]);
		expect(h.calls("start_live_watch")).toEqual([]);
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Declined Ana's request.", "info");
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("tako-watch", undefined);
	});

	it("while live, requests arrive with the relay and allowing needs no new broadcast", async () => {
		const h = harness({
			select: ["Everyone in the Project", "Allow everyone in the Project"],
			appendRequests: [ANA],
		});
		await h.run(); // start for the Project
		await flushViaIdle(h); // the relay's response brings the request
		await vi.waitFor(() =>
			expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("tako-watch", "● Live · 1 watching · 1 asking to watch"),
		);
		await h.emit("agent_end"); // the next pause asks
		await vi.waitFor(() => expect(h.calls("decide_live_watch_request")).toHaveLength(1));
		expect(h.calls("decide_live_watch_request")[0]).toEqual({ request_id: "r-1", decision: "allow_project" });
		expect(h.calls("start_live_watch")).toHaveLength(1);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Everyone in the Project may watch now.", "info");
	});

	it("decide later waits for /tako-watch", async () => {
		const h = harness({ select: ["Decide later", "Allow Ana"] });
		await h.emit("session_start");
		h.receive([ANA]);
		await h.emit("agent_end");
		await vi.waitFor(() => expect(h.ctx.ui.select).toHaveBeenCalledTimes(1));
		await h.emit("agent_end");
		await Promise.resolve();
		expect(h.ctx.ui.select).toHaveBeenCalledTimes(1);
		await h.run();
		expect(h.ctx.ui.select).toHaveBeenCalledTimes(2);
		expect(h.calls("start_live_watch")).toHaveLength(1);
	});

	it("an expired request is said to have expired", async () => {
		const h = harness({
			select: ["Decline"],
			decide: () => {
				throw new Error("live_watch:request_expired");
			},
		});
		await h.emit("session_start");
		h.receive([ANA]);
		await h.run();
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Ana's request has expired.", "info");
	});

	it("requests gone from the server are dropped", async () => {
		const h = harness();
		await h.emit("session_start");
		h.receive([ANA]);
		h.receive([]);
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("tako-watch", undefined);
		await h.emit("agent_end");
		expect(h.ctx.ui.select).not.toHaveBeenCalled();
	});

	it("ignores requests without an interactive UI or for another session", async () => {
		const quiet = harness({ hasUI: false });
		await quiet.emit("session_start");
		quiet.receive([ANA]);
		await quiet.emit("agent_end");
		expect(quiet.ctx.ui.notify).not.toHaveBeenCalled();
		expect(quiet.ctx.ui.select).not.toHaveBeenCalled();

		const h = harness();
		await h.emit("session_start");
		h.receive([ANA], "pi-other");
		expect(h.ctx.ui.notify).not.toHaveBeenCalled();
		h.receive([ANA]);
		h.switchSession("pi-2");
		await h.emit("session_start");
		expect(h.ctx.ui.setStatus).toHaveBeenLastCalledWith("tako-watch", undefined);
	});
});
