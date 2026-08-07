import {
	mkdtempSync,
	mkdirSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectLocalContext, type AgenticContextContract } from "../src/context";
import type { CommandRunner } from "../src/git";
import type { ActiveAgenticWorktreeState } from "../src/state";

function workspace(root: string): ActiveAgenticWorktreeState {
	return {
		workspaceKey: "api",
		repositoryFingerprint: "github:1:acme/api",
		configuredBaseRef: "main",
		overrideBaseRef: null,
		repoRoot: root,
		worktreeRoot: root,
		relativeWorktreePath: "project/run/api",
		branchName: "tako/task-api",
		baseSha: "a".repeat(40),
		initialHeadSha: "a".repeat(40),
		effectiveConfigHash: "b".repeat(64),
		lifecycle: "verified",
	};
}

function contract(overrides: Partial<AgenticContextContract> = {}): AgenticContextContract {
	return {
		run_id: "run-1",
		step_instance_key: "inspect",
		byte_budget: 4096,
		sources: [
			{
				source_id: "guide",
				workspace_key: "api",
				relative_path: "docs/GUIDE.md",
				required: true,
				sensitivity: "normal",
			},
		],
		...overrides,
	};
}

function gitRunner(): CommandRunner {
	return vi.fn(async (_command, args) => {
		const operation = args.slice(2).join(" ");
		if (operation === "rev-parse HEAD") {
			return { stdout: `${"c".repeat(40)}\n`, stderr: "", exitCode: 0 };
		}
		if (operation === "status --porcelain=v1 --untracked-files=all") {
			return { stdout: " M docs/GUIDE.md\n", stderr: "", exitCode: 0 };
		}
		if (operation === "diff --cached --binary --no-ext-diff") {
			return { stdout: "index change\n", stderr: "", exitCode: 0 };
		}
		return { stdout: "", stderr: "unexpected git command", exitCode: 1 };
	});
}

describe("collectLocalContext", () => {
	it("reads only configured files and returns bounded content plus Git observations", async () => {
		const root = mkdtempSync(join(tmpdir(), "tako-context-"));
		mkdirSync(join(root, "docs"));
		writeFileSync(join(root, "docs", "GUIDE.md"), "# Guide\nSafe text.\n");
		writeFileSync(join(root, "secret.env"), "TOKEN=must-not-leak\n");
		const run = gitRunner();

		const result = await collectLocalContext(contract(), [workspace(root)], run);

		expect(result.documents).toEqual([
			expect.objectContaining({
				sourceId: "guide",
				workspaceKey: "api",
				relativePath: "docs/GUIDE.md",
				content: "# Guide\nSafe text.\n",
			}),
		]);
		expect(JSON.stringify(result)).not.toContain("must-not-leak");
		expect(result.observations).toEqual([
			expect.objectContaining({
				source_id: "guide",
				provenance: "pi",
				content_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
				status: "verified",
				citations: ["docs/GUIDE.md"],
				workspace_observation: expect.objectContaining({
					head_sha: "c".repeat(40),
					dirty: true,
					dirty_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
					index_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
					byte_count: 19,
					line_count: 3,
				}),
			}),
		]);
		expect(run).toHaveBeenCalledTimes(3);
	});

	it.each([
		"../secret.env",
		"/etc/passwd",
		"C:/Users/dev/secret.md",
		"docs\\GUIDE.md",
		"docs/./GUIDE.md",
	])(
		"rejects unsafe relative path %s",
		async (relativePath) => {
			const root = mkdtempSync(join(tmpdir(), "tako-context-"));
			await expect(
				collectLocalContext(
					contract({
						sources: [
							{
								...contract().sources[0],
								relative_path: relativePath,
							},
						],
					}),
					[workspace(root)],
					gitRunner(),
				),
			).rejects.toThrow(/relative path/i);
		},
	);

	it("rejects symlink escapes and files beyond the contract byte budget", async () => {
		const root = mkdtempSync(join(tmpdir(), "tako-context-"));
		const outside = mkdtempSync(join(tmpdir(), "tako-context-outside-"));
		mkdirSync(join(root, "docs"));
		writeFileSync(join(outside, "secret.md"), "secret");
		symlinkSync(join(outside, "secret.md"), join(root, "docs", "GUIDE.md"));
		await expect(
			collectLocalContext(contract(), [workspace(root)], gitRunner()),
		).rejects.toThrow(/symlink|contain/i);

		unlinkSync(join(root, "docs", "GUIDE.md"));
		writeFileSync(join(root, "docs", "GUIDE.md"), "x".repeat(20_000));
		await expect(
			collectLocalContext(
				contract({ byte_budget: 1024 }),
				[workspace(root)],
				gitRunner(),
			),
		).rejects.toThrow(/byte budget/i);
	});

	it("represents an optional missing document without reading outside managed roots", async () => {
		const root = mkdtempSync(join(tmpdir(), "tako-context-"));
		const result = await collectLocalContext(
			contract({
				sources: [{ ...contract().sources[0], required: false }],
			}),
			[workspace(root)],
			gitRunner(),
		);
		expect(result.documents).toEqual([]);
		expect(result.observations[0]).toMatchObject({
			source_id: "guide",
			status: "missing",
			content_hash: "0".repeat(64),
		});
	});
});
