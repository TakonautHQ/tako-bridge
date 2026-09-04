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

function activeSourceContents(directory = join(packageRoot, "src")): string {
	return readdirSync(directory, { withFileTypes: true })
		.map((entry) => {
			const path = join(directory, entry.name);
			return entry.isDirectory()
				? activeSourceContents(path)
				: entry.isFile() && /\.ts$/.test(entry.name)
					? readFileSync(path, "utf-8")
					: "";
		})
		.join("\n");
}

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

function packPackage(home: string): string {
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
	return join(extractedDir, "package");
}

function packAndInstallDependencies(home: string): string {
	const extractedPackage = packPackage(home);
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
		let commands: Array<{ name: string }> | undefined;
		let settled = false;
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		};
		const timer = setTimeout(() => {
			child.kill();
			fail(new Error(`Timed out waiting for get_commands. stderr=${stderr}`));
		}, 10_000);

		child.stdout?.on("data", (chunk) => {
			stdout += String(chunk);
			for (const line of stdout.split("\n")) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.type === "response" && msg.command === "get_commands") {
						commands = msg.data?.commands ?? [];
						clearTimeout(timer);
						child.kill();
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
		child.on("error", fail);
		child.on("close", () => {
			if (settled) return;
			if (!commands) {
				fail(new Error(`Pi exited before get_commands. stderr=${stderr}`));
				return;
			}
			settled = true;
			clearTimeout(timer);
			resolvePromise(commands);
		});
		child.stdin?.write(JSON.stringify({ type: "get_commands" }) + "\n");
	});
}

describe("Pi package manifest", () => {
	it("contains no retired Agent flag or consent route in active source", () => {
		const source = activeSourceContents();
		expect(source).not.toContain("dev_agents");
		expect(source).not.toContain("/connect-agent");
	});

	it("declares a standalone Tako Bridge Pi package", () => {
		const pkg = readPackage();
		expect(pkg.name).toBe("@takonaut/tako-bridge");
		expect(pkg.pi?.extensions).toEqual(["./src/index.ts"]);
		expect(pkg.bin).toBeUndefined();
		expect(pkg.peerDependencies?.["@earendil-works/pi-coding-agent"]).toBe("*");
		expect(pkg.peerDependencies?.["@earendil-works/pi-tui"]).toBe("*");
		expect(pkg.devDependencies?.["@earendil-works/pi-coding-agent"]).toBe(
			"0.84.0",
		);
		expect(pkg.devDependencies?.["@earendil-works/pi-tui"]).toBe("0.84.1");
		for (const name of [
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-tui",
			"typebox",
		]) {
			expect(pkg.dependencies?.[name]).toBeUndefined();
		}
	});

	it("uses the package version for runtime identity and manifest negotiation", () => {
		const version = readPackage().version;
		expect(
			readFileSync(join(packageRoot, "src", "client.ts"), "utf-8"),
		).toContain(`version: "${version}"`);
		expect(
			readFileSync(join(packageRoot, "src", "index.ts"), "utf-8"),
		).toContain(`extensionVersion: "${version}"`);
	});

	it("packs only the Bridge runtime and public documentation", () => {
		const home = mkdtempSync(join(tmpdir(), "tako-bridge-pack-"));
		tempHomes.push(home);
		const extractedPackage = packAndInstallDependencies(home);
		expect(existsSync(join(extractedPackage, "src", "index.ts"))).toBe(true);
		expect(readFileSync(join(extractedPackage, ".npmrc"), "utf-8")).toBe(
			"audit=false\nfund=false\n",
		);
		expect(existsSync(join(extractedPackage, "src", "runner.ts"))).toBe(false);
		expect(existsSync(join(extractedPackage, "src", "runner-cli.ts"))).toBe(
			false,
		);
		expect(existsSync(join(extractedPackage, "test"))).toBe(false);
	}, 30_000);

	it(
		"installs packed production dependencies with npm",
		() => {
			const home = mkdtempSync(join(tmpdir(), "tako-bridge-npm-install-"));
			tempHomes.push(home);
			const extractedPackage = packPackage(home);
			execFileSync("npm", ["install", "--omit=dev"], {
				cwd: extractedPackage,
				stdio: "pipe",
				timeout: 30_000,
			});
			expect(existsSync(join(extractedPackage, "node_modules"))).toBe(true);
		},
		90_000,
	);

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
				"tako-step",
				"tako-answer",
				"tako-retry",
				"tako-route",
				"tako-resolve-gate",
				"tako-context",
				"tako-confirm-context",
				"tako-plan",
				"tako-resume-review",
				"tako-resume",
			]),
		);
		expect(names).not.toEqual(
			expect.arrayContaining([
				"tako-test",
				"tako-submit",
				"tako-current",
				"tako-abandon",
			]),
		);
	}, 60_000);
});
