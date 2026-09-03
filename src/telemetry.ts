import type { AgentTelemetrySnapshot } from "./client";

export const AGENT_TELEMETRY_INTERVAL_MS = 5_000;

interface TelemetryReporterOptions {
	intervalMs?: number;
	initialSequence?: number;
	snapshot: () => Omit<AgentTelemetrySnapshot, "sequence"> | null;
	report: (snapshot: AgentTelemetrySnapshot) => Promise<unknown>;
	onSequence?: (sequence: number) => void;
	onFeatureDisabled?: (error: unknown) => void;
	onError?: (error: unknown) => void;
}

export function isFeatureDisabledError(error: unknown): boolean {
	return String(error).includes("feature_disabled:agent_profiles_v2");
}

export function startAgentTelemetryReporter(
	options: TelemetryReporterOptions,
): () => void {
	const intervalMs = options.intervalMs ?? AGENT_TELEMETRY_INTERVAL_MS;
	let sequence = Math.max(0, options.initialSequence ?? 0);
	let stopped = false;
	let reporting = false;

	const timer = setInterval(async () => {
		if (stopped || reporting) return;
		const next = options.snapshot();
		if (!next) return;
		reporting = true;
		sequence += 1;
		options.onSequence?.(sequence);
		try {
			const result = await options.report({ ...next, sequence });
			if (stopped) return;
			const serverSequence =
				typeof result === "object" &&
				result !== null &&
				typeof (result as { sequence?: unknown }).sequence === "number"
					? (result as { sequence: number }).sequence
					: sequence;
			if (serverSequence > sequence) {
				sequence = serverSequence;
				options.onSequence?.(sequence);
			}
		} catch (error) {
			if (stopped) return;
			if (isFeatureDisabledError(error)) {
				stopped = true;
				clearInterval(timer);
				options.onFeatureDisabled?.(error);
			} else {
				options.onError?.(error);
			}
		} finally {
			reporting = false;
		}
	}, intervalMs);

	return () => {
		stopped = true;
		clearInterval(timer);
	};
}
