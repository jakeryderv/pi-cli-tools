# pi-cli-tools

A Pi package for registering standalone command-line programs as native tools, with bounded execution, version-aware introspection, and on-demand documentation.

## Status

The package currently:

- Loads and strictly validates bundled and user registry definitions.
- Merges definitions by stable ID, including explicit user disable entries.
- Resolves configured executable candidates to exact paths without launching them.
- Provides an agent-independent Linux/macOS runner for bounded shell-free execution, process-group cleanup, separate output capture, and private capped spooling.
- Exposes `/cli-tools` for human-facing registry and availability diagnostics.

The Pi extension does not register executable CLI tools or call the runner yet. Native tool registration and result rendering remain a later adapter milestone.

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

Pi extensions run with the user's full system permissions. When the extension begins connecting configured CLIs to the runner, those programs will be able to access the same files, inherited environment variables, credentials, and network resources available to the Pi process.

The core runner invokes the configured top-level path without a shell, bounds arguments and output, and cleans the original POSIX process group after timeout, cancellation, or direct-child exit. These measures do not sandbox a CLI, guarantee recursive containment, or make an operation non-destructive. Interpreters, loaders, plugins, and child programs can still resolve through an inherited environment. Truncated or incomplete raw output may be retained in an owner-only temporary file and can contain secrets. Retention has a 512 MiB aggregate quota per temporary parent, and callers own explicit cleanup through `removeCliOutputSpool()`.

See the repository [security policy](https://github.com/jakeryderv/pi-cli-tools/blob/main/SECURITY.md) and [ADR-0002](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/adr/0002-bounded-posix-cli-runner.md).

## Registry configuration

Bundled definitions live in `tools/`. User definitions are loaded from Pi's agent directory under `cli-tools/`, canonically `~/.pi/agent/cli-tools/`. Each `.yaml`, `.yml`, or `.json` file contains one complete definition.

A user definition with the same `id` completely replaces its bundled definition. To disable a bundled entry explicitly:

```yaml
id: github
disabled: true
```

Missing user configuration is normal. Invalid files, duplicate IDs, duplicate tool names, missing executables, disabled entries, and resolved executable paths are reported by `/cli-tools` without entering model context.

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

| Script                   | Purpose                                                          |
| ------------------------ | ---------------------------------------------------------------- |
| `npm run format`         | Format supported repository files                                |
| `npm run format:check`   | Check formatting without modifying files                         |
| `npm run lint`           | Lint JavaScript and TypeScript                                   |
| `npm run lint:docs`      | Lint Markdown documentation                                      |
| `npm run typecheck`      | Run strict TypeScript checking without emitting files            |
| `npm test`               | Run the test suite once                                          |
| `npm run test:watch`     | Run tests in watch mode                                          |
| `npm run pack:check`     | Validate the npm package file manifest                           |
| `npm run security:audit` | Audit production dependencies at high severity or above          |
| `npm run smoke:pi`       | Load the local package through Pi without making a model request |
| `npm run check`          | Run the standard formatting, lint, type, test, and package gates |

## Packaging

The initial Pi package ships TypeScript source directly and has no generated production build. See [ADR-0001](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/adr/0001-source-distributed-typescript-package.md) for the rationale and review triggers.

The package remains private and versioned `0.0.0` until the first release process is designed. No release or npm publication should be inferred from a successful local pack check.

## Contributing

See the repository [contributing guide](https://github.com/jakeryderv/pi-cli-tools/blob/main/CONTRIBUTING.md) and [development lifecycle](https://github.com/jakeryderv/pi-cli-tools/blob/main/docs/development/lifecycle.md).

## License

[MIT](LICENSE)
