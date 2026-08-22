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

## Trust model

Pi extensions run with the user's full system permissions. A configured CLI may load plugins or configuration, contact networks, mutate local files, access credentials, or delete remote resources.

Future shell-free invocation, timeouts, cancellation, and output limits are defense-in-depth measures. They are not a sandbox and do not establish that a CLI command is safe or non-destructive.

Registry definitions are trusted configuration. Future project-local definitions must not be read until Pi has established project trust.
