import { API_BASE_URL_ENV } from '../runtime/api-client.js';
import { API_KEY_ENV } from '../runtime/auth.js';
import { API_KEYS_URL } from '../commands/auth.js';

export function printCommandHelp(command: string, subcommand?: string): void {
  const key = subcommand && !subcommand.startsWith('-') ? `${command} ${subcommand}` : command;
  const help: Record<string, string> = {
    capabilities: `Usage:
  octopus capabilities [--json]

Purpose:
  Print machine-readable CLI capabilities for agents.

Authentication:
  Does not require an API key. Functional commands do.
`,
  auth: `Usage:
  octopus auth login <apiKey> [--api-base-url <url>] [--json]
  octopus auth login [--stdin] [--no-open] [--api-base-url <url>] [--json]
  octopus auth status [--json]
  octopus auth logout [--json]

API key:
  Create one at ${API_KEYS_URL}
  Interactive login opens this page automatically, then verifies and stores the key.
  If the browser does not open, copy the URL above and open it manually.

Agent notes:
  Use "auth login <apiKey>" to verify and save a copied key directly.
  Use "auth login --stdin" for non-interactive setup.
  login verifies the API key before saving; invalid keys are not stored.
  ${API_KEY_ENV} overrides stored credentials.
  Functional commands require a configured API key, including local task-file and OTD runs.
`,
    env: `Usage:
  octopus env pre [--json]
  octopus env prod [--json]
  octopus env status [--json]

Purpose:
  Hidden internal command for switching API environment.
`,
    task: `Usage:
  octopus task list [--page <n>] [--page-size <n>] [--keyword <text>] [--json]
  octopus task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octopus task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    'task list': `Usage:
  octopus task list [--page <n>] [--page-size <n>] [--keyword <text>] [--json]
`,
    'task inspect': `Usage:
  octopus task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    'task validate': `Usage:
  octopus task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    run: `Usage:
  octopus run <taskId> [--task-file <file.json|file.xml|file.otd>] [--output <dir>] [--chrome-path <path>] [--headless] [--detach] [--json|--jsonl]

Agent notes:
  Requires a configured API key even when --task-file points to a local JSON, XML, or OTD file.
  Use --detach for background local collection.
  Use --jsonl for foreground event streams.
  JSONL now includes captcha and proxy request events when the runtime asks for them.
  run only starts local collection. Use data export <taskId> --lot-id <lotId> for files.
`,
    cloud: `Usage:
  octopus cloud start <taskId> [--json]
  octopus cloud stop <taskId> [--json]
  octopus cloud status <taskId> [--json]
  octopus cloud history <taskId> [--json]

Notes:
  Cloud collection only supports start/stop. There is no cloud pause/resume.
`,
    local: `Usage:
  octopus local status <taskId> [--json]
  octopus local pause <taskId> [--json]
  octopus local resume <taskId> [--json]
  octopus local stop <taskId> [--json]
  octopus local history <taskId> [--output <dir>] [--json]
  octopus local export <taskId> [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
  octopus local cleanup [--json]
`,
    data: `Usage:
  octopus data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
  octopus data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]

Defaults:
  --source local
  --format xlsx, unless inferred from --file extension
  --file task-name.<format>, with Windows-style duplicate suffixes
`,
    'data history': `Usage:
  octopus data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
`,
    'data export': `Usage:
  octopus data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
`,
    runs: `Usage:
  octopus runs list [--output <dir>] [--json]
  octopus runs status <runId> [--output <dir>] [--json]
  octopus runs logs <runId> [--output <dir>] [--limit 100] [--json]
  octopus runs data <runId> [--output <dir>] [--limit 100] [--json]
  octopus runs cleanup [--output <dir>] [--json]

Purpose:
  Internal local artifact inspection. User workflows should use taskId/lotId commands:
  octopus data history <taskId> --source local
  octopus data export <taskId> --source local --lot-id <lotId>
  cleanup removes stale control files whose local control socket is gone.
`,
    doctor: `Usage:
  octopus doctor [--chrome-path <path>] [--json]
`,
    browser: `Usage:
  octopus browser doctor [--chrome-path <path>] [--json]
`
  };

  console.log(help[key] ?? help[command] ?? '使用 octopus --help 查看可用命令');
}

export function printRootHelp(version: string): void {
  console.log(`octopus ${version}

Standalone Octoparse engine CLI.

Usage:
  octopus capabilities [--json]
  octopus doctor [--chrome-path <path>] [--json]
  octopus auth login <apiKey> [--api-base-url <url>] [--json]
  octopus auth login [--stdin] [--no-open] [--api-base-url <url>] [--json]
  octopus auth status [--json]
  octopus auth logout [--json]
  octopus browser doctor [--chrome-path <path>] [--json]
  octopus task list [--page <n>] [--page-size <n>] [--keyword <text>] [--json]
  octopus task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octopus task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octopus run <taskId> [--task-file <file.json|file.xml|file.otd>] [--output <dir>] [--chrome-path <path>] [--headless] [--detach] [--json|--jsonl]
  octopus cloud start <taskId> [--json]
  octopus cloud stop <taskId> [--json]
  octopus cloud status <taskId> [--json]
  octopus cloud history <taskId> [--json]
  octopus local status <taskId> [--json]
  octopus local pause <taskId> [--json]
  octopus local resume <taskId> [--json]
  octopus local stop <taskId> [--json]
  octopus local history <taskId> [--output <dir>] [--json]
  octopus local export <taskId> [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
  octopus local cleanup [--json]
  octopus data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
  octopus data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]

Task file format:
  {
    "taskId": "abc123",
    "taskName": "Example",
    "xml": "... original OTD XML ...",
    "xoml": "... transformed BPMN XOML ...",
    "fieldNames": ["title", "url"],
    "workflowSetting": {},
    "brokerSettings": {},
    "userAgent": "Mozilla/5.0 ...",
    "disableAD": false
  }

Design:
  - Runs embedded @octopus/engine directly.
  - Uses independent Chrome only.
  - Does not require the Electron client.
  - Cloud collection is controlled through backend APIs; local collection is controlled by the local engine.
  - Does not support kernel browser or legacy workflow in v1.

Authentication:
  API key is required for all functional commands, including local --task-file and .otd runs.
  Only setup/diagnostic commands can run without it: --help, --version, capabilities, doctor, browser doctor, auth, env.
  API key page:                   ${API_KEYS_URL}
  octopus auth login <key>     verify and store a copied API key directly
  octopus auth login          open API key page, verify pasted key, then store it
  octopus auth login --stdin  read API key from stdin, verify it, then store it
  octopus auth login --no-open do not open the browser during interactive login
  ${API_KEY_ENV}                  overrides stored credentials
  ${API_BASE_URL_ENV}             overrides API base URL; default is the production API

Run diagnostics:
  --timeout-ms <ms>            overall foreground run timeout, default 600000
  --extension-timeout-ms <ms>  runtime extension registration timeout, default 15000
  --debug-bridge              include extension bridge command/response logs

Agent contract:
  --json   return one stable JSON envelope: {"ok":true,"data":...} or {"ok":false,"error":...}
  --jsonl  stream long-running run events as one JSON object per line
  stdout   reserved for requested data/output; diagnostics and failures go to stderr in human mode
  exit 0   success; non-zero means the command did not complete as requested

Exit codes:
  0  success
  1  operation failed
  2  runtime/environment failure
  3  unsupported task definition
`);
}
