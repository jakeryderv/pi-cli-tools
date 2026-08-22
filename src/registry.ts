import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";

import Value from "typebox/value";
import { isMap, isScalar, parseDocument, type Document } from "yaml";

import {
	DisabledRegistryEntrySchema,
	RegistryDefinitionSchema,
	RegistryIdSchema,
	type DisabledRegistryEntry,
	type LoadedDisabledEntry,
	type LoadedRegistryDefinition,
	type RegistryDefinition,
	type RegistryEntry,
	type RegistryIssue,
	type RegistryLayer,
	type RegistryLayerSummary,
	type RegistryLoadResult,
	type QuarantinedRegistryId,
	type RegistrySource,
} from "./types.js";

const REGISTRY_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const MAX_REGISTRY_FILE_BYTES = 256 * 1024;
const MAX_REGISTRY_FILES_PER_LAYER = 256;
const MAX_SCHEMA_ERRORS = 8;

interface ParsedEntry {
	entry: RegistryEntry;
	source: RegistrySource;
}

interface ParsedLayer {
	entries: ParsedEntry[];
	issues: RegistryIssue[];
	invalidIds: Map<string, string[]>;
	summary: RegistryLayerSummary;
}

/** Load, validate, and merge registry layers in ascending precedence order. */
export async function loadRegistry(layers: readonly RegistryLayer[]): Promise<RegistryLoadResult> {
	const definitions = new Map<string, LoadedRegistryDefinition>();
	const disabled = new Map<string, LoadedDisabledEntry>();
	const issues: RegistryIssue[] = [];
	const summaries: RegistryLayerSummary[] = [];
	const quarantined = new Map<string, QuarantinedRegistryId>();

	for (const layer of layers) {
		const parsed = await parseLayer(layer);
		issues.push(...parsed.issues);
		summaries.push(parsed.summary);

		const entriesById = groupBy(parsed.entries, ({ entry }) => entry.id);
		const touchedIds = new Set([...entriesById.keys(), ...parsed.invalidIds.keys()]);
		for (const id of touchedIds) {
			const entries = entriesById.get(id) ?? [];
			const invalidPaths = parsed.invalidIds.get(id) ?? [];
			if (entries.length > 1) {
				issues.push({
					code: "duplicate_id",
					layer: layer.name,
					message: `Registry ID "${id}" is declared more than once in layer "${layer.name}": ${entries
						.map(({ source }) => source.path)
						.join(", ")}`,
				});
			}

			if (entries.length > 1 || invalidPaths.length > 0) {
				quarantined.set(id, {
					id,
					layer: layer.name,
					paths: [...new Set([...entries.map(({ source }) => source.path), ...invalidPaths])].sort(compareStrings),
					reason: entries.length > 1 ? "duplicate_id" : "invalid_override",
				});
				continue;
			}

			const parsedEntry = entries[0];
			if (!parsedEntry) continue;
			quarantined.delete(id);

			if (isDisabledEntry(parsedEntry.entry)) {
				definitions.delete(id);
				disabled.set(id, {
					entry: parsedEntry.entry,
					source: parsedEntry.source,
				});
				continue;
			}

			disabled.delete(id);
			definitions.set(id, {
				definition: parsedEntry.entry,
				source: parsedEntry.source,
			});
		}
	}

	const executableDefinitions = new Map([...definitions].filter(([id]) => !quarantined.has(id)));
	const conflictingIds = findToolNameConflicts(executableDefinitions, issues);
	const mergedDefinitions = [...definitions.values()]
		.filter(({ definition }) => !conflictingIds.has(definition.id))
		.sort(compareDefinitionIds);

	return {
		definitions: mergedDefinitions,
		disabled: [...disabled.values()].sort((left, right) => compareStrings(left.entry.id, right.entry.id)),
		quarantined: [...quarantined.values()].sort((left, right) => compareStrings(left.id, right.id)),
		issues,
		layers: summaries,
	};
}

