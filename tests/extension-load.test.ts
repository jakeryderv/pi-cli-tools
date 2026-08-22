import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import cliToolsExtension from "../extensions/cli-tools.js";

describe("cli-tools extension factory", () => {
	let agentDirectory: string | undefined;

	afterEach(async () => {
		vi.unstubAllEnvs();
		if (agentDirectory) await rm(agentDirectory, { force: true, recursive: true });
		agentDirectory = undefined;
	});

	it("exports an extension factory", () => {
		expect(cliToolsExtension).toBeTypeOf("function");
	});

	it("registers lifecycle hooks and diagnostics without calling Pi action methods during factory loading", async () => {
		agentDirectory = await mkdtemp(join(tmpdir(), "pi-cli-tools-agent-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
		const on = vi.fn<(event: string, handler: unknown) => void>();
		const registerCommand = vi.fn<(name: string, command: unknown) => void>();
		const registerTool = vi.fn();
		const getAllTools = vi.fn(() => []);
		const getActiveTools = vi.fn(() => []);
		const pi = {
			getActiveTools,
			getAllTools,
			on,
			registerCommand,
			registerTool,
		} as unknown as ExtensionAPI;

		await expect(cliToolsExtension(pi)).resolves.toBeUndefined();
		expect(getAllTools).not.toHaveBeenCalled();
		expect(getActiveTools).not.toHaveBeenCalled();
		expect(registerTool).not.toHaveBeenCalled();
		expect(on.mock.calls.map(([event]) => event)).toEqual(["session_start", "tool_result"]);
		expect(registerCommand).toHaveBeenCalledOnce();
		expect(registerCommand).toHaveBeenCalledWith(
			"cli-tools",
			expect.objectContaining({
				description: "Show native CLI registration, activation, and executable discovery status",
			}),
		);
	});
});
