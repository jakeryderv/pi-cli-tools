# pi-cli-tools

A Pi package for registering standalone command-line programs as native tools, with bounded execution, version-aware introspection, and on-demand documentation.

## Status

The project is currently scaffolded for implementation. The extension loads successfully but does not register CLI tools yet.

See the [project design outline](docs/pi-cli-tools-project-idea-outline.md) for the intended architecture, execution contract, security model, and roadmap.

## Why this project

Many useful capabilities already exist as portable command-line programs. This project aims to expose configured CLIs as clear, first-class Pi tools while keeping discovery, execution, introspection, and documentation logic independent of any one agent harness.

```text
Pi
  -> Pi extension
      -> agent-independent CLI registry and runtime
          -> installed standalone CLIs
```

## Security

Pi extensions run with the user's full system permissions. When this project begins launching configured CLIs, those programs will be able to access the same files, environment variables, credentials, and network resources available to the Pi process.

Shell-free invocation, timeouts, cancellation, and bounded output reduce specific risks; they do not sandbox a CLI or guarantee that an operation is non-destructive. See [SECURITY.md](SECURITY.md) and the design document's security model before using future releases with sensitive credentials.

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

The initial Pi package ships TypeScript source directly and has no generated production build. See [ADR-0001](docs/adr/0001-source-distributed-typescript-package.md) for the rationale and review triggers.

The package remains private and versioned `0.0.0` until the first release process is designed. No release or npm publication should be inferred from a successful local pack check.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [development lifecycle](docs/development/lifecycle.md).

## License

[MIT](LICENSE)
