import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

import { executeCliProcess } from "./process-lifecycle.js";
import { CombinedOutputCollector } from "./output.js";
import { RawOutputSpool, removeCliOutputSpool } from "./spool.js";
import {
	CLI_MAX_ARGUMENT_BYTES,
	CLI_MAX_ARGUMENT_COUNT,
	CLI_MAX_PATH_BYTES,
	CLI_MAX_TIMEOUT_MS,
	CLI_MAX_TOTAL_ARGUMENT_BYTES,
	CLI_MIN_TIMEOUT_MS,
} from "./limits.js";
import type { CliEnvironmentPolicy, CliExecutionOptions, CliExecutionRequest, CliExecutionResult } from "./types.js";

export * from "./limits.js";
export { removeCliOutputSpool };

export type CliExecutionRequestErrorCode =
	| "unsupported_platform"
	| "invalid_executable_path"
	| "invalid_arguments"
	| "invalid_cwd"
	| "invalid_timeout"
	| "invalid_environment_policy"
	| "invalid_output_strategy";

/** A pre-spawn execution contract violation. */
export class CliExecutionRequestError extends Error {
	readonly code: CliExecutionRequestErrorCode;

	constructor(code: CliExecutionRequestErrorCode, message: string) {
		super(message);
		this.name = "CliExecutionRequestError";
		this.code = code;
	}
}

/**
 * Execute an exact discovered top-level executable with bounded output and POSIX process-group supervision.
 * Invalid requests throw before spawning; process and spool outcomes are returned as structured results.
 */
export async function runCli(
	request: CliExecutionRequest,
	options: CliExecutionOptions = {},
): Promise<CliExecutionResult> {
	validateRequest(request);

	const executablePath = request.executablePath;
	const args = [...request.args];
	const cwd = request.cwd;
	const collector = new CombinedOutputCollector(request.outputStrategy);
	const spool = new RawOutputSpool(options.temporaryDirectory ?? tmpdir());
	const environment = createEnvironment(request.environment, options.inheritedEnvironment);
	const startedAt = process.hrtime.bigint();
	const processOutcome = await executeCliProcess({
		executablePath,
		args,
		cwd,
		timeoutMs: request.timeoutMs,
		environment,
		...(options.signal ? { signal: options.signal } : {}),
		startedAt,
		onPipes: (stdout, stderr) => {
			spool.attachInputs(stdout, stderr);
		},
		onOutput: (stream, chunk) => {
			const truncated = collector.add(stream, chunk);
			spool.capture(stream, chunk, truncated);
		},
	});
	const projection = collector.finish();
	const spoolResult = await spool.finish(
		projection.truncation.truncated || processOutcome.capture.cutOff,
		processOutcome.capture.complete,
		{
			stdout: projection.truncation.stdout.rawBytesReceived,
			stderr: projection.truncation.stderr.rawBytesReceived,
		},
	);
	const common = {
		executablePath,
		args,
		cwd,
		durationMs: elapsedMilliseconds(startedAt),
		stdout: projection.stdout,
		stderr: projection.stderr,
		truncation: projection.truncation,
		capture: processOutcome.capture,
		spool: spoolResult,
	};

	switch (processOutcome.status) {
		case "spawn_error":
			return {
				...common,
				status: "spawn_error",
				exitCode: null,
				signal: null,
				spawnError: processOutcome.spawnError ?? createMissingStateError("Spawn error metadata missing"),
				termination: null,
				processGroupCleanup: null,
			};
		case "timed_out":
			return {
				...common,
				status: "timed_out",
				exitCode: processOutcome.exitCode,
				signal: processOutcome.signal,
				spawnError: processOutcome.spawnError,
				termination:
					processOutcome.termination?.reason === "timed_out"
						? processOutcome.termination
						: { reason: "timed_out", attempted: false, forced: false, confirmed: false, error: null },
				processGroupCleanup: null,
			};
		case "cancelled":
			return {
				...common,
				status: "cancelled",
				exitCode: processOutcome.exitCode,
				signal: processOutcome.signal,
				spawnError: processOutcome.spawnError,
				termination:
					processOutcome.termination?.reason === "cancelled"
						? processOutcome.termination
						: { reason: "cancelled", attempted: false, forced: false, confirmed: false, error: null },
				processGroupCleanup: null,
			};
		case "exited":
			return {
				...common,
				status: "exited",
				exitCode: processOutcome.exitCode,
				signal: processOutcome.signal,
				spawnError: null,
				termination: null,
				processGroupCleanup: processOutcome.processGroupCleanup ?? {
					reason: "natural_exit",
					attempted: false,
					forced: false,
					confirmed: false,
					error: createMissingStateError("Natural process-group cleanup metadata missing"),
				},
			};
	}
}

