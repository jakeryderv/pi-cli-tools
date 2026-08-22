import type {
	ExtensionAPI,
	ExtensionContext,
	SourceInfo,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import Type from "typebox";
import type { Static } from "typebox";

import { discoverRegistry } from "../src/introspect.js";
import { CLI_MAX_ARGUMENT_BYTES, CLI_MAX_ARGUMENT_COUNT } from "../src/limits.js";
import { CliExecutionRequestError, runCli, type CliExecutionRequestErrorCode } from "../src/runner.js";
import type {
	CliDiscovery,
	CliErrorDetails,
	CliExecutionRequest,
	CliExecutionResult,
	LoadedRegistryDefinition,
	RegistryLoadResult,
} from "../src/types.js";

export const PI_MODEL_OUTPUT_MAX_BYTES = 50 * 1024;
export const PI_MODEL_OUTPUT_MAX_LINES = 2_000;
export const PI_DIAGNOSTIC_MAX_BYTES = 50 * 1024;
export const PI_DIAGNOSTIC_MAX_LINES = 2_000;
const MAX_TOOL_DESCRIPTION_BYTES = 2_048;
const MAX_DIAGNOSTIC_ITEMS = 50;
const MAX_DIAGNOSTIC_NESTED_ITEMS = 8;
const MAX_DIAGNOSTIC_NESTED_VALUE_BYTES = 80;
const MAX_DIAGNOSTIC_LINE_BYTES = 1_000;
const MAX_DIAGNOSTIC_VALUE_BYTES = 500;
const MAX_MODEL_METADATA_VALUE_BYTES = 512;
const MAX_ARGV_PREVIEW_BYTES = 240;

/** The complete and deliberately minimal model-provided input contract. */
export const CliToolParameters = Type.Object(
	{
		args: Type.Array(
			Type.String({
				maxLength: CLI_MAX_ARGUMENT_BYTES,
				description: "One literal argv element. Empty strings are allowed; shell syntax is not interpreted.",
			}),
			{
				maxItems: CLI_MAX_ARGUMENT_COUNT,
				description: "Exact command-line arguments passed to the configured executable.",
			},
		),
	},
	{ additionalProperties: false },
);

export type CliToolInput = Static<typeof CliToolParameters>;

export type CliSpoolCleanupOwnership =
	| {
			readonly applicable: false;
			readonly owner: "none";
			readonly lifecycle: "not_retained";
			readonly method: null;
	  }
	| {
			readonly applicable: true;
			readonly owner: "pi-cli-tools";
			readonly lifecycle: "retained_until_explicit_cleanup";
			readonly method: "removeCliOutputSpool";
	  };

export type CliToolResultDetails =
	| {
			readonly adapter: "pi-cli-tools";
			readonly kind: "execution";
			readonly registryId: string;
			readonly execution: CliExecutionResult;
			readonly spoolCleanup: CliSpoolCleanupOwnership;
	  }
	| {
			readonly adapter: "pi-cli-tools";
			readonly kind: "request_error";
			readonly registryId: string;
			readonly error: {
				readonly code: CliExecutionRequestErrorCode;
				readonly message: string;
			};
	  };

export interface ToolNameCollision {
	readonly code: "tool_name_collision";
	readonly registryId: string;
	readonly toolName: string;
	readonly executablePath: string;
	readonly owner: ToolInfo["sourceInfo"];
}

export interface RegisteredCliTool {
	readonly discovery: Extract<CliDiscovery, { status: "available" }>;
	activeAtRegistration: boolean;
	ownerAtRegistration: ToolInfo["sourceInfo"] | null;
}

export interface CliToolRegistrationError {
	readonly registryId: string;
	readonly toolName: string;
	readonly executablePath: string;
	readonly message: string;
}

export interface PiCliToolsState {
	readonly registry: RegistryLoadResult;
	phase: "pending" | "activating" | "ready";
	discoveries: CliDiscovery[];
	registered: RegisteredCliTool[];
	collisions: ToolNameCollision[];
	registrationErrors: CliToolRegistrationError[];
	unsupported: Extract<CliDiscovery, { status: "available" }>[];
}

export function createPiCliToolsState(registry: RegistryLoadResult): PiCliToolsState {
	return {
		registry,
		phase: "pending",
		discoveries: [],
		registered: [],
		collisions: [],
		registrationErrors: [],
		unsupported: [],
	};
}

/** Discover and register eligible tools. Call only after Pi has bound extension actions. */
export async function activatePiCliTools(
	pi: ExtensionAPI,
	state: PiCliToolsState,
	cwd: string,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	state.phase = "activating";
	const quarantinedIds = new Set(state.registry.quarantined.map(({ id }) => id));
	const eligibleDefinitions = state.registry.definitions.filter(({ definition }) => !quarantinedIds.has(definition.id));
	state.discoveries = await discoverRegistry(eligibleDefinitions, { cwd });

	const existingByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	for (const discovery of state.discoveries) {
		if (discovery.status !== "available") continue;
		if (platform !== "linux" && platform !== "darwin") {
			state.unsupported.push(discovery);
			continue;
		}

		const { definition } = discovery.registry;
		const existing = existingByName.get(definition.tool_name);
		if (existing) {
			state.collisions.push({
				code: "tool_name_collision",
				registryId: definition.id,
				toolName: definition.tool_name,
				executablePath: discovery.resolution.executablePath,
				owner: existing.sourceInfo,
			});
			continue;
		}

		try {
			pi.registerTool(createNativeCliTool(discovery));
			state.registered.push({ discovery, activeAtRegistration: false, ownerAtRegistration: null });
		} catch (error) {
			state.registrationErrors.push({
				registryId: definition.id,
				toolName: definition.tool_name,
				executablePath: discovery.resolution.executablePath,
				message: clipDiagnosticValue(getErrorMessage(error)),
			});
		}
	}

	const registeredToolsByName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	const activeNames = new Set(pi.getActiveTools());
	for (const registered of state.registered) {
		const toolName = registered.discovery.registry.definition.tool_name;
		registered.activeAtRegistration = activeNames.has(toolName);
		registered.ownerAtRegistration = registeredToolsByName.get(toolName)?.sourceInfo ?? null;
	}
	state.phase = "ready";
}

export function createNativeCliTool(
	discovery: Extract<CliDiscovery, { status: "available" }>,
): ToolDefinition<typeof CliToolParameters, CliToolResultDetails> {
	const { definition } = discovery.registry;
	return {
		name: definition.tool_name,
		label: definition.tool_name,
		description: createToolDescription(definition),
		parameters: CliToolParameters,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			try {
				const execution = await runCli(mapCliExecutionRequest(discovery, params, ctx), {
					...(signal ? { signal } : {}),
				});
				const details: CliToolResultDetails = {
					adapter: "pi-cli-tools",
					kind: "execution",
					registryId: definition.id,
					execution,
					spoolCleanup: createSpoolCleanupOwnership(execution),
				};
				return {
					content: [{ type: "text", text: formatCliExecutionForModel(execution) }],
					details,
				};
			} catch (error) {
				if (!(error instanceof CliExecutionRequestError)) throw error;
				const details: CliToolResultDetails = {
					adapter: "pi-cli-tools",
					kind: "request_error",
					registryId: definition.id,
					error: { code: error.code, message: error.message },
				};
				return {
					content: [{ type: "text", text: formatCliRequestErrorForModel(error) }],
					details,
				};
			}
		},
		renderCall(args, theme, context) {
			const preview = context.argsComplete
				? formatArgvPreview(isRecord(args) ? args.args : undefined)
				: "(arguments pending)";
			return new Text(theme.fg("toolTitle", theme.bold(`${definition.tool_name} `)) + theme.fg("muted", preview), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return new Text(theme.fg("warning", "Running…"), 0, 0);
			const details = result.details;
			if (!isCliToolResultDetails(details)) {
				return new Text(theme.fg("error", "Invalid pi-cli-tools result"), 0, 0);
			}
			if (expanded) {
				const content = result.content.find(({ type }) => type === "text");
				return new Text(content?.type === "text" ? sanitizeModelText(content.text) : "(no output)", 0, 0);
			}
			return new Text(formatCollapsedResult(details, theme), 0, 0);
		},
	};
}

export function mapCliExecutionRequest(
	discovery: Extract<CliDiscovery, { status: "available" }>,
	input: CliToolInput,
	ctx: Pick<ExtensionContext, "cwd">,
): CliExecutionRequest {
	const { definition } = discovery.registry;
	return {
		executablePath: discovery.resolution.executablePath,
		args: input.args,
		cwd: ctx.cwd,
		timeoutMs: definition.execution.timeout_ms,
		environment: definition.execution.inherit_env ? "inherit" : "empty",
		outputStrategy: "tail",
	};
}

export function createToolDescription(definition: LoadedRegistryDefinition["definition"]): string {
	const routingParts = [normalizeSingleLine(definition.routing.description)];
	if (definition.routing.prefer_for?.length) {
		routingParts.push(`Prefer for: ${definition.routing.prefer_for.map(normalizeSingleLine).join("; ")}.`);
	}
	if (definition.routing.avoid_for?.length) {
		routingParts.push(`Avoid for: ${definition.routing.avoid_for.map(normalizeSingleLine).join("; ")}.`);
	}
	const suffix = " Arguments are passed as literal argv without a shell; output is bounded using tail selection.";
	const routingBudget = MAX_TOOL_DESCRIPTION_BYTES - Buffer.byteLength(suffix, "utf8");
	return `${clipUtf8(routingParts.join(" "), routingBudget)}${suffix}`;
}

export function isCliToolResultDetails(value: unknown): value is CliToolResultDetails {
	if (!isRecord(value) || value.adapter !== "pi-cli-tools" || typeof value.registryId !== "string") return false;
	if (value.kind === "request_error") {
		return isRecord(value.error) && typeof value.error.code === "string" && typeof value.error.message === "string";
	}
	return value.kind === "execution" && isRecord(value.execution) && typeof value.execution.status === "string";
}

export function isCliToolResultError(details: CliToolResultDetails): boolean {
	if (details.kind === "request_error") return true;
	const execution = details.execution;
	return execution.status !== "exited" || execution.exitCode !== 0 || execution.signal !== null;
}

export function formatCliExecutionForModel(execution: CliExecutionResult): string {
	let content = formatStatusLine(execution);
	const stdout = sanitizeModelText(execution.stdout);
	const stderr = sanitizeModelText(execution.stderr);
	if (stdout.length > 0) content = appendBlock(content, `stdout:\n${stdout}`);
	if (stderr.length > 0) content = appendBlock(content, `stderr:\n${stderr}`);
	if (stdout.length === 0 && stderr.length === 0) content = appendBlock(content, "(no output)");

	if (execution.status === "spawn_error") {
		content = appendBlock(
			content,
			`Spawn failed (${formatErrorCode(execution.spawnError)}); the configured executable could not be started.`,
		);
	}
	if (execution.truncation.truncated) {
		content = appendBlock(
			content,
			`Output truncated using ${execution.truncation.strategy} selection: ${String(execution.truncation.returned.bytes)}/${String(execution.truncation.original.bytes)} bytes, ${String(execution.truncation.returned.lines)}/${String(execution.truncation.original.lines)} lines.`,
		);
	}
	if (execution.truncation.boundaryLinePartial) {
		content = appendBlock(content, "A boundary line is partial because it exceeded the output byte budget.");
	}
	if (!execution.capture.complete) {
		content = appendBlock(
			content,
			`Warning: process output capture is incomplete (${execution.capture.reason ?? "unknown_reason"}).`,
		);
	}

	switch (execution.spool.status) {
		case "complete":
			content = appendBlock(
				content,
				`${formatModelSpoolNotice("Complete", execution.spool.path)}\nRetained raw output requires explicit pi-cli-tools cleanup.`,
			);
			break;
		case "partial":
			content = appendBlock(
				content,
				`${formatModelSpoolNotice("Partial", execution.spool.path)}\nRetained raw output requires explicit pi-cli-tools cleanup.`,
			);
			break;
		case "failed": {
			const retainedWarning =
				execution.spool.retainedPaths.length > 0
					? " Warning: partial raw-output artifacts remain and require explicit pi-cli-tools cleanup."
					: "";
			content = appendBlock(
				content,
				`Raw output retention failed (${formatErrorCode(execution.spool.error)}); complete output is unavailable.${retainedWarning}`,
			);
			break;
		}
		case "not_needed":
			break;
	}
	if (execution.spool.cleanupError) {
		content = appendBlock(
			content,
			`Warning: raw-output sidecar cleanup failed (${formatErrorCode(execution.spool.cleanupError)}).`,
		);
	}

	const cleanup = execution.status === "exited" ? execution.processGroupCleanup : execution.termination;
	if (cleanup && (!cleanup.confirmed || cleanup.error)) {
		content = appendBlock(
			content,
			`Warning: process-group cleanup was not confirmed${cleanup.forced ? " after forced termination" : ""}${cleanup.error ? ` (${formatErrorCode(cleanup.error)})` : ""}.`,
		);
	}
	return boundFinalModelContent(content);
}

export function createSpoolCleanupOwnership(execution: CliExecutionResult): CliSpoolCleanupOwnership {
	if (execution.spool.retainedPaths.length === 0) {
		return { applicable: false, owner: "none", lifecycle: "not_retained", method: null };
	}
	return {
		applicable: true,
		owner: "pi-cli-tools",
		lifecycle: "retained_until_explicit_cleanup",
		method: "removeCliOutputSpool",
	};
}

export function formatCliRequestErrorForModel(error: CliExecutionRequestError): string {
	return boundFinalModelContent(
		`Status: request_error; code=${error.code}\nRequest rejected before spawn: ${clipMetadataValue(error.message)}`,
	);
}

export function formatCliToolsDiagnostics(
	state: PiCliToolsState,
	activeToolNames: readonly string[],
	currentTools?: readonly ToolInfo[],
): string {
	const available = state.discoveries.filter(({ status }) => status === "available");
	const missing = state.discoveries.filter(({ status }) => status === "missing");
	const active = new Set(activeToolNames);
	const currentByName = new Map((currentTools ?? []).map((tool) => [tool.name, tool]));
	const ownershipChanges = currentTools
		? state.registered.flatMap((registered) => {
				const toolName = registered.discovery.registry.definition.tool_name;
				const currentOwner = currentByName.get(toolName)?.sourceInfo;
				const registeredOwner = registered.ownerAtRegistration;
				if (!registeredOwner || (currentOwner && sourceInfoEquals(currentOwner, registeredOwner))) return [];
				return [{ registered, registeredOwner, currentOwner }];
			})
		: [];
	const changedNames = new Set(
		ownershipChanges.map(({ registered }) => registered.discovery.registry.definition.tool_name),
	);
	const activeCount = state.registered.filter(({ discovery }) => {
		const toolName = discovery.registry.definition.tool_name;
		return active.has(toolName) && !changedNames.has(toolName);
	}).length;
	const lines = [
		"CLI tools registry",
		`Configured: ${String(state.registry.definitions.length)} | Available: ${String(available.length)} | Registered: ${String(state.registered.length)} | Active: ${String(activeCount)} | Collisions: ${String(state.collisions.length)} | Ownership changes: ${String(ownershipChanges.length)} | Missing: ${String(missing.length)} | Disabled: ${String(state.registry.disabled.length)} | Registry issues: ${String(state.registry.issues.length)}`,
		`Lifecycle: ${state.phase}`,
	];

	appendDiagnosticSection(
		lines,
		"Sources",
		state.registry.layers.map((layer) => {
			const availability = layer.exists ? `${String(layer.files.length)} file(s)` : "not found";
			return `  ${layer.name}: ${clipDiagnosticValue(layer.directory)} (${availability})`;
		}),
	);
	appendDiagnosticSection(
		lines,
		"Registered",
		state.registered.map(({ discovery }) => {
			const { definition } = discovery.registry;
			const toolName = definition.tool_name;
			const status = changedNames.has(toolName)
				? "ownership changed"
				: active.has(toolName)
					? "active"
					: "inactive or filtered by Pi";
			return `  ${toolName} (${definition.id}) -> ${clipDiagnosticValue(discovery.resolution.executablePath)} [${status}]`;
		}),
	);
	appendDiagnosticSection(
		lines,
		"Ownership changes",
		ownershipChanges.map(({ registered, registeredOwner, currentOwner }) => {
			const { definition } = registered.discovery.registry;
			return `  [ownership_changed] ${definition.tool_name} (${definition.id}); registered owner: ${formatSourceInfo(registeredOwner)}; current owner: ${currentOwner ? formatSourceInfo(currentOwner) : "not present"}`;
		}),
	);
	appendDiagnosticSection(
		lines,
		"Collisions",
		state.collisions.map(
			(collision) =>
				`  [${collision.code}] ${collision.toolName} (${collision.registryId}) -> ${clipDiagnosticValue(collision.executablePath)}; existing owner: ${formatSourceInfo(collision.owner)}`,
		),
	);
	appendDiagnosticSection(
		lines,
		"Missing",
		missing.map(({ registry, resolution }) => {
			const candidates = formatDiagnosticList(registry.definition.binary.candidates);
			const checked = formatDiagnosticList(resolution.checkedPaths);
			const checkedSuffix = checked.length > 0 ? `; checked: ${checked}` : "; PATH supplied no searchable directories";
			return `  ${registry.definition.tool_name} (${registry.definition.id}): ${candidates}${checkedSuffix}`;
		}),
	);
	appendDiagnosticSection(
		lines,
		"Disabled",
		state.registry.disabled.map(({ entry, source }) => `  ${entry.id} (${clipDiagnosticValue(source.path)})`),
	);
	appendDiagnosticSection(
		lines,
		"Quarantined",
		state.registry.quarantined.map((entry) => {
			const lowerDefinitionExists = state.registry.definitions.some(({ definition }) => definition.id === entry.id);
			const outcome = lowerDefinitionExists
				? "lower-precedence definition withheld"
				: "no lower-precedence executable definition existed";
			return `  ${entry.id}: ${entry.reason} in ${entry.layer}; ${outcome} (${formatDiagnosticList(entry.paths)})`;
		}),
	);
	appendDiagnosticSection(
		lines,
		"Unsupported platform",
		state.unsupported.map(
			({ registry }) =>
				`  ${registry.definition.tool_name} (${registry.definition.id}): native execution not registered`,
		),
	);
	appendDiagnosticSection(
		lines,
		"Registration errors",
		state.registrationErrors.map(
			(error) =>
				`  ${error.toolName} (${error.registryId}) -> ${clipDiagnosticValue(error.executablePath)}: ${error.message}`,
		),
	);
	appendDiagnosticSection(
		lines,
		"Registry issues",
		state.registry.issues.map(
			(issue) =>
				`  [${issue.code}] ${clipDiagnosticValue(issue.message)}${issue.path ? ` (${clipDiagnosticValue(issue.path)})` : ""}`,
		),
	);
	lines.push("", "Run /reload after installing, replacing, or reconfiguring a CLI.");
	return boundDiagnosticContent(lines.join("\n"));
}

export function hasCliToolsWarnings(state: PiCliToolsState, currentTools?: readonly ToolInfo[]): boolean {
	return (
		state.registry.issues.length > 0 ||
		state.registry.quarantined.length > 0 ||
		state.collisions.length > 0 ||
		state.registrationErrors.length > 0 ||
		state.unsupported.length > 0 ||
		Boolean(
			currentTools &&
			state.registered.some((registered) => {
				const registeredOwner = registered.ownerAtRegistration;
				if (!registeredOwner) return false;
				const toolName = registered.discovery.registry.definition.tool_name;
				const currentOwner = currentTools.find(({ name }) => name === toolName)?.sourceInfo;
				return !currentOwner || !sourceInfoEquals(currentOwner, registeredOwner);
			}),
		)
	);
}

function formatStatusLine(execution: CliExecutionResult): string {
	const fields = [`Status: ${execution.status}`];
	if (execution.status !== "spawn_error") {
		fields.push(`code=${execution.exitCode === null ? "none" : String(execution.exitCode)}`);
		if (execution.signal) fields.push(`signal=${execution.signal}`);
	}
	fields.push(`duration=${String(execution.durationMs)}ms`);
	return fields.join("; ");
}

function formatCollapsedResult(
	details: CliToolResultDetails,
	theme: Parameters<NonNullable<ToolDefinition["renderCall"]>>[1],
): string {
	if (details.kind === "request_error") {
		return theme.fg("error", `request error: ${details.error.code}`);
	}
	const execution = details.execution;
	let summary: string;
	if (execution.status === "exited") {
		const exit = execution.signal ? `signal ${execution.signal}` : `exit ${String(execution.exitCode)}`;
		summary = theme.fg(isCliToolResultError(details) ? "error" : "success", exit);
	} else if (execution.status === "cancelled") {
		summary = theme.fg("warning", "cancelled");
	} else {
		summary = theme.fg("error", execution.status);
	}
	summary += theme.fg("dim", ` ${String(execution.durationMs)}ms`);
	if (execution.truncation.truncated) summary += theme.fg("warning", " [truncated]");
	if (!execution.capture.complete) summary += theme.fg("warning", " [partial capture]");
	if (execution.spool.status === "complete") summary += theme.fg("muted", " [spooled]");
	if (execution.spool.status === "partial") summary += theme.fg("warning", " [partial spool]");
	if (execution.spool.status === "failed" || execution.spool.cleanupError) {
		summary += theme.fg("warning", " [spool warning]");
	}
	const cleanup = execution.status === "exited" ? execution.processGroupCleanup : execution.termination;
	if (cleanup && (!cleanup.confirmed || cleanup.error)) summary += theme.fg("warning", " [cleanup warning]");
	return summary;
}

function formatArgvPreview(args: unknown): string {
	if (!Array.isArray(args)) return "(invalid arguments)";
	try {
		const serialized = JSON.stringify(args.map((argument) => sanitizeModelText(String(argument))));
		return clipUtf8(normalizeSingleLine(serialized), MAX_ARGV_PREVIEW_BYTES);
	} catch {
		return "[unrenderable arguments]";
	}
}

function sanitizeModelText(value: string): string {
	const stripped = stripTerminalSequences(value).replaceAll("\r\n", "\n").replaceAll("\r", "");
	return Array.from(stripped)
		.filter((character) => {
			const codePoint = character.codePointAt(0);
			if (codePoint === undefined) return false;
			return codePoint === 0x09 || codePoint === 0x0a || (codePoint >= 0x20 && (codePoint < 0x7f || codePoint > 0x9f));
		})
		.join("")
		.replace(/\p{Cf}/gu, "");
}

function normalizeSingleLine(value: string): string {
	return sanitizeModelText(value).replace(/\s+/gu, " ").trim();
}

function clipMetadataValue(value: string): string {
	return clipUtf8(normalizeSingleLine(value), MAX_MODEL_METADATA_VALUE_BYTES);
}

function formatModelSpoolNotice(kind: "Complete" | "Partial", path: string): string {
	if (
		sanitizeModelText(path) === path &&
		!path.includes("\n") &&
		Buffer.byteLength(path, "utf8") <= MAX_MODEL_METADATA_VALUE_BYTES
	) {
		return `${kind} raw output: ${path}`;
	}
	return `${kind} raw output retained; its path was omitted from model text because it exceeded safe framing.`;
}

function clipDiagnosticValue(value: string): string {
	return clipUtf8(normalizeSingleLine(value), MAX_DIAGNOSTIC_VALUE_BYTES);
}

function clipUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const suffix = "…";
	const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
	let result = "";
	let bytes = 0;
	for (const character of value) {
		const characterBytes = Buffer.byteLength(character, "utf8");
		if (bytes + characterBytes > budget) break;
		result += character;
		bytes += characterBytes;
	}
	return `${result}${suffix}`;
}

