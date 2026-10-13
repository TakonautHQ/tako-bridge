import { basename } from "node:path";

import { redactSensitiveValues } from "./redaction.js";

export interface AgentMetricsSnapshot {
	currentActivity: string | null;
	lastTool: string | null;
	toolCalls: number;
	turns: number;
	tokensIn: number;
	tokensOut: number;
	costUsd: number;
	lastError: string | null;
}

interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cost?: { total?: number };
}

const ACTIVITY_MAX = 120;

function clip(value: string, max = ACTIVITY_MAX): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * A short, privacy-safe description of a tool call: file names only (never
 * full paths or contents) and redacted, truncated shell commands.
 */
export function describeToolCall(toolName: string, args: unknown): string {
	const input = (args && typeof args === "object" ? args : {}) as Record<
		string,
		unknown
	>;
	const path = [input.path, input.file_path, input.filePath].find(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	if (typeof input.command === "string" && input.command) {
		return clip(`${toolName}: ${redactSensitiveValues(input.command)}`);
	}
	if (path) return clip(`${toolName} ${basename(path)}`);
	if (typeof input.pattern === "string" && input.pattern) {
		return clip(`${toolName} "${redactSensitiveValues(input.pattern)}"`, 80);
	}
	return clip(toolName);
}

/** Accumulates per-session agent metrics from Pi lifecycle events. */
export class AgentMetricsTracker {
	private metrics: AgentMetricsSnapshot = AgentMetricsTracker.empty();

	static empty(): AgentMetricsSnapshot {
		return {
			currentActivity: null,
			lastTool: null,
			toolCalls: 0,
			turns: 0,
			tokensIn: 0,
			tokensOut: 0,
			costUsd: 0,
			lastError: null,
		};
	}

	reset(): void {
		this.metrics = AgentMetricsTracker.empty();
	}

	snapshot(): AgentMetricsSnapshot {
		return { ...this.metrics, costUsd: Math.round(this.metrics.costUsd * 10_000) / 10_000 };
	}

	onAgentStart(): void {
		this.metrics.currentActivity = "Thinking";
	}

	onToolStart(toolName: string, args: unknown): void {
		this.metrics.toolCalls += 1;
		this.metrics.lastTool = clip(toolName, 80);
		this.metrics.currentActivity = describeToolCall(toolName, args);
	}

	onToolEnd(toolName: string, isError: boolean): void {
		// Tool output is never forwarded; only the fact that it failed.
		if (isError) this.metrics.lastError = clip(`${toolName} failed`, 300);
	}

	onTurnEnd(message: unknown): void {
		this.metrics.turns += 1;
		const usage = (message as { usage?: UsageLike } | undefined)?.usage;
		if (!usage) return;
		this.metrics.tokensIn += Math.max(0, (usage.input ?? 0) + (usage.cacheRead ?? 0));
		this.metrics.tokensOut += Math.max(0, usage.output ?? 0);
		this.metrics.costUsd += Math.max(0, usage.cost?.total ?? 0);
	}

	onAgentIdle(): void {
		this.metrics.currentActivity = "Waiting for input";
	}
}
