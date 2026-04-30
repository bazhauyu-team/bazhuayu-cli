import { API_BASE_URL_ENV } from '../runtime/api-client.js';
import { API_KEY_ENV } from '../runtime/auth.js';

export function printCommandHelp(command: string, subcommand?: string): void {
  const key = subcommand && !subcommand.startsWith('-') ? `${command} ${subcommand}` : command;
  const help: Record<string, string> = {
    capabilities: `Usage:
  octo-engine capabilities [--json]

Purpose:
  Print machine-readable CLI capabilities for agents.

Authentication:
  Does not require an API key. Functional commands do.
`,
    auth: `Usage:
  octo-engine auth login [--stdin] [--api-base-url <url>] [--json]
  octo-engine auth status [--json]
  octo-engine auth logout [--json]

Agent notes:
  Use "auth login --stdin" for non-interactive setup.
  login verifies the API key before saving; invalid keys are not stored.
  ${API_KEY_ENV} overrides stored credentials.
  Functional commands require a configured API key, including local task-file and OTD runs.
`,
    env: `Usage:
  octo-engine env pre [--json]
  octo-engine env prod [--json]
  octo-engine env status [--json]

Purpose:
  Hidden internal command for switching API environment.
`,
    task: `Usage:
  octo-engine task list [--page <n>] [--page-size <n>] [--keyword <text>] [--json]
  octo-engine task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octo-engine task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    'task list': `Usage:
  octo-engine task list [--page <n>] [--page-size <n>] [--keyword <text>] [--json]
`,
    'task inspect': `Usage:
  octo-engine task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    'task validate': `Usage:
  octo-engine task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    run: `Usage:
  octo-engine run <taskId> [--task-file <file.json|file.xml|file.otd>] [--output <dir>] [--chrome-path <path>] [--headless] [--detach] [--json|--jsonl]

Agent notes:
  Requires a configured API key even when --task-file points to a local JSON, XML, or OTD file.
  Use --detach for background local collection.
  Use --jsonl for foreground event streams.
  run only starts local collection. Use data export <taskId> --lot-id <lotId> for files.
`,
    cloud: `Usage:
  octo-engine cloud start <taskId> [--json]
  octo-engine cloud stop <taskId> [--json]
  octo-engine cloud status <taskId> [--json]
  octo-engine cloud history <taskId> [--json]

Notes:
  Cloud collection only supports start/stop. There is no cloud pause/resume.
`,
    local: `Usage:
  octo-engine local status <taskId> [--json]
  octo-engine local pause <taskId> [--json]
  octo-engine local resume <taskId> [--json]
  octo-engine local stop <taskId> [--json]
  octo-engine local history <taskId> [--output <dir>] [--json]
  octo-engine local export <taskId> [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
  octo-engine local cleanup [--json]
`,
    data: `Usage:
  octo-engine data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
  octo-engine data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]

Defaults:
  --source local
  --format xlsx, unless inferred from --file extension
  --file task-name.<format>, with Windows-style duplicate suffixes
`,
    'data history': `Usage:
  octo-engine data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
`,
    'data export': `Usage:
  octo-engine data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
`,
    runs: `Usage:
  octo-engine runs list [--output <dir>] [--json]
  octo-engine runs status <runId> [--output <dir>] [--json]
  octo-engine runs logs <runId> [--output <dir>] [--limit 100] [--json]
  octo-engine runs data <runId> [--output <dir>] [--limit 100] [--json]
  octo-engine runs cleanup [--output <dir>] [--json]

Purpose:
  Internal local artifact inspection. User workflows should use taskId/lotId commands:
  octo-engine data history <taskId> --source local
  octo-engine data export <taskId> --source local --lot-id <lotId>
  cleanup removes stale control files whose local control socket is gone.
`,
    doctor: `Usage:
  octo-engine doctor [--chrome-path <path>] [--json]
`,
    browser: `Usage:
  octo-engine browser doctor [--chrome-path <path>] [--json]
`
  };

  console.log(help[key] ?? help[command] ?? '使用 octo-engine --help 查看可用命令');
}

export function printRootHelp(version: string): void {
  console.log(`octo-engine ${version}

Standalone Octoparse engine CLI.

Usage:
  octo-engine capabilities [--json]
  octo-engine doctor [--chrome-path <path>] [--json]
  octo-engine auth login [--stdin] [--api-base-url <url>] [--json]
  octo-engine auth status [--json]
  octo-engine auth logout [--json]
  octo-engine browser doctor [--chrome-path <path>] [--json]
  octo-engine task list [--page <n>] [--page-size <n>] [--keyword <text>] [--json]
  octo-engine task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octo-engine task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octo-engine run <taskId> [--task-file <file.json|file.xml|file.otd>] [--output <dir>] [--chrome-path <path>] [--headless] [--detach] [--json|--jsonl]
  octo-engine cloud start <taskId> [--json]
  octo-engine cloud stop <taskId> [--json]
  octo-engine cloud status <taskId> [--json]
  octo-engine cloud history <taskId> [--json]
  octo-engine local status <taskId> [--json]
  octo-engine local pause <taskId> [--json]
  octo-engine local resume <taskId> [--json]
  octo-engine local stop <taskId> [--json]
  octo-engine local history <taskId> [--output <dir>] [--json]
  octo-engine local export <taskId> [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
  octo-engine local cleanup [--json]
  octo-engine data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
  octo-engine data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]

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
  octo-engine auth login          verify and store API key in ~/.octo-engine/credentials.json
  octo-engine auth login --stdin  read API key from stdin, verify it, then store it
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
