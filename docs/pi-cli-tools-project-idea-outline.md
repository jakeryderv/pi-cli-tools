# Pi CLI Tools Registry

## Project idea

Build a **Pi package whose main component is a Pi extension** that registers installed, standalone command-line programs as native Pi tools.

The package should keep the real capabilities agent-independent: Pi supplies the adapter, while a reusable CLI registry/runtime discovers tools, executes them, inspects their installed interfaces, and retrieves documentation. This gives Pi clear, first-class tools without replacing portable CLIs with agent-specific integrations.

```text
Pi
  -> Pi extension / native-tool adapter
      -> agent-independent CLI registry and runtime
          -> firecrawl, playwright, gh, docker, ...
```

The first release should prove that a small native wrapper improves tool selection and execution reliability compared with asking the agent to invoke the same CLI through a general-purpose shell tool.

## Goals

- Make configured, installed CLIs discoverable as native Pi tools.
- Give each CLI concise, curated routing guidance.
- Execute explicit argument arrays without a shell.
- Provide consistent cancellation, timeout, output handling, and diagnostics.
- Use the installed executable for version-aligned syntax and local help.
- Retrieve documentation on demand instead of placing manuals in the permanent prompt.
- Keep registry, execution, introspection, and documentation logic independent of Pi.
- Allow richer CLI-specific schemas later without requiring them for every tool.

## Non-goals

At least through the initial releases, the project will not:

- Install, update, or authenticate CLIs automatically.
- Sandbox installed programs or guarantee that a CLI operation is non-destructive.
- Convert every CLI flag and subcommand into a large generated schema.
- Infer execution safety from `--help` output.
- Recursively introspect every possible subcommand at startup.
- Crawl and index arbitrary documentation sites automatically.
- Replace rich MCP or project-specific integrations when those are a better fit.
- Extract multiple packages before another adapter or consumer justifies that cost.

## Sources of truth

Different parts of the system have different authorities:

| Concern                                                     | Source of truth                   |
| ----------------------------------------------------------- | --------------------------------- |
| Identity, routing, introspection strategy, execution policy | Declarative registry              |
| Availability, version, syntax, and local help               | Installed executable              |
| Detailed behavior not available locally                     | Configured official documentation |

Routing descriptions should remain curated and stable. Installed help may be used for documentation and validation, but should not silently rewrite a tool's routing description at runtime.

## Design principles

- Prefer standalone CLIs for generic, global capabilities.
- Register each configured CLI as a native Pi tool with a concise description of what it does, when to use it, and when not to use it.
- Begin with a small, stable interface such as `{ "args": [...] }` instead of converting every CLI flag into a large tool schema.
- Invoke a resolved executable directly with an argument array; never construct a shell command.
- Perform only executable discovery during startup. Retrieve versions, help, and man pages lazily and cache the results.
- Keep all command and documentation output bounded before returning it to the model.
- Keep documentation out of the permanent prompt. Retrieve only the relevant material when the agent needs it.
- Prefer local, version-aligned information before remote documentation.
- Treat retrieved documentation and CLI output as reference data, not trusted agent instructions.
- Keep the Pi adapter thin so the registry/runtime can later support other agent harnesses.
- Keep routing metadata deterministic; avoid runtime-generated descriptions that make behavior and prompt caching unpredictable.

## Architecture

```text
pi-cli-tools/
├── package.json
├── extensions/
│   ├── cli-tools.ts       # Pi factory lifecycle and diagnostics command
│   └── pi-adapter.ts      # Pi schemas, registration, result formatting, and rendering
├── src/
│   ├── types.ts           # agent-independent contracts
│   ├── limits.ts          # shared registry and runtime hard limits
│   ├── registry.ts        # load, merge, and validate definitions
│   ├── runner.ts          # bounded shell-free execution facade
│   ├── process-lifecycle.ts # process-group supervision
│   ├── output.ts          # deterministic bounded text projection
│   ├── spool.ts           # private lazy raw-output retention
│   ├── introspect.ts      # executable, version, help, and man discovery
│   ├── docs.ts            # documentation retrieval and focused search
│   └── cache.ts           # introspection and documentation cache
├── tools/
│   ├── github.yaml
│   └── ripgrep.yaml
└── tests/
    └── fixtures/
        └── bin/            # controlled fake executables for runner tests
```

