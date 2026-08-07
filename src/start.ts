import type { BaseRefOverrideRequest } from "./client";

const WORKSPACE_KEY_RE = /^[a-z][a-z0-9_-]{0,79}$/;
const BASE_REF_RE =
	/^(?![-/])(?!.*(?:\.\.|\/\/|@\{|\\|\s))[A-Za-z0-9._/-]{1,255}(?<![./])$/;
const MAX_OVERRIDES = 32;

function tokenize(value: string): string[] {
	const result: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let active = false;
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index];
		if (quote) {
			if (character === quote) {
				quote = null;
				continue;
			}
			if (character === "\\" && index + 1 < value.length) {
				index += 1;
				current += value[index];
				active = true;
				continue;
			}
			current += character;
			active = true;
			continue;
		}
		if (character === '"' || character === "'") {
			quote = character;
			active = true;
			continue;
		}
		if (/\s/.test(character)) {
			if (active) {
				result.push(current);
				current = "";
				active = false;
			}
			continue;
		}
		current += character;
		active = true;
	}
	if (quote) throw new Error("Unterminated quote in /tako-start arguments");
	if (active) result.push(current);
	return result;
}

export interface ParsedStartArguments {
	taskKey: string;
	baseRefOverrides: BaseRefOverrideRequest[];
}

export function parseStartArguments(value: string): ParsedStartArguments {
	const tokens = tokenize(value.trim());
	const taskKey = tokens.shift();
	if (!taskKey || taskKey.startsWith("--") || taskKey.length > 100) {
		throw new Error(
			'Usage: /tako-start TASK-KEY [--base-ref WORKSPACE=REF --reason "WHY"]',
		);
	}
	const overrides: BaseRefOverrideRequest[] = [];
	while (tokens.length) {
		const option = tokens.shift();
		if (option === "--base-ref") {
			const assignment = tokens.shift();
			const separator = assignment?.indexOf("=") ?? -1;
			if (!assignment || separator <= 0) {
				throw new Error("--base-ref requires WORKSPACE=REF");
			}
			const workspaceKey = assignment.slice(0, separator);
			const ref = assignment.slice(separator + 1);
			if (!WORKSPACE_KEY_RE.test(workspaceKey) || !BASE_REF_RE.test(ref)) {
				throw new Error("Base-ref override is invalid or unsafe");
			}
			if (overrides.some((item) => item.workspaceKey === workspaceKey)) {
				throw new Error("A Code Workspace can be overridden only once");
			}
			overrides.push({ workspaceKey, ref, reason: "" });
			if (overrides.length > MAX_OVERRIDES) {
				throw new Error("Too many base-ref overrides");
			}
			continue;
		}
		if (option === "--reason") {
			const pending = overrides.at(-1);
			const reason = tokens.shift()?.trim() ?? "";
			if (!pending || pending.reason || !reason || reason.length > 500) {
				throw new Error(
					"--reason must follow one --base-ref and be 1-500 characters",
				);
			}
			pending.reason = reason;
			continue;
		}
		throw new Error(`Unknown /tako-start option: ${option ?? ""}`);
	}
	if (overrides.some((item) => !item.reason)) {
		throw new Error("Every base-ref override requires --reason");
	}
	return { taskKey, baseRefOverrides: overrides };
}
