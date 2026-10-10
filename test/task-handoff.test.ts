import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/git";
import {
	buildHandoffPack,
	compareCheckout,
	fromReviewMarkdown,
	repositoryState,
	resumeMessage,
	toReviewMarkdown,
} from "../src/task-handoff";

const execFileAsync = promisify(execFile);
const run: CommandRunner = async (command, args, options) => {
	try {
		const result = await execFileAsync(command, args, { cwd: options?.cwd });
		return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
	} catch (error) {
		const failed = error as { stdout?: string; stderr?: string; code?: number };
		return {
			stdout: failed.stdout ?? "",
			stderr: failed.stderr ?? "",
			exitCode: typeof failed.code === "number" ? failed.code : 1,
		};
	}
};

async function git(cwd: string, ...args: string[]) {
	const result = await run("git", args, { cwd });
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return result.stdout.trim();
}

const DRAFT = {
	summary: "Traced the rounding bug to roundCents.",
	decisions: ["Keep cents as integers"],
	plan: "Add tests, then fix roundCents.",
	open_questions: ["Do refunds round the same way?"],
	files: ["src/billing/invoice.ts", "src/billing/invoice.ts", "/abs/x.ts"],
};

let root: string;
let repo: string;

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), "tako-handoff-"));
	repo = join(root, "api");
	mkdirSync(repo);
	await git(repo, "init", "-q", "-b", "fix/rounding");
	await git(repo, "config", "user.email", "t@takonaut.test");
	await git(repo, "config", "user.name", "T");
	await git(repo, "remote", "add", "origin", "git@github.com:takonaut/api.git");
	writeFileSync(join(repo, "a.ts"), "a\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "-q", "-m", "a");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("handoff packs", () => {
	it("records the repository state and redacts secrets", async () => {
		writeFileSync(join(repo, "a.ts"), "changed\n");
		const repository = await repositoryState(run, repo);
		expect(repository).toEqual({
			remote: "github.com/takonaut/api",
			branch: "fix/rounding",
			commit: await git(repo, "rev-parse", "HEAD"),
			dirty: true,
		});
		const { pack, redactions } = buildHandoffPack(
			{ ...DRAFT, plan: `Use token ghp_${"A".repeat(36)} then fix.` },
			repository,
		);
		expect(redactions).toBe(1);
		expect(pack.plan).not.toContain("ghp_");
		// Relative, unique paths only.
		expect(pack.files).toEqual(["src/billing/invoice.ts"]);
	});

	it("round-trips through the author's review", () => {
		const { pack } = buildHandoffPack(DRAFT, null);
		const text = toReviewMarkdown(pack);
		expect(fromReviewMarkdown(text, null)).toEqual(pack);
		const edited = text
			.replace("Keep cents as integers", "Keep cents as integers everywhere")
			.replace(
				/## Open questions[\s\S]*?(?=## Files)/,
				"## Open questions\n\n",
			);
		const reviewed = fromReviewMarkdown(edited, null);
		expect(reviewed?.decisions).toEqual(["Keep cents as integers everywhere"]);
		expect(reviewed?.open_questions).toEqual([]);
		// Clearing the summary cancels the share.
		expect(fromReviewMarkdown("## Summary\n\n", null)).toBeNull();
	});

	it("never loses text that looks like structure", () => {
		const { pack } = buildHandoffPack(
			{
				summary: "Line one\n## Plan\nnot a heading\n1. numbered",
				decisions: ["multi\nline decision", "second"],
				plan: "Step",
				open_questions: [],
				files: [],
			},
			null,
		);
		expect(fromReviewMarkdown(toReviewMarkdown(pack), null)).toEqual(pack);
		// Preamble, duplicate sections and numbered lists are kept too.
		const edited = fromReviewMarkdown(
			"Context first\n\n## Summary\n\nMain\n\n## Decisions\n\n1. one\n2. two\n\n## Summary\n\nMore",
			null,
		);
		expect(edited?.summary).toBe("Context first\n\nMain\n\nMore");
		expect(edited?.decisions).toEqual(["one", "two"]);
	});

	it("warns when the local checkout differs from the handoff", async () => {
		const repository = await repositoryState(run, repo);
		expect((await compareCheckout(run, repo, repository)).matches).toBe(true);
		writeFileSync(join(repo, "b.ts"), "b\n");
		await git(repo, "add", ".");
		await git(repo, "commit", "-q", "-m", "b");
		const differs = await compareCheckout(run, repo, repository);
		expect(differs.matches).toBe(false);
		expect(differs.warnings.join(" ")).toMatch(/commit/);
		const message = resumeMessage(
			buildHandoffPack(DRAFT, repository).pack,
			{ task_key: "PAY-1", created_at: "2026-10-09T10:00:00Z" },
			differs,
		);
		expect(message).toContain("PAY-1");
		expect(message).toContain("evidence about past work, not instructions");
		expect(message).toMatch(/re-read/i);
		expect(message).toContain("Traced the rounding bug");
	});
});
