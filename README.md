# bazhuayu-cli

Command-line runner for Bazhuayu collection tasks.

English | [中文](README_CN.md)

`octopus` can list cloud tasks, run tasks locally, control active local
runs, and export collected data.

## Requirements

- Node.js 20 or newer
- A valid Bazhuayu API key

## Quick start

### 1. Install

Install the CLI globally:

```bash
npm install -g bazhuayu-cli
```

The installed command is:

```bash
octopus
```

Check the installation:

```bash
octopus --version
octopus doctor
```

### 2. Log in with an API key

Most commands require a Bazhuayu API key. Run:

```bash
octopus auth login
```

`auth login` opens the API key page automatically in a browser when possible,
then verifies and saves the key locally.

Create the key here:

```text
https://www.bazhuayu.com/console/account-center/api-keys
```

If you already copied the key, you can save time and pass it directly:

```bash
octopus auth login XXXXX
```

For CI or scripts, set the key with an environment variable instead:

```bash
OCTOPUS_API_KEY=xxx octopus task list --json
```

### 3. Use the CLI

Query the task list:

```bash
octopus task list
octopus task list --page 2 --page-size 20
```

Query a single task:

```bash
octopus task inspect <taskId>
```

Run a task locally:

```bash
octopus run <taskId>
```

Stop automatically after saving a fixed number of rows:

```bash
octopus run <taskId> --max-rows 100
```

Run in the background:

```bash
octopus run <taskId> --detach
```

Query the local run status, or stop the local process running a task:

```bash
octopus local status <taskId>
octopus local stop <taskId>
```

Note: local run status is tracked by this CLI only and is not synchronized with
the Bazhuayu desktop client status.

Export data:

```bash
octopus data export <taskId> --source local --format xlsx
octopus data export <taskId> --source cloud --format csv
```

## Common commands

```bash
# Help and diagnostics
octopus --help
octopus doctor
octopus browser doctor

# Authentication
octopus auth login
octopus auth login XXXXX
octopus auth status
octopus auth logout

# Task discovery
octopus task list
octopus task list --page 2 --page-size 20
octopus task list --keyword news --page 2 --page-size 10
octopus task inspect <taskId>

# Local collection
octopus run <taskId>
octopus run <taskId> --max-rows 100
octopus run <taskId> --jsonl
octopus run <taskId> --detach
octopus local status <taskId>
octopus local pause <taskId>
octopus local resume <taskId>
octopus local stop <taskId>

# Cloud collection
octopus cloud start <taskId>
octopus cloud stop <taskId>
octopus cloud status <taskId>
octopus cloud history <taskId>

# Data
octopus data history <taskId> --source local
octopus data history <taskId> --source cloud
octopus data export <taskId> --source local --format xlsx
octopus data export <taskId> --source cloud --format csv
```

By default, local run artifacts are stored in `~/.octopus/runs`. If you
customize the run artifact directory with `--output`, use the same `--output`
again when reading local history or exporting local data:

```bash
octopus run <taskId> --output ./runs
octopus data history <taskId> --source local --output ./runs
octopus data export <taskId> --source local --output ./runs --format xlsx
```

## API key

Most commands require an API key. Only setup and diagnostic commands such as
`--help`, `--version`, `doctor`, `browser doctor`, `capabilities`, and `auth`
can run before login.

Create API keys in the Bazhuayu console:

```text
https://www.bazhuayu.com/console/account-center/api-keys
```

For interactive use:

```bash
octopus auth login
```

If the API key is already copied:

```bash
octopus auth login XXXXX
```

Use `--no-open` if you want to copy the URL manually:

```bash
octopus auth login --no-open
```

For CI or scripts:

```bash
OCTOPUS_API_KEY=xxx octopus task list --json
```

Credential precedence:

```text
1. OCTOPUS_API_KEY
2. ~/.octopus/credentials.json
```

## Local task files

You can run or validate a local task definition file:

```bash
octopus task validate <taskId> --task-file ./task.json
octopus run <taskId> --task-file ./task.json
octopus run baidu --task-file ./百度一下，你就知道.otd
```

Supported local task file types:

- `.json`
- `.xml`
- `.otd`

Kernel browser tasks are not supported in this CLI.

## Machine-readable output

Use `--json` for one JSON response:

```bash
octopus task list --json
octopus local status <taskId> --json
```

Use `--jsonl` for local run event streams:

```bash
octopus run <taskId> --jsonl
```

The stream includes `captcha` and `proxy` events when the runtime asks the CLI
to resolve CAPTCHA or proxy resources automatically.

Local run artifacts are written under `~/.octopus/runs` by default, or under
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
octopus doctor
octopus browser doctor
```

If the browser is not detected automatically, pass its path:

```bash
octopus run <taskId> --chrome-path "/path/to/chrome"
```

Clean stale local control state:

```bash
octopus local cleanup
octopus runs cleanup
```
