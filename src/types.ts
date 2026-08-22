import Type from "typebox";
import type { Static } from "typebox";

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

const ArgumentSchema = Type.String({ minLength: 1, maxLength: 8192 });
const ArgumentListSchema = Type.Array(ArgumentSchema, {
	maxItems: 128,
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
				timeout_ms: Type.Integer({ minimum: 100, maximum: 600_000 }),
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
