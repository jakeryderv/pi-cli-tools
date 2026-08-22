import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { discoverRegistry } from "../src/introspect.js";
import { loadRegistry } from "../src/registry.js";
import type { CliDiscovery, RegistryLoadResult } from "../src/types.js";

const MAX_STATUS_ITEMS = 50;

/** Load the CLI registry and expose human-facing diagnostics. */
export default async function cliToolsExtension(pi: ExtensionAPI): Promise<void> {
	const registry = await loadRegistry([
		{
			name: "bundled",
			kind: "bundled",
			directory: fileURLToPath(new URL("../tools/", import.meta.url)),
			required: true,
		},
		{
			name: "user",
			kind: "user",
			directory: join(getAgentDir(), "cli-tools"),
			required: false,
		},
	]);
	const discoveries = await discoverRegistry(registry.definitions);

	pi.registerCommand("cli-tools", {
		description: "Show configured CLI registry and executable discovery status",
		handler: (_args, ctx) => {
			const configuredToolNames = new Set(pi.getAllTools().map(({ name }) => name));
			const collisions = new Set<string>();
			for (const { definition } of registry.definitions) {
				if (configuredToolNames.has(definition.tool_name)) collisions.add(definition.tool_name);
			}
			ctx.ui.notify(
				formatRegistryStatus(registry, discoveries, collisions),
				registry.issues.length > 0 || collisions.size > 0 ? "warning" : "info",
			);
			return Promise.resolve();
		},
	});
}

function formatRegistryStatus(
	registry: RegistryLoadResult,
	discoveries: readonly CliDiscovery[],
	collisions: ReadonlySet<string>,
): string {
	const available = discoveries.filter(({ status }) => status === "available");
	const missing = discoveries.filter(({ status }) => status === "missing");
	const lines = [
		"CLI tools registry",
		`Configured: ${String(registry.definitions.length)} | Available: ${String(available.length)} | Missing: ${String(missing.length)} | Disabled: ${String(registry.disabled.length)} | Issues: ${String(registry.issues.length)}`,
		"",
		"Sources:",
		...registry.layers.map(formatLayerStatus),
	];

	appendSection(
		lines,
		"Available",
		available.map(({ registry: entry, resolution }) => {
			if (!("executablePath" in resolution)) return "";
			const collision = collisions.has(entry.definition.tool_name) ? " [tool name collision]" : "";
			return `  ${entry.definition.tool_name} (${entry.definition.id}) -> ${resolution.executablePath}${collision}`;
		}),
	);
	appendSection(
		lines,
		"Missing",
		missing.map(
			({ registry: entry }) =>
				`  ${entry.definition.tool_name} (${entry.definition.id}): ${entry.definition.binary.candidates.join(", ")}`,
		),
	);
	appendSection(
		lines,
		"Disabled",
		registry.disabled.map(({ entry, source }) => `  ${entry.id} (${source.path})`),
	);
	appendSection(
		lines,
		"Issues",
		registry.issues.map((issue) => `  [${issue.code}] ${issue.message}${issue.path ? ` (${issue.path})` : ""}`),
	);

	return lines.join("\n");
}

function formatLayerStatus(layer: RegistryLoadResult["layers"][number]): string {
	if (!layer.exists) return `  ${layer.name}: ${layer.directory} (not found)`;

	const noun = layer.files.length === 1 ? "file" : "files";
	return `  ${layer.name}: ${layer.directory} (${String(layer.files.length)} ${noun})`;
}

function appendSection(lines: string[], title: string, items: string[]): void {
	if (items.length === 0) return;
	lines.push("", `${title}:`, ...items.slice(0, MAX_STATUS_ITEMS));
	if (items.length > MAX_STATUS_ITEMS) lines.push(`  ... ${String(items.length - MAX_STATUS_ITEMS)} more`);
}
