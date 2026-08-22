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

The agent-independent runner passes the discovered top-level executable path directly to `spawn()` with an explicit argument array and `shell: false`. The runner itself does not search `PATH` for that top-level file, accept environment overrides in the execution request, open stdin, or interpret shell syntax. Request paths, argument bytes/count, timeout, environment mode, and output strategy are validated before spawn.

A fixed top-level path does not pin the executable inode or every program involved in execution. A script can use an `/usr/bin/env` shebang, a loader can honor variables such as `LD_PRELOAD` or `DYLD_*`, and the selected program can resolve interpreters, plugins, or children through inherited `PATH`. Executable replacement between discovery and spawn also remains a time-of-check/time-of-use risk.

Execution is supported on Linux and macOS. Timeout and cancellation signal the detached process group with bounded `SIGTERM`-to-`SIGKILL` escalation. A surviving original process group is also cleaned after direct-child exit; cancellation can accelerate that cleanup without replacing the already-observed exit status. A program can escape by creating another session or process group. Native Windows process-tree execution is not supported. Repeated signaling uses a numeric process-group ID, so an extreme identifier-reuse race cannot be eliminated without a platform supervisor that remains the group leader.

Model-facing process text is held in bounded streaming reservoirs. Raw stdout and stderr are spooled lazily with backpressure only after retention becomes necessary. A complete or partial owner-only file is retained when model-facing text is truncated or pipe capture is forcibly cut off. Capture completeness is reported separately from model-facing truncation; a forced cutoff can never produce a `complete` spool.

Raw spool payload is capped at 64 MiB per invocation, and package-owned retained output is limited to 512 MiB per temporary parent. Assembly can temporarily require about twice the payload cap. Retained output is not automatically deleted during the session; its consumer owns cleanup through `removeCliOutputSpool()`. Setup, write, assembly, and sidecar-cleanup failures remain visible metadata and do not replace the process status. Retained files may contain credentials, tokens, private paths, or adversarial text.

The configured timeout bounds child execution and process-group control, not every filesystem operation used to prepare or finalize a retained spool. Node filesystem calls cannot be reliably cancelled in-process. `durationMs` includes spool finalization, so slow or stuck temporary storage can delay `runCli()` beyond `timeoutMs`; callers requiring a wall-clock storage bound need an external supervisor or session-owned asynchronous spool service.

## Trust model

Pi extensions run with the user's full system permissions. A configured CLI may load plugins or configuration, contact networks, mutate local files, access credentials, or delete remote resources. Inherited environments may expose credentials and loader settings, and a CLI may resolve its own plugins or child programs through inherited `PATH`.

Shell-free invocation, timeouts, cancellation, output limits, and private capped spooling are defense-in-depth measures. They are not a sandbox and do not establish that a CLI command is safe or non-destructive.

Registry definitions are trusted configuration. The v0.1b Pi extension does not register native executable tools yet. Future project-local definitions must not be read until Pi has established project trust.
