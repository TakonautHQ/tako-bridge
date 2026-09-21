import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReportUI } from "./report.js";
import {
	type BridgeUpdates,
	bridgeReleaseUrl,
	bridgeUpgradeCommand,
	isNewerBridgeRelease,
} from "./updates.js";

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

/** Display-only upgrade instructions: the user, not a background task, runs pi install. */
export class BridgeUpdateCommand {
	private busy = false;
	constructor(
		private readonly updates: BridgeUpdates,
		private readonly scope: () => BridgeInstallScope | null,
	) {}

	async run(ctx: { hasUI: boolean; ui: ReportUI }, args = ""): Promise<void> {
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
					...(release ? ["View release notes", "Show upgrade command"] : []),
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
				if (action === "Show upgrade command" && release) {
					// Never advise replacing a newer/dev version with an older release.
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
							"Review upgrade command",
							`${scope === "project" ? "Project-local: run from the project where Bridge is installed." : "User-wide installation."}\n${command}\nPi may reset/clean its managed package clone when changing pinned refs. Preserve any local edits first. Bridge will NOT execute this command.`,
						)) &&
						current()
					) {
						ui.notify?.(
							`${command}\n\nRun this yourself from ${scope === "project" ? "the original project directory" : "a terminal"}, then restart Pi or run /reload. No installation was performed.`,
							"info",
						);
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
