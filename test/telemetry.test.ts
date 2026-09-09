import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	isFeatureDisabledError,
	startAgentTelemetryReporter,
} from "../src/telemetry";

describe("Agent telemetry reporter", () => {
	it("recognizes the active Agent Profiles feature-disable code", () => {
		expect(
			isFeatureDisabledError(new Error("feature_disabled:agent_profiles_v2")),
		).toBe(true);
	});

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
	});

	afterEach(() => vi.useRealTimers());

	it("posts one complete snapshot every five seconds with monotonic sequence", async () => {
		const report = vi.fn(async () => ({ accepted: true, sequence: 1 }));
		const stop = startAgentTelemetryReporter({
			intervalMs: 5_000,
			report,
			snapshot: () => ({
				runId: "run-1",
				sessionId: "session-1",
				observedAt: new Date().toISOString(),
				instances: [
					{
						instanceKey: "pi:session-1",
						parentInstanceKey: null,
						label: "Pi parent",
						role: "executor",
						reportedStatus: "provisioning",
						startedAt: "2030-01-01T00:00:00.000Z",
						lastActivityAt: new Date().toISOString(),
					},
				],
			}),
		});

		expect(report).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(4_999);
		expect(report).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(report).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenLastCalledWith(
			expect.objectContaining({
				sequence: 1,
				runId: "run-1",
				sessionId: "session-1",
			}),
		);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(report).toHaveBeenCalledTimes(2);
		expect(report).toHaveBeenLastCalledWith(
			expect.objectContaining({ sequence: 2 }),
		);

		stop();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(report).toHaveBeenCalledTimes(2);
	});

	it("continues a durable sequence across reporter recreation and server replay", async () => {
		const sequences: number[] = [];
		const report = vi
			.fn()
			.mockResolvedValueOnce({
				accepted: false,
				sequence: 12,
				reason: "replay",
			})
			.mockResolvedValueOnce({ accepted: true, sequence: 13 });
		const stop = startAgentTelemetryReporter({
			intervalMs: 5_000,
			initialSequence: 7,
			onSequence: (sequence) => sequences.push(sequence),
			report,
			snapshot: () => ({
				runId: "run-1",
				sessionId: "session-1",
				observedAt: new Date().toISOString(),
				instances: [],
			}),
		});

		await vi.advanceTimersByTimeAsync(5_000);
		expect(report).toHaveBeenLastCalledWith(
			expect.objectContaining({ sequence: 8 }),
		);
		expect(sequences).toEqual([8, 12]);

		await vi.advanceTimersByTimeAsync(5_000);
		expect(report).toHaveBeenLastCalledWith(
			expect.objectContaining({ sequence: 13 }),
		);
		expect(sequences).toEqual([8, 12, 13]);
		stop();
	});

	it("records skipped heartbeat ticks while a report is still in flight", async () => {
		const report = vi.fn(() => new Promise(() => {}));
		const skipped = vi.fn();
		const stop = startAgentTelemetryReporter({
			intervalMs: 5_000,
			reportTimeoutMs: 12_000,
			onSkip: skipped,
			report,
			snapshot: () => ({
				runId: "run-1",
				sessionId: "session-1",
				observedAt: new Date().toISOString(),
				instances: [],
			}),
		} as Parameters<typeof startAgentTelemetryReporter>[0] & {
			reportTimeoutMs: number;
			onSkip: (sequence: number) => void;
		});

		await vi.advanceTimersByTimeAsync(5_000);
		expect(report).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(5_000);
		expect(report).toHaveBeenCalledOnce();
		expect(skipped).toHaveBeenCalledWith(1);
		stop();
	});

	it("times out a stuck report, exposes lifecycle callbacks, and retries", async () => {
		const report = vi
			.fn()
			.mockImplementationOnce(() => new Promise(() => {}))
			.mockResolvedValueOnce({ accepted: true, sequence: 2 });
		const starts = vi.fn();
		const successes = vi.fn();
		const errors = vi.fn();
		const stop = startAgentTelemetryReporter({
			intervalMs: 5_000,
			reportTimeoutMs: 1_000,
			onStart: starts,
			onSuccess: successes,
			onError: errors,
			report,
			snapshot: () => ({
				runId: "run-1",
				sessionId: "session-1",
				observedAt: new Date().toISOString(),
				instances: [],
			}),
		} as Parameters<typeof startAgentTelemetryReporter>[0] & {
			reportTimeoutMs: number;
			onStart: (sequence: number) => void;
			onSuccess: (sequence: number, durationMs: number) => void;
		});

		await vi.advanceTimersByTimeAsync(5_000);
		expect(starts).toHaveBeenLastCalledWith(1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(errors).toHaveBeenLastCalledWith(
			expect.objectContaining({ message: "telemetry_timeout" }),
			1,
			1_000,
		);
		await vi.advanceTimersByTimeAsync(4_000);
		expect(report).toHaveBeenCalledTimes(2);
		expect(starts).toHaveBeenLastCalledWith(2);
		expect(successes).toHaveBeenLastCalledWith(2, 0);
		stop();
	});

	it("suppresses callbacks from an in-flight request after stop", async () => {
		let rejectReport: ((error: Error) => void) | undefined;
		const report = vi.fn(
			() =>
				new Promise((_resolve, reject) => {
					rejectReport = reject;
				}),
		);
		const sequences: number[] = [];
		const disabled = vi.fn();
		const errors = vi.fn();
		const stop = startAgentTelemetryReporter({
			intervalMs: 5_000,
			report,
			onSequence: (sequence) => sequences.push(sequence),
			onFeatureDisabled: disabled,
			onError: errors,
			snapshot: () => ({
				runId: "old-run",
				sessionId: "session-1",
				observedAt: new Date().toISOString(),
				instances: [],
			}),
		});

		await vi.advanceTimersByTimeAsync(5_000);
		expect(sequences).toEqual([1]);
		stop();
		rejectReport?.(new Error("feature_disabled:agent_profiles_v2"));
		await Promise.resolve();
		await Promise.resolve();

		expect(disabled).not.toHaveBeenCalled();
		expect(errors).not.toHaveBeenCalled();
		expect(sequences).toEqual([1]);
	});

	it("stops at the extension boundary when the feature is disabled", async () => {
		const report = vi.fn(async () => {
			throw new Error("feature_disabled:agent_profiles_v2");
		});
		const disabled = vi.fn();
		startAgentTelemetryReporter({
			intervalMs: 5_000,
			report,
			onFeatureDisabled: disabled,
			snapshot: () => ({
				runId: "run-1",
				sessionId: "session-1",
				observedAt: new Date().toISOString(),
				instances: [],
			}),
		});

		await vi.advanceTimersByTimeAsync(5_000);
		expect(disabled).toHaveBeenCalledOnce();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(report).toHaveBeenCalledOnce();
	});
});
