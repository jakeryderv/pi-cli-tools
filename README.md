# pi-cli-tools

A Pi package for registering standalone command-line programs as native tools with bounded, shell-free execution.

## Status

The package currently:

- Loads and strictly validates bundled and user registry definitions.
- Merges definitions by stable ID, including explicit user disable entries, and quarantines attributable ambiguous overrides from execution.
- Resolves configured executable candidates to exact paths without launching them.
- Registers one native Pi tool for each available, eligible, non-colliding CLI on Linux and macOS.
- Registers one shared `cli_docs` tool after native registration when at least one eligible CLI is available.
- Retrieves configured installed-version, top-level help, explicit subcommand help, and optional local man text only when `cli_docs` is called.
- Deduplicates concurrent identical introspection and caches only complete successful bounded results in memory by definition, executable, environment, operation, cwd, and subcommand identity.
- Executes literal argument arrays through the agent-independent bounded runner with the registry's timeout and environment policy, Pi's current working directory, and Pi's cancellation signal.
- Preserves actual process outcomes while applying definition-level accepted-exit classification only in the Pi adapter.
- Returns bounded model-facing stdout/stderr plus serializable execution, truncation, capture, spool, and process-group cleanup details.
- Exposes `/cli-tools` for human-facing registration, activation, collision, registry, availability, execution-policy, local-source, and in-memory cache diagnostics without filling the cache.

See the [project design outline](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/pi-cli-tools-project-idea-outline.md) for the intended architecture, execution contract, security model, and roadmap.

## Why this project

Many useful capabilities already exist as portable command-line programs. This project aims to expose configured CLIs as clear, first-class Pi tools while keeping discovery, execution, introspection, and documentation logic independent of any one agent harness.

```text
Pi
  -> Pi extension
      -> agent-independent CLI registry and runtime
          -> installed standalone CLIs
```

## Security

Pi extensions run with the user's full system permissions. Configured native CLIs can access the same files, inherited environment variables, credentials, and network resources available to the Pi process when their registry policy enables environment inheritance. GitHub CLI can use inherited credentials and mutate remote resources; ripgrep can disclose local secrets, and flags such as `--follow`, `--no-ignore`, `--pre`, and `--search-zip` broaden its effects.

The core runner invokes the configured top-level path without a shell, bounds arguments and output, and cleans the original POSIX process group after timeout, cancellation, or direct-child exit. These measures do not sandbox a CLI, guarantee recursive containment, make an operation non-destructive, or neutralize CLI-specific regex, glob, URL, plugin, alias, or flag semantics. Interpreters, loaders, plugins, and child programs can still resolve through an inherited environment. Accepted exit codes are trusted result-classification policy, not a safety decision. Bounded CLI output is stored in Pi session history and may later be exported or shared. Truncated or incomplete raw output may also be retained in an owner-only temporary file and can contain secrets. Retention has a 512 MiB aggregate quota per temporary parent. Result details mark cleanup as not applicable when nothing was retained and otherwise identify `pi-cli-tools` as the owner. The current native-execution adapter does not delete retained output automatically; embedding hosts can use `removeCliOutputSpool()`, and users can remove a disclosed spool path explicitly.

