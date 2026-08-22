import Type from "typebox";
import type { Static } from "typebox";

import { CLI_MAX_ARGUMENT_BYTES, CLI_MAX_ARGUMENT_COUNT, CLI_MAX_TIMEOUT_MS, CLI_MIN_TIMEOUT_MS } from "./limits.js";

const RegistryIdSchema = Type.String({
	minLength: 1,
	maxLength: 64,
	pattern: "^[a-z][a-z0-9_-]*$",
});

const ToolNameSchema = Type.String({
	minLength: 1,
	maxLength: 64,
	pattern: "^[a-z][a-z0-9_]*$",
});

const ArgumentSchema = Type.String({ minLength: 1, maxLength: CLI_MAX_ARGUMENT_BYTES });
const ArgumentListSchema = Type.Array(ArgumentSchema, {
	maxItems: CLI_MAX_ARGUMENT_COUNT,
});

const RoutingListSchema = Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
	maxItems: 32,
	uniqueItems: true,
});

const IntrospectionCommandSchema = Type.Object(
	{
		args: ArgumentListSchema,
	},
	{ additionalProperties: false },
);

/** Strict schema for a complete configured CLI definition. */
export const RegistryDefinitionSchema = Type.Object(
	{
		id: RegistryIdSchema,
		tool_name: ToolNameSchema,
		binary: Type.Object(
			{
				candidates: Type.Array(
					Type.String({
						minLength: 1,
						maxLength: 255,
						pattern: "^[^/\\\\\\u0000]+$",
					}),
					{
						minItems: 1,
						maxItems: 32,
						uniqueItems: true,
					},
				),
			},
			{ additionalProperties: false },
		),
		routing: Type.Object(
			{
				description: Type.String({ minLength: 1, maxLength: 2048 }),
				prefer_for: Type.Optional(RoutingListSchema),
				avoid_for: Type.Optional(RoutingListSchema),
			},
			{ additionalProperties: false },
		),
		introspection: Type.Object(
			{
				version: Type.Optional(IntrospectionCommandSchema),
				help: Type.Optional(IntrospectionCommandSchema),
				subcommand_help: Type.Optional(
					Type.Object(
						{
							append_args: ArgumentListSchema,
						},
						{ additionalProperties: false },
					),
				),
				man: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
		docs: Type.Object(
			{
				official: Type.Array(Type.String({ minLength: 1, maxLength: 2048 }), {
					maxItems: 16,
					uniqueItems: true,
				}),
			},
			{ additionalProperties: false },
		),
		execution: Type.Object(
			{
				timeout_ms: Type.Integer({ minimum: CLI_MIN_TIMEOUT_MS, maximum: CLI_MAX_TIMEOUT_MS }),
				cwd: Type.Literal("session"),
				inherit_env: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export const DisabledRegistryEntrySchema = Type.Object(
	{
		id: RegistryIdSchema,
		disabled: Type.Literal(true),
	},
	{ additionalProperties: false },
);

export type RegistryDefinition = Static<typeof RegistryDefinitionSchema>;
export type DisabledRegistryEntry = Static<typeof DisabledRegistryEntrySchema>;
export type RegistryEntry = RegistryDefinition | DisabledRegistryEntry;

type RegistryLayerKind = "bundled" | "user";

export interface RegistryLayer {
	name: string;
	kind: RegistryLayerKind;
	directory: string;
	required: boolean;
}

export interface RegistrySource {
	layer: string;
	path: string;
}

export interface LoadedRegistryDefinition {
	definition: RegistryDefinition;
	source: RegistrySource;
}

export interface LoadedDisabledEntry {
	entry: DisabledRegistryEntry;
	source: RegistrySource;
}

type RegistryIssueCode =
	| "duplicate_id"
	| "duplicate_tool_name"
	| "file_read_error"
	| "file_too_large"
	| "invalid_definition"
	| "invalid_url"
	| "layer_read_error"
	| "yaml_parse_error"
	| "yaml_warning";

export interface RegistryIssue {
	code: RegistryIssueCode;
	message: string;
	layer: string;
	path?: string;
}

export interface RegistryLayerSummary {
	name: string;
	kind: RegistryLayerKind;
	directory: string;
	required: boolean;
	exists: boolean;
	files: string[];
}

export interface RegistryLoadResult {
	definitions: LoadedRegistryDefinition[];
	disabled: LoadedDisabledEntry[];
	issues: RegistryIssue[];
	layers: RegistryLayerSummary[];
}

export interface ExecutableResolution {
	candidate: string;
	executablePath: string;
	checkedPaths: string[];
}

export interface MissingExecutableResolution {
	checkedPaths: string[];
}

export type CliDiscovery =
	| {
			status: "available";
			registry: LoadedRegistryDefinition;
			resolution: ExecutableResolution;
	  }
	| {
			status: "missing";
			registry: LoadedRegistryDefinition;
			resolution: MissingExecutableResolution;
	  };

export type CliExecutionStatus = "exited" | "timed_out" | "cancelled" | "spawn_error";
export type CliEnvironmentPolicy = "inherit" | "empty";
export type CliOutputStrategy = "head" | "tail";

/** Trusted, agent-independent inputs for one direct CLI invocation. */
export interface CliExecutionRequest {
	/** Absolute top-level executable path returned by discovery; the runner does not PATH-search it. */
	readonly executablePath: string;
	/** Exact argv elements. They are never parsed, escaped, or interpreted as shell text. */
	readonly args: readonly string[];
	/** Absolute working directory selected by the trusted adapter or registry policy. */
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly environment: CliEnvironmentPolicy;
	readonly outputStrategy: CliOutputStrategy;
}

/** Host-only controls which must not be exposed as model-provided execution parameters. */
export interface CliExecutionOptions {
	readonly signal?: AbortSignal;
	/** Embedding/test override for the snapshot used by the "inherit" policy. */
	readonly inheritedEnvironment?: Readonly<NodeJS.ProcessEnv>;
	/** Embedding/test override for the parent of package-owned spool directories. */
	readonly temporaryDirectory?: string;
}

export interface CliOutputExtent {
	/** UTF-8 bytes after streaming decoding, including replacement of invalid input. */
	readonly bytes: number;
	/** Newline-delimited logical lines. Empty text has zero lines. */
	readonly lines: number;
}

export interface CliStreamOutputStats {
	readonly rawBytesReceived: number;
	readonly original: CliOutputExtent;
	readonly returned: CliOutputExtent;
	readonly truncated: boolean;
}

export interface CliOutputTruncation {
	readonly truncated: boolean;
	readonly strategy: CliOutputStrategy;
	readonly limits: CliOutputExtent;
	readonly original: CliOutputExtent;
	readonly returned: CliOutputExtent;
	readonly reasons: {
		readonly bytes: boolean;
		readonly lines: boolean;
	};
	readonly stdout: CliStreamOutputStats;
	readonly stderr: CliStreamOutputStats;
	/** A UTF-8-safe prefix or suffix of an oversized boundary line was returned. */
	readonly boundaryLinePartial: boolean;
}

export interface CliCaptureMetadata {
	readonly complete: boolean;
	readonly cutOff: boolean;
	readonly reason: "output_drain_timeout" | "process_group_cleanup" | "termination_confirmation_timeout" | null;
}

export interface CliErrorDetails {
	readonly name: string;
	readonly message: string;
	readonly code: string | null;
	readonly syscall: string | null;
}

interface CliOutputSpoolBase {
	readonly bytesWritten: number;
	readonly maxBytes: number;
	/** Files or directories retained for inspection or explicit cleanup. */
	readonly retainedPaths: readonly string[];
	/** Sidecar cleanup failure after a usable combined file was assembled. */
	readonly cleanupError: CliErrorDetails | null;
}

export type CliOutputSpool =
	| (CliOutputSpoolBase & {
			readonly status: "not_needed";
			readonly path: null;
			readonly bytesWritten: 0;
			readonly error: null;
	  })
	| (CliOutputSpoolBase & {
			readonly status: "complete";
			readonly path: string;
			readonly error: null;
	  })
	| (CliOutputSpoolBase & {
			readonly status: "partial";
			readonly path: string;
			readonly error: null;
	  })
	| (CliOutputSpoolBase & {
			readonly status: "failed";
			readonly path: null;
			readonly error: CliErrorDetails;
	  });

interface CliTerminationBase {
	/** False when the first cause was observed before a process successfully spawned. */
	readonly attempted: boolean;
	/** True only when SIGKILL was successfully sent to the original process group. */
	readonly forced: boolean;
	/** Whether the original POSIX process group was observed to be gone. */
	readonly confirmed: boolean;
	readonly error: CliErrorDetails | null;
}

export interface CliTimeoutTermination extends CliTerminationBase {
	readonly reason: "timed_out";
}

export interface CliCancellationTermination extends CliTerminationBase {
	readonly reason: "cancelled";
}

export type CliTermination = CliTimeoutTermination | CliCancellationTermination;

export interface CliProcessGroupCleanup extends CliTerminationBase {
	readonly reason: "natural_exit";
}

interface CliExecutionResultBase {
	readonly executablePath: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly durationMs: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly truncation: CliOutputTruncation;
	readonly capture: CliCaptureMetadata;
	readonly spool: CliOutputSpool;
}

export type CliExecutionResult =
	| (CliExecutionResultBase & {
			readonly status: "exited";
			readonly exitCode: number | null;
			readonly signal: NodeJS.Signals | null;
			readonly spawnError: null;
			readonly termination: null;
			readonly processGroupCleanup: CliProcessGroupCleanup;
	  })
	| (CliExecutionResultBase & {
			readonly status: "timed_out";
			readonly exitCode: number | null;
			readonly signal: NodeJS.Signals | null;
			readonly spawnError: CliErrorDetails | null;
			readonly termination: CliTimeoutTermination;
			readonly processGroupCleanup: null;
	  })
	| (CliExecutionResultBase & {
			readonly status: "cancelled";
			readonly exitCode: number | null;
			readonly signal: NodeJS.Signals | null;
			readonly spawnError: CliErrorDetails | null;
			readonly termination: CliCancellationTermination;
			readonly processGroupCleanup: null;
	  })
	| (CliExecutionResultBase & {
			readonly status: "spawn_error";
			readonly exitCode: null;
			readonly signal: null;
			readonly spawnError: CliErrorDetails;
			readonly termination: null;
			readonly processGroupCleanup: null;
	  });
