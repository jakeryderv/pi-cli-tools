# ADR-0002: Bound CLI execution with process groups and deterministic output projection

- Status: Accepted
- Date: 2026-08-21
- Deciders: Project maintainers

## Context

The agent-independent runner launches installed programs with untrusted, model-selected argument arrays. It must not introduce shell parsing, permit unbounded memory or model-facing output, or leave ordinary descendants running after an invocation is considered complete.

Node's child-process timeout and abort options signal only the direct child and do not provide process-group escalation. Linux and macOS support negative-PID process-group signaling, while native Windows containment requires a different mechanism. Output callback arrival order is not stable across operating systems or chunk boundaries, so it is unsuitable as a durable allocation policy for a combined stdout/stderr budget.

Complete raw output is useful after model-facing truncation, but it may contain credentials. Per-invocation bounds alone do not prevent repeated calls from consuming aggregate disk. Filesystem operations are also not reliably cancellable in-process, so child-process timeout guarantees must not be overstated as complete operation-wide deadlines.

## Decision

The v0.1b runner will:

- Support execution only on Linux and macOS. Other platforms fail validation before spawn.
- Validate absolute executable and working-directory paths, exact argument arrays, UTF-8 argument byte limits, timeout, environment policy, and output strategy before spawn.
- Pass the discovered top-level path directly to `spawn()` with `shell: false`, ignored stdin, explicit arguments, and either a snapshot of the inherited environment or an empty environment.
- Describe path assurance narrowly: the runner does not `PATH`-search the top-level file. It does not pin the inode or resolve shebang interpreters, loaders, plugins, or children selected by that program.
- Launch a detached process group. Cancellation and timeout send `SIGTERM`, wait 500 milliseconds, escalate a surviving original group to `SIGKILL`, and stop process-control confirmation after five seconds.
- Preserve the first observed status cause. A cancellation observed before an asynchronous spawn error remains `cancelled`, with the spawn error retained as secondary metadata.
- After direct-child exit, preserve `exited` status while independently cleaning any surviving original process group. Cancellation or the configured child timeout can accelerate that cleanup. A descendant that creates a new group or session remains outside this guarantee.
- Stop pipe draining after five seconds when no original process group remains but an escaped descendant still holds inherited descriptors. Capture cutoff is represented separately from model-facing truncation.
- Report `forced: true` only after `SIGKILL` is successfully sent, not merely after escalation is considered.
- Decode stdout and stderr independently with streaming UTF-8 replacement while retaining raw byte counts.
- Apply one deterministic 48 KiB and 1,980-line process-text budget. Conceptually stdout precedes stderr: head selection gives stdout priority, while tail selection gives stderr priority. This leaves 2 KiB and 20 lines below Pi's ceiling for later adapter framing.
- Keep bounded head or tail reservoirs in memory rather than buffering complete process output.
- Buffer only the bounded raw prefix needed before truncation. Create private `0700`/`0600` spool storage lazily once model truncation or forced capture cutoff requires retention, then stream with backpressure.
- Assemble one labeled file that preserves stream identity. A capture cutoff or 64 MiB payload cap produces a partial spool and can never expose a complete path.
- Surface setup, write, assembly, and sidecar-cleanup failures as spool metadata without replacing process status. Recover owner permissions before assembly and cleanup when possible.
- Limit package-owned retained output to 512 MiB per temporary parent, including conservative reservations for concurrent assembly. Assembly can temporarily use roughly twice the 64 MiB payload cap.
- Retain output for deliberate inspection instead of deleting it automatically during the session. The consumer owns deletion through `removeCliOutputSpool()`.
- Define `timeoutMs` as a child-execution and process-control timeout. `durationMs` includes spool finalization, but filesystem preparation/finalization has no hard in-process deadline because Node filesystem calls are not reliably cancellable.

The Pi extension does not register or call the runner in v0.1b. The future adapter will use tail projection as its documented default unless a later registry field makes that policy configurable.

## Consequences

### Positive

- Runner-introduced shell and top-level `PATH` expansion are avoided.
- Ordinary descendants in the original group are cleaned after cancellation, timeout, and natural direct-child exit.
- Memory, model-facing text, per-invocation raw payload, and aggregate retained spool use have explicit limits.
- Output selection is stable regardless of OS pipe chunking or stdout/stderr callback interleaving.
- Result and spool unions encode status, reason, path, and error invariants.
- Incomplete capture cannot be mistaken for complete raw output.
- Small outputs perform no spool filesystem work.

### Negative

- Native Windows execution is unsupported, including `.cmd` and `.bat` files that normally require a command interpreter.
- An adversarial descendant can escape by creating another session or process group; abrupt runner-process termination can also leave children.
- Numeric process-group reuse presents an extreme signaling race that requires a platform supervisor to eliminate.
- Exact top-level discovery does not pin an inode or control shebang interpreters, loaders, plugins, and child programs.
- Inherited environments can expose credentials and loader configuration.
- Temporary output may contain secrets and remains until its consumer removes it.
- Fixed channel priority can starve one stream under heavy output, but this behavior is explicit and deterministic.
- Slow or stuck temporary storage can delay completion beyond the child timeout. A strict operation-wide storage deadline requires an external worker or asynchronous session-owned spool service.

## Alternatives considered

### Use Node's `timeout` and `signal` spawn options

These options are simpler but signal only the direct child and do not implement bounded process-group escalation.

### Allocate the combined budget by callback arrival order

This can approximate a merged transcript, but callback and chunk ordering is platform-dependent. Identical logical output could produce different projections.

### Buffer complete output and truncate after exit

This permits arbitrary memory growth and does not meet the bounded collection requirement.

### Create spool files before every spawn

Eager sidecars simplify raw-prefix handling, but small invocations can then leak sensitive files when cleanup fails. Lazy activation keeps a bounded prefix in memory and avoids filesystem state when retention is unnecessary.

### Automatically sweep retained files during a session

Automatic deletion provides stronger lifecycle bounds but conflicts with the requirement that the returned path remain available for deliberate inspection. An aggregate quota and explicit cleanup API bound new retention while preserving caller ownership. A later session adapter may add an opt-in TTL.

### Claim recursive process-tree termination

POSIX process groups cover ordinary descendants but cannot contain a process that deliberately changes its session or group. Stronger guarantees require platform-specific supervision such as Linux cgroups or a Windows Job Object helper.

### Race spool finalization against a timer

Returning while non-cancellable filesystem operations continue can create later, unreported files and leaks. The runner instead reports the narrower child-process timeout guarantee honestly. A strict wall-clock bound requires isolation in a helper process or worker with session-owned cleanup.

## Review triggers

Revisit this decision when:

- Native Windows execution becomes a supported requirement.
- Strict containment requires cgroups, sandboxing, or another supervisor.
- A helper process or asynchronous spool service can provide operation-wide storage deadlines.
- Pi changes its model-facing byte or line limits.
- Operational evidence shows that fixed stream priority is unsuitable.
- A session owner introduces TTL cleanup without making returned paths unreliable.
