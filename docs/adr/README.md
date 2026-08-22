# Architecture decision records

Architecture decision records capture durable decisions that affect multiple parts of the project or are costly to reverse.

## When to create an ADR

Create an ADR when a decision:

- Establishes a project-wide architectural boundary.
- Changes package, runtime, compatibility, security, or storage strategy.
- Chooses between meaningful alternatives with lasting trade-offs.
- Is likely to be revisited without written context.

Do not create an ADR for routine refactoring, formatting, dependency patches, or implementation details that are easy to reverse.

## Process

1. Copy `template.md` to the next numbered file.
2. Describe the context and decision drivers.
3. Record the decision and meaningful alternatives.
4. State positive and negative consequences.
5. Define triggers that should cause the decision to be reviewed.
6. Mark superseded records rather than rewriting their history.

## Status values

- **Proposed:** under discussion
- **Accepted:** current project decision
- **Superseded:** replaced by a later ADR
- **Deprecated:** retained for history but no longer recommended
