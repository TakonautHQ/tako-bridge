import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	evaluateBash,
	evaluatePath,
	evaluateToolCall,
	type PolicyConfig,
} from "../src/policy";

const cfg: PolicyConfig = {
	repoRoot: "/home/dev/repo",
	protectedBranches: ["main", "master"],
};

describe("evaluateBash", () => {
	it("allows ordinary commands", () => {
		expect(evaluateBash("npm test", cfg).allow).toBe(true);
		expect(evaluateBash("git commit -m 'x'", cfg).allow).toBe(true);
		expect(evaluateBash("git push origin feat/x", cfg).allow).toBe(true);
	});

	it("blocks recursive force delete", () => {
		expect(evaluateBash("rm -rf /", cfg).allow).toBe(false);
		expect(evaluateBash("rm -fr build", cfg).allow).toBe(false);
		expect(evaluateBash("rm --recursive --force build", cfg).allow).toBe(false);
		expect(evaluateBash("rm --force --recursive build", cfg).allow).toBe(false);
	});

	it("blocks force push and hard reset", () => {
		expect(evaluateBash("git push --force origin feat/x", cfg).allow).toBe(
			false,
		);
		expect(evaluateBash("git push -f", cfg).allow).toBe(false);
		expect(evaluateBash("git reset --hard HEAD~3", cfg).allow).toBe(false);
		expect(
			evaluateBash("git -C /home/dev/repo push --force origin feat/x", cfg)
				.allow,
		).toBe(false);
		expect(
			evaluateBash("git --work-tree=/home/dev/repo reset --hard HEAD~3", cfg)
				.allow,
		).toBe(false);
	});

	it("blocks pushes to protected branches", () => {
		expect(evaluateBash("git push origin main", cfg).allow).toBe(false);
		expect(evaluateBash("git push origin master", cfg).allow).toBe(false);
		expect(
			evaluateBash("git -C /home/dev/repo push origin main", cfg).allow,
		).toBe(false);
	});

	it("blocks migrations, deploys, secret reads", () => {
		expect(evaluateBash("alembic upgrade head", cfg).allow).toBe(false);
		expect(evaluateBash("./deploy.vps.sh", cfg).allow).toBe(false);
		expect(evaluateBash("cat .env", cfg).allow).toBe(false);
	});
});

describe("evaluatePath", () => {
	it("allows files inside the repo", () => {
		expect(evaluatePath("src/app.ts", cfg).allow).toBe(true);
		expect(evaluatePath("/home/dev/repo/src/app.ts", cfg).allow).toBe(true);
	});

	it("blocks writes outside the repo", () => {
		expect(evaluatePath("../other/secret.ts", cfg).allow).toBe(false);
		expect(evaluatePath("/etc/passwd", cfg).allow).toBe(false);
	});

	it("blocks .env / secret files", () => {
		expect(evaluatePath("src/.env", cfg).allow).toBe(false);
		expect(evaluatePath("config/credentials.json", cfg).allow).toBe(false);
		expect(evaluatePath("deploy/key.pem", cfg).allow).toBe(false);
	});

	it("allows verified worktree roots but rejects symlink and protected-path escapes", () => {
		const root = mkdtempSync(join(tmpdir(), "tako-policy-"));
		const worktree = join(root, "worktree");
		const outside = join(root, "outside");
		mkdirSync(join(worktree, "src"), { recursive: true });
		mkdirSync(outside);
		symlinkSync(outside, join(worktree, "src", "linked"));
		const agenticCfg: PolicyConfig = {
			repoRoot: worktree,
			repoRoots: [worktree],
			protectedBranches: ["main"],
			protectedPaths: ["protected"],
		};

		expect(
			evaluatePath(join(worktree, "src", "file.ts"), agenticCfg).allow,
		).toBe(true);
		expect(
			evaluatePath(join(worktree, "src", "linked", "escape.ts"), agenticCfg)
				.allow,
		).toBe(false);
		expect(
			evaluatePath(join(worktree, "protected", "file.ts"), agenticCfg).allow,
		).toBe(false);
		rmSync(root, { recursive: true, force: true });
	});
});

describe("evaluateToolCall", () => {
	it("dispatches by tool name and ignores read-only tools", () => {
		expect(evaluateToolCall("bash", { command: "rm -rf x" }, cfg).allow).toBe(
			false,
		);
		expect(evaluateToolCall("write", { path: "../x" }, cfg).allow).toBe(false);
		expect(evaluateToolCall("read", { path: "/etc/passwd" }, cfg).allow).toBe(
			true,
		);
		expect(evaluateToolCall("grep", { pattern: "x" }, cfg).allow).toBe(true);
	});
});
