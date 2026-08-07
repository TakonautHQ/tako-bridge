import { describe, expect, it } from "vitest";
import { parseStartArguments } from "../src/start";

describe("/tako-start arguments", () => {
	it("parses a Task key without overrides", () => {
		expect(parseStartArguments("PAY-142")).toEqual({
			taskKey: "PAY-142",
			baseRefOverrides: [],
		});
	});

	it("parses bounded per-Workspace refs with quoted reasons", () => {
		expect(
			parseStartArguments(
				'PAY-142 --base-ref api=release/1.0 --reason "Supported release fix" --base-ref web=abc123 --reason "Pinned incident build"',
			),
		).toEqual({
			taskKey: "PAY-142",
			baseRefOverrides: [
				{
					workspaceKey: "api",
					ref: "release/1.0",
					reason: "Supported release fix",
				},
				{
					workspaceKey: "web",
					ref: "abc123",
					reason: "Pinned incident build",
				},
			],
		});
	});

	it.each([
		"",
		"PAY-142 --base-ref api=release/1.0",
		'PAY-142 --reason "missing ref"',
		'PAY-142 --base-ref api=../main --reason "unsafe"',
		'PAY-142 --base-ref API=main --reason "bad key"',
		"PAY-142 --unknown value",
	])("rejects invalid input: %s", (value) => {
		expect(() => parseStartArguments(value)).toThrow();
	});
});
