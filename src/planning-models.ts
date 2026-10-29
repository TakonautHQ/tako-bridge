/**
 * The models this Pi can run, as reported on each Bridge heartbeat (Grill v2).
 * A Grill hosted on this Pi can only pick one of these, so the list is Pi's
 * own `getAvailable()` (models with configured credentials), not every model
 * Pi knows about.
 */

export interface ModelRegistryLike {
	getAvailable(): { provider: string; id: string }[];
}

/**
 * `provider/id` keys, once each and in Pi's order; `undefined` (not `[]`)
 * when the registry isn't known yet or fails, so the server keeps its last
 * report instead of hearing "no models".
 */
export function availableModelKeys(registry: ModelRegistryLike | null | undefined): string[] | undefined {
	if (!registry) return undefined;
	let models: { provider: string; id: string }[];
	try {
		models = registry.getAvailable();
	} catch {
		return undefined;
	}
	const keys: string[] = [];
	for (const model of models) {
		if (!model?.provider || !model?.id) continue;
		const key = `${model.provider}/${model.id}`;
		if (!keys.includes(key)) keys.push(key);
	}
	return keys;
}
