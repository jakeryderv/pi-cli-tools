import { readFile, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { isIP } from "node:net";

import Value from "typebox/value";
import { isMap, isScalar, parseDocument, type Document } from "yaml";

import {
	AcceptedExitCodesSchema,
	DisabledRegistryEntrySchema,
	RegistryDefinitionSchema,
	RegistryIdSchema,
	type DisabledRegistryEntry,
	type LoadedDisabledEntry,
	type LoadedRegistryDefinition,
	type OfficialDocumentationSource,
	type RegistryDefinition,
	type RegistryEntry,
	type RegistryIssue,
	type RegistryLayer,
	type RegistryLayerSummary,
	type RegistryLoadResult,
	type QuarantinedRegistryId,
	type RegistrySource,
} from "./types.js";
import {
	CLI_DOCS_MAX_SUBCOMMAND_BYTES,
	CLI_DOCS_MAX_SUBCOMMAND_SEGMENT_BYTES,
	CLI_INTROSPECTION_SUBCOMMAND_APPEND_MAX_BYTES,
	CLI_MAX_ARGUMENT_BYTES,
	CLI_MAX_TOTAL_ARGUMENT_BYTES,
} from "./limits.js";
import { parseStrictSemver } from "./semver.js";

const REGISTRY_EXTENSIONS = new Set([".json", ".yaml", ".yml"]);
const MAX_REGISTRY_FILE_BYTES = 256 * 1024;
const MAX_REGISTRY_FILES_PER_LAYER = 256;
const MAX_SCHEMA_ERRORS = 8;

export const DEFAULT_ACCEPTED_EXIT_CODES = Object.freeze([0] as const);

/** Omission remains eager for compatibility with pre-v0.3 user definitions. */
export function getActivationPolicy(definition: RegistryDefinition): "eager" | "lazy" {
	return definition.activation ?? "eager";
}

/** Resolve the authoritative definition policy without mutating parsed registry data. */
export function getAcceptedExitCodes(definition: RegistryDefinition): readonly number[] {
	return definition.execution.accepted_exit_codes ?? DEFAULT_ACCEPTED_EXIT_CODES;
}

/** Validate a canonical accepted-exit policy for registry data and serialized result details. */
export function isAcceptedExitCodes(value: unknown): value is number[] {
	if (!Value.Check(AcceptedExitCodesSchema, value)) return false;
	const seen = new Set<number>();
	for (const code of value) {
		// JSON serializes -0 as 0, so accepting it would make detail round-trips lossy.
		if (Object.is(code, -0) || seen.has(code)) return false;
		seen.add(code);
	}
	return true;
}

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
	if (definition.tool_name === "cli_docs" || definition.tool_name === "cli_tools") {
		return createFileIssue("invalid_definition", layer, path, `Pi tool name "${definition.tool_name}" is reserved`);
	}

	if (
		!isUtf8Within(definition.routing.description, 2_048) ||
		definition.routing.keywords?.some((value) => !isUtf8Within(value, 64)) ||
		definition.routing.prefer_for?.some((value) => !isUtf8Within(value, 512)) ||
		definition.routing.avoid_for?.some((value) => !isUtf8Within(value, 512))
	) {
		return createFileIssue("invalid_definition", layer, path, "Routing metadata exceeds its UTF-8 byte bounds");
	}

	const acceptedExitPolicies = [
		definition.execution.accepted_exit_codes,
		definition.introspection.version?.accepted_exit_codes,
		definition.introspection.help?.accepted_exit_codes,
		definition.introspection.subcommand_help?.accepted_exit_codes,
		definition.introspection.man === false ? undefined : definition.introspection.man.accepted_exit_codes,
	];
	if (acceptedExitPolicies.some((codes) => codes !== undefined && !isAcceptedExitCodes(codes))) {
		return createFileIssue(
			"invalid_definition",
			layer,
			path,
			"Accepted exit codes must use canonical non-negative integer representations without duplicates",
		);
	}

	if (definition.binary.candidates.some((candidate) => candidate === "." || candidate === "..")) {
		return createFileIssue("invalid_definition", layer, path, "Binary candidates cannot be '.' or '..'");
	}

	const argumentLists = [
		definition.introspection.version?.args,
		definition.introspection.help?.args,
		definition.introspection.subcommand_help?.append_args,
		definition.introspection.man === false ? undefined : definition.introspection.man.args,
	].filter((args): args is string[] => args !== undefined);
	for (const args of argumentLists) {
		let totalBytes = 0;
		for (const argument of args) {
			const bytes = Buffer.byteLength(argument, "utf8");
			if (argument.includes("\0") || bytes > CLI_MAX_ARGUMENT_BYTES) {
				return createFileIssue(
					"invalid_definition",
					layer,
					path,
					`Introspection arguments must be NUL-free and at most ${String(CLI_MAX_ARGUMENT_BYTES)} UTF-8 bytes each`,
				);
			}
			totalBytes += bytes + 1;
		}
		if (totalBytes > CLI_MAX_TOTAL_ARGUMENT_BYTES) {
			return createFileIssue(
				"invalid_definition",
				layer,
				path,
				`Introspection arguments must total at most ${String(CLI_MAX_TOTAL_ARGUMENT_BYTES)} UTF-8 bytes`,
			);
		}
	}

	const subcommandHelp = definition.introspection.subcommand_help;
	if (subcommandHelp) {
		const appendBytes = subcommandHelp.append_args.reduce(
			(total, argument) => total + Buffer.byteLength(argument, "utf8") + 1,
			0,
		);
		if (appendBytes > CLI_INTROSPECTION_SUBCOMMAND_APPEND_MAX_BYTES) {
			return createFileIssue(
				"invalid_definition",
				layer,
				path,
				`Subcommand help append arguments must reserve ${String(CLI_DOCS_MAX_SUBCOMMAND_BYTES)} UTF-8 bytes for the selected path`,
			);
		}
		const seenPaths = new Set<string>();
		for (const allowedPath of subcommandHelp.allowed_paths) {
			const pathBytes = allowedPath.reduce((total, segment) => total + Buffer.byteLength(segment, "utf8") + 1, 0);
			if (
				pathBytes > CLI_DOCS_MAX_SUBCOMMAND_BYTES ||
				allowedPath.some((segment) => Buffer.byteLength(segment, "utf8") > CLI_DOCS_MAX_SUBCOMMAND_SEGMENT_BYTES)
			) {
				return createFileIssue(
					"invalid_definition",
					layer,
					path,
					"Allowed subcommand paths exceed the configured UTF-8 selector budget",
				);
			}
			const key = JSON.stringify(allowedPath);
			if (seenPaths.has(key)) {
				return createFileIssue("invalid_definition", layer, path, "Allowed subcommand paths must be unique");
			}
			seenPaths.add(key);
		}
	}

	const manCandidates = definition.introspection.man === false ? [] : definition.introspection.man.binary.candidates;
	if (manCandidates.some((candidate) => candidate === "." || candidate === "..")) {
		return createFileIssue("invalid_definition", layer, path, "Man binary candidates cannot be '.' or '..'");
	}

	const officialIds = new Set<string>();
	for (const source of definition.docs.official) {
		if (officialIds.has(source.id)) {
			return createFileIssue("invalid_definition", layer, path, "Official documentation source IDs must be unique");
		}
		officialIds.add(source.id);
		const sourceIssue = validateOfficialDocumentationSource(source, definition);
		if (sourceIssue) return createFileIssue(sourceIssue.code, layer, path, sourceIssue.message);
	}

	return undefined;
}

