import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { TakonautClient, TakonautMcpTool } from "./client";

const LOCAL_PREFIX = "tako_mcp_";
const MAX_TOOL_TEXT_BYTES = 8 * 1024;
const TRUNCATION_MARKER = "\n…[truncated]";
const LEGACY_GATEWAY_TOOL_NAMES = new Set([
	"bridge_search_capabilities",
	"bridge_read_capability",
	"bridge_prepare_action",
	"bridge_execute_action",
]);

type DynamicToolApi = Pick<
	ExtensionAPI,
	"registerTool" | "getActiveTools" | "setActiveTools"
>;

export interface PreparedTakonautCatalog {
	readonly client: TakonautClient;
	readonly tools: ReadonlyMap<string, string>;
}

function boundedText(value: string): string {
	if (Buffer.byteLength(value, "utf8") <= MAX_TOOL_TEXT_BYTES) return value;
	const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
	const bytes = Buffer.from(value, "utf8");
	const head = bytes
		.subarray(0, MAX_TOOL_TEXT_BYTES - markerBytes - 3)
		.toString("utf8")
		.replace(/\uFFFD$/, "");
	return `${head}${TRUNCATION_MARKER}`;
}

function toolResult(payload: unknown) {
	const preview =
		payload !== null &&
		typeof payload === "object" &&
		!Array.isArray(payload) &&
		typeof (payload as { preview?: unknown }).preview === "string"
			? (payload as { preview: string }).preview
			: JSON.stringify(payload);
	return {
		content: [{ type: "text" as const, text: boundedText(preview) }],
		details: {},
	};
}

function localToolName(serverName: string): string {
	return `${LOCAL_PREFIX}${serverName}`;
}

function parametersFor(tool: TakonautMcpTool) {
	if (tool.inputSchema.type !== "object") {
		throw new Error(
			"Takonaut returned an MCP input schema without object type.",
		);
	}
	return Type.Unsafe(tool.inputSchema as any);
}

/** Runtime registry for the caller-filtered Takonaut MCP catalog. */
export class TakonautToolCatalog {
	private readonly registered = new Set<string>();
	private active = new Map<string, string>();
	private activeClient: TakonautClient | null = null;

	constructor(
		private readonly pi: DynamicToolApi,
		private readonly getClient: () => TakonautClient | null,
	) {}

	/** Validate and register definitions without changing the active catalog. */
	async prepare(
		client: TakonautClient,
		verifiedTools?: TakonautMcpTool[],
	): Promise<PreparedTakonautCatalog> {
		const activeBefore = this.pi.getActiveTools();
		try {
			const tools = verifiedTools ?? (await client.listTools());
			const next = new Map<string, string>();
			const prepared = tools
				.filter((tool) => !LEGACY_GATEWAY_TOOL_NAMES.has(tool.name))
				.map((tool) => ({ tool, parameters: parametersFor(tool) }));

			for (const { tool, parameters } of prepared) {
				const localName = localToolName(tool.name);
				if (next.has(localName)) {
					throw new Error("Takonaut returned duplicate local MCP tool names.");
				}
				next.set(localName, tool.name);
				if (this.registered.has(localName)) continue;

				this.pi.registerTool({
					name: localName,
					label: `Takonaut: ${tool.name}`,
					description:
						tool.description ||
						`Run the authorized Takonaut MCP tool ${tool.name}.`,
					promptSnippet: `Run Takonaut MCP tool ${tool.name}`,
					parameters,
					execute: async (
						_toolCallId: string,
						params: Record<string, unknown>,
						signal?: AbortSignal,
					) => {
						if (signal?.aborted) {
							throw new Error("Takonaut MCP tool call cancelled");
						}
						const activeServerName = this.active.get(localName);
						const currentClient = this.activeClient;
						if (!activeServerName || !currentClient) {
							return toolResult({ error: "capability_unavailable" });
						}
						return toolResult(
							await currentClient.callTool(activeServerName, params),
						);
					},
				});
				this.registered.add(localName);
			}
			// Definitions are prepared but remain inactive until the caller commits
			// the authenticated configuration and explicitly activates the catalog.
			this.pi.setActiveTools(activeBefore);
			return { client, tools: next };
		} catch (error) {
			// registerTool may activate definitions immediately. Restore the exact
			// pre-prepare set so a partial catalog can never become model-visible.
			this.pi.setActiveTools(activeBefore);
			throw error;
		}
	}

	snapshot(): PreparedTakonautCatalog | null {
		if (!this.activeClient) return null;
		return { client: this.activeClient, tools: new Map(this.active) };
	}

	activate(prepared: PreparedTakonautCatalog): string[] {
		const previousActive = this.active;
		const previousClient = this.activeClient;
		const previousToolNames = this.pi.getActiveTools();
		this.active = new Map(prepared.tools);
		this.activeClient = prepared.client;
		try {
			this.syncActiveTools();
			return [...this.active.keys()];
		} catch (error) {
			this.active = previousActive;
			this.activeClient = previousClient;
			try {
				this.pi.setActiveTools(previousToolNames);
			} catch {
				// The original activation error remains the actionable failure.
			}
			throw error;
		}
	}

	async refresh(
		client = this.getClient(),
		verifiedTools?: TakonautMcpTool[],
	): Promise<string[]> {
		if (!client) {
			this.clear();
			return [];
		}
		try {
			return this.activate(await this.prepare(client, verifiedTools));
		} catch (error) {
			// Fail closed: a failed reconnect or organization refresh must not leave
			// a stale Takonaut catalog visible in Pi.
			this.clear();
			throw error;
		}
	}

	clear(): void {
		this.active = new Map();
		this.activeClient = null;
		this.syncActiveTools();
	}

	private syncActiveTools(): void {
		const next = this.pi
			.getActiveTools()
			.filter((name) => !this.registered.has(name));
		for (const name of this.active.keys()) {
			if (!next.includes(name)) next.push(name);
		}
		this.pi.setActiveTools(next);
	}
}
