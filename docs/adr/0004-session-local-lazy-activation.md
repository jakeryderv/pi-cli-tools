# ADR-0004: Register native tools before applying session-local lazy activation

- Status: Accepted
- Date: 2026-08-22
- Deciders: Project maintainers

## Context

A growing registry cannot keep every native CLI definition active without enlarging the permanent tool surface. Pi's deferred loading requires a tool to exist in `getAllTools()` while being absent from the active set. `registerTool()` activates a tool by default, `setActiveTools()` can update the active set, and purely additive changes become loader additions on the next model turn. Pi has no native-tool unregistration API or atomic registration-conflict primitive.

Registration conflicts also do not reliably throw. Another extension can replace a name later, so a successful call does not establish durable ownership. Activation must not disable built-in, SDK, or third-party tools that appeared concurrently.

## Decision

v0.3 will:

- Add strict definition policy `activation: eager | lazy`; omission means eager for compatibility, and the two bundled definitions explicitly remain eager.
- Register every eligible available non-colliding native definition during one awaited `session_start` activation before changing the active set.
- Re-read Pi's effective tools after registration and retain registration-time `sourceInfo` for ownership checks.
- Keep the shared `cli_tools` catalog active. Its deterministic agent-independent search reads only validated final registry routing metadata and performs no process, introspection, DNS, or network work.
- Let `cli_tools` enable one through ten exact registry IDs only. Validate every requested entry and current ownership before mutation, reject the whole batch on any failure, union names with Pi's latest active set, call `setActiveTools()` once, and verify the postcondition.
- Keep enable idempotent and additive. Never roll back to an older active-set snapshot because that could remove unrelated concurrent additions.
- Use sequential tool execution mode while retaining a synchronous read/union/write activation commit.
- Remove only currently adapter-owned lazy names during initial policy setup. Preserve every unrelated active name and ensure owned eager/shared tools remain active.
- Leave all successfully owned native tools active when `cli_tools` collides, is filtered, or fails registration, preventing unreachable lazy capabilities.
- Permit `cli_docs` to inspect an inactive registered native tool without activating it.
- Treat dynamic enables as extension-instance/session-local. Reload/session replacement repeats discovery and policy and resets dynamic activation.
- Report policy, registered/active state, activation origin/failure, shared-tool state, fallback, filtering, collisions, and ownership changes through bounded diagnostics and compact tool rendering.

## Consequences

### Positive

- Registry size no longer requires every native schema to remain active.
- Compatible Pi/model combinations can use native deferred loading, while other models receive Pi's normal next-turn fallback.
- Explicit enable cannot intentionally replace another owner or remove unrelated tools.
- Search remains deterministic, bounded, serializable, and independent of executable or network behavior.
- Reload provides one coherent reset for discovery, ownership, activation, and caches.

### Negative

- All lazy tools must still be registered, so Pi retains their definitions in its full registry.
- Pi cannot make conflict preflight atomic; later privileged ownership replacement can only be detected.
- A `cli_tools` collision intentionally sacrifices lazy activation and leaves native tools active.
- Dynamic enable state is not reconstructed from session history.

## Alternatives considered

### Register native tools only when enabled

This conflicts with Pi's deferred-loading contract and creates late-registration ownership and discoverability ambiguity.

### Replace the active set with only adapter-selected tools

This could disable built-in or third-party tools and makes concurrent changes unsafe.

### Persist dynamic enables across reload

History reconstruction and an in-place watcher add stale ownership/configuration behavior without an unregistration API. Registry policy is the deterministic reset point.

## Review triggers

Revisit this decision when:

- Pi provides atomic registration conflict handling or native-tool unregistration.
- Pi's deferred-loading contract no longer requires register-all/activate-some.
- Operational evidence requires user-persistent activation state.
- The compatibility fallback causes unacceptable active-tool growth.
