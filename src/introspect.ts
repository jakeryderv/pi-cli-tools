import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";

import {
	LocalIntrospectionCache,
	LocalIntrospectionCacheConcurrencyError,
	LocalIntrospectionCacheWaiterCancelledError,
	hashCanonicalValue,
	type LocalIntrospectionCacheDiagnostics,
	type LocalIntrospectionCacheKey,
} from "./cache.js";
import {
	CLI_DOCS_MAX_SUBCOMMAND_BYTES,
	CLI_DOCS_MAX_SUBCOMMAND_SEGMENT_BYTES,
	CLI_DOCS_MAX_SUBCOMMAND_SEGMENTS,
	CLI_INTROSPECTION_AGGREGATE_TIMEOUT_MS,
	CLI_INTROSPECTION_DOCUMENT_MAX_BYTES,
	CLI_INTROSPECTION_DOCUMENT_MAX_LINES,
	CLI_INTROSPECTION_MAX_TIMEOUT_MS,
	CLI_INTROSPECTION_VERSION_MAX_BYTES,
	CLI_INTROSPECTION_VERSION_MAX_LINES,
} from "./limits.js";
import { CliExecutionRequestError, runCliCapture, type CliCaptureExecutionOptions } from "./runner.js";
import type {
	CliDiscovery,
	CliDocsRequest,
	CliDocsResult,
	CliErrorDetails,
	CliExecutionResult,
	ExecutableIdentity,
	ExecutableResolution,
	LoadedRegistryDefinition,
	LocalIntrospectionCommand,
	LocalIntrospectionFailure,
	LocalIntrospectionFailureCode,
	LocalIntrospectionOutcome,
	LocalIntrospectionSource,
	LocalIntrospectionSuccess,
	MissingExecutableResolution,
	RegistryDefinition,
} from "./types.js";

const WINDOWS_EXECUTABLE_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

export interface ExecutableDiscoveryOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
}

/** Resolve the first executable candidate found on PATH without launching it. */
export async function resolveExecutable(
	candidates: readonly string[],
	options: ExecutableDiscoveryOptions = {},
): Promise<ExecutableResolution | MissingExecutableResolution> {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const directories = getSearchDirectories(env, cwd);
	const checkedPaths: string[] = [];

	for (const candidate of candidates) {
		options.signal?.throwIfAborted();
		const candidateNames = getCandidateNames(candidate, env);
		for (const directory of directories) {
			for (const candidateName of candidateNames) {
				const path = join(directory, candidateName);
				checkedPaths.push(path);

				if (!(await awaitWithSignal(isExecutableFile(path), options.signal))) continue;
				try {
					return {
						candidate,
						executablePath: await awaitWithSignal(realpath(path), options.signal),
						checkedPaths,
					};
				} catch {
					if (options.signal?.aborted) throw abortReason(options.signal);
					// The path changed after it was checked; continue discovery.
				}
			}
		}
	}

	options.signal?.throwIfAborted();
	return { checkedPaths };
}

/** Resolve executables for each merged registry definition in stable registry order. */
export async function discoverRegistry(
	definitions: readonly LoadedRegistryDefinition[],
	options: ExecutableDiscoveryOptions = {},
): Promise<CliDiscovery[]> {
	const discoveries: CliDiscovery[] = [];

	for (const registry of definitions) {
		const resolution = await resolveExecutable(registry.definition.binary.candidates, options);
		if ("executablePath" in resolution) {
			discoveries.push({ status: "available", registry, resolution });
		} else {
			discoveries.push({ status: "missing", registry, resolution });
		}
	}

	return discoveries;
}

function getSearchDirectories(env: NodeJS.ProcessEnv, cwd: string): string[] {
	const pathValue = getEnvironmentValue(env, "PATH");
	if (!pathValue) return [];

	const directories = pathValue.split(delimiter).flatMap((entry) => {
		if (entry.length === 0) return [];
		return [isAbsolute(entry) ? entry : resolve(cwd, entry)];
	});
	return [...new Set(directories)];
}