The initial implementation should ship as one Pi package. Module boundaries should keep Pi-specific types out of `src/`, but the agent-independent modules should not be extracted into a separate package until there is a real second consumer.

The package manifest should explicitly register `extensions/cli-tools.ts`. Pi runtime packages should be peer dependencies, while YAML parsing and other runtime libraries should be normal production dependencies.

## Registry and configuration model

### Registry definition

Each definition has a stable registry identity, a Pi tool name, executable candidates, routing guidance, explicitly configured introspection commands, documentation sources, and execution settings.

```yaml
id: github
tool_name: cli_gh

binary:
  candidates: ["gh"]

routing:
  description: Work with GitHub repositories, issues, pull requests, releases, and workflows.
  prefer_for:
    - querying or modifying GitHub resources
    - GitHub API requests authenticated through the installed CLI
  avoid_for:
    - editing local Git history

introspection:
  version:
    args: ["--version"]
  help:
    args: ["--help"]
  subcommand_help:
    append_args: ["--help"]
  man: false

docs:
  official:
    - https://cli.github.com/manual/

execution:
  timeout_ms: 120000
  cwd: session
  inherit_env: true
```

`id`, `tool_name`, and the executable name are intentionally separate. For example, a stable registry entry named `github` may expose `cli_gh` while invoking an executable named `gh`.

Definitions may optionally declare `execution.accepted_exit_codes` as a nonempty, duplicate-free list of integer process exit codes from 0 through 255. Omission means exactly `[0]`; an explicit list is authoritative and does not implicitly add zero. The bundled ripgrep definition uses `[0, 1]` because exit 1 represents no matches. Complete higher-precedence replacement means an override that omits the field returns to `[0]` rather than inheriting a lower definition's list.

### Validation rules

The registry should be validated before any tools are registered:

- Registry IDs must be unique within a configuration layer.
- Tool names must satisfy Pi's tool-name requirements.
- Tool-name collisions with built-in or extension tools must fail clearly by default.
- Definitions must use known fields and valid values.
- Argument lists must contain strings only.
- Accepted exit codes, when present, must contain 1 through 256 unique finite integers in the portable 0-through-255 process-exit range; canonical negative zero is rejected because it is not JSON-stable.
- Timeouts and output limits must remain within hard runtime bounds.
- A missing executable is an availability condition, not an extension startup failure.
- An invalid definition is reported with its source file and is not registered.

The runtime should not silently override an existing Pi tool. A future explicit opt-in may allow intentional overrides, but that is not part of v0.1.

### Configuration layers

The intended precedence is:

```text
1. Definitions bundled with the package
2. User definitions and explicit overrides
3. Trusted project definitions and overrides — later milestone
```

The canonical user configuration location can be `~/.pi/agent/cli-tools/`. Project-local configuration, if added, should be derived from Pi's configured project directory name rather than hardcoding `.pi`, and must only be read after the project is trusted.

Definitions are merged by stable `id`. A later definition with the same ID replaces the complete earlier definition rather than performing an ambiguous deep merge. A user layer disables a bundled definition with a strict tombstone containing only its ID and `disabled: true`.

Each `.yaml`, `.yml`, or `.json` file contains one definition or tombstone. Duplicate IDs within the same layer are errors. Two enabled entries that resolve to the same `tool_name` are also errors. When the highest-precedence layer touching an ID contains duplicates or an invalid file with a safely identifiable valid ID, that ID is quarantined from executable registration rather than falling back to a lower definition. Malformed files whose IDs cannot be identified do not suppress unrelated definitions.