async function parseLayer(layer: RegistryLayer): Promise<ParsedLayer> {
	const issues: RegistryIssue[] = [];
	const invalidIds = new Map<string, string[]>();
	let directoryEntries;

	try {
		directoryEntries = await readdir(layer.directory, { withFileTypes: true });
	} catch (error) {
		const missing = isErrorCode(error, "ENOENT");
		if (!missing || layer.required) {
			issues.push({
				code: "layer_read_error",
				layer: layer.name,
				message: missing
					? `Required registry directory does not exist: ${layer.directory}`
					: `Unable to read registry directory ${layer.directory}: ${getErrorMessage(error)}`,
			});
		}

		return {
			entries: [],
			issues,
			invalidIds,
			summary: createLayerSummary(layer, false, []),
		};
	}

	const matchingFiles = directoryEntries
		.flatMap((entry) =>
			entry.isFile() && REGISTRY_EXTENSIONS.has(extname(entry.name).toLowerCase())
				? [join(layer.directory, entry.name)]
				: [],
		)
		.sort(compareStrings);
	const files = matchingFiles.slice(0, MAX_REGISTRY_FILES_PER_LAYER);
	if (matchingFiles.length > MAX_REGISTRY_FILES_PER_LAYER) {
		issues.push({
			code: "layer_read_error",
			layer: layer.name,
			message: `Registry layer contains ${String(matchingFiles.length)} files; only the first ${String(MAX_REGISTRY_FILES_PER_LAYER)} are loaded`,
		});
	}
	const entries: ParsedEntry[] = [];

	for (const path of files) {
		const parsed = await parseRegistryFile(layer, path);
		issues.push(...parsed.issues);
		if (parsed.entry) entries.push(parsed.entry);
		if (parsed.invalidId) {
			const paths = invalidIds.get(parsed.invalidId);
			if (paths) paths.push(path);
			else invalidIds.set(parsed.invalidId, [path]);
		}
	}

	return {
		entries,
		issues,
		invalidIds,
		summary: createLayerSummary(layer, true, files),
	};
}

async function parseRegistryFile(
	layer: RegistryLayer,
	path: string,
): Promise<{ entry?: ParsedEntry; invalidId?: string; issues: RegistryIssue[] }> {
	const source = { layer: layer.name, path };
	let contents: string;

	try {
		const metadata = await stat(path);
		if (metadata.size > MAX_REGISTRY_FILE_BYTES) {
			return {
				issues: [
					createFileIssue(
						"file_too_large",
						layer,
						path,
						`Registry file exceeds ${String(MAX_REGISTRY_FILE_BYTES)} bytes`,
					),
				],
			};
		}
		contents = await readFile(path, "utf8");
	} catch (error) {
		return {
			issues: [
				createFileIssue("file_read_error", layer, path, `Unable to read registry file: ${getErrorMessage(error)}`),
			],
		};
	}

	const document = parseDocument(contents, { uniqueKeys: true });
	const recoverableId = getUnambiguousDocumentRegistryId(document);
	if (document.errors.length > 0) {
		return {
			...(recoverableId ? { invalidId: recoverableId } : {}),
			issues: [
				createFileIssue("yaml_parse_error", layer, path, document.errors.map(({ message }) => message).join("; ")),
			],
		};
	}
	if (document.warnings.length > 0) {
		return {
			...(recoverableId ? { invalidId: recoverableId } : {}),
			issues: [
				createFileIssue("yaml_warning", layer, path, document.warnings.map(({ message }) => message).join("; ")),
			],
		};
	}

	let value: unknown;
	try {
		value = document.toJS({ maxAliasCount: 100 });
	} catch (error) {
		return {
			...(recoverableId ? { invalidId: recoverableId } : {}),
			issues: [createFileIssue("yaml_parse_error", layer, path, `Unable to convert YAML: ${getErrorMessage(error)}`)],
		};
	}

	const parsed = parseRegistryEntry(value);
	if ("errors" in parsed) {
		const invalidId = getValidRegistryId(value);
		return {
			...(invalidId ? { invalidId } : {}),
			issues: [createFileIssue("invalid_definition", layer, path, parsed.errors.join("; "))],
		};
	}

	if (!isDisabledEntry(parsed.entry)) {
		const customIssue = validateDefinition(parsed.entry, layer, path);
		if (customIssue) return { invalidId: parsed.entry.id, issues: [customIssue] };
	}

	return {
		entry: { entry: parsed.entry, source },
		issues: [],
	};
}

