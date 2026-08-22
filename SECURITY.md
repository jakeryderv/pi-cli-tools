# Security policy

## Supported versions

The project has not published a release. Security reports are currently evaluated against the `main` branch. A supported-version table will be added with the first release policy.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Report it privately through [GitHub Security Advisories](https://github.com/jakeryderv/pi-cli-tools/security/advisories/new). Include:

- A description of the issue and potential impact
- Affected files, versions, or commits
- Reproduction steps or a proof of concept
- Required environment or configuration
- Any suggested mitigation

Please allow maintainers time to investigate and coordinate a fix before public disclosure.

## Security-sensitive areas

This project is expected to launch installed command-line programs using model-selected arguments. Security review should pay particular attention to:

- Executable discovery, path resolution, and replacement
- Shell avoidance and exact argument boundaries
- Working-directory and filesystem access
- Environment inheritance and credential exposure
- Cancellation, timeout, and child-process cleanup
- Output bounds and temporary output files
- Registry configuration and project trust
- Network documentation sources and cache integrity
- Prompt injection in CLI output, help text, man pages, and remote documentation
- npm package contents and runtime dependency placement

## Runner boundaries

The agent-independent runner passes the discovered top-level executable path directly to `spawn()` with an explicit argument array and `shell: false`. The runner itself does not search `PATH` for that top-level file, accept environment overrides in the execution request, open stdin, or interpret shell syntax. Shell metacharacters remain literal argv elements, but they still have any regular-expression, glob, URL, plugin, alias, or flag meaning implemented by the selected CLI. Request paths, argument bytes/count, timeout, environment mode, and output strategy are validated before spawn.

A fixed top-level path does not pin the executable inode or every program involved in execution. A script can use an `/usr/bin/env` shebang, a loader can honor variables such as `LD_PRELOAD` or `DYLD_*`, and the selected program can resolve interpreters, plugins, or children through inherited `PATH`. Executable replacement between discovery and spawn also remains a time-of-check/time-of-use risk.

Execution is supported on Linux and macOS. Timeout and cancellation signal the detached process group with bounded `SIGTERM`-to-`SIGKILL` escalation. A surviving original process group is also cleaned after direct-child exit; cancellation can accelerate that cleanup without replacing the already-observed exit status. A program can escape by creating another session or process group. Native Windows process-tree execution is not supported. Repeated signaling uses a numeric process-group ID, so an extreme identifier-reuse race cannot be eliminated without a platform supervisor that remains the group leader.

Model-facing process text is held in bounded streaming reservoirs. Raw stdout and stderr are spooled lazily with backpressure only after retention becomes necessary. A complete or partial owner-only file is retained when model-facing text is truncated or pipe capture is forcibly cut off. Capture completeness is reported separately from model-facing truncation; a forced cutoff can never produce a `complete` spool.

Raw spool payload is capped at 64 MiB per invocation, and package-owned retained output is limited to 512 MiB per temporary parent. Assembly can temporarily require about twice the payload cap. Retained output is not automatically deleted during the session; its consumer owns cleanup through `removeCliOutputSpool()`. Setup, write, assembly, and sidecar-cleanup failures remain visible metadata and do not replace the process status. Retained files may contain credentials, tokens, private paths, or adversarial text.

The configured timeout bounds child execution and process-group control, not every filesystem operation used to prepare or finalize a retained spool. Node filesystem calls cannot be reliably cancelled in-process. `durationMs` includes spool finalization, so slow or stuck temporary storage can delay `runCli()` beyond `timeoutMs`; callers requiring a wall-clock storage bound need an external supervisor or session-owned asynchronous spool service.

## Local introspection boundaries

Startup, executable discovery, native registration, reload, and `/cli-tools` diagnostics do not run version, help, man, or network commands. The shared `cli_docs` tool starts local introspection only on an explicit invocation and can select only a native CLI successfully registered from the strict registry. It does not fetch remote documentation or accept raw command strings, executable paths, arbitrary arguments, environment or cwd overrides, stdin, man-page names, URLs, query text, or cache controls. Subcommand paths are bounded command-name segments, must exactly match a registry-declared allowlist, and are revalidated after Pi middleware. The bundled GitHub definition does not enable subcommand help because arbitrary GitHub aliases and extensions can dispatch executable behavior.

Version, help, and subcommand help use the stored exact CLI path and registry-declared argv templates. Template and subcommand elements remain separate argv entries and are never shell-expanded. Template validation reserves the maximum selector count and byte budget, so every declared allowed path fits the runner limits. A request establishes one coherent resolved target identity, uses it for every cache key and source, verifies it around execution, and checks it again before returning the aggregate result. These checks do not pin an inode against replacement between a final check and `spawn()`, control an executable's shebang interpreter or loader, or constrain plugins and children.

A configured man source names helper candidates and fixed arguments explicitly; `man: true` and caller-selected pages are rejected. The helper is resolved and realpathed lazily, then invoked without a shell or TTY and with ignored stdin. Its environment forces `MANPAGER=cat`, `PAGER=cat`, `TERM=dumb`, deterministic locale values, and omits hostile `MANOPT`, credentials, and unrelated host values. The host `PATH` remains available because `man` may require formatters. A man implementation, formatter, macro processor, or page content is not sandboxed and may still execute local helpers.

Introspection reuses the runner's request validation and POSIX process-group supervision with shorter timeouts and smaller deterministic head-capture limits. It triggers aggregate cancellation after 15 seconds and races that signal around executable/helper filesystem phases. Node filesystem operations cannot be cancelled reliably in-process and may continue in the background after the bounded caller has stopped waiting; a true filesystem wall-clock bound requires an external supervisor. Introspection discards raw overflow and never creates execution spools. Output sanitization removes terminal escape sequences, carriage-return rewriting, overstrike controls, C0/C1 controls, and Unicode format characters before cache or model exposure. Sanitization cannot make semantic prompt injection trustworthy; returned version, help, and man text is explicitly framed as untrusted local reference data and persists in Pi session history.

The cache is extension-instance memory only, bounded by entries and UTF-8 bytes, and stores only sanitized complete successful results. Structured cryptographic keys include the registry ID, complete definition digest, exact target/helper file identity, source, argv and validated subcommand, cwd, and environment-snapshot digest. Environment values and their digest are not exposed to the model. Failed exits, signals, spawn failures, timeouts, cancellations, capture cutoffs, unconfirmed process cleanup, and unstable identities are not cached. Cached keys and values are cloned on insertion and retrieval so callers cannot mutate stored state or byte accounting. Identical concurrent requests share a child; cancelling one waiter does not cancel remaining waiters. A loader remains in concurrency accounting until it settles, including after all waiters cancel or identity invalidation aborts it. Session shutdown aborts and awaits all bounded flight settlement before reload starts a new cache. There is no disk cache, negative cache, remote fetch, semantic search, or claimed version alignment in v0.2. Version diagnostics report only that a registry has a cached version and never display executed version text.

Documentation-command accepted exits, when explicitly configured, are separate from generic native execution accepted exits. For example, ripgrep's native exit `1` policy does not automatically make `rg --help` exit `1` successful. Unaccepted man exits remain ordinary failures with bounded execution metadata; v0.2 does not infer that every nonzero helper exit means a missing page.

## Trust model

Pi extensions run with the user's full system permissions. A configured CLI may load plugins or configuration, contact networks, mutate local files, access credentials, or delete remote resources. Inherited environments may expose credentials and loader settings, and a CLI may resolve its own plugins or child programs through inherited `PATH`.

The bundled definitions have materially different exposure:

- `cli_gh` inherits the Pi environment because GitHub CLI commonly needs credentials and configuration. It can mutate remote resources, invoke aliases or extensions, and launch editors or browsers.
- `cli_rg` receives an empty environment, which avoids ambient credentials and `RIPGREP_CONFIG_PATH`, but it still has the Pi process's filesystem permissions. It can expose secrets or ignored and hidden files. Flags including `--follow`, `--no-ignore`, `--pre`, and `--search-zip` can broaden filesystem traversal or launch child programs.

Shell-free invocation, timeouts, cancellation, output limits, and private capped spooling are defense-in-depth measures. They are not a sandbox and do not establish that a CLI command is safe or non-destructive.

Registry definitions are trusted configuration. The optional `execution.accepted_exit_codes` list is trusted result-classification policy: it determines whether a normal, signal-free process exit is marked as a Pi error, but it does not rewrite the runner outcome, authorize the operation, or prove that output is benign. Omission means only exit zero; an explicit list is authoritative. Timeouts, cancellations, spawn errors, signal terminations, null exit codes, and exits outside the list remain errors.

The Pi adapter registers an executable tool only after `session_start`, only when discovery resolved an executable on Linux or macOS, and only when the tool name did not collide with a Pi tool visible during registration preflight. Pi exposes no unregister operation or conflict result, so a privileged extension loaded later can still attempt to register the same name; the adapter's guarantee is narrowly that it never overrides an owner visible at its preflight snapshot.

The generic native-execution model contract contains only `{ args: string[] }`. Executable path, cwd, timeout, environment policy, stdin, shell text, and spool controls are not model-selectable. Pi extensions may mutate validated tool arguments in `tool_call` handlers without revalidation, so the runner remains the final pre-spawn authority for argument type, NUL, count, per-item byte, and combined byte limits.

Registry issues remain human-facing. Duplicate or attributable invalid higher-layer IDs quarantine matching lower definitions from executable registration so a malformed attempted override or tombstone cannot unexpectedly leave a bundled CLI callable. Unattributable malformed files do not suppress unrelated definitions.

CLI stdout and stderr are untrusted reference data. Repository files returned by ripgrep can contain prompt injection, and GitHub content can contain remote untrusted text. The adapter removes terminal control and problematic formatting characters from model-visible text, preserves stream labels, and enforces a final 50 KiB/2,000-line bound including framing. It currently uses tail selection for all CLIs, which can omit the beginning of search results. Serializable tool details preserve the runner outcome for Pi rendering and diagnostics; these details and bounded model-facing output are persisted in Pi session history. Local documentation provenance intentionally includes the exact executable/helper path, final argv, and cwd required to audit the operation. Session exports or shared session files can therefore disclose usernames, installation layouts, credentials, private paths, or other sensitive CLI output.

Cleanup metadata is conditional: results with no retained paths mark cleanup as not applicable, while results with retained output identify `pi-cli-tools` as the owner until explicit cleanup. The current adapter does not reconstruct or automatically delete paths from imported session data or during session shutdown. Embedding hosts can call `removeCliOutputSpool()` with the live result, and users can explicitly remove a disclosed spool path. Failed spools warn when partial sidecar artifacts remain. Process crashes and forced termination can leave orphaned package-owned temporary directories; per-invocation and aggregate quotas remain fallback bounds.

Project-local registry definitions are not implemented. Any future project-local definitions must not be read until Pi has established project trust.