## Extension lifecycle and tool activation

### Startup

The extension does only bounded local work during startup, split around Pi's runtime binding boundary:

1. During extension factory loading, load and validate bundled and user registry layers and register lifecycle handlers plus `/cli-tools`.
2. Do not call uninitialized Pi action methods such as `getAllTools()` or `getActiveTools()` from the factory. Pi permits `registerTool()` during factory loading, but this adapter intentionally defers it because collision preflight depends on post-bind `getAllTools()` and discovery depends on the session `ctx.cwd`.
3. In one awaited, idempotent `session_start` handler, resolve executable candidates on `PATH` relative to `ctx.cwd`.
4. Snapshot `getAllTools()` before adapter registration, record collisions with their `sourceInfo`, and register each available, supported, non-quarantined, non-colliding definition once.
5. Record registration and activation outcomes for human-facing diagnostics.
6. Register the shared documentation tool only once local introspection is introduced in v0.2.

Startup does not run executables or version, help, man, or network documentation commands. `/reload` creates a fresh extension instance and is the v0.1c refresh mechanism; no in-place watcher or refresh subsystem is used because Pi has no native-tool unregistration API.

### Missing and changed executables

A configured but missing executable should not produce a broken native tool. It should appear in diagnostics as unavailable, including the executable candidates that were checked.

Execution should pass the selected top-level path directly rather than asking the runner to search `PATH` again for every call. This does not control shebang interpreters, loaders, plugins, or children selected by the executable. A reload or explicit refresh command may repeat discovery if the user installs or replaces a CLI during a session.

### Activation and scale

For the small v0.1 registry, available CLI tools may be active immediately.

As the registry grows, the Pi adapter should support:

- Registering tools while leaving selected tools inactive.
- An always-active `cli_tools` search/list/enable tool.
- Per-definition `eager` or `lazy` activation.
- Additive activation through Pi's dynamic tool APIs so compatible models can use deferred tool loading.

The agent-independent registry should expose searchable routing metadata, but activation remains an adapter concern.

## Native CLI tool contract

The generic v0.1 input is deliberately small:

```json
{
  "args": ["pr", "view", "42", "--json", "title,state"]
}
```

The initial tool input exposes exactly one required `args` array and does not expose environment overrides, shell text, standard input, cwd, timeout, executable selection, output strategy, or spool controls. Commands run in Pi's current working directory; the current registry schema supports only `cwd: session`.

Richer CLI-specific tools may be added selectively after the generic interface is proven useful. Those tools may share the same runner and registry entry.

### Execution contract

For every invocation, the runner should:

1. Pass the top-level executable path selected during discovery directly to the process API without another runner-initiated `PATH` search.
2. Pass arguments directly to the process without a shell.
3. Validate argument count and total argument size against hard limits.
4. Use the session working directory or a configured fixed directory.
5. Apply the configured environment policy.
6. Honor the caller's cancellation signal.
7. Enforce the configured child timeout and clean the original process group on timeout, cancellation, or direct-child exit.
8. Capture stdout and stderr separately.
9. Preserve exit code, terminating signal, duration, timeout, and cancellation state.
10. Bound all data returned to the model.

“Safe execution” in this project means shell-free, bounded process invocation. It does not mean that the installed program is sandboxed, trustworthy, or non-destructive.

The v0.1b core runner makes these boundaries concrete:

