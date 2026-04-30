# octo-engine-cli

Command-line runner for Octoparse/Bazhuayu collection tasks.

`octo-engine` can list cloud tasks, run tasks locally with an independent Chrome
browser, control active local runs, and export collected data.

## Install

```bash
npm install -g bazhuayu-cli
```

The installed command is:

```bash
octo-engine
```

Check the installation:

```bash
octo-engine --version
octo-engine doctor
```

## Requirements

- Node.js 20 or newer
- Google Chrome or a Chromium-compatible browser
- A valid Octoparse/Bazhuayu API key

## Quick start

Log in once:

```bash
octo-engine auth login
```

List your cloud tasks:

```bash
octo-engine task list
```

Inspect a task:

```bash
octo-engine task inspect <taskId>
```

Run a task locally:

```bash
octo-engine run <taskId>
```

Run in the background:

```bash
octo-engine run <taskId> --detach
```

Check or stop an active local run:

```bash
octo-engine local status <taskId>
octo-engine local stop <taskId>
```

Export data:

```bash
octo-engine data export <taskId> --source local --format xlsx
octo-engine data export <taskId> --source cloud --format csv
```

## Common commands

```bash
# Help and diagnostics
octo-engine --help
octo-engine doctor
octo-engine browser doctor

# Authentication
octo-engine auth login
octo-engine auth status
octo-engine auth logout

# Task discovery
octo-engine task list
octo-engine task list --keyword news --page-size 10
octo-engine task inspect <taskId>

# Local collection
octo-engine run <taskId>
octo-engine run <taskId> --jsonl
octo-engine run <taskId> --detach
octo-engine local status <taskId>
octo-engine local pause <taskId>
octo-engine local resume <taskId>
octo-engine local stop <taskId>

# Cloud collection
octo-engine cloud start <taskId>
octo-engine cloud stop <taskId>
octo-engine cloud status <taskId>
octo-engine cloud history <taskId>

# Data
octo-engine data history <taskId> --source local
octo-engine data history <taskId> --source cloud
octo-engine data export <taskId> --source local --format xlsx
octo-engine data export <taskId> --source cloud --format csv
```

By default, local run artifacts are stored in `~/.octo-engine/runs`. If you
customize the run artifact directory with `--output`, use the same `--output`
again when reading local history or exporting local data:

```bash
octo-engine run <taskId> --output ./runs
octo-engine data history <taskId> --source local --output ./runs
octo-engine data export <taskId> --source local --output ./runs --format xlsx
```

## API key

Most commands require an API key. Only setup and diagnostic commands such as
`--help`, `--version`, `doctor`, `browser doctor`, `capabilities`, and `auth`
can run before login.

For interactive use:

```bash
octo-engine auth login
```

For CI or scripts:

```bash
OCTO_ENGINE_API_KEY=xxx octo-engine task list --json
```

Credential precedence:

```text
1. OCTO_ENGINE_API_KEY
2. ~/.octo-engine/credentials.json
```

## Local task files

You can run or validate a local task definition file:

```bash
octo-engine task validate <taskId> --task-file ./task.json
octo-engine run <taskId> --task-file ./task.json
octo-engine run baidu --task-file ./百度一下，你就知道.otd
```

Supported local task file types:

- `.json`
- `.xml`
- `.otd`

Standalone local runs support independent Chrome only. Kernel browser tasks are
not supported in this CLI.

## Machine-readable output

Use `--json` for one JSON response:

```bash
octo-engine task list --json
octo-engine local status <taskId> --json
```

Use `--jsonl` for local run event streams:

```bash
octo-engine run <taskId> --jsonl
```

Local run artifacts are written under `~/.octo-engine/runs` by default, or under
the selected `--output` directory when configured:

```text
<output>/<runId>/
  meta.json
  events.jsonl
  logs.jsonl
  rows.jsonl
```

## Troubleshooting

Check the local environment:

```bash
octo-engine doctor
octo-engine browser doctor
```

If Chrome is not detected automatically, pass its path:

```bash
octo-engine run <taskId> --chrome-path "/path/to/chrome"
```

Clean stale local control state:

```bash
octo-engine local cleanup
octo-engine runs cleanup
```

## More documentation

- Agent and automation contract: [`docs/AGENT_USAGE.md`](docs/AGENT_USAGE.md)
- JSON schemas: [`docs/SCHEMAS.md`](docs/SCHEMAS.md)
- CLI design notes: [`docs/CLI_DESIGN.md`](docs/CLI_DESIGN.md)
- Publishing notes: [`docs/PUBLISHING.md`](docs/PUBLISHING.md)
