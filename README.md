# bazhuayu-cli

Command-line runner for Bazhuayu collection tasks.

English | [中文](README_CN.md)

`bazhuayu` can list cloud tasks, run tasks locally, control active local
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
bazhuayu
```

Check the installation:

```bash
bazhuayu --version
bazhuayu doctor
```

### 2. Log in

Most commands require Bazhuayu credentials. Run:

```bash
bazhuayu auth login
```

Interactive login lets you choose OAuth browser login or API key login.
To force OAuth:

```bash
bazhuayu auth login --oauth
```

API key login opens the API key page automatically in a browser when possible,
then verifies and saves the key locally.

Create the key here:

```text
https://www.bazhuayu.com/console/account-center/api-keys
```

If you already copied the key, you can save time and pass it directly:

```bash
bazhuayu auth login XXXXX
```

For CI or scripts, set the key with an environment variable instead:

```bash
OCTOPUS_API_KEY=xxx bazhuayu task list --json
```

CI can also provide a bearer access token:

```bash
OCTOPUS_ACCESS_TOKEN=xxx bazhuayu task list --json
```

### 3. Use the CLI

Query the task list:

```bash
bazhuayu task list
bazhuayu task list --page 2 --page-size 20
```

Query a single task:

```bash
bazhuayu task inspect <taskId>
```

Run a task locally:

```bash
bazhuayu run <taskId>
```

Local Chrome execution is supported on macOS x64/arm64, Windows x64, and
Linux x64. Linux arm64 is not supported by the local CLI runtime because Chrome
for Testing does not currently provide a Linux arm64 browser package; use a
supported local platform or cloud collection there.

### Use your signed-in Chrome or Edge profile

User-browser mode reuses an existing Chrome/Edge profile, including its cookies
and login state. It is supported on Windows and macOS. Set it up in this order:

```bash
# Inspect Chrome or use --browser-id edge.
bazhuayu browser status --browser-id chrome --json
bazhuayu browser profiles --browser-id chrome --json

# Close the browser first, or let the CLI close it with --force-close.
bazhuayu browser install --browser-id chrome --profile "Default" --force-close --json

# Reopen Chrome once, confirm the Octopus extension is enabled, then verify:
bazhuayu browser status --browser-id chrome --profile "Default" --json

# Persist this browser/profile for both run and detect:
bazhuayu browser use user --browser-id chrome --profile "Default" --json
```

`browser status --json` must report `data.readyForUserBrowserRun=true` before
the profile is ready. Machine clients should follow `data.nextActions` or
`error.details.nextActions`. Switch back at any time:

```bash
bazhuayu browser use independent --json
```

The saved mode applies to `run` and `detect`. Override one invocation with
`--browser independent|user`, plus optional `--browser-id chrome|edge` and
`--profile <name>`. User-browser mode cannot run headless. Agents should read
`browserRuntime.modes.user.setupRecipe` from `bazhuayu capabilities --json` and
perform every machine step themselves; reopening/enabling the extension remains
an explicit user action.

Create a local task from a URL directly with CLI-only selection:

```bash
bazhuayu detect 'https://example.com/list' --auto --output task.json
bazhuayu detect 'https://example.com/search' --manual --query keyword --save-session --output task.json
```

`detect` uses the protected SmartProxy detector by default and requires
configured credentials. Manual mode can save a cookies-only browser session for
later local runs. Agent mode is available through `--agent --agent-command`;
that command executes a local shell command and should only point to a trusted
agent runner.

If an LLM/agent is helping a user create a task with bazhuayu-cli, it should run
`bazhuayu capabilities --json` first and follow
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
bazhuayu run <taskId> --max-rows 100
```

Run in the background:

```bash
bazhuayu run <taskId> --detach
```

Query the local run status, or stop the local process running a task:

```bash
bazhuayu local status <taskId>
bazhuayu local stop <taskId>
```

Note: local run status is tracked by this CLI only and is not synchronized with
the Bazhuayu desktop client status.

Export data:

```bash
bazhuayu data export <taskId> --source local --format xlsx
bazhuayu data export <taskId> --source cloud --format csv
```

