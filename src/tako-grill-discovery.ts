import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	GrillSearchPicker,
	safeGrillLabel,
	type GrillPickerPage,
} from "./tako-grill-picker.js";

const PROJECT_KEY = /^[A-Za-z0-9_-]{1,50}$/;
const UUID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECT_LIMIT = 20;
const PARENT_LIMIT = 50;

type CallDiscovery = (
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<unknown>;
type Project = { key: string; name: string };
type Parent = {
	id: string;
	title: string;
	levelName: string;
	resumable: boolean;
};
type Ui = Pick<ExtensionCommandContext, "ui" | "mode">;

class GrillDiscoveryTooLarge extends Error {}

function checkSignal(signal?: AbortSignal): void {
	signal?.throwIfAborted();
}

export async function listGrillProjects(
	call: CallDiscovery,
	query = "",
	signal?: AbortSignal,
): Promise<Project[]> {
	checkSignal(signal);
	const result = await call(
		"list_projects",
		{ query, limit: PROJECT_LIMIT },
		signal,
	);
	checkSignal(signal);
	if (!Array.isArray(result)) {
		if (
			result &&
			typeof result === "object" &&
			(result as Record<string, unknown>).truncated === true
		) {
			throw new GrillDiscoveryTooLarge(
				"Project list is too large; search by Project name or key",
			);
		}
		throw new Error("Takonaut returned an invalid Project list");
	}
	return result.map((entry) => {
		if (
			!entry ||
			typeof entry !== "object" ||
			!PROJECT_KEY.test(entry.key) ||
			typeof entry.name !== "string"
		) {
			throw new Error("Takonaut returned an invalid Project");
		}
		return { key: entry.key as string, name: entry.name as string };
	});
}

export async function listGrillParents(
	call: CallDiscovery,
	projectKey: string,
	query = "",
	signal?: AbortSignal,
): Promise<{ items: Parent[]; truncated: boolean }> {
	checkSignal(signal);
	const result = await call(
		"list_tako_grill_parents",
		{ project_key: projectKey, query, limit: PARENT_LIMIT },
		signal,
	);
	checkSignal(signal);
	if (!result || typeof result !== "object" || Array.isArray(result))
		throw new Error("Takonaut returned an invalid Work hierarchy list");
	const data = result as Record<string, unknown>;
	if (data.truncated === true && !Array.isArray(data.items)) {
		throw new GrillDiscoveryTooLarge(
			"Work hierarchy list is too large; search by title or PRD number",
		);
	}
	if (
		data.project_key !== projectKey ||
		!Array.isArray(data.items) ||
		typeof data.truncated !== "boolean"
	) {
		throw new Error("Takonaut returned an invalid Work hierarchy list");
	}
	return {
		truncated: data.truncated,
		items: data.items.map((entry: unknown) => {
			if (!entry || typeof entry !== "object")
				throw new Error("Takonaut returned an invalid Work item");
			const row = entry as Record<string, unknown>;
			if (
				typeof row.id !== "string" ||
				!UUID.test(row.id) ||
				typeof row.title !== "string" ||
				typeof row.level_name !== "string"
			) {
				throw new Error("Takonaut returned an invalid Work item");
			}
			return {
				id: row.id,
				title: row.title,
				levelName: row.level_name,
				resumable: typeof row.resumable_session_id === "string",
			};
		}),
	};
}

function projectPage(projects: Project[]): GrillPickerPage {
	return {
		items: projects.map((p) => ({
			value: p.key,
			label: `${safeGrillLabel(p.name)} · ${p.key}`,
		})),
		truncated: projects.length === PROJECT_LIMIT,
	};
}

function parentPage(
	parents: { items: Parent[]; truncated: boolean },
	projectKey?: string,
): GrillPickerPage {
	return {
		items: parents.items.map((item) => ({
			value: item.id,
			label: `${safeGrillLabel(item.title)} · ${safeGrillLabel(item.levelName)} · ${item.id}`,
			description: [projectKey, item.resumable ? "Resume" : ""]
				.filter(Boolean)
				.join(" · "),
		})),
		truncated: parents.truncated,
	};
}

async function pick(
	ui: Ui,
	title: string,
	initial: GrillPickerPage,
	search: (query: string, signal: AbortSignal) => Promise<GrillPickerPage>,
	signal?: AbortSignal,
): Promise<string | undefined> {
	checkSignal(signal);
	if (ui.mode === "tui") {
		let picker: GrillSearchPicker | undefined;
		let abort: (() => void) | undefined;
		try {
			const choice = await ui.ui.custom<string | null>(
				(tui, theme, _keys, done) => {
					picker = new GrillSearchPicker(theme, {
						title,
						initial,
						search: (query, localSignal) =>
							search(
								query,
								signal ? AbortSignal.any([signal, localSignal]) : localSignal,
							),
						onSelect: (value) => done(value),
						onCancel: () => done(null),
						onChange: () => tui.requestRender(),
					});
					abort = () => {
						picker?.dispose();
						done(null);
					};
					signal?.addEventListener("abort", abort, { once: true });
					return picker;
				},
			);
			checkSignal(signal);
			return choice ?? undefined;
		} finally {
			if (abort) signal?.removeEventListener("abort", abort);
			picker?.dispose();
		}
	}
	// RPC has select/input dialogs but no custom TUI component. Provide an
	// explicit searchable option instead of silently limiting the first page.
	let page = initial;
	for (;;) {
		const options = new Map(page.items.map((item) => [item.label, item.value]));
		const searchLabel = `Search ${title.toLowerCase()}…`;
		const selected = await ui.ui.select(title, [
			...options.keys(),
			searchLabel,
		]);
		checkSignal(signal);
		if (!selected) return undefined;
		if (selected !== searchLabel) return options.get(selected);
		const query = await ui.ui.input(
			`Search ${title.toLowerCase()}`,
			"Type a name, key, or PRD number",
		);
		checkSignal(signal);
		if (query === undefined) return undefined;
		if (query.trim().length > 200)
			throw new Error("Search is limited to 200 characters");
		page = await search(query.trim(), signal ?? new AbortController().signal);
		checkSignal(signal);
	}
}

export async function chooseGrillParent(input: {
	query: string | null;
	call: CallDiscovery;
	ui: Ui;
	signal?: AbortSignal;
}): Promise<{ projectKey: string; parentId: string }> {
	const { call, ui, signal } = input;
	let projects: Project[] = [];
	let projectListTooLarge = false;
	try {
		projects = await listGrillProjects(call, "", signal);
	} catch (error) {
		if (!(error instanceof GrillDiscoveryTooLarge)) throw error;
		projectListTooLarge = true;
	}
	if (!projects.length && !projectListTooLarge)
		throw new Error("No accessible Projects were found");
	if (input.query) {
		if (projectListTooLarge || projects.length === PROJECT_LIMIT)
			throw new Error(
				"Project discovery is incomplete for cross-Project search; browse a Project to narrow the search",
			);
		const matches: Array<{ projectKey: string; parent: Parent }> = [];
		for (const project of projects) {
			checkSignal(signal);
			let page: Awaited<ReturnType<typeof listGrillParents>>;
			try {
				page = await listGrillParents(call, project.key, input.query, signal);
			} catch (error) {
				checkSignal(signal);
				if (
					/Tako Grill is unavailable|Permission denied|forbidden|feature_disabled/i.test(
						String(error),
					)
				)
					continue;
				throw error;
			}
			if (page.truncated)
				throw new Error(
					"Too many Work items match; refine your search in the Project browser",
				);
			matches.push(
				...page.items.map((parent) => ({ projectKey: project.key, parent })),
			);
		}
		if (!matches.length)
			throw new Error(`No accessible Work item matches “${input.query}”`);
		const initial: GrillPickerPage = {
			items: matches.map(({ projectKey, parent }) => ({
				value: `${projectKey}:${parent.id}`,
				label: `${safeGrillLabel(parent.title)} · ${safeGrillLabel(parent.levelName)} · ${projectKey} · ${parent.id}`,
				description: parent.resumable ? "Resume" : undefined,
			})),
			truncated: false,
		};
		const selected = await pick(
			ui,
			"Matching Work items",
			initial,
			async (query) => ({
				items: initial.items.filter((item) =>
					item.label.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
				),
				truncated: false,
			}),
			signal,
		);
		const found = matches.find(
			({ projectKey, parent }) => `${projectKey}:${parent.id}` === selected,
		);
		if (!found) throw new Error("Tako Grill selection was cancelled");
		return { projectKey: found.projectKey, parentId: found.parent.id };
	}
	const selectedProject = await pick(
		ui,
		"Tako Grill Project",
		projectListTooLarge
			? { items: [], truncated: true }
			: projectPage(projects),
		async (query, requestSignal) =>
			projectPage(await listGrillProjects(call, query, requestSignal)),
		signal,
	);
	if (
		!selectedProject ||
		!projects.some((project) => project.key === selectedProject)
	) {
		// Search can return a Project outside the initial capped page.
		if (!selectedProject || !PROJECT_KEY.test(selectedProject))
			throw new Error("Tako Grill selection was cancelled");
	}
	let initialParents: Awaited<ReturnType<typeof listGrillParents>>;
	try {
		initialParents = await listGrillParents(call, selectedProject, "", signal);
	} catch (error) {
		if (!(error instanceof GrillDiscoveryTooLarge)) throw error;
		initialParents = { items: [], truncated: true };
	}
	const selectedParent = await pick(
		ui,
		"Tako Grill Work hierarchy",
		parentPage(initialParents),
		async (query, requestSignal) =>
			parentPage(
				await listGrillParents(call, selectedProject, query, requestSignal),
			),
		signal,
	);
	if (!selectedParent || !UUID.test(selectedParent))
		throw new Error("Tako Grill selection was cancelled");
	return { projectKey: selectedProject, parentId: selectedParent };
}
