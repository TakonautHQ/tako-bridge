import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerHandoffCommands } from "../src/task-handoff-commands";

type Handler = (args: string, ctx: unknown) => Promise<void>;

function harness() {
	const commands = new Map<string, Handler>();
	const tools = new Map<string, any>();
	let active = ["read", "tako_read"];
	const events = new Map<string, (...args: unknown[]) => unknown>();
	const pi = {
		on: (name: string, handler: (...args: unknown[]) => unknown) =>
			events.set(name, handler),
		registerCommand: (name: string, options: { handler: Handler }) =>
			commands.set(name, options.handler),
		registerTool: vi.fn((definition: any) =>
			tools.set(definition.name, definition),
		),
		getActiveTools: () => [...active],
		setActiveTools: (names: string[]) => {
			active = [...names];
		},
		sendUserMessage: vi.fn((_text: string, _options?: unknown) => {}),
	};
	const callTool = vi.fn(
		async (name: string, args: Record<string, unknown>) => {
			if (name === "create_task_handoff")
				return { handoff_id: "h-1", redactions: 2, ...args };
			if (name === "list_task_handoffs")
				return {
					handoffs: ["h-1", "h-2"].map((handoff_id) => ({
						handoff_id,
						created_at: "2026-10-09T10:00:00Z",
						visibility: "project",
						preview: "Traced the rounding bug",
					})),
				};
			if (name === "get_task_handoff")
				return {
					handoff_id: "h-1",
					created_at: "2026-10-09T10:00:00Z",
					content: {
						summary: "Traced the rounding bug to roundCents.",
						decisions: ["Keep cents as integers"],
						plan: "Add tests.",
						open_questions: [],
						files: ["src/billing/invoice.ts"],
						repository: {
							remote: "github.com/takonaut/api",
							branch: "fix/rounding",
							commit: "a".repeat(40),
							dirty: false,
						},
					},
				};
			if (name === "withdraw_task_handoff") return { status: "withdrawn" };
			throw new Error(`unexpected ${name}`);
		},
	);
	const directory = mkdtempSync(join(tmpdir(), "tako-handoff-cmd-"));
	registerHandoffCommands(pi as never, {
		connection: () => ({ callTool }) as never,
		run: async () => ({ stdout: "", stderr: "", exitCode: 128 }),
		cwd: () => directory,
		activeTaskKey: () => null,
	});
	const sent: unknown[] = [];
	const ctx = {
		hasUI: true,
		ui: {
			notify: vi.fn(),
			editor: vi.fn(async (_title: string, text: string) => text),
			select: vi.fn(
				async (_title: string, _labels: string[]) => "Everyone in the Project",
			),
			input: vi.fn(async () => "ana@takonaut.test, bo@takonaut.test"),
			confirm: vi.fn(async (_title: string, _message: string) => true),
		},
		newSession: vi.fn(async (options: any) => {
			await options.withSession({
				sendMessage: async (message: unknown) => sent.push(message),
			});
			return { cancelled: false };
		}),
	};
	return {
		commands,
		events,
		tools,
		pi,
		callTool,
		ctx,
		sent,
		active: () => active,
		cleanup: () => rmSync(directory, { recursive: true, force: true }),
	};
}

const DRAFT = {
	summary: `Traced the bug. Token ghp_${"A".repeat(36)} was in a log.`,
	decisions: ["Keep cents as integers"],
	plan: "Add tests.",
	open_questions: ["Refunds?"],
	files: ["src/billing/invoice.ts"],
};

async function draft(h: ReturnType<typeof harness>, params = DRAFT) {
	const result = await h.tools
		.get("tako_handoff_draft")
		.execute("call-1", params, undefined, undefined, h.ctx);
	return JSON.parse(result.content[0].text);
}

let h: ReturnType<typeof harness>;
beforeEach(() => {
	h = harness();
});
afterEach(() => h.cleanup());