- Execution is supported on Linux and macOS; every other platform is rejected before spawn.
- Executable and working-directory paths must be absolute, NUL-free, and at most 4,096 UTF-8 bytes.
- At most 128 arguments are accepted. Each is at most 8,192 UTF-8 bytes and the array totals at most 32 KiB including one separator byte per argument. Empty arguments remain valid.
- Timeout must be an integer from 100 through 600,000 milliseconds.
- The trusted adapter passes a concrete session or registry-fixed working directory. The execution request exposes no model-selected directory.
- Environment policy is either a point-in-time inherited snapshot or a truly empty environment. There is no request-level override map.
- Stdin is ignored and no TTY is allocated.
- Cancellation and timeout signal the detached process group with `SIGTERM`, escalate a surviving group to `SIGKILL` after 500 milliseconds, and stop process-control confirmation after five seconds.
- A surviving original process group is also cleaned after direct-child exit while preserving `exited` status. Cancellation or child timeout during drain accelerates cleanup without changing the first cause.
- Pipe draining stops five seconds after direct-child exit when an escaped descendant holds inherited descriptors. Capture cutoff is explicit and distinct from model truncation.
- Process-group termination is best effort rather than sandboxing: descendants can escape by creating a new session or process group.
- The timeout bounds child execution and process control, not non-cancellable temporary-filesystem finalization. `durationMs` includes finalization and can exceed `timeoutMs`.
- Passing a fixed top-level path does not pin its inode or control shebang interpreters, loaders, plugins, and children selected through inherited environment variables or `PATH`.

Invalid requests are pre-spawn contract errors. Spawn failures, non-zero exits, signal exits, timeouts, and cancellations remain structured process outcomes. The first observed terminal cause wins, including cancellation before a later asynchronous spawn error.

### Result model

The agent-independent runner should return structured information similar to:

```text
CliExecutionResult
  executable
  args
  cwd
  status: exited | timed_out | cancelled | spawn_error
  exit_code
  signal
  duration_ms
  stdout
  stderr
  truncation
  capture
  spool: not_needed | complete | partial | failed
  process_group_cleanup
```

The Pi adapter turns this into sanitized, concise model-facing text plus serializable structured `details` for rendering and diagnostics. Details retain the complete runner result, including separate stdout/stderr, capture and truncation metadata, spool path/failure and conditional cleanup ownership, and process-group cleanup state. Cleanup is not applicable when no paths were retained; otherwise `pi-cli-tools` owns the retained artifacts until an embedding host calls `removeCliOutputSpool()` or the user explicitly removes a disclosed path. Because Pi persists tool details and model-facing output in session history, both forms must be treated as potentially sensitive.

The adapter's `tool_result` handler classifies a result as successful only when it is a normal, signal-free exit whose actual code appears in the matching registered definition's accepted list. Request errors, spawn errors, timeouts, cancellations, signal exits, null exit codes, and unaccepted exits remain Pi errors without discarding their structured results. Truncation, partial capture, and spool warnings do not by themselves convert an otherwise accepted exit into an error.

Accepted-exit classification is adapter policy, not runner semantics. The agent-independent runner always preserves the real process status and exit code. Newly emitted Pi details snapshot the effective list for historical rendering, while live middleware trusts the matching registered definition. Legacy v0.1c details without a snapshot retain `[0]` behavior. Model-facing status distinguishes accepted and unaccepted exits without adding the full policy list to permanent model context.

### Output limits

Tool output must follow Pi's bounded-output conventions: no more than 50KB or 2,000 lines in model-facing content, whichever limit is reached first.

The runner should retain stdout and stderr separately while applying one combined model-context budget. If output is truncated:

- The result must say that truncation occurred.
- It must report original and returned sizes.
- The complete output should be written to a temporary file when possible.
- The result should include the temporary path so the agent can inspect it deliberately.

The truncation strategy should be deterministic and configurable where different CLIs need head-oriented or tail-oriented output.

The v0.1b runner reserves framing space by limiting returned process text to 48 KiB and 1,980 logical lines. It uses one combined budget with a stable conceptual channel order of stdout followed by stderr: head selection gives stdout priority, while tail selection gives stderr priority. This is deterministic across OS pipe chunking and preserves separate stream fields and original/returned aggregate and per-stream counts. Each stream is decoded independently with a streaming UTF-8 decoder; invalid input uses replacement characters in model-facing text while raw byte counts remain available.

