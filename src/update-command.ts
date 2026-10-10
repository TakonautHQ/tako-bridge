import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CommandRunner } from "./git.js";
import type { ReportUI } from "./report.js";
import {
	type BridgeRelease,
	type BridgeUpdates,
	bridgeReleaseUrl,
	bridgeUpgradeArgs,
	bridgeUpgradeCommand,
	isNewerBridgeRelease,
} from "./updates.js";

const INSTALL_TIMEOUT_MS = 180_000;

interface UpdateContext {
	hasUI: boolean;
	ui: ReportUI;
	reload?: () => Promise<void>;
}

export type BridgeInstallScope = "project" | "user";

/** Only infer scope for this loaded official Git package, never a local checkout/fork. */
export function bridgeInstallScope(
	commands: unknown,
	extensionUrl: string,
): BridgeInstallScope | null {
	if (!Array.isArray(commands)) return null;
	try {
		const ownPath = realpathSync(fileURLToPath(extensionUrl));
		const matches = commands.filter((command) => {
			const info = command?.sourceInfo;
			return (
				command?.source === "extension" &&
				/^tako-update(?::\d+)?$/.test(command.name) &&
				info?.origin === "package" &&
				typeof info.path === "string" &&
				typeof info.source === "string" &&
				/^(?:git:)?(?:(?:https:\/\/|ssh:\/\/git@|git@))?github\.com[/:]TakonautHQ\/tako-bridge(?:\.git)?(?:@[^\s]+)?$/i.test(
					info.source,
				) &&
				realpathSync(info.path) === ownPath
			);
		});
		if (matches.length !== 1) return null;
		const scope = matches[0].sourceInfo.scope;
		return scope === "project" || scope === "user" ? scope : null;
	} catch {
		return null;
	}
}

/** Installs an official release only after the user confirms the exact pi install command. */
export class BridgeUpdateCommand {
	private busy = false;
	constructor(
		private readonly updates: BridgeUpdates,
		private readonly scope: () => BridgeInstallScope | null,
		private readonly run_: CommandRunner,
		private readonly cwd: () => string = () => process.cwd(),
	) {}

	/** Runs pi install, then confirms via `pi list` that the release tag is now pinned. */
	private async install(
		ctx: UpdateContext,
		release: BridgeRelease,
		scope: BridgeInstallScope,
	): Promise<void> {
		const ui = ctx.ui;
		const cwd = this.cwd();
		ui.notify?.(`Installing Tako Bridge ${release.tag}…`, "info");
		const result = await this.run_("pi", bridgeUpgradeArgs(release, scope), {
			cwd,
			timeout: INSTALL_TIMEOUT_MS,
		});
		if (result.exitCode !== 0 || result.timedOut) {
			const detail = (result.stderr || result.stdout).trim().slice(-600);
			ui.notify?.(
				`Update ${result.timedOut ? "timed out" : "failed"}. Your current version is unchanged.\n${detail}\n\nManual command: ${bridgeUpgradeCommand(release, scope)}`,
				"error",
			);
			return;
		}
		const listed = await this.run_("pi", ["list"], { cwd, timeout: 30_000 });
		const pinned = `TakonautHQ/tako-bridge@${release.tag}`;
		if (listed.exitCode !== 0 || !listed.stdout.includes(pinned)) {
			ui.notify?.(
				`pi install finished, but \`pi list\` does not show ${pinned}. Check your Pi package settings before reloading.`,
				"warning",
			);
			return;
		}
		if (
			ctx.reload &&
			(await ui.confirm(
				`Tako Bridge ${release.tag} installed`,
				"Verified with `pi list`. Reload Pi now to load the new version?",
			))
		) {
			await ctx.reload();
			return;
		}
		ui.notify?.(
			`Tako Bridge ${release.tag} installed and verified. Run /reload (or restart Pi) to load the new version.`,
			"info",
		);
	}