## Common commands

```bash
# Help and diagnostics
bazhuayu --help
bazhuayu doctor

# Authentication
bazhuayu auth login
bazhuayu auth login XXXXX
bazhuayu auth status
bazhuayu auth logout

# Task discovery
bazhuayu task list
bazhuayu task list --page 2 --page-size 20
bazhuayu task list --keyword news --page 2 --page-size 10
bazhuayu task inspect <taskId>

# Local collection
bazhuayu run <taskId>
bazhuayu run <taskId> --max-rows 100
bazhuayu run <taskId> --jsonl
bazhuayu run <taskId> --detach
bazhuayu local status <taskId>
bazhuayu local pause <taskId>
bazhuayu local resume <taskId>
bazhuayu local stop <taskId>

# Cloud collection
bazhuayu cloud start <taskId>
bazhuayu cloud stop <taskId>
bazhuayu cloud status <taskId>
bazhuayu cloud history <taskId>

# Data
bazhuayu data history <taskId> --source local
bazhuayu data history <taskId> --source cloud
bazhuayu data export <taskId> --source local --format xlsx
bazhuayu data export <taskId> --source cloud --format csv
```

By default, local run artifacts are stored in `~/.octopus/runs`. If you
customize the run artifact directory with `--output`, use the same `--output`
again when reading local history or exporting local data:

```bash
bazhuayu run <taskId> --output ./runs
bazhuayu data history <taskId> --source local --output ./runs
bazhuayu data export <taskId> --source local --output ./runs --format xlsx
```

## Authentication

Most commands require OAuth or API key credentials. Only setup and diagnostic commands such as
`--help`, `--version`, `doctor`, `capabilities`, and `auth`
can run before login.

Create API keys in the Bazhuayu console:

```text
https://www.bazhuayu.com/console/account-center/api-keys
```

For interactive use:

```bash
bazhuayu auth login
```

Force OAuth browser login:

```bash
bazhuayu auth login --oauth
```

If the API key is already copied:

```bash
bazhuayu auth login XXXXX
```

Use `--no-open` if you want to copy the URL manually:

```bash
bazhuayu auth login --no-open
```

For CI or scripts:

```bash
OCTOPUS_API_KEY=xxx bazhuayu task list --json
```

Or:

```bash
OCTOPUS_ACCESS_TOKEN=xxx bazhuayu task list --json
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
bazhuayu task validate <taskId> --task-file ./task.json
bazhuayu run <taskId> --task-file ./task.json
bazhuayu run baidu --task-file ./百度一下，你就知道.otd
```

Supported local task file types:

- `.json`
- `.xml`
- `.otd`

Kernel browser tasks are not supported in this CLI.

## Machine-readable output

Use `--json` for one JSON response:

```bash
bazhuayu task list --json
bazhuayu local status <taskId> --json
```

Use `--jsonl` for local run event streams:

```bash
bazhuayu run <taskId> --jsonl
```

The stream includes `captcha` and `proxy` events when the runtime asks the CLI
to resolve CAPTCHA or proxy resources automatically.

## Paid capabilities

Some task features can consume paid account balance or resource packages:

- Paid templates can block `bazhuayu run` before startup when the account cannot
  start the template or the balance is below the required charging granularity.
- Premium proxy IP can block `bazhuayu run` before startup when the task is
  configured to use premium proxy IP and the balance is below the client
  threshold.
- CAPTCHA solving can emit a low-balance warning before startup, and can fail
  during the run if the CAPTCHA service reports no balance or a daily limit.
- `bazhuayu cloud start` maps cloud startup status codes to readable JSON errors
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
bazhuayu doctor
```

If the browser is not detected automatically, pass its path:

```bash
bazhuayu run <taskId> --chrome-path "/path/to/chrome"
```

Linux arm64 local execution is not supported, even with `--chrome-path`,
because the bundled local runtime depends on Chrome for Testing platform
support.

Clean stale local control state:

```bash
bazhuayu local cleanup
bazhuayu runs cleanup
```
