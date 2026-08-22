import Type from "typebox";
import type { Static } from "typebox";

import {
	CLI_MAX_ACCEPTED_EXIT_CODES,
	CLI_MAX_ARGUMENT_BYTES,
	CLI_MAX_ARGUMENT_COUNT,
	CLI_DOCS_MAX_SUBCOMMAND_SEGMENT_BYTES,
	CLI_DOCS_MAX_SUBCOMMAND_SEGMENTS,
	CLI_INTROSPECTION_MAX_TIMEOUT_MS,
	CLI_INTROSPECTION_SUBCOMMAND_APPEND_MAX_ARGUMENTS,
	CLI_OFFICIAL_MAX_ALLOWED_HOSTS,
	CLI_OFFICIAL_MAX_SOURCES,
	CLI_OFFICIAL_MAX_TOPICS,
	CLI_MAX_PROCESS_EXIT_CODE,
	CLI_MAX_TIMEOUT_MS,
	CLI_MIN_TIMEOUT_MS,
} from "./limits.js";

export const RegistryIdSchema = Type.String({
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
const IntrospectionArgumentListSchema = Type.Array(ArgumentSchema, {
	minItems: 1,
	maxItems: CLI_MAX_ARGUMENT_COUNT,
});

const BinaryCandidatesSchema = Type.Object(
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
);

const RoutingListSchema = Type.Array(Type.String({ minLength: 1, maxLength: 512 }), {
	maxItems: 32,
	uniqueItems: true,
});

const RoutingKeywordsSchema = Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
	maxItems: 32,
	uniqueItems: true,
});

const OfficialHostSchema = Type.String({ minLength: 4, maxLength: 253, pattern: "^[a-z0-9.-]+$" });

const OfficialAlignmentSchema = Type.Union([
	Type.Object({ mode: Type.Literal("latest") }, { additionalProperties: false }),
	Type.Object({ mode: Type.Literal("unversioned") }, { additionalProperties: false }),
	Type.Object({ mode: Type.Literal("unknown") }, { additionalProperties: false }),
	Type.Object(
		{
			mode: Type.Literal("exact"),
			version: Type.String({ minLength: 5, maxLength: 64 }),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			mode: Type.Literal("compatible"),
			version: Type.String({ minLength: 5, maxLength: 64 }),
			precision: Type.Union([Type.Literal("major"), Type.Literal("major_minor")]),
		},
		{ additionalProperties: false },
	),
]);

export const OfficialDocumentationSourceSchema = Type.Object(
	{
		id: RegistryIdSchema,
		title: Type.String({ minLength: 1, maxLength: 128 }),
		url: Type.String({ minLength: 10, maxLength: 2048 }),
		allowed_hosts: Type.Array(OfficialHostSchema, {
			minItems: 1,
			maxItems: CLI_OFFICIAL_MAX_ALLOWED_HOSTS,
			uniqueItems: true,
		}),
		allowed_path_prefix: Type.String({ minLength: 1, maxLength: 1024, pattern: "^/" }),
		media: Type.Union([Type.Literal("html"), Type.Literal("markdown"), Type.Literal("text")]),
		topics: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
				maxItems: CLI_OFFICIAL_MAX_TOPICS,
				uniqueItems: true,
			}),
		),
		alignment: OfficialAlignmentSchema,
	},
	{ additionalProperties: false },
);

export type OfficialDocumentationSource = Static<typeof OfficialDocumentationSourceSchema>;

export const AcceptedExitCodesSchema = Type.Array(Type.Integer({ minimum: 0, maximum: CLI_MAX_PROCESS_EXIT_CODE }), {
	minItems: 1,
	maxItems: CLI_MAX_ACCEPTED_EXIT_CODES,
	uniqueItems: true,
});

const IntrospectionCommandSchema = Type.Object(
	{
		args: IntrospectionArgumentListSchema,
		accepted_exit_codes: Type.Optional(AcceptedExitCodesSchema),
		timeout_ms: Type.Optional(Type.Integer({ minimum: CLI_MIN_TIMEOUT_MS, maximum: CLI_INTROSPECTION_MAX_TIMEOUT_MS })),
	},
	{ additionalProperties: false },
);

const VersionIntrospectionCommandSchema = Type.Object(
	{
		args: IntrospectionArgumentListSchema,
		accepted_exit_codes: Type.Optional(AcceptedExitCodesSchema),
		timeout_ms: Type.Optional(Type.Integer({ minimum: CLI_MIN_TIMEOUT_MS, maximum: CLI_INTROSPECTION_MAX_TIMEOUT_MS })),
		parse: Type.Optional(Type.Object({ kind: Type.Literal("semver_first") }, { additionalProperties: false })),
	},
	{ additionalProperties: false },
);

const SubcommandPathSchema = Type.Array(
	Type.String({
		minLength: 1,
		maxLength: CLI_DOCS_MAX_SUBCOMMAND_SEGMENT_BYTES,
		pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
	}),
	{ minItems: 1, maxItems: CLI_DOCS_MAX_SUBCOMMAND_SEGMENTS },
);