function getCandidateNames(candidate: string, env: NodeJS.ProcessEnv): string[] {
	if (process.platform !== "win32" || extname(candidate).length > 0) return [candidate];

	const pathExt = getEnvironmentValue(env, "PATHEXT");
	const extensions = pathExt
		? pathExt
				.split(";")
				.map((extension) => extension.trim())
				.filter(Boolean)
		: WINDOWS_EXECUTABLE_EXTENSIONS;
	return extensions.map((extension) => `${candidate}${extension}`);
}

function getEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	if (process.platform !== "win32") return env[name];

	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
	return key ? env[key] : undefined;
}

async function isExecutableFile(path: string): Promise<boolean> {
	try {
		const metadata = await stat(path);
		if (!metadata.isFile()) return false;
		await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

const SUBCOMMAND_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const DEFAULT_INTROSPECTION_ACCEPTED_EXIT_CODES = [0] as const;

export interface CliDocsSubcommandValidation {
	readonly valid: boolean;
	readonly subcommand: readonly string[];
	readonly message?: string;
}

export interface LocalIntrospectionServiceDiagnostics {
	readonly cache: LocalIntrospectionCacheDiagnostics;
	readonly lastFailures: readonly {
		readonly registryId: string;
		readonly source: LocalIntrospectionSource;
		readonly code: string;
	}[];
}

type CaptureExecutor = (
	request: Parameters<typeof runCliCapture>[0],
	options: CliCaptureExecutionOptions,
) => Promise<CliExecutionResult>;

interface ConfiguredCommand {
	readonly source: LocalIntrospectionSource;
	readonly executablePath: string;
	readonly args: readonly string[];
	readonly timeoutMs: number;
	readonly acceptedExitCodes: readonly number[];
	readonly environment: Readonly<NodeJS.ProcessEnv>;
	readonly helperIdentity?: ExecutableIdentity;
}

class LocalIntrospectionOutcomeError extends Error {
	readonly outcome: Exclude<LocalIntrospectionOutcome, LocalIntrospectionSuccess>;

	constructor(outcome: Exclude<LocalIntrospectionOutcome, LocalIntrospectionSuccess>) {
		super(`${outcome.source}: ${outcome.code}`);
		this.name = "LocalIntrospectionOutcomeError";
		this.outcome = outcome;
	}
}

class LocalIntrospectionDeadlineError extends Error {
	constructor() {
		super("Local introspection aggregate deadline exceeded");
		this.name = "LocalIntrospectionDeadlineError";
	}
}

/** Validate a model-selected CLI subcommand path again immediately before core use. */
export function validateCliDocsSubcommand(value: unknown): CliDocsSubcommandValidation {
	if (value === undefined) return { valid: true, subcommand: [] };
	if (!Array.isArray(value)) return { valid: false, subcommand: [], message: "subcommand must be an array" };
	if (value.length < 1 || value.length > CLI_DOCS_MAX_SUBCOMMAND_SEGMENTS) {
		return {
			valid: false,
			subcommand: [],
			message: `subcommand must contain 1 through ${String(CLI_DOCS_MAX_SUBCOMMAND_SEGMENTS)} segments`,
		};
	}
	const subcommand: string[] = [];
	let totalBytes = 0;
	for (const segment of value as unknown[]) {
		if (typeof segment !== "string") {
			return { valid: false, subcommand: [], message: "every subcommand segment must be a string" };
		}
		const bytes = Buffer.byteLength(segment, "utf8");
		if (bytes < 1 || bytes > CLI_DOCS_MAX_SUBCOMMAND_SEGMENT_BYTES || !SUBCOMMAND_SEGMENT_PATTERN.test(segment)) {
			return {
				valid: false,
				subcommand: [],
				message: `subcommand segments must match ${SUBCOMMAND_SEGMENT_PATTERN.source} and be at most ${String(CLI_DOCS_MAX_SUBCOMMAND_SEGMENT_BYTES)} UTF-8 bytes`,
			};
		}
		totalBytes += bytes + 1;
		if (totalBytes > CLI_DOCS_MAX_SUBCOMMAND_BYTES) {
			return {
				valid: false,
				subcommand: [],
				message: `subcommand must total at most ${String(CLI_DOCS_MAX_SUBCOMMAND_BYTES)} UTF-8 bytes`,
			};
		}
		subcommand.push(segment);
	}
	return { valid: true, subcommand };
}

/** Session-scoped, agent-independent retrieval of explicitly configured local CLI documentation. */
export class LocalIntrospectionService {
	readonly #cache: LocalIntrospectionCache;
	readonly #execute: CaptureExecutor;
	readonly #getHostEnvironment: () => Readonly<NodeJS.ProcessEnv>;
	readonly #lifecycle = new AbortController();
	readonly #lastFailures = new Map<string, string>();
	readonly #aggregateTimeoutMs: number;
	#closed = false;
	#closePromise: Promise<void> | undefined;

	constructor(
		options: {
			readonly cache?: LocalIntrospectionCache;
			readonly execute?: CaptureExecutor;
			readonly getHostEnvironment?: () => Readonly<NodeJS.ProcessEnv>;
			/** Deterministic test override; production uses the fixed aggregate deadline. */
			readonly aggregateTimeoutMs?: number;
		} = {},
	) {
		this.#cache = options.cache ?? new LocalIntrospectionCache();
		this.#execute = options.execute ?? runCliCapture;
		this.#getHostEnvironment = options.getHostEnvironment ?? (() => process.env);
		this.#aggregateTimeoutMs = options.aggregateTimeoutMs ?? CLI_INTROSPECTION_AGGREGATE_TIMEOUT_MS;
	}

	async inspect(request: CliDocsRequest): Promise<CliDocsResult> {
		const { definition } = request.discovery.registry;
		const definitionSha256 = hashCanonicalValue(definition);
		const validation = validateCliDocsSubcommand(request.subcommand);
		if (!validation.valid) {
			const outcome = failure("help", "invalid_request");
			this.#recordOutcome(definition.id, outcome);
			return {
				status: "failed",
				registryId: definition.id,
				toolName: definition.tool_name,
				requestedSubcommand: [],
				version: { status: "unavailable", source: "version", code: "not_configured" },
				documentation: outcome,
				attempts: [outcome],
				definitionSha256,
				executableIdentitySha256: null,
			};
		}

		const configuredSubcommand = definition.introspection.subcommand_help;
		if (
			validation.subcommand.length > 0 &&
			configuredSubcommand &&
			!configuredSubcommand.allowed_paths.some((allowed) => arraysEqual(allowed, validation.subcommand))
		) {
			const outcome = failure("subcommand_help", "invalid_request");
			this.#recordOutcome(definition.id, outcome);
			return {
				status: "failed",
				registryId: definition.id,
				toolName: definition.tool_name,
				requestedSubcommand: validation.subcommand,
				version: { status: "unavailable", source: "version", code: "not_configured" },
				documentation: outcome,
				attempts: [outcome],
				definitionSha256,
				executableIdentitySha256: null,
			};
		}

		const hostEnvironment = snapshotEnvironment(this.#getHostEnvironment());
		const deadline = new AbortController();
		const deadlineTimer = setTimeout(() => {
			deadline.abort(new LocalIntrospectionDeadlineError());
		}, this.#aggregateTimeoutMs);
		deadlineTimer.unref();
		const aggregateSignal = AbortSignal.any(
			[request.signal, this.#lifecycle.signal, deadline.signal].filter(
				(signal): signal is AbortSignal => signal !== undefined,
			),
		);

		try {
			if (this.#closed || aggregateSignal.aborted) {
				return this.#cancelledResult(definition, validation.subcommand, definitionSha256, deadline.signal.aborted);
			}

			const initialIdentity = await fingerprintExecutable(request.discovery.resolution.executablePath, aggregateSignal);
			if (!initialIdentity) {
				const unavailableVersion: LocalIntrospectionOutcome = {
					status: "unavailable",
					source: "version",
					code: "executable_unavailable",
				};
				const unavailable: LocalIntrospectionOutcome = {
					status: "unavailable",
					source: validation.subcommand.length > 0 ? "subcommand_help" : "help",
					code: "executable_unavailable",
				};
				this.#recordOutcome(definition.id, unavailableVersion);
				this.#recordOutcome(definition.id, unavailable);
				return {
					status: "failed",
					registryId: definition.id,
					toolName: definition.tool_name,
					requestedSubcommand: validation.subcommand,
					version: unavailableVersion,
					documentation: unavailable,
					attempts: [unavailableVersion, unavailable],
					definitionSha256,
					executableIdentitySha256: null,
				};
			}
			const executableIdentitySha256 = hashCanonicalValue(initialIdentity);
			this.#cache.prepareRegistry(definition.id, `${definitionSha256}:${executableIdentitySha256}`);
			const selectedEnvironment = definition.execution.inherit_env ? hostEnvironment : {};

			const versionPromise = this.#retrieveSelected(
				request,
				"version",
				[],
				selectedEnvironment,
				definitionSha256,
				initialIdentity,
				aggregateSignal,
			);
			const docsPromise = this.#retrieveDocumentation(
				request,
				validation.subcommand,
				selectedEnvironment,
				hostEnvironment,
				definitionSha256,
				initialIdentity,
				aggregateSignal,
			);
			const [version, docs] = await Promise.all([versionPromise, docsPromise]);
			if (isSignalAborted(aggregateSignal)) {
				this.#recordOutcome(definition.id, version);
				for (const attempt of docs.attempts) this.#recordOutcome(definition.id, attempt);
				return {
					status: "failed",
					registryId: definition.id,
					toolName: definition.tool_name,
					requestedSubcommand: validation.subcommand,
					version,
					documentation: docs.documentation,
					attempts: [version, ...docs.attempts],
					definitionSha256,
					executableIdentitySha256,
				};
			}
			const finalIdentity = await fingerprintExecutable(request.discovery.resolution.executablePath, aggregateSignal);
			if (!finalIdentity || hashCanonicalValue(finalIdentity) !== executableIdentitySha256) {
				const identityFailure = identityFailureFromOutcome(docs.documentation);
				this.#recordOutcome(definition.id, identityFailure);
				return {
					status: "failed",
					registryId: definition.id,
					toolName: definition.tool_name,
					requestedSubcommand: validation.subcommand,
					version: version.status === "ok" ? identityFailureFromOutcome(version) : version,
					documentation: identityFailure,
					attempts: [version, ...docs.attempts, identityFailure],
					definitionSha256,
					executableIdentitySha256,
				};
			}
			this.#recordOutcome(definition.id, version);
			for (const attempt of docs.attempts) this.#recordOutcome(definition.id, attempt);
			return {
				status: docs.documentation.status === "ok" ? "ok" : "failed",
				registryId: definition.id,
				toolName: definition.tool_name,
				requestedSubcommand: validation.subcommand,
				version,
				documentation: docs.documentation,
				attempts: [version, ...docs.attempts],
				definitionSha256,
				executableIdentitySha256,
			};
		} catch (error) {
			if (aggregateSignal.aborted) {
				return this.#cancelledResult(definition, validation.subcommand, definitionSha256, deadline.signal.aborted);
			}
			throw error;
		} finally {
			clearTimeout(deadlineTimer);
		}
	}

	diagnostics(): LocalIntrospectionServiceDiagnostics {
		return {
			cache: this.#cache.diagnostics(),
			lastFailures: [...this.#lastFailures].map(([key, code]) => {
				const separator = key.indexOf(":");
				return {
					registryId: separator < 0 ? key : key.slice(0, separator),
					source: (separator < 0 ? "help" : key.slice(separator + 1)) as LocalIntrospectionSource,
					code,
				};
			}),
		};
	}

	close(): Promise<void> {
		if (this.#closePromise) return this.#closePromise;
		this.#closed = true;
		this.#lifecycle.abort();
		this.#closePromise = this.#cache.close();
		return this.#closePromise;
	}

	async #retrieveDocumentation(
		request: CliDocsRequest,
		subcommand: readonly string[],
		selectedEnvironment: Readonly<NodeJS.ProcessEnv>,
		hostEnvironment: Readonly<NodeJS.ProcessEnv>,
		definitionSha256: string,
		expectedTargetIdentity: ExecutableIdentity,
		signal: AbortSignal,
	): Promise<{ documentation: LocalIntrospectionOutcome; attempts: readonly LocalIntrospectionOutcome[] }> {
		if (subcommand.length > 0) {
			const outcome = await this.#retrieveSelected(
				request,
				"subcommand_help",
				subcommand,
				selectedEnvironment,
				definitionSha256,
				expectedTargetIdentity,
				signal,
			);
			return { documentation: outcome, attempts: [outcome] };
		}

		const help = await this.#retrieveSelected(
			request,
			"help",
			[],
			selectedEnvironment,
			definitionSha256,
			expectedTargetIdentity,
			signal,
		);
		if (help.status === "ok" || signal.aborted) return { documentation: help, attempts: [help] };
		const man = await this.#retrieveMan(request, hostEnvironment, definitionSha256, expectedTargetIdentity, signal);
		return {
			documentation: man.status === "unavailable" && help.status === "failed" ? help : man,
			attempts: [help, man],
		};
	}

	async #retrieveSelected(
		request: CliDocsRequest,
		source: "version" | "help" | "subcommand_help",
		subcommand: readonly string[],
		environment: Readonly<NodeJS.ProcessEnv>,
		definitionSha256: string,
		expectedTargetIdentity: ExecutableIdentity,
		signal: AbortSignal,
	): Promise<LocalIntrospectionOutcome> {
		const { definition } = request.discovery.registry;
		const configured = definition.introspection[source];
		if (!configured) return { status: "unavailable", source, code: "not_configured" };
		const configuredArgs =
			source === "subcommand_help"
				? definition.introspection.subcommand_help?.append_args
				: source === "version"
					? definition.introspection.version?.args
					: definition.introspection.help?.args;
		if (!configuredArgs) return { status: "unavailable", source, code: "not_configured" };
		const args = source === "subcommand_help" ? [...subcommand, ...configuredArgs] : [...configuredArgs];
		const command: ConfiguredCommand = {
			source,
			executablePath: request.discovery.resolution.executablePath,
			args,
			timeoutMs: Math.min(
				definition.execution.timeout_ms,
				configured.timeout_ms ?? CLI_INTROSPECTION_MAX_TIMEOUT_MS,
				CLI_INTROSPECTION_MAX_TIMEOUT_MS,
			),
			acceptedExitCodes: configured.accepted_exit_codes ?? DEFAULT_INTROSPECTION_ACCEPTED_EXIT_CODES,
			environment,
		};
		return this.#retrieveConfigured(request, command, subcommand, definitionSha256, expectedTargetIdentity, signal);
	}

	async #retrieveMan(
		request: CliDocsRequest,
		hostEnvironment: Readonly<NodeJS.ProcessEnv>,
		definitionSha256: string,
		expectedTargetIdentity: ExecutableIdentity,
		signal: AbortSignal,
	): Promise<LocalIntrospectionOutcome> {
		const { definition } = request.discovery.registry;
		const configured = definition.introspection.man;
		if (configured === false) return { status: "unavailable", source: "man", code: "not_configured" };
		if (signal.aborted) return failure("man", failureCodeForAbort(signal));
		const resolution = await resolveExecutable(configured.binary.candidates, {
			cwd: request.cwd,
			env: { ...hostEnvironment },
			signal,
		});
		if (!("executablePath" in resolution)) {
			return { status: "unavailable", source: "man", code: "helper_missing" };
		}
		const helperIdentity = await fingerprintExecutable(resolution.executablePath, signal);
		if (!helperIdentity) return { status: "unavailable", source: "man", code: "helper_missing" };
		const command: ConfiguredCommand = {
			source: "man",
			executablePath: resolution.executablePath,
			args: [...configured.args],
			timeoutMs: Math.min(
				definition.execution.timeout_ms,
				configured.timeout_ms ?? CLI_INTROSPECTION_MAX_TIMEOUT_MS,
				CLI_INTROSPECTION_MAX_TIMEOUT_MS,
			),
			acceptedExitCodes: configured.accepted_exit_codes ?? DEFAULT_INTROSPECTION_ACCEPTED_EXIT_CODES,
			environment: createManEnvironment(hostEnvironment),
			helperIdentity,
		};
		return this.#retrieveConfigured(request, command, [], definitionSha256, expectedTargetIdentity, signal);
	}

	async #retrieveConfigured(
		request: CliDocsRequest,
		configured: ConfiguredCommand,
		subcommand: readonly string[],
		definitionSha256: string,
		expectedTargetIdentity: ExecutableIdentity,
		signal: AbortSignal,
	): Promise<LocalIntrospectionOutcome> {
		const { definition } = request.discovery.registry;
		const targetIdentity = await fingerprintExecutable(request.discovery.resolution.executablePath, signal);
		if (!targetIdentity) {
			return { status: "unavailable", source: configured.source, code: "executable_unavailable" };
		}
		if (hashCanonicalValue(targetIdentity) !== hashCanonicalValue(expectedTargetIdentity)) {
			return failure(configured.source, "identity_changed");
		}
		if (configured.helperIdentity) {
			const currentHelperIdentity = await fingerprintExecutable(configured.executablePath, signal);
			if (
				!currentHelperIdentity ||
				hashCanonicalValue(currentHelperIdentity) !== hashCanonicalValue(configured.helperIdentity)
			) {
				return failure(configured.source, "identity_changed");
			}
		}
		const command: LocalIntrospectionCommand = {
			executablePath: configured.executablePath,
			args: configured.args,
			cwd: request.cwd,
			timeoutMs: configured.timeoutMs,
		};
		const key: LocalIntrospectionCacheKey = {
			schemaVersion: 1,
			registryId: definition.id,
			definitionSha256,
			executable: expectedTargetIdentity,
			...(configured.helperIdentity ? { helperExecutable: configured.helperIdentity } : {}),
			source: configured.source,
			subcommand,
			args: configured.args,
			cwd: request.cwd,
			environmentSha256: hashCanonicalValue(configured.environment),
		};

		try {
			return await this.#cache.getOrLoad(key, signal, async (flightSignal) => {
				const beforeTargetIdentity = await fingerprintExecutable(
					request.discovery.resolution.executablePath,
					flightSignal,
				);
				const beforeHelperIdentity = configured.helperIdentity
					? await fingerprintExecutable(configured.executablePath, flightSignal)
					: undefined;
				if (
					!beforeTargetIdentity ||
					hashCanonicalValue(beforeTargetIdentity) !== hashCanonicalValue(expectedTargetIdentity) ||
					(configured.helperIdentity &&
						(!beforeHelperIdentity ||
							hashCanonicalValue(beforeHelperIdentity) !== hashCanonicalValue(configured.helperIdentity)))
				) {
					throw new LocalIntrospectionOutcomeError(failure(configured.source, "identity_changed", command));
				}
				const result = await this.#execute(
					{
						executablePath: configured.executablePath,
						args: configured.args,
						cwd: request.cwd,
						timeoutMs: configured.timeoutMs,
						environment: "inherit",
						outputStrategy: "head",
					},
					{
						signal: flightSignal,
						inheritedEnvironment: configured.environment,
						maxOutputBytes:
							configured.source === "version"
								? CLI_INTROSPECTION_VERSION_MAX_BYTES
								: CLI_INTROSPECTION_DOCUMENT_MAX_BYTES,
						maxOutputLines:
							configured.source === "version"
								? CLI_INTROSPECTION_VERSION_MAX_LINES
								: CLI_INTROSPECTION_DOCUMENT_MAX_LINES,
					},
				);
				const outcome = mapExecutionOutcome(configured, command, result);
				if (outcome.status !== "ok") throw new LocalIntrospectionOutcomeError(outcome);
				const afterTargetIdentity = await fingerprintExecutable(
					request.discovery.resolution.executablePath,
					flightSignal,
				);
				const afterHelperIdentity = configured.helperIdentity
					? await fingerprintExecutable(configured.executablePath, flightSignal)
					: undefined;
				if (
					!afterTargetIdentity ||
					hashCanonicalValue(afterTargetIdentity) !== hashCanonicalValue(expectedTargetIdentity) ||
					(configured.helperIdentity &&
						(!afterHelperIdentity ||
							hashCanonicalValue(afterHelperIdentity) !== hashCanonicalValue(configured.helperIdentity)))
				) {
					throw new LocalIntrospectionOutcomeError(failure(configured.source, "identity_changed", command, result));
				}
				return outcome;
			});
		} catch (error) {
			if (error instanceof LocalIntrospectionOutcomeError) {
				if (
					error.outcome.status === "failed" &&
					error.outcome.code === "cancelled" &&
					failureCodeForAbort(signal) === "timed_out"
				) {
					return { ...error.outcome, code: "timed_out" };
				}
				return error.outcome;
			}
			if (error instanceof LocalIntrospectionCacheConcurrencyError) {
				return failure(configured.source, "concurrency_limit", command);
			}
			if (error instanceof LocalIntrospectionCacheWaiterCancelledError) {
				return failure(configured.source, failureCodeForAbort(signal), command);
			}
			if (error instanceof CliExecutionRequestError) {
				return failure(configured.source, "invalid_request", command, undefined, toErrorDetails(error));
			}
			throw error;
		}
	}

	#recordOutcome(registryId: string, outcome: LocalIntrospectionOutcome): void {
		const key = `${registryId}:${outcome.source}`;
		if (outcome.status === "ok") this.#lastFailures.delete(key);
		else this.#lastFailures.set(key, outcome.code);
	}

	#cancelledResult(
		definition: RegistryDefinition,
		subcommand: readonly string[],
		definitionSha256: string,
		deadline: boolean,
	): CliDocsResult {
		const code = deadline ? "timed_out" : "cancelled";
		const version = failure("version", code);
		const documentation = failure(subcommand.length > 0 ? "subcommand_help" : "help", code);
		return {
			status: "failed",
			registryId: definition.id,
			toolName: definition.tool_name,
			requestedSubcommand: subcommand,
			version,
			documentation,
			attempts: [version, documentation],
			definitionSha256,
			executableIdentitySha256: null,
		};
	}
}

