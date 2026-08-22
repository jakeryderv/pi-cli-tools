import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	CLI_MAX_ARGUMENT_BYTES,
	CLI_MAX_ARGUMENT_COUNT,
	CLI_MAX_PATH_BYTES,
	CLI_MAX_TIMEOUT_MS,
	CLI_MAX_TOTAL_ARGUMENT_BYTES,
	CLI_MIN_TIMEOUT_MS,
	CliExecutionRequestError,
	runCli,
} from "../src/runner.js";
import type { CliExecutionRequestErrorCode } from "../src/runner.js";
import type { CliExecutionRequest } from "../src/types.js";
import { buildArgumentsOfTotalBytes, createRequest, fixturePath, runFake } from "./helpers/runner.js";

const describePosix = process.platform === "linux" || process.platform === "darwin" ? describe : describe.skip;

describePosix("runCli request validation", () => {
	let root: string;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-cli-tools-validation-"));
	});

	afterEach(async () => {
		await rm(root, { force: true, recursive: true });
	});

	it("accepts empty arrays and exact count, per-argument, total, path, and timeout boundaries", async () => {
		await expect(
			runCli(
				{
					executablePath: process.execPath,
					args: [],
					cwd: root,
					timeoutMs: CLI_MIN_TIMEOUT_MS,
					environment: "empty",
					outputStrategy: "tail",
				},
				{ temporaryDirectory: root },
			),
		).resolves.toMatchObject({ status: "exited" });

		const exactCount = [fixturePath, "exit", "0", ...Array<string>(CLI_MAX_ARGUMENT_COUNT - 3).fill("")];
		await expect(runExactArgs(exactCount)).resolves.toMatchObject({ status: "exited" });
		await expect(runFake(root, ["exit", "0", "é".repeat(CLI_MAX_ARGUMENT_BYTES / 2)])).resolves.toMatchObject({
			status: "exited",
		});
		const exactTotal = buildArgumentsOfTotalBytes([fixturePath, "exit", "0"], CLI_MAX_TOTAL_ARGUMENT_BYTES);
		await expect(runExactArgs(exactTotal)).resolves.toMatchObject({ status: "exited" });
		await expect(runFake(root, ["exit", "0"], {}, { timeoutMs: CLI_MAX_TIMEOUT_MS })).resolves.toMatchObject({
			status: "exited",
		});

		const exactPath = `/${"x".repeat(CLI_MAX_PATH_BYTES - 1)}`;
		await expect(
			runCli({ ...createRequest(root, ["exit", "0"]), executablePath: exactPath }, { temporaryDirectory: root }),
		).resolves.toMatchObject({ status: "spawn_error" });
		await expect(
			runCli({ ...createRequest(root, ["exit", "0"]), cwd: exactPath }, { temporaryDirectory: root }),
		).resolves.toMatchObject({ status: "spawn_error" });
	});

	it("rejects every hard validation branch with a stable error code", async () => {
		const base = createRequest(root, ["exit", "0"]);
		const exactTotal = buildArgumentsOfTotalBytes([fixturePath, "exit", "0"], CLI_MAX_TOTAL_ARGUMENT_BYTES);
		const overlongPath = `/${"x".repeat(CLI_MAX_PATH_BYTES)}`;
		const cases: readonly { request: CliExecutionRequest; code: CliExecutionRequestErrorCode }[] = [
			{ request: { ...base, executablePath: "relative-tool" }, code: "invalid_executable_path" },
			{ request: { ...base, executablePath: `${process.execPath}\0bad` }, code: "invalid_executable_path" },
			{ request: { ...base, executablePath: overlongPath }, code: "invalid_executable_path" },
			{ request: { ...base, args: "not-an-array" as never }, code: "invalid_arguments" },
			{ request: { ...base, args: [1] as never }, code: "invalid_arguments" },
			{ request: { ...base, args: Array<string>(CLI_MAX_ARGUMENT_COUNT + 1).fill("") }, code: "invalid_arguments" },
			{ request: { ...base, args: ["é".repeat(CLI_MAX_ARGUMENT_BYTES / 2 + 1)] }, code: "invalid_arguments" },
			{ request: { ...base, args: [...exactTotal, ""] }, code: "invalid_arguments" },
			{ request: { ...base, args: ["nul\0argument"] }, code: "invalid_arguments" },
			{ request: { ...base, cwd: "relative-directory" }, code: "invalid_cwd" },
			{ request: { ...base, cwd: `${root}\0bad` }, code: "invalid_cwd" },
			{ request: { ...base, cwd: overlongPath }, code: "invalid_cwd" },
			{ request: { ...base, timeoutMs: CLI_MIN_TIMEOUT_MS - 1 }, code: "invalid_timeout" },
			{ request: { ...base, timeoutMs: CLI_MAX_TIMEOUT_MS + 1 }, code: "invalid_timeout" },
			{ request: { ...base, timeoutMs: 100.5 }, code: "invalid_timeout" },
			{ request: { ...base, environment: "override" as never }, code: "invalid_environment_policy" },
			{ request: { ...base, outputStrategy: "middle" as never }, code: "invalid_output_strategy" },
		];

		for (const testCase of cases) {
			try {
				await runCli(testCase.request, { temporaryDirectory: root });
				throw new Error("invalid request unexpectedly executed");
			} catch (error) {
				expect(error).toBeInstanceOf(CliExecutionRequestError);
				expect((error as CliExecutionRequestError).code).toBe(testCase.code);
			}
		}
	});

	it("does not spawn when cancellation occurs during the environment snapshot", async () => {
		const controller = new AbortController();
		const inheritedEnvironment: NodeJS.ProcessEnv = {};
		Object.defineProperty(inheritedEnvironment, "CANCEL_DURING_SNAPSHOT", {
			enumerable: true,
			get: () => {
				controller.abort();
				return "value";
			},
		});

		const result = await runCli(
			{ ...createRequest(root, ["exit", "0"]), executablePath: join(root, "missing"), environment: "inherit" },
			{ signal: controller.signal, inheritedEnvironment, temporaryDirectory: root },
		);

		expect(result).toMatchObject({
			status: "cancelled",
			spawnError: null,
			termination: { attempted: false },
		});
	});

	it("preserves cancellation observed before an asynchronous spawn error", async () => {
		const controller = new AbortController();
		const execution = runCli(
			{ ...createRequest(root, ["exit", "0"]), executablePath: join(root, "missing") },
			{ signal: controller.signal, temporaryDirectory: root },
		);
		controller.abort();

		const result = await execution;

		expect(result).toMatchObject({
			status: "cancelled",
			spawnError: { code: "ENOENT" },
			termination: { reason: "cancelled", attempted: false },
		});
	});

	function runExactArgs(args: readonly string[]): ReturnType<typeof runCli> {
		return runCli(
			{
				executablePath: process.execPath,
				args,
				cwd: root,
				timeoutMs: 5_000,
				environment: "empty",
				outputStrategy: "tail",
			},
			{ temporaryDirectory: root },
		);
	}
});