function appendBlock(content: string, block: string): string {
	return `${content}${content.endsWith("\n") ? "" : "\n"}${block}`;
}

function boundFinalModelContent(content: string): string {
	if (
		Buffer.byteLength(content, "utf8") <= PI_MODEL_OUTPUT_MAX_BYTES &&
		logicalLineCount(content) <= PI_MODEL_OUTPUT_MAX_LINES
	) {
		return content;
	}

	const firstNewline = content.indexOf("\n");
	const status = firstNewline < 0 ? content : content.slice(0, firstNewline);
	const remainder = firstNewline < 0 ? "" : content.slice(firstNewline + 1);
	const notice = "[Adapter framing required additional bounded tail selection.]";
	const prefix = `${clipUtf8(status, 256)}\n${notice}\n`;
	const byteBudget = PI_MODEL_OUTPUT_MAX_BYTES - Buffer.byteLength(prefix, "utf8");
	const lineBudget = PI_MODEL_OUTPUT_MAX_LINES - logicalLineCount(prefix);
	return `${prefix}${selectTextTail(remainder, byteBudget, lineBudget)}`;
}

function selectTextTail(value: string, maxBytes: number, maxLines: number): string {
	const characters = Array.from(value);
	let result = "";
	let bytes = 0;
	let newlines = 0;
	for (let index = characters.length - 1; index >= 0; index -= 1) {
		const character = characters[index];
		if (character === undefined) continue;
		const nextBytes = bytes + Buffer.byteLength(character, "utf8");
		const nextNewlines = newlines + (character === "\n" ? 1 : 0);
		if (nextBytes > maxBytes || nextNewlines >= maxLines) break;
		result = `${character}${result}`;
		bytes = nextBytes;
		newlines = nextNewlines;
	}
	return result;
}