function isAuthorizedOfficialPath(pathname: string, allowed: string): boolean {
	return (
		pathname === allowed || (allowed.endsWith("/") ? pathname.startsWith(allowed) : pathname.startsWith(`${allowed}/`))
	);
}

function isSafeOfficialPath(pathname: string): boolean {
	return pathname.startsWith("/") && !/%(?:25|2e|2f|5c)/iu.test(pathname) && !pathname.includes("\\");
}

function validateOfficialDocumentationSource(
	source: OfficialDocumentationSource,
	definition: RegistryDefinition,
): { code: "invalid_definition" | "invalid_url"; message: string } | undefined {
	if (!isUtf8Within(source.id, 64) || !isUtf8Within(source.title, 128)) {
		return {
			code: "invalid_definition",
			message: `Official documentation source ${source.id} exceeds its UTF-8 metadata bound`,
		};
	}
	if (!isAscii(source.url) || source.url.includes("\\") || hasAsciiControl(source.url)) {
		return {
			code: "invalid_url",
			message: `Official documentation URL must use bounded ASCII without controls or backslashes: ${source.id}`,
		};
	}
	let url: URL;
	try {
		url = new URL(source.url);
	} catch {
		return { code: "invalid_url", message: `Official documentation URL is invalid: ${source.id}` };
	}
	if (
		url.protocol !== "https:" ||
		url.port !== "" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.hostname !== url.hostname.toLowerCase() ||
		!isValidDnsHostname(url.hostname)
	) {
		return {
			code: "invalid_url",
			message: `Official documentation URL must be fixed public-host HTTPS on port 443 without credentials, query, or fragment: ${source.id}`,
		};
	}
	if (
		source.allowed_hosts.some((host) => !isValidDnsHostname(host) || host !== host.toLowerCase()) ||
		new Set(source.allowed_hosts).size !== source.allowed_hosts.length ||
		!source.allowed_hosts.includes(url.hostname)
	) {
		return {
			code: "invalid_url",
			message: `Official documentation source ${source.id} must exactly allow its canonical URL hostname`,
		};
	}
	if (
		!isAscii(source.allowed_path_prefix) ||
		source.allowed_path_prefix.includes("\\") ||
		hasAsciiControl(source.allowed_path_prefix) ||
		source.allowed_path_prefix.includes("?") ||
		source.allowed_path_prefix.includes("#") ||
		!isSafeOfficialPath(url.pathname) ||
		!isSafeOfficialPath(source.allowed_path_prefix) ||
		!isAuthorizedOfficialPath(url.pathname, source.allowed_path_prefix)
	) {
		return {
			code: "invalid_url",
			message: `Official documentation source ${source.id} has an invalid or non-authorizing path prefix`,
		};
	}
	if (
		source.topics?.some((topic) => !isUtf8Within(topic, 64)) ||
		new Set(source.topics ?? []).size !== (source.topics?.length ?? 0)
	) {
		return {
			code: "invalid_definition",
			message: `Official documentation source ${source.id} has invalid or duplicate topics`,
		};
	}
	if (source.alignment.mode === "exact" || source.alignment.mode === "compatible") {
		if (parseStrictSemver(source.alignment.version) === null) {
			return {
				code: "invalid_definition",
				message: `Official documentation source ${source.id} declares an invalid semantic version`,
			};
		}
		if (definition.introspection.version?.parse?.kind !== "semver_first") {
			return {
				code: "invalid_definition",
				message: `Official documentation source ${source.id} requires introspection.version.parse.kind=semver_first`,
			};
		}
	}
	return undefined;
}

function isValidDnsHostname(host: string): boolean {
	if (host.length > 253 || host.endsWith(".") || host.includes("_") || host.includes("*") || isIP(host) !== 0) {
		return false;
	}
	const labels = host.split(".");
	return (
		labels.length >= 2 &&
		labels.every((label) => label.length >= 1 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label))
	);
}

function isAscii(value: string): boolean {
	return Array.from(value).every((character) => (character.codePointAt(0) ?? 0) <= 0x7f);
}

function hasAsciiControl(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 0x20 || code === 0x7f;
	});
}

function isUtf8Within(value: string, maxBytes: number): boolean {
	return Buffer.byteLength(value, "utf8") <= maxBytes;
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
