import type { AgentTelemetrySnapshot } from "./client";

export const AGENT_TELEMETRY_INTERVAL_MS = 5_000;
export const AGENT_TELEMETRY_TIMEOUT_MS = 10_000;

interface TelemetryReporterOptions {
	intervalMs?: number;
	reportTimeoutMs?: number;
	initialSequence?: number;
	snapshot: () => Omit<AgentTelemetrySnapshot, "sequence"> | null;
	report: (snapshot: AgentTelemetrySnapshot) => Promise<unknown>;
	onSequence?: (sequence: number) => void;
	onStart?: (sequence: number) => void;
	onSkip?: (sequence: number) => void;
	onSuccess?: (sequence: number, durationMs: number) => void;
	onFeatureDisabled?: (error: unknown) => void;
	onError?: (error: unknown, sequence: number, durationMs: number) => void;
}

async function withTelemetryTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error("telemetry_timeout")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function isFeatureDisabledError(error: unknown): boolean {
	return String(error).includes("feature_disabled:agent_profiles_v2");
}

export function startAgentTelemetryReporter(
	options: TelemetryReporterOptions,
): () => void {
	const intervalMs = options.intervalMs ?? AGENT_TELEMETRY_INTERVAL_MS;
	const reportTimeoutMs = options.reportTimeoutMs ?? AGENT_TELEMETRY_TIMEOUT_MS;
	let sequence = Math.max(0, options.initialSequence ?? 0);
	let stopped = false;
	let reporting = false;

	const timer = setInterval(async () => {
		if (stopped) return;
		if (reporting) {
			options.onSkip?.(sequence);
			return;
		}
		const next = options.snapshot();
		if (!next) return;
		reporting = true;
		sequence += 1;
		const startedAt = Date.now();
		options.onSequence?.(sequence);
		options.onStart?.(sequence);
		try {
			const result = await withTelemetryTimeout(
				options.report({ ...next, sequence }),
				reportTimeoutMs,
			);
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
			options.onSuccess?.(sequence, Date.now() - startedAt);
		} catch (error) {
			if (stopped) return;
			if (isFeatureDisabledError(error)) {
				stopped = true;
				clearInterval(timer);
				options.onFeatureDisabled?.(error);
			} else {
				options.onError?.(error, sequence, Date.now() - startedAt);
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
