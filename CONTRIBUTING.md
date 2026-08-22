# Contributing

## Development setup

Requirements:

- Node.js 22.19.0 or newer
- npm

Install dependencies and run the standard gate:

```bash
npm ci
npm run check
```

Also run the production dependency audit and Pi package smoke test before requesting review:

```bash
npm run security:audit
npm run smoke:pi
```

## Working agreement

Follow the [development lifecycle](docs/development/lifecycle.md) with ceremony proportional to the change:

1. Understand the request, repository state, constraints, and existing decisions.
2. State scope and acceptance criteria.
3. Record significant durable decisions as ADRs.
4. Implement the smallest coherent change.
5. Run applicable verification with pass/fail/skip evidence.
6. Review the final diff for requirements, risk, and unintended changes.
7. Update applicable documentation.
8. Deliver through a traceable commit and pull request.

Use focused branches and avoid mixing unrelated cleanup with feature work.

## Code and test expectations

- Keep Pi-specific registration, lifecycle, and rendering concerns in the extension adapter.
- Keep reusable registry, process, introspection, and documentation behavior independent of Pi.
- Add behavior and focused tests together.
- Prefer controlled fixture executables over invoking real third-party CLIs in unit tests.
- Do not rely on network access, user credentials, or global machine state in the default test suite.
- Preserve cancellation, timeout, output bounding, and cleanup behavior in process-related changes.
- Avoid speculative modules and abstractions without a current caller.

## Dependencies

Before adding a dependency:

- Confirm that the platform or standard library does not already provide the needed behavior.
- Check maintenance status, license, security history, and transitive dependency cost.
- Put libraries imported at runtime in `dependencies`.
- Put Pi runtime packages imported by the extension in `peerDependencies` as required by Pi packaging, and repeat them in `devDependencies` when needed for local development.
- Put test, lint, formatting, and type-checking tools in `devDependencies`.
- Commit the resulting `package-lock.json` changes.

Do not use a development-only dependency to satisfy a production import; Pi installs packages with production dependencies only.

## Architecture decisions

Create an ADR for a durable, cross-cutting, or costly-to-reverse choice. Follow [the ADR process](docs/adr/README.md). Do not create ADRs for routine implementation details.

## Documentation and security

Every change should explicitly consider:

- User and contributor documentation
- Public contracts and architecture
- Security and project-trust boundaries
- Environment and credential exposure
- Filesystem and network effects
- Untrusted CLI or documentation output
- Packaging and release impact

Use private reporting for vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Pull requests

A pull request should include:

- A concise summary and linked issue or plan where applicable
- Acceptance criteria
- Verification results with command evidence
- Security and documentation impact
- Package or release impact
- Residual risks and follow-up work

A skipped check requires a reason and, when applicable, a follow-up issue.
