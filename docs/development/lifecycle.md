# Development lifecycle

This project uses a lightweight software engineering lifecycle. The amount of ceremony should match the size and reversibility of the change, but every change should remain understandable, verifiable, and traceable.

## Lifecycle stages

| Stage             | Purpose                                                                             | Typical output or gate                             |
| ----------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------- |
| Understand        | Inspect the request, code, constraints, prior decisions, and repository state       | Scope and relevant context                         |
| Plan              | Define the intended change and acceptance criteria                                  | Short plan, issue, or pull request description     |
| Design            | Choose an approach and evaluate trade-offs                                          | Design note; ADR for significant durable decisions |
| Implement         | Make a minimal, coherent change                                                     | Source, configuration, or content diff             |
| Verify            | Run static analysis, tests, packaging checks, smoke tests, and security checks      | Structured pass/fail/skip evidence                 |
| Review            | Inspect the diff against requirements, architecture, security boundaries, and risks | Human or agent review findings                     |
| Document          | Update user, API, architecture, operations, security, or release documentation      | Applicable documentation changes                   |
| Deliver           | Commit, open a pull request, merge, package, or release                             | Traceable delivery record                          |
| Operate and learn | Observe outcomes and feed issues back into planning                                 | Metrics, incidents, and follow-up work             |

Documentation and security are cross-cutting concerns rather than isolated final steps. A failed verification or review returns the work to planning, design, or implementation as appropriate.

## Applying the lifecycle

### Understand

Before changing the repository:

- Read the request and relevant project documentation.
- Inspect the working tree and existing implementation.
- Identify constraints from Pi, Node.js, packaging, supported platforms, and project trust.
- Separate known facts from assumptions that require verification.

### Plan

State:

- The behavior or outcome being changed.
- What is in and out of scope.
- Acceptance criteria that can be checked.
- Expected security and documentation impact.

A small change may keep this plan in its pull request description. Larger work should use a linked issue.

### Design

Use the simplest design that meets the acceptance criteria. Create an ADR only when a decision is durable, cross-cutting, costly to reverse, or likely to be questioned later. Routine implementation choices do not need ADRs.

### Implement

Keep the diff minimal and internally coherent:

- Add behavior and its tests together.
- Avoid speculative modules or abstractions without a current caller.
- Keep Pi-specific lifecycle and rendering logic out of the agent-independent runtime.
- Do not mix unrelated cleanup into a feature change.

### Verify

The standard local gate is:

```bash
npm run check
npm run security:audit
npm run smoke:pi
```

Report each applicable check as one of:

| Result | Meaning                                                                         |
| ------ | ------------------------------------------------------------------------------- |
| Pass   | The command ran successfully and its result was inspected                       |
| Fail   | The command ran and found a blocking problem                                    |
| Skip   | The check was not applicable or could not run; include the reason and follow-up |

Do not claim a build, test, or check passes without fresh command output. Feature changes should also run focused tests that can falsify their acceptance criteria. For Pi lifecycle, native-tool, or local-introspection changes, `npm run smoke:pi` must exercise a real `DefaultResourceLoader`/session binding path, prove that startup leaves controlled version/help/man markers untouched, and invoke the applicable controlled tools (including `cli_docs`) without third-party network or model access; a print-mode notification alone is not sufficient evidence. Registry-expansion evaluations must load the actual bundled definitions and use fixture executables for every bundled candidate so contract execution does not depend on host-installed third-party CLIs, credentials, or third-party CLI network behavior. Dependency installation, audit, and package-install smoke steps may still contact the package registry.

### Review

Review the final diff for:

- Alignment with the request and acceptance criteria.
- Unintended behavior or unrelated changes.
- Error, cancellation, timeout, and cleanup paths.
- Shell, PATH, environment, credential, filesystem, network, and prompt-injection risks.
- Test quality and missing edge cases.
- Package contents and runtime dependency placement.
- Documentation and migration impact.

Review findings may return the change to an earlier lifecycle stage.

### Document

For every change, explicitly consider:

- README or user-facing behavior
- Public types or API contracts
- Architecture and ADRs
- Security and trust boundaries
- Development and operational procedures
- Release notes or migration guidance

“No documentation change” is acceptable when it is a considered result rather than an omission.

### Deliver

Prefer a focused branch and pull request with:

- A concise summary.
- Linked acceptance criteria or issue.
- Verification evidence.
- Security and documentation impact.
- Residual risks and follow-up work.

Commits should describe the intent of the change. Releases and published packages require a separate release process; passing normal CI is necessary but not sufficient to publish.

### Operate and learn

After delivery, observe CI reliability, dependency updates, package installation, Pi loading, and real CLI behavior. Record actionable findings as issues. Update an ADR when evidence invalidates a previous decision rather than silently diverging from it.
