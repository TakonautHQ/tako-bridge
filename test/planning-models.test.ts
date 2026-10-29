import { describe, expect, it } from "vitest";

import { availableModelKeys } from "../src/planning-models";

describe("availableModelKeys", () => {
	it("lists the models Pi has credentials for as provider/id, once each", () => {
		const registry = {
			getAvailable: () => [
				{ provider: "anthropic", id: "claude-opus-5-5" },
				{ provider: "openai", id: "gpt-5.2" },
				{ provider: "anthropic", id: "claude-opus-5-5" },
			],
		};
		expect(availableModelKeys(registry)).toEqual(["anthropic/claude-opus-5-5", "openai/gpt-5.2"]);
	});

	it("is unknown (not empty) before Pi has handed over its registry", () => {
		expect(availableModelKeys(null)).toBeUndefined();
	});

	it("is unknown when the registry fails, so the server keeps the last report", () => {
		const registry = {
			getAvailable: () => {
				throw new Error("models.json is invalid");
			},
		};
		expect(availableModelKeys(registry)).toBeUndefined();
	});

	it("drops entries without a provider or id", () => {
		const registry = {
			getAvailable: () => [
				{ provider: "", id: "x" },
				{ provider: "ollama", id: "" },
				{ provider: "ollama", id: "qwen3-coder:32b" },
			],
		};
		expect(availableModelKeys(registry)).toEqual(["ollama/qwen3-coder:32b"]);
	});
});
