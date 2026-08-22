# Pi CLI Tools Registry

## Project idea

Build a **Pi package whose main component is a Pi extension** that registers installed, standalone command-line programs as native Pi tools.

The package should keep the real capabilities agent-independent: Pi supplies the adapter, while a reusable CLI registry/runtime discovers tools, executes them, inspects their installed interfaces, and retrieves documentation. This gives Pi clear, first-class tools without replacing portable CLIs with a collection of agent-specific integrations.

```text
Pi
  -> Pi extension / native-tool adapter
      -> agent-independent CLI registry and runtime
          -> firecrawl, playwright, ctx7, gh, docker, ...
```

## Design principles

- Prefer standalone CLIs for generic, global capabilities.
- Register each configured CLI as a native Pi tool with a concise description of what it does, when to use it, and when not to use it.
- Begin with a small, stable interface such as `{ "args": [...] }` instead of converting every CLI flag into a large tool schema.
- Use the installed binary as the primary source of truth: detect its path and inspect its version, help output, subcommand help, and man pages.
- Keep documentation out of the permanent prompt. Retrieve only the relevant material when the agent needs it.
- Prefer local, version-aligned information before remote documentation.
- Keep the Pi adapter thin so the registry/runtime can later support other agent harnesses.

## Main components

```text
pi-cli-tools/
├── package.json
├── extensions/
│   └── cli-tools.ts       # Pi integration and tool registration
├── src/
│   ├── registry.ts        # load and validate tool definitions
│   ├── runner.ts          # safely execute configured binaries
│   ├── introspect.ts      # PATH, version, help, and man discovery
│   └── docs.ts            # documentation retrieval, search, and cache
└── tools/
    ├── firecrawl.yaml
    ├── playwright.yaml
    ├── context7.yaml
    └── github.yaml
```

### Declarative registry

Each definition describes the executable, routing guidance, introspection commands, documentation sources, and execution policy.

```yaml
name: firecrawl
binary: firecrawl

routing:
  description: Search, scrape, crawl, map, and extract web content.
  prefer_for:
    - crawling websites
    - structured web extraction

version:
  args: ["--version"]

docs:
  local_help: true
  man: false
  official:
    - https://docs.firecrawl.dev

execution:
  timeout: 120
  inherit_env: true
```

### Native CLI tools

At startup, the extension loads the registry, finds installed binaries, determines their versions, and registers one native Pi tool per available CLI.

```json
{
  "args": ["crawl", "https://example.com"]
}
```

Richer, CLI-specific schemas can be added selectively after the generic interface is proven useful.

### Shared `cli_docs` tool

Expose one documentation tool for every registered CLI:

```text
cli_docs({
  tool: "firecrawl",
  query: "exclude paths when crawling"
})
```

Its retrieval order should be:

1. Installed version and `--help` output.
2. Subcommand help and local man pages.
3. Cached official documentation associated with that version.
4. Live official documentation when the local and cached sources are insufficient.

It should return a small, relevant excerpt plus source information, not inject an entire manual into context.

## Separation of concerns

| Layer | Purpose |
|---|---|
| Standalone CLI | Portable, reusable capability |
| CLI registry/runtime | Discovery, execution, introspection, and documentation |
| Pi extension | Registers registry entries as native Pi tools |
| `cli_docs` | Supplies current syntax and behavior on demand |
| Skills | Teach higher-level workflows that may combine multiple tools |
| MCP/project extensions | Provide rich, structured, project-specific integrations |

The intended configuration model is:

```text
Global/user scope  -> standalone CLIs + CLI registry
Workflow guidance  -> skills
Project scope      -> MCP servers and project-specific extensions
```

## Development roadmap

### v0.1 — Registry and execution

- Load YAML or JSON tool definitions.
- Detect configured binaries on `PATH`.
- Detect installed versions.
- Register one native Pi tool per available CLI.
- Execute explicit argument arrays with timeouts and clear results.

### v0.2 — Local introspection

- Capture top-level `--help` output.
- Retrieve subcommand help on demand.
- Add man-page support.
- Introduce the shared `cli_docs` tool.

### v0.3 — Official documentation

- Configure authoritative documentation sources per CLI.
- Associate documentation with installed versions where possible.
- Add caching and focused search/retrieval.
- Improve tool-routing descriptions using discovered capabilities.

### v1.0 — Reusable agent-independent core

- Stabilize and extract the generic registry/runtime into its own package.
- Keep the Pi package as a thin adapter.
- Define adapter boundaries that can later support Codex, Claude, or other agents without duplicating CLI logic.

```text
agent-independent CLI core
        ├── Pi adapter
        ├── Codex adapter
        └── Claude adapter
```

## Recommended starting point

Ship the first implementation as a single Pi package, but keep the Pi-specific extension separate from the registry, runner, introspection, and documentation modules. Extract the universal core only after the registry format and runtime behavior have stabilized.