function logicalLineCount(value: string): number {
	if (value.length === 0) return 0;
	let newlines = 0;
	for (const character of value) if (character === "\n") newlines += 1;
	return newlines + (value.endsWith("\n") ? 0 : 1);
}

function formatErrorCode(error: CliErrorDetails): string {
	return clipMetadataValue(error.code ?? error.name);
}

function formatSourceInfo(source: SourceInfo): string {
	return `${clipDiagnosticValue(source.source)} at ${clipDiagnosticValue(source.path)}`;
}

function sourceInfoEquals(left: SourceInfo, right: SourceInfo): boolean {
	return (
		left.path === right.path &&
		left.source === right.source &&
		left.scope === right.scope &&
		left.origin === right.origin &&
		left.baseDir === right.baseDir
	);
}

function formatDiagnosticList(values: readonly string[]): string {
	const selected = values
		.slice(0, MAX_DIAGNOSTIC_NESTED_ITEMS)
		.map((value) => clipUtf8(normalizeSingleLine(value), MAX_DIAGNOSTIC_NESTED_VALUE_BYTES));
	if (values.length > MAX_DIAGNOSTIC_NESTED_ITEMS) {
		selected.push(`… ${String(values.length - MAX_DIAGNOSTIC_NESTED_ITEMS)} more`);
	}
	return selected.join(", ");
}

