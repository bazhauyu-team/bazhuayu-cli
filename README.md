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

### 2. Log in

Most commands require Bazhuayu credentials. Run:

```bash
octopus auth login
```

Interactive login lets you choose OAuth browser login or API key login.
To force OAuth:

```bash
octopus auth login --oauth
```

API key login opens the API key page automatically in a browser when possible,
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

CI can also provide a bearer access token:

```bash
OCTOPUS_ACCESS_TOKEN=xxx octopus task list --json
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

Local Chrome execution is supported on macOS x64/arm64, Windows x64, and
Linux x64. Linux arm64 is not supported by the local CLI runtime because Chrome
for Testing does not currently provide a Linux arm64 browser package; use a
supported local platform or cloud collection there.

Create a local task from a URL directly with CLI-only selection:

```bash
octopus detect 'https://example.com/list' --auto --output task.json
octopus detect 'https://example.com/search' --manual --query keyword --save-session --output task.json
```

`detect` uses the protected SmartProxy detector by default and requires
configured credentials. Manual mode can save a cookies-only browser session for
later local runs. Agent mode is available through `--agent --agent-command`;
that command executes a local shell command and should only point to a trusted
agent runner.

If an LLM/agent is helping a user create a task with bazhuayu-cli, it should run
`octopus capabilities --json` first and follow
`machineContract.recipes.createTaskFromUrlWithAgent`. That recipe tells the
agent to prepare deterministic context, write a plan, preview it, apply it, and
validate the generated task instead of asking the user to explain internal
detect flags, using `--auto` as the default path, or hand-writing JSON.
Agent workflows generate a full-page screenshot, an annotated screenshot, and
top candidate crop screenshots when boxes are available. These paths are exposed
through `context.screenshot`, `context.visualArtifacts`, and
`context.decisionSummary`; pass the user's natural-language request with `--goal`
so the agent can judge candidates against both the visual page and the stated
intent. The context also includes
`resultValidationPolicy`; agents should treat isolated missing fields in ads,
topic cards, sponsored items, or heterogeneous rows as normal partial data
instead of repeatedly recreating the task.

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

## Authentication

Most commands require OAuth or API key credentials. Only setup and diagnostic commands such as
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

Force OAuth browser login:

```bash
octopus auth login --oauth
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

Or:

```bash
OCTOPUS_ACCESS_TOKEN=xxx octopus task list --json
```

Credential precedence:

```text
1. OCTOPUS_API_KEY
2. OCTOPUS_ACCESS_TOKEN
3. ~/.octopus/credentials.json
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

## Paid capabilities

Some task features can consume paid account balance or resource packages:

- Paid templates can block `octopus run` before startup when the account cannot
  start the template or the balance is below the required charging granularity.
- Premium proxy IP can block `octopus run` before startup when the task is
  configured to use premium proxy IP and the balance is below the client
  threshold.
- CAPTCHA solving can emit a low-balance warning before startup, and can fail
  during the run if the CAPTCHA service reports no balance or a daily limit.
- `octopus cloud start` maps cloud startup status codes to readable JSON errors
  such as `CLOUD_BALANCE_NOT_ENOUGH` and `CLOUD_PROXY_BALANCE_NOT_ENOUGH`.

Foreground `--jsonl` runs emit structured billing events:

```json
{"event":"billing.error","code":"CAPTCHA_BALANCE_NOT_ENOUGH","message":"验证码余额不足，请充值后重试。"}
```

The same events are written to `events.jsonl`, including detached runs.

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

Linux arm64 local execution is not supported, even with `--chrome-path`,
because the bundled local runtime depends on Chrome for Testing platform
support.

Clean stale local control state:

```bash
octopus local cleanup
octopus runs cleanup
```
