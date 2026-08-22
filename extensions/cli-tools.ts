import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
	activatePiCliTools,
	createPiCliToolsState,
	formatCliToolsDiagnostics,
	hasCliToolsWarnings,
	isCliDocsToolResultDetails,
	isCliDocsToolResultError,
	isCliToolsToolResultDetails,
	isCliToolsToolResultError,
	isCliToolResultDetails,
	isCliToolResultError,
} from "./pi-adapter.js";
import { getAcceptedExitCodes, loadRegistry } from "../src/registry.js";

/** Load the registry during factory setup, then adapt eligible CLIs after Pi binds its runtime. */
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
	const state = createPiCliToolsState(registry);
	let activation: Promise<void> | undefined;

	pi.on("session_start", async (_event, ctx) => {
		activation ??= activatePiCliTools(pi, state, ctx.cwd);
		await activation;
	});

	pi.on("tool_result", (event) => {
		if (event.toolName === "cli_tools" && isCliToolsToolResultDetails(event.details)) {
			if (isCliToolsToolResultError(event.details)) return { isError: true };
			return;
		}
		if (event.toolName === "cli_docs" && isCliDocsToolResultDetails(event.details)) {
			if (isCliDocsToolResultError(event.details)) return { isError: true };
			return;
		}
		const registered = state.registered.find(
			({ discovery }) => discovery.registry.definition.tool_name === event.toolName,
		);
		if (!registered || !isCliToolResultDetails(event.details)) return;
		const { definition } = registered.discovery.registry;
		if (event.details.registryId !== definition.id) return;
		if (isCliToolResultError(event.details, getAcceptedExitCodes(definition))) return { isError: true };
		return;
	});

	pi.on("session_shutdown", async () => {
		const localService = state.introspectionService;
		const officialService = state.officialDocumentationService;
		state.introspectionService = null;
		state.officialDocumentationService = null;
		await Promise.all([localService?.close(), officialService?.close()]);
	});

	pi.registerCommand("cli-tools", {
		description: "Show native CLI registration, activation, and executable discovery status",
		handler: (_args, ctx) => {
			const currentTools = pi.getAllTools();
			ctx.ui.notify(
				formatCliToolsDiagnostics(state, pi.getActiveTools(), currentTools),
				hasCliToolsWarnings(state, currentTools) ? "warning" : "info",
			);
			return Promise.resolve();
		},
	});
}