function appendDiagnosticSection(lines: string[], title: string, items: string[]): void {
	if (items.length === 0) return;
	lines.push(
		"",
		`${title}:`,
		...items.slice(0, MAX_DIAGNOSTIC_ITEMS).map((item) => clipUtf8(sanitizeModelText(item), MAX_DIAGNOSTIC_LINE_BYTES)),
	);
	if (items.length > MAX_DIAGNOSTIC_ITEMS) {
		lines.push(`  ... ${String(items.length - MAX_DIAGNOSTIC_ITEMS)} more`);
	}
}

function boundDiagnosticContent(content: string): string {
	if (
		Buffer.byteLength(content, "utf8") <= PI_DIAGNOSTIC_MAX_BYTES &&
		logicalLineCount(content) <= PI_DIAGNOSTIC_MAX_LINES
	) {
		return content;
	}
	const notice = "[Diagnostics truncated to the pi-cli-tools notification limit.]";
	const separator = "\n";
	const selected = selectTextHead(
		content,
		PI_DIAGNOSTIC_MAX_BYTES - Buffer.byteLength(separator + notice, "utf8"),
		PI_DIAGNOSTIC_MAX_LINES - 1,
	).trimEnd();
	return `${selected}${separator}${notice}`;
}

function selectTextHead(value: string, maxBytes: number, maxLines: number): string {
	let result = "";
	let bytes = 0;
	let newlines = 0;
	for (const character of value) {
		const nextBytes = bytes + Buffer.byteLength(character, "utf8");
		const nextNewlines = newlines + (character === "\n" ? 1 : 0);
		const nextLines = nextNewlines + (character === "\n" ? 0 : 1);
		if (nextBytes > maxBytes || nextLines > maxLines) break;
		result += character;
		bytes = nextBytes;
		newlines = nextNewlines;
	}
	return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
