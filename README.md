# pi-cli-tools

A Pi package for registering standalone command-line programs as native tools with bounded, shell-free execution.

## Status

The package currently:

- Loads and strictly validates bundled and user registry definitions.
- Merges definitions by stable ID, including explicit user disable entries, and quarantines attributable ambiguous overrides from execution.
- Resolves configured executable candidates to exact paths without launching them.
- Registers one native Pi tool for each available, eligible, non-colliding CLI on Linux and macOS.
- Executes literal argument arrays through the agent-independent bounded runner with the registry's timeout and environment policy, Pi's current working directory, and Pi's cancellation signal.
- Returns bounded model-facing stdout/stderr plus serializable execution, truncation, capture, spool, and process-group cleanup details.
- Exposes `/cli-tools` for human-facing registration, activation, collision, registry, and availability diagnostics.

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

Pi extensions run with the user's full system permissions. Configured native CLIs can access the same files, inherited environment variables, credentials, and network resources available to the Pi process when their registry policy enables environment inheritance.

The core runner invokes the configured top-level path without a shell, bounds arguments and output, and cleans the original POSIX process group after timeout, cancellation, or direct-child exit. These measures do not sandbox a CLI, guarantee recursive containment, or make an operation non-destructive. Interpreters, loaders, plugins, and child programs can still resolve through an inherited environment. Bounded CLI output is stored in Pi session history and may later be exported or shared. Truncated or incomplete raw output may also be retained in an owner-only temporary file and can contain secrets. Retention has a 512 MiB aggregate quota per temporary parent. Result details mark cleanup as not applicable when nothing was retained and otherwise identify `pi-cli-tools` as the owner. v0.1c does not delete retained output automatically; embedding hosts can use `removeCliOutputSpool()`, and users can remove a disclosed spool path explicitly.

See the repository [security policy](https://github.com/jakeryderv/pi-cli-tools/blob/main/SECURITY.md) and [ADR-0002](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/adr/0002-bounded-posix-cli-runner.md).

## Registry configuration

Bundled definitions live in `tools/`. User definitions are loaded from Pi's agent directory under `cli-tools/`, canonically `~/.pi/agent/cli-tools/`. Each `.yaml`, `.yml`, or `.json` file contains one complete definition.

A user definition with the same `id` completely replaces its bundled definition. To disable a bundled entry explicitly:

```yaml
id: github
disabled: true
```

Missing user configuration is normal. Invalid files, quarantined overrides, duplicate IDs, duplicate tool names, Pi tool-name collisions, missing executables, disabled entries, resolved executable paths, and activation state are reported by `/cli-tools` without entering model context.

Executable discovery and native registration happen during Pi's `session_start`, after Pi has initialized extension action methods and before the first prompt. Discovery does not invoke the executable or run version, help, man, or network requests. Run `/reload` after installing, replacing, or reconfiguring a CLI; in-place refresh is intentionally avoided because Pi does not expose native-tool unregistration.

## Native tool contract

Every generic v0.1c native tool accepts exactly:

```json
{
  "args": ["pr", "view", "42", "--json", "title,state"]
}
```

Each array item is passed as one literal argument. Empty strings are valid, and shell syntax is not interpreted by the adapter. The model cannot select the executable, shell text, stdin, working directory, environment, timeout, output strategy, or spool location. Those values come from trusted discovery, registry policy, and the current Pi session.

A successful process exit, nonzero exit, terminating signal, timeout, cancellation, spawn error, or request-validation error remains a distinct structured outcome. Nonzero exits are marked as Pi tool errors without discarding their stdout, stderr, or exit code. Model-facing text is sanitized and bounded to Pi's 50 KiB/2,000-line limits; raw result details remain available to Pi renderers and session history.

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
| `npm test`               | Run the test suite once                                                                |
| `npm run test:watch`     | Run tests in watch mode                                                                |
| `npm run pack:check`     | Validate the npm package file manifest                                                 |
| `npm run security:audit` | Audit production dependencies at high severity or above                                |
| `npm run smoke:pi`       | Pack/install production files, then exercise real Pi lifecycle without a model request |
| `npm run check`          | Run the standard formatting, lint, type, test, and package gates                       |

## Packaging

The initial Pi package ships TypeScript source directly and has no generated production build. See [ADR-0001](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/adr/0001-source-distributed-typescript-package.md) for the rationale and review triggers.

The package remains private and versioned `0.0.0` until the first release process is designed. No release or npm publication should be inferred from a successful local pack check.

## Contributing

See the repository [contributing guide](https://github.com/jakeryderv/pi-cli-tools/blob/main/CONTRIBUTING.md) and [development lifecycle](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/development/lifecycle.md).

## License

[MIT](LICENSE)