function parseRegistryEntry(value: unknown): { entry: RegistryEntry } | { errors: string[] } {
	if (isRecord(value) && value.disabled === true) {
		if (Value.Check(DisabledRegistryEntrySchema, value)) {
			return { entry: Value.Parse(DisabledRegistryEntrySchema, value) };
		}
		return { errors: formatSchemaErrors(DisabledRegistryEntrySchema, value) };
	}

	if (Value.Check(RegistryDefinitionSchema, value)) {
		return { entry: Value.Parse(RegistryDefinitionSchema, value) };
	}
	return { errors: formatSchemaErrors(RegistryDefinitionSchema, value) };
}

function validateDefinition(
	definition: RegistryDefinition,
	layer: RegistryLayer,
	path: string,
): RegistryIssue | undefined {
	if (definition.binary.candidates.some((candidate) => candidate === "." || candidate === "..")) {
		return createFileIssue("invalid_definition", layer, path, "Binary candidates cannot be '.' or '..'");
	}

	for (const source of definition.docs.official) {
		try {
			const url = new URL(source);
			if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
		} catch {
			return createFileIssue("invalid_url", layer, path, `Official documentation URL is invalid: ${source}`);
		}
	}

	return undefined;
}

function findToolNameConflicts(
	definitions: ReadonlyMap<string, LoadedRegistryDefinition>,
	issues: RegistryIssue[],
): Set<string> {
	const byToolName = groupBy(definitions.values(), ({ definition }) => definition.tool_name);
	const conflictingIds = new Set<string>();

	for (const [toolName, entries] of byToolName) {
		if (entries.length < 2) continue;

		for (const { definition } of entries) conflictingIds.add(definition.id);
		issues.push({
			code: "duplicate_tool_name",
			layer: "merged",
			message: `Pi tool name "${toolName}" is used by multiple registry entries: ${entries
				.map(({ definition, source }) => `${definition.id} (${source.path})`)
				.join(", ")}`,
		});
	}

	return conflictingIds;
}

function formatSchemaErrors(
	schema: typeof RegistryDefinitionSchema | typeof DisabledRegistryEntrySchema,
	value: unknown,
): string[] {
	const errors = [...Value.Errors(schema, value)];
	const formatted = errors
		.slice(0, MAX_SCHEMA_ERRORS)
		.map(({ instancePath, message }) => `${instancePath || "/"} ${message}`);
	if (errors.length > MAX_SCHEMA_ERRORS) {
		formatted.push(`${String(errors.length - MAX_SCHEMA_ERRORS)} more validation errors`);
	}
	return formatted;
}

function createLayerSummary(layer: RegistryLayer, exists: boolean, files: string[]): RegistryLayerSummary {
	return {
		name: layer.name,
		kind: layer.kind,
		directory: layer.directory,
		required: layer.required,
		exists,
		files,
	};
}

function createFileIssue(
	code: RegistryIssue["code"],
	layer: RegistryLayer,
	path: string,
	message: string,
): RegistryIssue {
	return { code, layer: layer.name, path, message };
}

function isDisabledEntry(entry: RegistryEntry): entry is DisabledRegistryEntry {
	return "disabled" in entry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getValidRegistryId(value: unknown): string | undefined {
	if (!isRecord(value) || !Value.Check(RegistryIdSchema, value.id)) return undefined;
	return Value.Parse(RegistryIdSchema, value.id);
}

function getUnambiguousDocumentRegistryId(document: Document.Parsed): string | undefined {
	if (!isMap(document.contents)) return undefined;
	const idPairs = document.contents.items.filter(({ key }) => isScalar(key) && key.value === "id");
	if (idPairs.length !== 1) return undefined;
	const value = idPairs[0]?.value;
	if (!isScalar(value) || !Value.Check(RegistryIdSchema, value.value)) return undefined;
	return Value.Parse(RegistryIdSchema, value.value);
}

function isErrorCode(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error && error.code === code;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function groupBy<T, Key>(values: Iterable<T>, getKey: (value: T) => Key): Map<Key, T[]> {
	const groups = new Map<Key, T[]>();
	for (const value of values) {
		const key = getKey(value);
		const group = groups.get(key);
		if (group) group.push(value);
		else groups.set(key, [value]);
	}
	return groups;
}

function compareDefinitionIds(left: LoadedRegistryDefinition, right: LoadedRegistryDefinition): number {
	return compareStrings(left.definition.id, right.definition.id);
}

function compareStrings(left: string, right: string): number {
	if (left < right) return -1;
	if (left > right) return 1;
	return 0;
}