Collection uses bounded head/tail reservoirs rather than buffering complete output. Raw prefix bytes remain bounded in memory until truncation or forced capture cutoff makes retention necessary. The runner then lazily creates private stdout/stderr sidecars, streams with backpressure, and assembles one owner-readable file with labeled stream sections.

Combined raw spool payload is capped at 64 MiB. Capture cutoff or cap exhaustion returns a partial path and can never claim complete output. Setup, write, assembly, and sidecar-cleanup failures remain visible metadata without replacing process status. Package-owned retained output has a 512 MiB aggregate quota per temporary parent; assembly can temporarily use roughly twice the payload cap. Files can contain credentials or adversarial output and remain until the consumer calls `removeCliOutputSpool()`.

The v0.1d Pi adapter uses tail output for every CLI unless registry-configurable output policy is introduced. This is appropriate for general command output but can omit the beginning of search results; the hermetic evaluation records that UX limitation rather than expanding policy scope. Final rendered status, labels, notices, paths, and process text remain bounded to Pi's full 50 KiB and 2,000-line ceiling.

## Local introspection

Introspection commands must be explicitly configured in the registry. The runtime should not recursively guess every CLI's command structure.

### Version and help

Version and top-level help are retrieved on first use and cached. Subcommand help is requested only for an explicit subcommand path supplied to `cli_docs`.

For the example definition:

```text
subcommand: ["pr", "create"]
append_args: ["--help"]
```

The local command would be equivalent to invoking:

```text
gh pr create --help
```

without using a shell.

### Man pages

Man-page retrieval is optional and platform-dependent. It must disable interactive pagers and return plain, bounded text. Absence of `man` or of a page is a normal unavailable-source result.

### Cache identity

Local introspection cache entries should include enough identity to avoid stale results, such as:

- Resolved executable path
- Executable file metadata or content identity
- Reported version when available
- Registry definition hash
- Introspection request, including subcommand path

A changed executable or changed definition must invalidate the relevant cache entry.

## Shared `cli_docs` tool

Expose one documentation tool for every registered CLI:

```text
cli_docs({
  tool: "cli_gh",
  subcommand: ["pr", "create"],
  query: "create a draft pull request"
})
```

`subcommand` is optional but should be preferred when the caller knows which command family is relevant. This avoids relying on natural-language search to infer where `--help` belongs.

Its retrieval order should be:

1. Installed version and explicitly requested local help.
2. Configured local man page.
3. Cached official documentation associated with that version where possible.
4. Live official documentation when local and cached sources are insufficient.

The tool should return:

- A small relevant excerpt
- Source type: `help`, `man`, `cache`, or `official`
- Installed CLI version when known
- Introspection command used for local material
- Source URL for remote material
- Cache status
- Truncation status

It must never inject an entire manual into context.

### Official documentation boundaries

Official documentation support should initially be limited to explicitly configured URLs and domains. Retrieval should use bounded fetching and focused local search rather than attempting to become a universal crawler.

Version alignment is best-effort because many documentation sites expose only their latest release. The result must distinguish version-matched, version-unknown, and latest-only sources rather than implying stronger alignment than is available.

Remote documentation is untrusted reference text even when it comes from an official domain. Returned excerpts should preserve provenance and must not be treated as instructions to the agent.

## Security and trust model

Installing the Pi package grants its extension normal extension privileges. Configuring a CLI also authorizes the extension to launch that installed executable with model-selected arguments.

The security model should state explicitly:

- Registry definitions are trusted configuration.
- Accepted exit codes classify normal process results; they do not authorize an operation or establish safety.
- Project-local definitions are ignored until the project is trusted.
- Executables are never installed automatically.
- Executables are invoked by resolved path without a shell.
- Model-provided arguments remain untrusted input and are bounded before spawning.
- Environment inheritance may expose all credentials available to the Pi process.
- A registered CLI may execute plugins, load configuration files, contact networks, mutate local files, or delete remote resources.
- Timeout and cancellation reduce runaway execution risk but do not provide sandboxing.
- Documentation and process output may contain adversarial text and are returned as attributed reference data.

