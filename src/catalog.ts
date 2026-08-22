import {
	CLI_CATALOG_DEFAULT_RESULTS,
	CLI_CATALOG_MAX_QUERY_BYTES,
	CLI_CATALOG_MAX_QUERY_TERMS,
	CLI_CATALOG_MAX_RESULTS,
} from "./limits.js";
import type { LoadedRegistryDefinition } from "./types.js";

export type CatalogAvailability =
	| "unknown"
	| "registered"
	| "missing"
	| "disabled"
	| "quarantined"
	| "collision"
	| "unsupported"
	| "registration_failed"
	| "filtered_by_pi"
	| "ownership_changed";

export interface CatalogEntryState {
	readonly registry: LoadedRegistryDefinition;
	readonly availability: CatalogAvailability;
	readonly active: boolean;
	readonly enableable: boolean;
	readonly reason: string | null;
}

export interface CatalogSearchRequest {
	readonly query: string;
	readonly limit?: number;
}

export interface CatalogSearchMatch {
	readonly registryId: string;
	readonly toolName: string;
	readonly description: string;
	readonly matchedFields: readonly string[];
	readonly score: number;
	readonly coveredTerms: number;
	readonly active: boolean;
	readonly enableable: boolean;
	readonly availability: CatalogAvailability;
	readonly unavailableReason: string | null;
}

export interface ValidatedCatalogQuery {
	readonly phrase: string;
	readonly terms: readonly string[];
	readonly limit: number;
}

export class CatalogRequestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CatalogRequestError";
	}
}

/** Validate and normalize a bounded lexical catalog query. */
export function validateCatalogSearchRequest(request: unknown): ValidatedCatalogQuery {
	if (!isRecord(request)) throw new CatalogRequestError("Search input must be an object");
	if (Object.keys(request).some((key) => key !== "query" && key !== "limit")) {
		throw new CatalogRequestError("Search input contains an unknown field");
	}
	if (typeof request.query !== "string") throw new CatalogRequestError("query must be a string");
	if (
		request.query.length === 0 ||
		Buffer.byteLength(request.query, "utf8") > CLI_CATALOG_MAX_QUERY_BYTES ||
		hasControlCharacter(request.query) ||
		/\p{Cf}/u.test(request.query)
	) {
		throw new CatalogRequestError(
			`query must be nonempty printable text of at most ${String(CLI_CATALOG_MAX_QUERY_BYTES)} UTF-8 bytes`,
		);
	}
	const phrase = normalizePhrase(request.query);
	const terms = unique(tokenize(phrase));
	if (phrase.length === 0 || terms.length === 0 || terms.length > CLI_CATALOG_MAX_QUERY_TERMS) {
		throw new CatalogRequestError(`query must contain 1 through ${String(CLI_CATALOG_MAX_QUERY_TERMS)} lexical terms`);
	}
	const limit = request.limit ?? CLI_CATALOG_DEFAULT_RESULTS;
	if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > CLI_CATALOG_MAX_RESULTS) {
		throw new CatalogRequestError(`limit must be an integer from 1 through ${String(CLI_CATALOG_MAX_RESULTS)}`);
	}
	return { phrase, terms, limit };
}

/** Search trusted final registry metadata only. No runtime I/O is performed. */
export function searchCatalog(
	entries: readonly CatalogEntryState[],
	request: CatalogSearchRequest,
): CatalogSearchMatch[] {
	const query = validateCatalogSearchRequest(request);
	return entries
		.map((entry) => scoreEntry(entry, query))
		.filter((match): match is CatalogSearchMatch => match !== undefined && match.score > 0)
		.sort((left, right) => {
			if (left.score !== right.score) return right.score - left.score;
			if (left.coveredTerms !== right.coveredTerms) return right.coveredTerms - left.coveredTerms;
			return compareStrings(left.registryId, right.registryId);
		})
		.slice(0, query.limit);
}

function scoreEntry(entry: CatalogEntryState, query: ValidatedCatalogQuery): CatalogSearchMatch | undefined {
	const { definition } = entry.registry;
	const id = normalizePhrase(definition.id);
	const tool = normalizePhrase(definition.tool_name);
	const candidates = definition.binary.candidates.map(normalizePhrase);
	const keywords = (definition.routing.keywords ?? []).map(normalizePhrase);
	const prefer = (definition.routing.prefer_for ?? []).map(normalizePhrase);
	const avoid = (definition.routing.avoid_for ?? []).map(normalizePhrase);
	const description = normalizePhrase(definition.routing.description);
	const identity = [id, tool, ...candidates];
	const matchedFields = new Set<string>();
	let score = 0;
	if (query.phrase === id) {
		score += 1_000;
		matchedFields.add("id");
	} else if (query.phrase === tool) {
		score += 950;
		matchedFields.add("tool_name");
	} else if (candidates.includes(query.phrase) || keywords.includes(query.phrase)) {
		score += 900;
		matchedFields.add(candidates.includes(query.phrase) ? "candidate" : "keyword");
	}

	let coveredTerms = 0;
	for (const term of query.terms) {
		let covered = false;
		if (identity.some((value) => tokenize(value).includes(term))) {
			score += 120;
			covered = true;
			matchedFields.add(term === id ? "id" : term === tool ? "tool_name" : "candidate");
		}
		if (keywords.some((value) => tokenize(value).includes(term))) {
			score += 100;
			covered = true;
			matchedFields.add("keyword");
		}
		if (identity.some((value) => tokenize(value).some((token) => token.startsWith(term)))) {
			score += 60;
			covered = true;
			matchedFields.add("identity_prefix");
		}
		if (prefer.some((value) => tokenize(value).includes(term))) {
			score += 40;
			covered = true;
			matchedFields.add("prefer_for");
		}
		if (tokenize(description).includes(term)) {
			score += 25;
			covered = true;
			matchedFields.add("description");
		}
		if (avoid.some((value) => tokenize(value).includes(term))) {
			score -= 40;
			matchedFields.add("avoid_for");
		}
		if (covered) coveredTerms += 1;
	}
	if (coveredTerms === query.terms.length) score += 100;
	if (score <= 0) return undefined;
	return {
		registryId: definition.id,
		toolName: definition.tool_name,
		description: definition.routing.description,
		matchedFields: [...matchedFields].sort(compareStrings),
		score,
		coveredTerms,
		active: entry.active,
		enableable: entry.enableable,
		availability: entry.availability,
		unavailableReason: entry.reason,
	};
}

export function normalizeCatalogTerms(value: string): readonly string[] {
	return unique(tokenize(normalizePhrase(value)));
}

function normalizePhrase(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function tokenize(value: string): string[] {
	return value.match(/[\p{L}\p{N}]+/gu) ?? [];
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 0x20 || (code >= 0x7f && code <= 0x9f);
	});
}

function compareStrings(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