export async function fingerprintExecutable(
	path: string,
	signal?: AbortSignal,
): Promise<ExecutableIdentity | undefined> {
	try {
		signal?.throwIfAborted();
		const resolved = await awaitWithSignal(realpath(path), signal);
		const metadata = await awaitWithSignal(stat(resolved, { bigint: true }), signal);
		if (!metadata.isFile()) return undefined;
		await awaitWithSignal(access(resolved, process.platform === "win32" ? constants.F_OK : constants.X_OK), signal);
		return {
			realpath: resolved,
			dev: metadata.dev.toString(),
			ino: metadata.ino.toString(),
			mode: metadata.mode.toString(),
			size: metadata.size.toString(),
			mtimeNs: metadata.mtimeNs.toString(),
			ctimeNs: metadata.ctimeNs.toString(),
		};
	} catch {
		if (signal?.aborted) throw abortReason(signal);
		return undefined;
	}
}

/** Normalize terminal controls, overstrike/backspace formatting, carriage rewriting, and Unicode format controls. */
export function sanitizeLocalDocumentationText(value: string): string {
	const stripped = stripVTControlCharacters(value);
	let line: string[] = [];
	let cursor = 0;
	let output = "";
	const flush = (newline: boolean) => {
		output += line.join("");
		if (newline) output += "\n";
		line = [];
		cursor = 0;
	};
	for (const character of stripped) {
		if (character === "\n") {
			flush(true);
			continue;
		}
		if (character === "\r") {
			cursor = 0;
			continue;
		}
		if (character === "\b") {
			cursor = Math.max(0, cursor - 1);
			continue;
		}
		const codePoint = character.codePointAt(0);
		if (
			codePoint === undefined ||
			(codePoint !== 0x09 && (codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f))) ||
			/\p{Cf}/u.test(character)
		) {
			continue;
		}
		if (cursor < line.length) line[cursor] = character;
		else line.push(character);
		cursor += 1;
	}
	flush(false);
	return output;
}