Many authenticated CLIs require their inherited environment. The bundled GitHub definition therefore uses `inherit_env: true`, while ripgrep uses an empty environment to avoid ambient credentials and `RIPGREP_CONFIG_PATH`. Diagnostics make that choice visible. A later version may add allow/deny lists or explicit environment profiles.

Deterministic confirmation policies may also be added later. The runtime should not attempt to classify arbitrary arguments as safe or destructive from help text alone.

## Separation of concerns

| Layer                  | Purpose                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| Standalone CLI         | Portable, reusable capability                                              |
| CLI registry/runtime   | Identity, discovery, execution, introspection, and documentation           |
| Pi extension           | Registers tools, adapts results, controls activation, and exposes commands |
| `cli_docs`             | Supplies current syntax and behavior on demand                             |
| Skills                 | Teach higher-level workflows that may combine multiple tools               |
| MCP/project extensions | Provide rich, structured, stateful, or project-specific integrations       |

The intended configuration model is:

```text
Global/user scope  -> standalone CLIs + CLI registry
Workflow guidance  -> skills
Project scope      -> MCP servers and project-specific extensions
```

Not every external capability should be forced into this registry. A CLI is a good fit when it has a stable non-interactive interface and useful standalone behavior. Stateful services, highly structured APIs, and project-specific systems may remain better MCP or extension candidates.

## Human-facing diagnostics

The extension should expose a status command, such as `/cli-tools`, that reports:

- Loaded registry sources
- Available and missing entries
- Resolved executable paths
- Validation and name-collision errors
- Cached versions when known
- Activation state
- How to refresh discovery after installing a CLI

Diagnostics should not require the model or consume conversation context. v0.1c stores activation-time collision outcomes rather than recomputing collisions from names, which avoids classifying successfully registered adapter tools as collisions with themselves. v0.1d also exposes bounded timeout, session-cwd, and environment policy for registered and missing definitions, plus non-default accepted-exit policy. Diagnostics instruct users to run `/reload` after executable or registry changes.

## Testing strategy

### Registry tests

- Valid and invalid definitions
- Unknown fields, invalid argument lists, and strict accepted-exit boundaries
- Configuration precedence, complete replacement, and invalid-override quarantine
- Duplicate IDs and tool-name collisions
- Missing executable behavior

### Runner tests

Use controlled fixture executables to verify:

- Exact argument preservation, including spaces and shell metacharacters
- Absence of shell interpolation
- Working-directory behavior
- Environment policy
- Separate stdout and stderr capture
- Non-zero exit codes
- Spawn failures
- Timeout and cancellation
- Process-tree termination
- Large-output truncation and full-output spooling

### Introspection and documentation tests

- Version and help are not executed during startup
- Lazy cache population and invalidation
- Explicit subcommand help construction
- Missing man pages
- Source provenance and bounded excerpts
- Remote source domain restrictions

### Pi integration tests

- Package discovery and extension loading
- Both bundled definitions through controlled executables, without host-installed CLIs or third-party CLI network requests
- Native tool registration only for available CLIs
- Clear handling of registration collisions
- Accepted and unaccepted nonzero classification through the real Pi tool-result pipeline
- Tool cancellation through Pi's signal
- Structured result rendering and bounded large output
- Reload or refresh after executable changes

## Success criteria

The initial idea is validated when:

- Missing or invalid CLI entries do not prevent the extension from loading.
- Startup performs no version, help, man, or network documentation calls.
- Executable and argument boundaries are preserved without shell interpretation.
- Cancellation, timeout, and direct-child exit clean ordinary descendants remaining in the original process group.
- Large output cannot overwhelm model context.
- Local help corresponds to the executable selected for execution.
- Representative agent tasks select and use the native CLI tool reliably compared with a shell-only baseline.
- The Pi extension contains adaptation and lifecycle logic, not core registry, process, or documentation behavior.