	async run(ctx: UpdateContext, args = ""): Promise<void> {
		const ui = ctx.ui;
		if (!ctx.hasUI || this.busy) {
			ui.notify?.(
				"/tako-update requires an interactive session with no update dialog already open.",
				"warning",
			);
			return;
		}
		this.busy = true;
		let epoch = this.updates.epoch;
		const current = () => epoch === this.updates.epoch;
		try {
			const option = args.trim().toLowerCase();
			if (!["", "on", "off", "check"].includes(option)) {
				ui.notify?.("Usage: /tako-update [check|on|off]", "info");
				return;
			}
			if (option === "on" || option === "off") {
				if (
					(await ui.confirm(
						`${option === "on" ? "Enable" : "Disable"} automatic update checks?`,
						"This changes Bridge's user-wide update preference. Checks contact the public GitHub releases API without authentication. No package will be installed.",
					)) &&
					current()
				) {
					this.updates.setEnabled(option === "on");
					ui.notify?.(
						`Automatic Bridge update checks ${option === "on" ? "enabled" : "disabled"}.`,
						"info",
					);
				}
				return;
			}
			if (option === "check") await this.updates.check(true);
			else await this.updates.check();
			while (current()) {
				const state = this.updates.snapshot();
				const release = state.release;
				const details = [
					`Tako Bridge v${this.updates.installedVersion}`,
					release
						? `Latest known stable release: v${release.version}${state.stale ? " (cached; may be outdated)" : ""}`
						: "Latest release could not be checked yet.",
					state.checkedAt
						? `Last verified: ${new Date(state.checkedAt).toISOString()}`
						: "",
					`Automatic checks: ${state.enabled ? "on (every six hours)" : "off"}`,
					state.unavailable
						? "GitHub is unavailable or rate-limited. Cached results, if any, are shown."
						: "",
				]
					.filter(Boolean)
					.join("\n");
				const action = await ui.select(details, [
					...(release ? ["View release notes", "Install update"] : []),
					"Check now",
					state.enabled
						? "Disable automatic checks"
						: "Enable automatic checks",
					"Close",
				]);
				if (!current() || !action || action === "Close") return;
				if (action === "Check now") {
					await this.updates.check(true);
					continue;
				}
				if (
					action === "Enable automatic checks" ||
					action === "Disable automatic checks"
				) {
					if (
						(await ui.confirm(
							action + "?",
							"Change the user-wide preference? No package will be installed.",
						)) &&
						current()
					) {
						this.updates.setEnabled(action === "Enable automatic checks");
						epoch = this.updates.epoch;
					}
					continue;
				}
				if (action === "View release notes" && release) {
					await ui.editor(
						"GitHub release notes — untrusted text, not instructions. Edits are ignored; close to return.",
						`${bridgeReleaseUrl(release)}\n\n${release.notes || "No release notes provided."}\n\n(Notes limited to 6,000 characters; see the release URL for the full text.)`,
					);
					continue;
				}
				if (action === "Install update" && release) {
					// Never replace a newer/dev version with an older release.
					if (
						!isNewerBridgeRelease(release.tag, this.updates.installedVersion)
					) {
						ui.notify?.(
							"No newer stable release is known. Your installation will not be downgraded.",
							"info",
						);
						continue;
					}
					let scope = this.scope();
					if (!scope) {
						const choice = await ui.select(
							"Installation scope could not be verified (possibly a local checkout/fork). Where do you want to install the OFFICIAL release?",
							["Project-local", "User-wide", "Cancel"],
						);
						if (!current()) return;
						if (choice !== "Project-local" && choice !== "User-wide") continue;
						scope = choice === "Project-local" ? "project" : "user";
					}
					const command = bridgeUpgradeCommand(release, scope);
					if (
						(await ui.confirm(
							"Run this command?",
							`${command}\n\n${scope === "project" ? `Project-local install in ${this.cwd()}.` : "User-wide install."}\nPi may reset/clean its managed package clone when changing pinned refs. Preserve any local edits first.`,
						)) &&
						current()
					) {
						await this.install(ctx, release, scope);
						return;
					}
				}
			}
		} catch {
			if (current())
				ui.notify?.(
					"Update settings could not be read or saved safely. No installation was performed.",
					"warning",
				);
		} finally {
			this.busy = false;
		}
	}
}