function mapExecutionOutcome(
	configured: ConfiguredCommand,
	command: LocalIntrospectionCommand,
	result: CliExecutionResult,
): LocalIntrospectionOutcome {
	if (result.status === "spawn_error") {
		return failure(configured.source, "spawn_error", command, result, result.spawnError);
	}
	if (result.status === "timed_out") return failure(configured.source, "timed_out", command, result);
	if (result.status === "cancelled") return failure(configured.source, "cancelled", command, result);
	if (result.signal !== null || result.exitCode === null) {
		return failure(configured.source, "signal_exit", command, result);
	}
	if (!result.capture.complete) return failure(configured.source, "capture_incomplete", command, result);
	if (!result.processGroupCleanup.confirmed || result.processGroupCleanup.error) {
		return failure(
			configured.source,
			"cleanup_incomplete",
			command,
			result,
			result.processGroupCleanup.error ?? undefined,
		);
	}
	if (!configured.acceptedExitCodes.includes(result.exitCode)) {
		return failure(configured.source, "unaccepted_exit", command, result);
	}
	return {
		status: "ok",
		source: configured.source,
		command,
		stdout: sanitizeLocalDocumentationText(result.stdout),
		stderr: sanitizeLocalDocumentationText(result.stderr),
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		truncated: result.truncation.truncated,
		cache: "miss",
		execution: toExecutionMetadata(result),
	};
}

