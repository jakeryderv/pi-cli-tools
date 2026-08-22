import type { ExtensionAPI, RegisteredCommand, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";

import type {
	CliDiscovery,
	LoadedRegistryDefinition,
	RegistryDefinition,
	RegistryLoadResult,
} from "../../src/types.js";

export type MockEventHandler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;

export interface MockPiHarness {
	api: ExtensionAPI;
	handlers: Map<string, MockEventHandler[]>;
	tools: ToolDefinition[];
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	activeNames: Set<string>;
	notifications: { message: string; severity: string }[];
	emit(eventName: string, event: Record<string, unknown>, ctx?: Record<string, unknown>): Promise<unknown[]>;
	context(cwd: string): Record<string, unknown>;
}

export function createMockPi(
	options: {
		existingTools?: ToolInfo[];
		activateRegisteredTools?: boolean;
		registerToolError?: Error;
	} = {},
): MockPiHarness {
	const handlers = new Map<string, MockEventHandler[]>();
	const tools: ToolDefinition[] = [];
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const activeNames = new Set<string>();
	const notifications: { message: string; severity: string }[] = [];
	const existingTools = [...(options.existingTools ?? [])];
	for (const tool of existingTools) activeNames.add(tool.name);

	const api = {
		on(eventName: string, handler: MockEventHandler) {
			const current = handlers.get(eventName) ?? [];
			current.push(handler);
			handlers.set(eventName, current);
		},
		registerTool(tool: ToolDefinition) {
			if (options.registerToolError) throw options.registerToolError;
			tools.push(tool);
			if (options.activateRegisteredTools ?? true) activeNames.add(tool.name);
		},
		registerCommand(name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) {
			commands.set(name, command);
		},
		getAllTools(): ToolInfo[] {
			return [
				...existingTools,
				...tools.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
					sourceInfo: createSourceInfo(`<test:${tool.name}>`, "extension:test"),
				})),
			];
		},
		getActiveTools(): string[] {
			return [...activeNames];
		},
	} as unknown as ExtensionAPI;

	const harness: MockPiHarness = {
		api,
		handlers,
		tools,
		commands,
		activeNames,
		notifications,
		async emit(eventName, event, ctx = harness.context(process.cwd())) {
			const results: unknown[] = [];
			for (const handler of handlers.get(eventName) ?? []) results.push(await handler(event, ctx));
			return results;
		},
		context(cwd) {
			return {
				cwd,
				ui: {
					notify(message: string, severity: string) {
						notifications.push({ message, severity });
					},
				},
			};
		},
	};
	return harness;
}

export function createDefinition(
	id = "fixture",
	toolName = "cli_fixture",
	overrides: Partial<RegistryDefinition> = {},
): RegistryDefinition {
	return {
		id,
		tool_name: toolName,
		binary: { candidates: [id] },
		routing: {
			description: `Use ${id}.`,
			prefer_for: ["controlled CLI operations"],
			avoid_for: ["unrelated local file edits"],
		},
		introspection: { man: false },
		docs: { official: [] },
		execution: { timeout_ms: 5_000, cwd: "session", inherit_env: false },
		...overrides,
	};
}

export function loadDefinition(definition: RegistryDefinition): LoadedRegistryDefinition {
	return {
		definition,
		source: { layer: "test", path: `/registry/${definition.id}.yaml` },
	};
}

export function createRegistry(
	definitions: RegistryDefinition[],
	overrides: Partial<RegistryLoadResult> = {},
): RegistryLoadResult {
	return {
		definitions: definitions.map(loadDefinition),
		disabled: [],
		quarantined: [],
		issues: [],
		layers: [],
		...overrides,
	};
}

export function createAvailableDiscovery(
	executablePath: string,
	definition: RegistryDefinition = createDefinition(),
): Extract<CliDiscovery, { status: "available" }> {
	return {
		status: "available",
		registry: loadDefinition(definition),
		resolution: {
			candidate: definition.binary.candidates[0] ?? definition.id,
			executablePath,
			checkedPaths: [executablePath],
		},
	};
}

export function createToolInfo(name: string, source = "builtin"): ToolInfo {
	return {
		name,
		description: `${name} description`,
		parameters: { type: "object" },
		sourceInfo: createSourceInfo(`<${source}:${name}>`, source),
	};
}

function createSourceInfo(path: string, source: string): ToolInfo["sourceInfo"] {
	return { path, source, scope: "temporary", origin: "top-level" };
}
