# ADR-0001: Distribute the initial Pi package as TypeScript source

- Status: Accepted
- Date: 2026-08-21
- Deciders: Project maintainers

## Context

Pi loads extensions through jiti and supports TypeScript modules directly. The first releases of this project have one consumer: the Pi extension declared by the package manifest. The agent-independent modules are internal boundaries rather than a separately published public library.

Adding an emitted JavaScript build now would create source and distribution trees, package build orchestration, and source-map concerns before a non-Pi consumer requires them.

Static checking is still required because runtime TypeScript loading does not replace compile-time validation.

## Decision

The initial package will:

- Ship its TypeScript extension and internal source modules directly.
- Point the Pi package manifest at `extensions/cli-tools.ts`.
- Use strict TypeScript with `tsc --noEmit` as a required verification gate.
- Use an explicit package file allowlist instead of publishing the repository wholesale.
- Avoid public library exports until an external consumer exists.
- Avoid a generated `dist/` directory and production build step.

## Consequences

### Positive

- The repository has one source of truth.
- Local Pi development does not require rebuilding after every edit.
- Initial packaging and source maps remain simple.
- The project avoids committing to a public library format prematurely.

### Negative

- The package depends on Pi's TypeScript extension-loading behavior.
- The internal runtime cannot yet be consumed directly by plain Node.js without a TypeScript loader.
- Packaging checks must ensure all required TypeScript source files are included.

## Alternatives considered

### Compile the entire package to `dist/`

This is conventional for general npm libraries, but it adds machinery without benefiting the current Pi-only consumer.

### Publish separate core and Pi adapter packages immediately

This would make the boundary physically explicit, but no second consumer currently justifies versioning and releasing multiple packages.

## Review triggers

Revisit this decision when:

- A non-Pi adapter or direct Node.js consumer is implemented.
- The project introduces supported public library exports.
- Pi no longer supports loading TypeScript package extensions directly.
- Startup performance or compatibility demonstrates that precompiled JavaScript is preferable.