function validateRequest(request: CliExecutionRequest): void {
	if (process.platform !== "linux" && process.platform !== "darwin") {
		throw new CliExecutionRequestError(
			"unsupported_platform",
			`CLI execution is supported only on Linux and macOS, not ${process.platform}`,
		);
	}
	if (!isBoundedAbsolutePath(request.executablePath)) {
		throw new CliExecutionRequestError(
			"invalid_executable_path",
			`executablePath must be an absolute, NUL-free path of at most ${String(CLI_MAX_PATH_BYTES)} UTF-8 bytes`,
		);
	}
	if (!Array.isArray(request.args)) {
		throw new CliExecutionRequestError("invalid_arguments", "args must be an array");
	}
	if (request.args.length > CLI_MAX_ARGUMENT_COUNT) {
		throw new CliExecutionRequestError(
			"invalid_arguments",
			`args must contain at most ${String(CLI_MAX_ARGUMENT_COUNT)} elements`,
		);
	}
	let totalArgumentBytes = 0;
	for (const argument of request.args as readonly unknown[]) {
		if (typeof argument !== "string") {
			throw new CliExecutionRequestError("invalid_arguments", "every argument must be a string");
		}
		if (argument.includes("\0")) {
			throw new CliExecutionRequestError("invalid_arguments", "arguments cannot contain NUL characters");
		}
		const argumentBytes = Buffer.byteLength(argument, "utf8");
		if (argumentBytes > CLI_MAX_ARGUMENT_BYTES) {
			throw new CliExecutionRequestError(
				"invalid_arguments",
				`each argument must be at most ${String(CLI_MAX_ARGUMENT_BYTES)} UTF-8 bytes`,
			);
		}
		totalArgumentBytes += argumentBytes + 1;
		if (totalArgumentBytes > CLI_MAX_TOTAL_ARGUMENT_BYTES) {
			throw new CliExecutionRequestError(
				"invalid_arguments",
				`arguments must total at most ${String(CLI_MAX_TOTAL_ARGUMENT_BYTES)} UTF-8 bytes including separators`,
			);
		}
	}
	if (!isBoundedAbsolutePath(request.cwd)) {
		throw new CliExecutionRequestError(
			"invalid_cwd",
			`cwd must be an absolute, NUL-free path of at most ${String(CLI_MAX_PATH_BYTES)} UTF-8 bytes`,
		);
	}
	if (
		!Number.isInteger(request.timeoutMs) ||
		request.timeoutMs < CLI_MIN_TIMEOUT_MS ||
		request.timeoutMs > CLI_MAX_TIMEOUT_MS
	) {
		throw new CliExecutionRequestError(
			"invalid_timeout",
			`timeoutMs must be an integer from ${String(CLI_MIN_TIMEOUT_MS)} through ${String(CLI_MAX_TIMEOUT_MS)}`,
		);
	}
	const environment: unknown = request.environment;
	if (environment !== "inherit" && environment !== "empty") {
		throw new CliExecutionRequestError("invalid_environment_policy", 'environment must be "inherit" or "empty"');
	}
	const outputStrategy: unknown = request.outputStrategy;
	if (outputStrategy !== "head" && outputStrategy !== "tail") {
		throw new CliExecutionRequestError("invalid_output_strategy", 'outputStrategy must be "head" or "tail"');
	}
}

function isBoundedAbsolutePath(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		!value.includes("\0") &&
		Buffer.byteLength(value, "utf8") <= CLI_MAX_PATH_BYTES &&
		isAbsolute(value)
	);
}

function createEnvironment(
	policy: CliEnvironmentPolicy,
	inheritedEnvironment: Readonly<NodeJS.ProcessEnv> | undefined,
): NodeJS.ProcessEnv {
	if (policy === "empty") return {};
	const source = inheritedEnvironment ?? process.env;
	const snapshot: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(source)) {
		if (typeof value === "string") snapshot[name] = value;
	}
	return snapshot;
}

function elapsedMilliseconds(startedAt: bigint): number {
	return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

function createMissingStateError(message: string): {
	name: string;
	message: string;
	code: null;
	syscall: null;
} {
	return { name: "Error", message, code: null, syscall: null };
}
