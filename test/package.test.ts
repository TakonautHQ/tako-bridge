import { execFile, execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempHomes: string[] = [];

afterEach(() => {
	for (const dir of tempHomes.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function readPackage(): Record<string, any> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(
			readFileSync(join(packageRoot, "package.json"), "utf-8"),
		);
	} catch (error) {
		throw new Error("package.json must contain valid JSON", { cause: error });
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("package.json must contain an object");
	}
	return parsed as Record<string, any>;
}

function packAndInstallDependencies(home: string): string {
	const packedDir = join(home, "packed");
	const extractedDir = join(home, "extracted");
	mkdirSync(packedDir, { recursive: true });
	mkdirSync(extractedDir, { recursive: true });
	execFileSync("bun", ["pm", "pack", "--destination", packedDir, "--quiet"], {
		cwd: packageRoot,
		stdio: "pipe",
	});
	const tarball = readdirSync(packedDir).find((name) => name.endsWith(".tgz"));
	if (!tarball) throw new Error("bun pm pack did not produce a .tgz archive");
	execFileSync("tar", ["-xzf", join(packedDir, tarball), "-C", extractedDir]);
	const extractedPackage = join(extractedDir, "package");
	execFileSync("bun", ["install", "--production"], {
		cwd: extractedPackage,
		stdio: "pipe",
	});
	return extractedPackage;
}

async function installedCommands(
	home: string,
): Promise<Array<{ name: string }>> {
	const pi =
		process.env.PI_BIN || join(packageRoot, "node_modules", ".bin", "pi");
	const env = { ...process.env, HOME: home };
	const extractedPackage = packAndInstallDependencies(home);
	execFileSync(pi, ["install", extractedPackage], { env, stdio: "pipe" });

	return await new Promise((resolvePromise, reject) => {
		const child = execFile(pi, ["--mode", "rpc", "--no-session"], {
			cwd: home,
			env,
			timeout: 15_000,
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Timed out waiting for get_commands. stderr=${stderr}`));
		}, 10_000);

		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
			for (const line of stdout.split("\n")) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.type === "response" && msg.command === "get_commands") {
						clearTimeout(timer);
						child.kill();
						resolvePromise(msg.data?.commands ?? []);
						return;
					}
				} catch {
					// Wait for a complete JSON line.
				}
			}
		});
		child.stderr?.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.stdin?.write(JSON.stringify({ type: "get_commands" }) + "\n");
	});
}

describe("Pi package manifest", () => {
	it("declares a standalone Tako Bridge Pi package", () => {
		const pkg = readPackage();
		expect(pkg.name).toBe("@takonaut/tako-bridge");
		expect(pkg.pi?.extensions).toEqual(["./src/index.ts"]);
		expect(pkg.bin).toBeUndefined();
		expect(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe(
			"*",
		);
		expect(pkg.devDependencies?.["@earendil-works/pi-coding-agent"]).toBe(
			"0.84.0",
		);
		for (const name of [
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-tui",
			"typebox",
		]) {
			expect(pkg.dependencies?.[name]).toBeUndefined();
		}
	});

	it("packs only the Bridge runtime and public documentation", () => {
		const home = mkdtempSync(join(tmpdir(), "tako-bridge-pack-"));
		tempHomes.push(home);
		const extractedPackage = packAndInstallDependencies(home);
		expect(existsSync(join(extractedPackage, "src", "index.ts"))).toBe(true);
		expect(existsSync(join(extractedPackage, "src", "runner.ts"))).toBe(false);
		expect(existsSync(join(extractedPackage, "src", "runner-cli.ts"))).toBe(
			false,
		);
		expect(existsSync(join(extractedPackage, "test"))).toBe(false);
	}, 30_000);

	it("autoloads Tako commands from a packed, isolated installation", async () => {
		const home = mkdtempSync(join(tmpdir(), "tako-pi-home-"));
		tempHomes.push(home);
		const commands = await installedCommands(home);
		const names = commands.map((c) => c.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"tako-setup",
				"tako-login",
				"tako-status",
				"tako-tasks",
				"tako-start",
				"tako-agentic-test",
				"tako-complete",
				"tako-finalize",
				"tako-cancel-ack",
				"tako-diagnostics",
				"tako-cleanup",
				"tako-test",
				"tako-submit",
				"tako-step",
				"tako-answer",
				"tako-retry",
				"tako-route",
				"tako-resolve-gate",
				"tako-context",
				"tako-confirm-context",
				"tako-plan",
				"tako-resume-review",
				"tako-current",
				"tako-resume",
				"tako-abandon",
			]),
		);
	}, 60_000);
});