## Development roadmap

### v0.1a — Registry and discovery foundation

- Load and strictly validate bundled and user registry layers.
- Merge complete definitions and explicit disable entries.
- Resolve executable candidates to exact real paths without launching them.
- Expose diagnostics without registering native tools.

### v0.1b — Agent-independent bounded runner

- Validate trusted execution requests and invoke configured top-level paths without a shell or runner-initiated `PATH` search.
- Support structured exits, spawn errors, cancellation, timeout, and bounded POSIX process-group termination.
- Capture separate streams under one deterministic model-facing budget.
- Stream raw output to private capped spools and retain complete output only when truncation requires it.
- Keep the Pi extension diagnostics-only while the core contract receives independent review.

### v0.1c — Native Pi tool adapter

- Defer executable discovery and Pi action methods to `session_start`.
- Register one generic `{ args: string[] }` native tool for each eligible available CLI.
- Preflight Pi tool-name collisions without intentional overrides.
- Map exact discovery paths, registry execution policy, current session cwd, and Pi cancellation into the v0.1b runner.
- Return bounded sanitized text, structured execution details, explicit Pi error classification, and compact TUI rendering.
- Report registered, active, missing, disabled, quarantined, colliding, unsupported, and failed registrations through `/cli-tools`.
- Use `/reload` for deterministic rediscovery and registration refresh.

### v0.1d — Second CLI and hermetic contract evaluation

- Bundle a strict ripgrep definition alongside GitHub CLI, with contrasting empty-environment policy and accepted no-match exit 1.
- Add optional strictly validated definition-level accepted exit codes while keeping the runner policy-neutral.
- Classify accepted exits only in the Pi adapter and preserve actual nonzero status in details and concise rendering.
- Make timeout, cwd, environment, and non-default accepted-exit policy visible in bounded human diagnostics.
- Exercise both production definitions through controlled executables, real Pi lifecycle and middleware, reload, bounded output, and packed production installation.
- Record deterministic evidence and residual limitations without claiming third-party CLI conformance or model-selection superiority.

### v0.1 — Reliable registry and execution

- Define agent-independent contracts.
- Load and strictly validate bundled and user definitions.
- Resolve configured binaries on `PATH`.
- Register one native Pi tool per available CLI.
- Execute explicit argument arrays without a shell.
- Honor cancellation and enforce bounded original-process-group cleanup.
- Return structured execution metadata.
- Truncate and spool large output.
- Add human-facing status and refresh commands.
- Cover the runner with controlled fake-executable tests.

### v0.2 — Local introspection

- Detect installed versions lazily.
- Capture top-level help on demand.
- Retrieve explicit subcommand help.
- Add optional man-page support.
- Introduce the shared `cli_docs` tool.
- Cache local introspection by executable and definition identity.

### v0.3 — Scale and official documentation

- Add lazy tool activation and a registry search/enable tool.
- Configure authoritative documentation URLs and domains per CLI.
- Add bounded fetching, caching, and focused local search.
- Associate documentation with installed versions where supported.
- Return explicit source provenance and version-alignment status.

### v1.0 — Stabilized adapter boundary

- Stabilize the registry, runner, introspection, documentation, and adapter contracts.
- Document the interface required by a new agent adapter.
- Extract the agent-independent core into its own package only when a second real consumer justifies it.

```text
agent-independent CLI core
        ├── Pi adapter
        ├── future Codex adapter
        └── future Claude adapter
```

## Recommended starting point

Ship the first implementation as a single Pi package with two contrasting CLI definitions and controlled fixture executables. Keep the Pi-specific extension separate from the registry, runner, introspection, and documentation modules, but optimize first for proving the generic execution contract.

Do not begin remote documentation retrieval until registry loading, shell-free execution, cancellation, timeout, output bounding, and diagnostics are tested and stable.
