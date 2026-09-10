import { readFileSync } from "node:fs";

interface BridgePackageMetadata {
	version?: unknown;
}

function readBridgeVersion(): string {
	let metadata: BridgePackageMetadata;
	try {
		metadata = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		) as BridgePackageMetadata;
	} catch (error) {
		throw new Error("Tako Bridge package metadata is unavailable.", {
			cause: error,
		});
	}
	if (typeof metadata.version !== "string" || metadata.version.length === 0) {
		throw new Error("Tako Bridge package version is unavailable.");
	}
	return metadata.version;
}

export const BRIDGE_VERSION = readBridgeVersion();