function identityFailureFromOutcome(outcome: LocalIntrospectionOutcome): LocalIntrospectionFailure {
	return {
		status: "failed",
		source: outcome.source,
		code: "identity_changed",
		...(outcome.command ? { command: outcome.command } : {}),
		...(outcome.status !== "unavailable" && outcome.execution
			? {
					exitCode: outcome.execution.exitCode,
					signal: outcome.execution.signal,
					durationMs: outcome.execution.durationMs,
					execution: outcome.execution,
				}
			: {}),
	};
}

function failure(
	source: LocalIntrospectionSource,
	code: LocalIntrospectionFailureCode,
	command?: LocalIntrospectionCommand,
	result?: CliExecutionResult,
	error?: CliErrorDetails,
): LocalIntrospectionFailure {
	return {
		status: "failed",
		source,
		code,
		...(command ? { command } : {}),
		...(result
			? {
					exitCode: result.exitCode,
					signal: result.signal,
					durationMs: result.durationMs,
				}
			: {}),
		...(error ? { error } : {}),
		...(result ? { execution: toExecutionMetadata(result) } : {}),
	};
}

function toExecutionMetadata(result: CliExecutionResult) {
	return {
		exitCode: result.exitCode,
		signal: result.signal,
		durationMs: result.durationMs,
		capture: { ...result.capture },
		cleanup:
			result.status === "exited"
				? { ...result.processGroupCleanup }
				: result.status === "timed_out" || result.status === "cancelled"
					? { ...result.termination }
					: null,
		error: result.status === "spawn_error" ? { ...result.spawnError } : null,
	};
}

