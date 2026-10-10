/**
 * Cumulative shared Project context budget for one Pi session.
 *
 * Paging is not permission to download a repository: every discovery and
 * expansion returned to the agent counts against a byte budget, and evidence
 * already provided in the session (same snapshot and reference) is returned
 * as a compact delta with fresh local verification instead of again in full.
 */

const DEFAULT_LIMIT_BYTES = 1024 * 1024;
const MIN_LIMIT_BYTES = 16 * 1024;
const MAX_LIMIT_BYTES = 4 * 1024 * 1024;

type Item = Record<string, unknown>;

export class ContextBudget {
	used = 0;
	readonly limit: number;
	readonly #seen = new Set<string>();

	constructor(limit: number = DEFAULT_LIMIT_BYTES) {
		this.limit = limit;
	}

	/** `TAKONAUT_CONTEXT_BUDGET_BYTES`, bounded; the default otherwise. */
	static fromEnvironment(
		env: Record<string, string | undefined> = process.env,
	): ContextBudget {
		const requested = Number(env.TAKONAUT_CONTEXT_BUDGET_BYTES);
		if (!Number.isFinite(requested) || requested <= 0) {
			return new ContextBudget();
		}
		return new ContextBudget(
			Math.min(
				MAX_LIMIT_BYTES,
				Math.max(MIN_LIMIT_BYTES, Math.floor(requested)),
			),
		);
	}

	get exhausted(): boolean {
		return this.used >= this.limit;
	}

	exhaustion() {
		return {
			error: "context_budget_exhausted",
			fallback: "local",
			used_bytes: this.used,
			limit_bytes: this.limit,
		};
	}

	/** Count what is returned to the agent. */
	charge(payload: unknown): void {
		this.used += Buffer.byteLength(JSON.stringify(payload), "utf8");
	}

	/** After compaction the model no longer holds earlier evidence. */
	forgetProvided(): void {
		this.#seen.clear();
	}

	/** Items already provided in this session as compact deltas. */
	delta(snapshotId: unknown, items: unknown[]): Item[] {
		return items.map((entry) => {
			const item = entry as Item;
			if (typeof snapshotId !== "string" || typeof item.ref !== "string") {
				return item;
			}
			const key = `${snapshotId}\0${item.ref}`;
			if (!this.#seen.has(key)) {
				this.#seen.add(key);
				return item;
			}
			return {
				ref: item.ref,
				type: item.type,
				already_provided: true,
				local: item.local,
			};
		});
	}
}
