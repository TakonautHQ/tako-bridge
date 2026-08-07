export interface CompanionPackage {
	name: string;
	installSpec: string;
	acceptedSources: readonly string[];
}

export const REQUIRED_COMPANION_PACKAGES: readonly CompanionPackage[] = [
	{
		name: "Pi Subagents",
		installSpec: "npm:pi-subagents@0.34.0",
		acceptedSources: [
			"npm:pi-subagents",
			"git:github.com/nicobailon/pi-subagents",
			"https://github.com/nicobailon/pi-subagents",
		],
	},
	{
		name: "Pi Lens",
		installSpec: "npm:pi-lens@3.8.70",
		acceptedSources: [
			"npm:pi-lens",
			"git:github.com/apmantza/pi-lens",
			"https://github.com/apmantza/pi-lens",
		],
	},
	{
		name: "Ask User Question",
		installSpec: "npm:@juicesharp/rpiv-ask-user-question@1.20.0",
		acceptedSources: ["npm:@juicesharp/rpiv-ask-user-question"],
	},
];

export function missingCompanionPackages(
	listOutput: string,
): readonly CompanionPackage[] {
	const installedSources = listOutput
		.split("\n")
		.map((line) => line.trim().replace(/\s+\(filtered\)$/, ""))
		.filter((line) => /^(?:npm:|git:|https?:\/\/)/.test(line));

	return REQUIRED_COMPANION_PACKAGES.filter(
		(companion) =>
			!installedSources.some((source) =>
				companion.acceptedSources.some(
					(accepted) =>
						source === accepted || source.startsWith(`${accepted}@`),
				),
			),
	);
}
