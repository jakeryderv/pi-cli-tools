import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import cliToolsExtension from "../extensions/cli-tools.js";

describe("cli-tools extension", () => {
	let agentDirectory: string | undefined;

	afterEach(async () => {
		vi.unstubAllEnvs();
		if (agentDirectory) await rm(agentDirectory, { force: true, recursive: true });
		agentDirectory = undefined;
	});

	it("exports an extension factory", () => {
		expect(cliToolsExtension).toBeTypeOf("function");
	});

	it("loads registry state and registers only the diagnostics command", async () => {
		agentDirectory = await mkdtemp(join(tmpdir(), "pi-cli-tools-agent-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
		const registerCommand = vi.fn();
		const registerTool = vi.fn();
		const getAllTools = vi.fn(() => []);
		const pi = {
			getAllTools,
			registerCommand,
			registerTool,
		} as unknown as ExtensionAPI;

		await expect(cliToolsExtension(pi)).resolves.toBeUndefined();
		expect(getAllTools).not.toHaveBeenCalled();
		expect(registerTool).not.toHaveBeenCalled();
		expect(registerCommand).toHaveBeenCalledOnce();
		expect(registerCommand).toHaveBeenCalledWith(
			"cli-tools",
			expect.objectContaining({
				description: "Show configured CLI registry and executable discovery status",
			}),
		);
	});
});