See the repository [security policy](https://github.com/jakeryderv/pi-cli-tools/blob/main/SECURITY.md), [ADR-0002](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/adr/0002-bounded-posix-cli-runner.md), and [ADR-0003](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/adr/0003-session-local-introspection.md).

## Registry configuration

Bundled definitions live in `tools/`. User definitions are loaded from Pi's agent directory under `cli-tools/`, canonically `~/.pi/agent/cli-tools/`. Each `.yaml`, `.yml`, or `.json` file contains one complete definition.

A user definition with the same `id` completely replaces its bundled definition. To disable a bundled entry explicitly:

```yaml
id: github
disabled: true
```

Missing user configuration is normal. Invalid files, quarantined overrides, duplicate IDs, duplicate tool names, Pi tool-name collisions, missing executables, disabled entries, resolved executable paths, and activation state are reported by `/cli-tools` without entering model context.

Executable discovery and native registration happen during Pi's `session_start`, after Pi has initialized extension action methods and before the first prompt. Discovery and registration do not invoke the executable or run version, help, man, or network requests. Local introspection begins only on an explicit `cli_docs` call. Run `/reload` after installing, replacing, or reconfiguring a CLI; reload creates a fresh session-local introspection cache, and in-place refresh is intentionally avoided because Pi does not expose native-tool unregistration.

### Bundled definitions

| Registry ID | Native tool | Candidate | Environment | Accepted exits | Intended use                                                                                    |
| ----------- | ----------- | --------- | ----------- | -------------- | ----------------------------------------------------------------------------------------------- |
| `github`    | `cli_gh`    | `gh`      | Inherited   | `0` (default)  | GitHub repositories, issues, pull requests, releases, workflows, and authenticated API requests |
| `ripgrep`   | `cli_rg`    | `rg`      | Empty       | `0, 1`         | Advanced local literal, regular-expression, file-type, and ignore-aware searches                |

A bundled tool registers only when its candidate is executable on the session `PATH`. The ripgrep definition uses an empty environment to avoid ambient credentials and `RIPGREP_CONFIG_PATH`; users who need inherited configuration can provide a complete trusted override.

Definitions may set `execution.accepted_exit_codes` to a nonempty, duplicate-free list of integer codes from 0 through 255. Canonical negative zero is rejected because JSON would serialize it as zero and make historical details lossy. Omission means exactly `[0]`, while an explicit list is authoritative and does not implicitly add zero. Ripgrep declares `[0, 1]` because exit 1 means no matches. This policy classifies results for Pi; it does not alter the runner's actual status or exit code and is not evidence that a command is safe.

## Native tool contract

Every generic native CLI tool accepts exactly:

```json
{
  "args": ["pr", "view", "42", "--json", "title,state"]
}
```

For example, an advanced local search can use:

```json
{
  "args": ["--line-number", "TODO|FIXME", "."]
}
```

Each array item is passed as one literal argument. Empty strings are valid, and shell syntax is not interpreted by the adapter. Shell metacharacters still retain whatever meaning the selected CLI assigns to an argument, such as regular-expression or glob syntax. The model cannot select the executable, shell text, stdin, working directory, environment, timeout, output strategy, or spool location. Those values come from trusted discovery, registry policy, and the current Pi session.

A zero or accepted nonzero exit, unaccepted nonzero exit, terminating signal, timeout, cancellation, spawn error, or request-validation error remains a distinct structured outcome. The runner always reports the actual process status and exit code. The Pi adapter treats only a normal, signal-free exit in the definition's accepted list as successful; every other outcome is a Pi tool error without discarding stdout, stderr, or the exit code. Model-facing text is sanitized and bounded to Pi's 50 KiB/2,000-line limits; raw result details remain available to Pi renderers and session history. The native execution adapter uses deterministic tail selection for every CLI, including search results.

## Local `cli_docs` contract

When at least one native CLI registers successfully and no earlier tool owns the reserved name, the adapter registers one shared tool with this strict input:

```json
{
  "tool": "cli_gh"
}
```

`tool` must be the exact name of a successfully registered native CLI. `subcommand` is optional and accepts one through eight bounded ASCII command-name segments, but the complete path must also appear in that CLI definition's exact `allowed_paths` list. Options, undeclared aliases/extensions, paths, whitespace, shell syntax, executable selection, arbitrary arguments, environment/cwd/stdin overrides, man-page names, URLs, and cache controls are not accepted. Pi middleware can mutate validated input, so the adapter validates this contract again immediately before core use and verifies that it still owns the selected native tool. The bundled GitHub definition intentionally provides top-level help only because arbitrary GitHub aliases or extensions can execute behavior.

A top-level call lazily requests the registry-declared version and help argv arrays. If top-level help is unavailable or fails, it may try the explicitly configured local man command. A subcommand call constructs only:

```text
exact discovered executable + validated subcommand segments + configured append_args
```

It never substitutes top-level or man text for missing subcommand help. Every command uses the exact discovered path, `shell: false`, ignored stdin, no TTY, the registry cwd/environment policy, a timeout no longer than ten seconds, Pi/session cancellation, process-group cleanup, and deterministic head capture. Version output is bounded to 4 KiB/20 lines; help and man output are bounded to 32 KiB/1,000 lines. Overflow is discarded rather than spooled.

Man support is explicit trusted configuration, for example:

```yaml
introspection:
  subcommand_help:
    allowed_paths:
      - [safe, child]
    append_args: [--help]
  man:
    binary:
      candidates: [man]
    args: [gh]
    timeout_ms: 10000
```

`man: false` disables it; `man: true` is rejected because the runtime does not guess a page. The helper is resolved lazily from the host `PATH`, realpathed, and invoked directly with a controlled noninteractive pager environment. A missing helper is an unavailable source; an unaccepted helper exit remains a structured operational failure because v0.2 does not guess which exit code means “page missing.” Man implementations can still launch formatters or other helpers and are not sandboxed.

Successful complete local results are cached only in memory. Keys include registry and complete definition identity, exact executable metadata, helper identity for man, source, argv/subcommand, cwd, and a hash of the exact execution environment snapshot. One coherent target identity is checked before lookup, around execution, and before the aggregate result returns. Failed exits, signals, spawn failures, timeouts, cancellations, incomplete capture or cleanup, and identity changes are not cached. Concurrent identical requests share one child while preserving waiter-specific cancellation. Cancelled loaders continue counting against the concurrency limit until their bounded cleanup settles. Session shutdown aborts and awaits remaining flights before clearing the cache.

Returned text is framed as untrusted local reference data and sanitized for terminal controls, overstrikes, carriage rewriting, control characters, and Unicode format characters. Bounded serializable Pi details contain source, exact command provenance, cache, timing, capture, cleanup, truncation, and outcome metadata but do not duplicate help/manual text. Exact provenance intentionally includes local executable paths, final argv, and cwd in model text and Pi session history; users should treat exported sessions as potentially host-identifying. Cache diagnostics disclose only that a version is cached, never version output. `cli_docs` does not fetch remote or official documentation, perform semantic search, persist a cache, or claim version alignment with configured official URLs. Those capabilities remain outside v0.2.

## Requirements

- Node.js 22.19.0 or newer, matching Pi's current minimum
- npm
- Pi, installed through the development dependencies for local verification

## Development

Install the locked dependencies:

```bash
npm ci
```

Run the standard local gate:

```bash
npm run check
```

Run the additional security and Pi loading checks:

```bash
npm run security:audit
npm run smoke:pi
```

### Available scripts

| Script                   | Purpose                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `npm run format`         | Format supported repository files                                                      |
| `npm run format:check`   | Check formatting without modifying files                                               |
| `npm run lint`           | Lint JavaScript and TypeScript                                                         |
| `npm run lint:docs`      | Lint Markdown documentation                                                            |
| `npm run typecheck`      | Run strict TypeScript checking without emitting files                                  |
| `npm test`               | Run unit, lifecycle, and hermetic bundled CLI contract evaluation tests                |
| `npm run test:watch`     | Run tests in watch mode                                                                |
| `npm run pack:check`     | Validate the npm package file manifest                                                 |
| `npm run security:audit` | Audit production dependencies at high severity or above                                |
| `npm run smoke:pi`       | Pack/install production files, then exercise real Pi lifecycle without a model request |
| `npm run check`          | Run the standard formatting, lint, type, test, and package gates                       |

The [v0.1d CLI contract evaluation report](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/development/v0.1d-cli-contract-evaluation.md) separates deterministic fixture evidence from behavior that was not measured. After npm dependencies are installed, the contract tests use controlled executables instead of globally installed `gh` or `rg` and make no GitHub, authentication, or third-party CLI network requests. Dependency installation, `npm audit`, and the packed production-install smoke test may contact the npm registry.

## Packaging

The initial Pi package ships TypeScript source directly and has no generated production build. See [ADR-0001](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/adr/0001-source-distributed-typescript-package.md) for the rationale and review triggers.

The package remains private and versioned `0.0.0` until the first release process is designed. No release or npm publication should be inferred from a successful local pack check.

## Contributing

See the repository [contributing guide](https://github.com/jakeryderv/pi-cli-tools/blob/main/CONTRIBUTING.md) and [development lifecycle](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/development/lifecycle.md).

## License

[MIT](LICENSE)
