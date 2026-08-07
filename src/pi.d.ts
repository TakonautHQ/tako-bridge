export {};

// Minimal ambient declarations for the subset of Pi's extension API this extension uses,
// so the package typechecks standalone. At runtime Pi injects the real, fuller object
// (structurally compatible). Full types: `@earendil-works/pi-coding-agent`.

declare module "@earendil-works/pi-coding-agent" {
	export interface ToolCallEvent {
		type: "tool_call";
		toolCallId: string;
		toolName: string;
		input: Record<string, unknown>;
	}
	export interface ToolCallEventResult {
		block?: boolean;
		reason?: string;
	}
	export interface AgentEndEvent {
		type: "agent_end";
		messages: Array<{ role?: string; content?: unknown }>;
	}
	export interface SessionStartEvent {
		type: "session_start";
	}
	export interface SessionShutdownEvent {
		type: "session_shutdown";
		reason?: "quit" | "reload" | "new" | "resume" | "fork";
		targetSessionFile?: string;
	}
	export interface ExtensionContext {
		signal?: AbortSignal;
		hasUI: boolean;
		ui: {
			notify?(message: string, type?: "info" | "warning" | "error"): void;
			confirm(title: string, message: string): Promise<boolean>;
			input(title: string, placeholder?: string): Promise<string | undefined>;
		};
	}
	export interface ExtensionCommandContext extends ExtensionContext {
		reload(): Promise<void>;
	}

	export interface ExecResult {
		stdout: string;
		stderr: string;
		/** Pi 0.84 uses `code`; exitCode is accepted for compatibility adapters. */
		code: number;
		exitCode?: number;
		killed?: boolean;
	}

	export interface ExtensionAPI {
		on(
			event: "tool_call",
			handler: (
				event: ToolCallEvent,
				ctx: ExtensionContext,
			) => ToolCallEventResult | void | Promise<ToolCallEventResult | void>,
		): void;
		on(
			event: "agent_end",
			handler: (
				event: AgentEndEvent,
				ctx: ExtensionContext,
			) => void | Promise<void>,
		): void;
		on(
			event: "session_start",
			handler: (
				event: SessionStartEvent,
				ctx: ExtensionContext,
			) => void | Promise<void>,
		): void;
		on(
			event: "session_shutdown",
			handler: (
				event: SessionShutdownEvent,
				ctx: ExtensionContext,
			) => void | Promise<void>,
		): void;
		registerCommand(
			name: string,
			options: {
				description?: string;
				handler: (
					args: string,
					ctx: ExtensionCommandContext,
				) => Promise<void> | void;
			},
		): void;
		sendUserMessage(
			content: string,
			options?: { deliverAs?: "steer" | "followUp" },
		): void;
		exec(
			command: string,
			args: string[],
			options?: unknown,
		): Promise<ExecResult>;
	}
}