const SubcommandHelpCommandSchema = Type.Object(
	{
		allowed_paths: Type.Array(SubcommandPathSchema, { minItems: 1, maxItems: 256 }),
		append_args: Type.Array(ArgumentSchema, {
			minItems: 1,
			maxItems: CLI_INTROSPECTION_SUBCOMMAND_APPEND_MAX_ARGUMENTS,
		}),
		accepted_exit_codes: Type.Optional(AcceptedExitCodesSchema),
		timeout_ms: Type.Optional(Type.Integer({ minimum: CLI_MIN_TIMEOUT_MS, maximum: CLI_INTROSPECTION_MAX_TIMEOUT_MS })),
	},
	{ additionalProperties: false },
);

const ManCommandSchema = Type.Object(
	{
		binary: BinaryCandidatesSchema,
		args: IntrospectionArgumentListSchema,
		accepted_exit_codes: Type.Optional(AcceptedExitCodesSchema),
		timeout_ms: Type.Optional(Type.Integer({ minimum: CLI_MIN_TIMEOUT_MS, maximum: CLI_INTROSPECTION_MAX_TIMEOUT_MS })),
	},
	{ additionalProperties: false },
);

/** Strict schema for a complete configured CLI definition. */
export const RegistryDefinitionSchema = Type.Object(
	{
		id: RegistryIdSchema,
		tool_name: ToolNameSchema,
		activation: Type.Optional(Type.Union([Type.Literal("eager"), Type.Literal("lazy")])),
		binary: BinaryCandidatesSchema,
		routing: Type.Object(
			{
				description: Type.String({ minLength: 1, maxLength: 2048 }),
				keywords: Type.Optional(RoutingKeywordsSchema),
				prefer_for: Type.Optional(RoutingListSchema),
				avoid_for: Type.Optional(RoutingListSchema),
			},
			{ additionalProperties: false },
		),
		introspection: Type.Object(
			{
				version: Type.Optional(VersionIntrospectionCommandSchema),
				help: Type.Optional(IntrospectionCommandSchema),
				subcommand_help: Type.Optional(SubcommandHelpCommandSchema),
				man: Type.Union([Type.Literal(false), ManCommandSchema]),
			},
			{ additionalProperties: false },
		),
		docs: Type.Object(
			{
				official: Type.Array(OfficialDocumentationSourceSchema, {
					maxItems: CLI_OFFICIAL_MAX_SOURCES,
				}),
			},
			{ additionalProperties: false },
		),
		execution: Type.Object(
			{
				timeout_ms: Type.Integer({ minimum: CLI_MIN_TIMEOUT_MS, maximum: CLI_MAX_TIMEOUT_MS }),
				cwd: Type.Literal("session"),
				inherit_env: Type.Boolean(),
				accepted_exit_codes: Type.Optional(AcceptedExitCodesSchema),
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

/** An ambiguous higher-precedence ID which adapters must withhold from execution. */
export interface QuarantinedRegistryId {
	id: string;
	layer: string;
	paths: string[];
	reason: "duplicate_id" | "invalid_override";
}

export interface RegistryLoadResult {
	definitions: LoadedRegistryDefinition[];
	disabled: LoadedDisabledEntry[];
	/** Definitions remain diagnostic-visible, but IDs listed here are not executable. */
	quarantined: QuarantinedRegistryId[];
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

export type LocalIntrospectionSource = "version" | "help" | "subcommand_help" | "man";
export type LocalIntrospectionCacheStatus = "hit" | "miss";

/** Stable, serializable identity for an executable observed immediately around introspection. */
export interface ExecutableIdentity {
	readonly realpath: string;
	readonly dev: string;
	readonly ino: string;
	readonly mode: string;
	readonly size: string;
	readonly mtimeNs: string;
	readonly ctimeNs: string;
}

export interface LocalIntrospectionCommand {
	readonly executablePath: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly timeoutMs: number;
}

export interface LocalIntrospectionExecutionMetadata {
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly durationMs: number;
	readonly capture: CliCaptureMetadata;
	readonly cleanup: CliProcessGroupCleanup | CliTermination | null;
	readonly error: CliErrorDetails | null;
}

export interface LocalIntrospectionSuccess {
	readonly status: "ok";
	readonly source: LocalIntrospectionSource;
	readonly command: LocalIntrospectionCommand;
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly durationMs: number;
	readonly truncated: boolean;
	readonly cache: LocalIntrospectionCacheStatus;
	readonly execution: LocalIntrospectionExecutionMetadata;
}

export type LocalIntrospectionUnavailableCode = "not_configured" | "helper_missing" | "executable_unavailable";

export interface LocalIntrospectionUnavailable {
	readonly status: "unavailable";
	readonly source: LocalIntrospectionSource;
	readonly code: LocalIntrospectionUnavailableCode;
	readonly command?: LocalIntrospectionCommand;
}

export type LocalIntrospectionFailureCode =
	| "invalid_request"
	| "spawn_error"
	| "unaccepted_exit"
	| "signal_exit"
	| "timed_out"
	| "cancelled"
	| "capture_incomplete"
	| "cleanup_incomplete"
	| "identity_changed"
	| "concurrency_limit";

export interface LocalIntrospectionFailure {
	readonly status: "failed";
	readonly source: LocalIntrospectionSource;
	readonly code: LocalIntrospectionFailureCode;
	readonly command?: LocalIntrospectionCommand;
	readonly exitCode?: number | null;
	readonly signal?: NodeJS.Signals | null;
	readonly durationMs?: number;
	readonly error?: CliErrorDetails;
	readonly execution?: LocalIntrospectionExecutionMetadata;
}

export type LocalIntrospectionOutcome =
	LocalIntrospectionSuccess | LocalIntrospectionUnavailable | LocalIntrospectionFailure;

export interface CliDocsRequest {
	readonly discovery: Extract<CliDiscovery, { status: "available" }>;
	readonly cwd: string;
	readonly subcommand?: readonly string[];
	readonly signal?: AbortSignal;
}

export interface CliDocsResult {
	readonly status: "ok" | "failed";
	readonly registryId: string;
	readonly toolName: string;
	readonly requestedSubcommand: readonly string[];
	readonly version: LocalIntrospectionOutcome;
	readonly documentation: LocalIntrospectionOutcome;
	readonly attempts: readonly LocalIntrospectionOutcome[];
	readonly definitionSha256: string;
	readonly executableIdentitySha256: string | null;
}

export interface CliVersionEvidenceResult {
	readonly outcome: LocalIntrospectionOutcome;
	readonly definitionSha256: string;
	readonly executableIdentitySha256: string | null;
}

export type OfficialDocumentationCacheStatus = "hit" | "miss";
export type OfficialDocumentationAlignmentState =
	"exact" | "major_match" | "major_minor_match" | "unversioned" | "unknown" | "mismatch";

export interface InstalledVersionEvidence {
	readonly parser: "semver_first";
	readonly raw: string;
	readonly normalizedVersion: string | null;
	readonly source: "installed_version_command";
	readonly definitionSha256: string;
	readonly executableIdentitySha256: string | null;
}

export interface OfficialDocumentationAlignment {
	readonly state: OfficialDocumentationAlignmentState;
	readonly installedVersion: string | null;
	readonly sourceVersion: string | null;
	readonly precision: "exact" | "major_minor" | "major" | null;
	readonly basis: "fixed_exact" | "fixed_version_match" | "declared_latest" | "declared_unversioned" | "unparsed";
	readonly evidenceSource: "installed_version_command" | null;
	readonly evidenceDefinitionSha256: string | null;
	readonly evidenceExecutableIdentitySha256: string | null;
}

export interface OfficialDocumentationSnippet {
	readonly sourceId: string;
	readonly heading: string | null;
	readonly offset: number;
	readonly score: number;
	readonly text: string;
	readonly sha256: string;
}

export interface OfficialDocumentationProvenance {
	readonly sourceId: string;
	readonly title: string;
	readonly configuredUrl: string;
	readonly finalUrl: string;
	readonly redirects: readonly string[];
	readonly domain: string;
	readonly mediaType: string;
	readonly cache: OfficialDocumentationCacheStatus;
	readonly retrievedAt: string;
	readonly bodySha256: string;
	readonly textSha256: string;
	readonly alignment: OfficialDocumentationAlignment;
}

export type OfficialDocumentationFailureCode =
	| "invalid_request"
	| "cancelled"
	| "timeout"
	| "dns_error"
	| "unsafe_address"
	| "tls_error"
	| "network_error"
	| "peer_mismatch"
	| "redirect_error"
	| "status_error"
	| "headers_too_large"
	| "body_too_large"
	| "truncated_body"
	| "wrong_type"
	| "unsupported_encoding"
	| "invalid_utf8"
	| "empty_document"
	| "parse_error"
	| "concurrency_limit";

export interface OfficialDocumentationSourceSuccess {
	readonly status: "ok";
	readonly sourceId: string;
	readonly provenance: OfficialDocumentationProvenance;
	readonly snippets: readonly OfficialDocumentationSnippet[];
}

export interface OfficialDocumentationSourceFailure {
	readonly status: "failed";
	readonly sourceId: string;
	readonly code: OfficialDocumentationFailureCode;
	readonly message: string;
}

export type OfficialDocumentationSourceOutcome =
	OfficialDocumentationSourceSuccess | OfficialDocumentationSourceFailure;

export interface OfficialDocumentationRequest {
	readonly registry: LoadedRegistryDefinition;
	readonly query: string;
	readonly installedVersion?: InstalledVersionEvidence;
	readonly signal?: AbortSignal;
}

export interface OfficialDocumentationResult {
	readonly status: "ok" | "failed";
	readonly registryId: string;
	readonly toolName: string;
	readonly query: string;
	readonly outcomes: readonly OfficialDocumentationSourceOutcome[];
	readonly snippets: readonly (OfficialDocumentationSnippet & {
		readonly provenance: OfficialDocumentationProvenance;
	})[];
	readonly definitionSha256: string;
}