describe("/tako-handoff", () => {
	it("asks the agent for a draft, then shares the reviewed pack", async () => {
		await h.commands.get("tako-handoff")?.("PAY-1", h.ctx);
		expect(h.active()).toContain("tako_handoff_draft");
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("tako_handoff_draft"),
			{ deliverAs: "followUp" },
		);
		const result = await draft(h);
		expect(result).toEqual({
			status: "shared",
			handoff_id: "h-1",
			server_redactions: 2,
		});
		// Queued behind any running turn, never thrown away.
		expect(h.pi.sendUserMessage.mock.calls[0][1]).toEqual({
			deliverAs: "followUp",
		});
		// The author confirms the exact pack that is uploaded.
		expect(h.ctx.ui.confirm.mock.calls[0][1]).toContain("## Summary");
		// The author reviewed the redacted pack before anything left.
		const reviewed = h.ctx.ui.editor.mock.calls[0][1];
		expect(reviewed).toContain("[REDACTED]");
		expect(reviewed).not.toContain("ghp_");
		const [, args] = h.callTool.mock.calls[0];
		expect(args).toMatchObject({
			task_key: "PAY-1",
			visibility: "project",
			recipient_emails: [],
		});
		expect((args as any).pack.summary).toContain("[REDACTED]");
		expect(h.active()).not.toContain("tako_handoff_draft");
	});

	it("redacts what the author adds during review", async () => {
		h.ctx.ui.editor.mockImplementation(
			async (_title: string, text: string) =>
				`${text}\n## Plan\n\nRotate key sk-${"b".repeat(24)} later.`,
		);
		await h.commands.get("tako-handoff")?.("PAY-1", h.ctx);
		await draft(h);
		const [, args] = h.callTool.mock.calls[0];
		expect((args as any).pack.plan).toContain("[REDACTED]");
		expect(JSON.stringify(args)).not.toContain("sk-bbbb");
	});

	it("shares with named people", async () => {
		h.ctx.ui.select.mockResolvedValue("Specific people");
		await h.commands.get("tako-handoff")?.("PAY-1", h.ctx);
		await draft(h);
		expect(h.callTool.mock.calls[0][1]).toMatchObject({
			visibility: "people",
			recipient_emails: ["ana@takonaut.test", "bo@takonaut.test"],
		});
	});

	it("uploads nothing when the author cancels", async () => {
		h.ctx.ui.editor.mockResolvedValue("## Summary\n\n");
		await h.commands.get("tako-handoff")?.("PAY-1", h.ctx);
		expect(await draft(h)).toEqual({ status: "cancelled" });
		h.ctx.ui.editor.mockImplementation(
			async (_t: string, text: string) => text,
		);
		h.ctx.ui.confirm.mockResolvedValue(false);
		await h.commands.get("tako-handoff")?.("PAY-1", h.ctx);
		expect(await draft(h)).toEqual({ status: "cancelled" });
		expect(h.callTool).not.toHaveBeenCalled();
	});

	it("refuses a draft nobody asked for", async () => {
		await h.commands.get("tako-handoff")?.("PAY-1", h.ctx);
		await draft(h);
		expect(await draft(h)).toEqual({ error: "no_handoff_requested" });
	});

	it("disarms the draft tool when the request cannot be sent", async () => {
		h.pi.sendUserMessage.mockImplementation(() => {
			throw new Error("Agent is already processing");
		});
		await h.commands.get("tako-handoff")?.("PAY-1", h.ctx);
		expect(h.active()).not.toContain("tako_handoff_draft");
		expect(await draft(h)).toEqual({ error: "no_handoff_requested" });
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Could not ask"),
			"error",
		);
	});

	it("allows one pending request and clears it with the session", async () => {
		await h.commands.get("tako-handoff")?.("PAY-1", h.ctx);
		await h.commands.get("tako-handoff")?.("PAY-2", h.ctx);
		expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1);
		await h.events.get("session_shutdown")?.({}, h.ctx);
		expect(h.active()).not.toContain("tako_handoff_draft");
		expect(await draft(h)).toEqual({ error: "no_handoff_requested" });
	});

	it("stops before confirmation when the pack is too large", async () => {
		await h.commands.get("tako-handoff")?.("PAY-1", h.ctx);
		const result = await draft(h, {
			...DRAFT,
			summary: "x".repeat(200_000),
			plan: "y".repeat(70_000),
			decisions: Array.from({ length: 10 }, () => "z".repeat(1_000)),
		});
		expect(result).toEqual({ error: "too_large" });
		expect(h.ctx.ui.confirm).not.toHaveBeenCalled();
		expect(h.callTool).not.toHaveBeenCalled();
	});

	it("tells the author when sharing fails after confirmation", async () => {
		h.callTool.mockRejectedValueOnce(
			new Error("task_handoff:invalid_recipients"),
		);
		await h.commands.get("tako-handoff")?.("PAY-1", h.ctx);
		expect(await draft(h)).toEqual({ error: "invalid_recipients" });
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("invalid_recipients"),
			"error",
		);
	});

	it("withdraws a handoff", async () => {
		await h.commands.get("tako-handoff")?.("withdraw h-1", h.ctx);
		expect(h.callTool).toHaveBeenCalledWith("withdraw_task_handoff", {
			handoff_id: "h-1",
		});
	});
});

describe("/tako-resume", () => {
	it("starts a new session seeded with the pack and a mismatch warning", async () => {
		// Identical labels: the choice is by position, not by text.
		h.ctx.ui.select.mockImplementation(
			async (_title: string, labels: string[]) => labels[1],
		);
		await h.commands.get("tako-resume")?.("PAY-1", h.ctx);
		expect(h.callTool).toHaveBeenCalledWith("get_task_handoff", {
			handoff_id: "h-2",
		});
		expect(h.ctx.newSession).toHaveBeenCalledOnce();
		const [message] = h.sent as Array<{ customType: string; content: string }>;
		expect(message.customType).toBe("tako-handoff");
		expect(message.content).toContain("Traced the rounding bug");
		expect(message.content).toContain("not a Git checkout");
		expect(message.content).toMatch(/not instructions/);
	});
});
