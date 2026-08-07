import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	prepareDiagnosticContent,
	readAndPrepareDiagnostic,
} from "../src/diagnostics";

describe("explicit Diagnostic bundles", () => {
	it("redacts secrets and local roots without echoing rejected values", () => {
		const secret = ["sk", "live", "SUPERSECRETVALUE123456789"].join("-");
		const githubSecret = [
			"github",
			"pat",
			"1234567890abcdefghijklmnop",
		].join("_");
		const prepared = prepareDiagnosticContent(
			`Authorization: Bearer ${secret}\n${githubSecret}\n/home/dev/private/file.py`,
		);
		expect(prepared.content).not.toContain(secret);
		expect(prepared.content).not.toContain("/home/dev/private");
		expect(prepared.content).not.toContain(githubSecret);
		expect(prepared.content).toContain("[REDACTED]");
		expect(prepared.content).toContain("[LOCAL_PATH]");
		expect(prepared.redactionCount).toBe(3);
		let errorText = "";
		try {
			prepareDiagnosticContent(
				`${["-----BEGIN", "PRIVATE KEY-----"].join(" ")}\n${secret}\n${["-----END", "PRIVATE KEY-----"].join(" ")}`,
			);
		} catch (error) {
			errorText = String(error);
		}
		expect(errorText).toContain("prohibited high-risk material");
		expect(errorText).not.toContain(secret);
	});

	it("reads only bounded regular files inside the managed Workspace", () => {
		const root = mkdtempSync(join(tmpdir(), "tako-diagnostic-"));
		mkdirSync(join(root, "logs"));
		writeFileSync(join(root, "logs", "failure.txt"), "safe summary\n");
		expect(readAndPrepareDiagnostic(root, "logs/failure.txt").content).toBe(
			"safe summary\n",
		);
		expect(() => readAndPrepareDiagnostic(root, "../outside.txt")).toThrow(
			"safe Workspace-relative path",
		);
		writeFileSync(join(root, "outside.txt"), "outside");
		symlinkSync(join(root, "outside.txt"), join(root, "logs", "link.txt"));
		expect(() => readAndPrepareDiagnostic(root, "logs/link.txt")).toThrow(
			"not a symlink",
		);
	});

	it("rejects empty and oversized content", () => {
		expect(() => prepareDiagnosticContent("")).toThrow("non-empty");
		expect(() => prepareDiagnosticContent("x".repeat(128 * 1024 + 1))).toThrow(
			"128 KiB",
		);
	});
});
