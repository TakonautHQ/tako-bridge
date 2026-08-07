import { describe, expect, it } from "vitest";
import {
	missingCompanionPackages,
	REQUIRED_COMPANION_PACKAGES,
} from "../src/setup";

describe("Tako Bridge companion package setup", () => {
	it("includes the structured ask-user extension in the pinned companion set", () => {
		expect(
			REQUIRED_COMPANION_PACKAGES.map((companion) => companion.installSpec),
		).toContain("npm:@juicesharp/rpiv-ask-user-question@1.20.0");
	});

	it("installs the pinned required companion packages on a clean Pi profile", () => {
		expect(missingCompanionPackages("User packages:\n")).toEqual(
			REQUIRED_COMPANION_PACKAGES,
		);
	});

	it("recognizes existing npm installs without requiring the pinned source spelling", () => {
		const output = [
			"User packages:",
			"  npm:pi-subagents",
			"    /home/dev/.pi/agent/npm/node_modules/pi-subagents",
			"  npm:pi-lens@3.8.70 (filtered)",
			"    /home/dev/.pi/agent/npm/node_modules/pi-lens",
			"  npm:@juicesharp/rpiv-ask-user-question",
			"    /home/dev/.pi/agent/npm/node_modules/@juicesharp/rpiv-ask-user-question",
		].join("\n");

		expect(missingCompanionPackages(output)).toEqual([]);
	});

	it("recognizes a git install of Pi Lens as satisfying the requirement", () => {
		const output = [
			"User packages:",
			"  npm:pi-subagents@0.34.0",
			"    /home/dev/.pi/agent/npm/node_modules/pi-subagents",
			"  git:github.com/apmantza/pi-lens",
			"    /home/dev/.pi/agent/git/github.com/apmantza/pi-lens",
			"  npm:@juicesharp/rpiv-ask-user-question@1.20.0",
		].join("\n");

		expect(missingCompanionPackages(output)).toEqual([]);
	});

	it("does not mistake similarly named packages for required companions", () => {
		const output = [
			"User packages:",
			"  npm:my-pi-subagents-helper",
			"  git:github.com/example/pi-lens-fork-helper",
		].join("\n");

		expect(missingCompanionPackages(output)).toEqual(
			REQUIRED_COMPANION_PACKAGES,
		);
	});
});