function failureCodeForAbort(signal: AbortSignal): "timed_out" | "cancelled" {
	return signal.reason instanceof LocalIntrospectionDeadlineError ? "timed_out" : "cancelled";
}

function snapshotEnvironment(source: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
	const snapshot: NodeJS.ProcessEnv = {};
	for (const [name, value] of Object.entries(source)) if (typeof value === "string") snapshot[name] = value;
	return snapshot;
}

function createManEnvironment(host: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		LANG: "C",
		LC_ALL: "C",
		MANPAGER: "cat",
		PAGER: "cat",
		TERM: "dumb",
		GROFF_NO_SGR: "1",
	};
	if (typeof host.PATH === "string") environment.PATH = host.PATH;
	return environment;
}

function isSignalAborted(signal: AbortSignal): boolean {
	return signal.aborted;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise<T>((resolvePromise, rejectPromise) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () => {
			finish(() => {
				rejectPromise(abortReason(signal));
			});
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				finish(() => {
					resolvePromise(value);
				});
			},
			(error: unknown) => {
				finish(() => {
					rejectPromise(error instanceof Error ? error : new Error(String(error)));
				});
			},
		);
	});
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Local introspection aborted");
}

function toErrorDetails(error: Error): CliErrorDetails {
	const candidate = error as NodeJS.ErrnoException;
	return {
		name: error.name,
		message: error.message,
		code: typeof candidate.code === "string" ? candidate.code : null,
		syscall: typeof candidate.syscall === "string" ? candidate.syscall : null,
	};
}
