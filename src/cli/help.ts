import { API_BASE_URL_ENV } from '../runtime/api-client.js';
import { ACCESS_TOKEN_ENV, API_KEY_ENV } from '../runtime/auth.js';
import { API_KEYS_URL } from '../commands/auth.js';

const BRAND_BLUE = '\u001b[38;2;37;99;235m';
const ANSI_RESET = '\u001b[0m';

function colorEnabled(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') return true;
  return Boolean(process.stdout.isTTY);
}

function commandName(value: string): string {
  return colorEnabled() ? `${BRAND_BLUE}${value}${ANSI_RESET}` : value;
}

function commandLine(command: string, description: string): string {
  return `    ${commandName(command.padEnd(12))} ${description}`;
}

export function printCommandHelp(command: string, subcommand?: string): void {
  const key = subcommand && !subcommand.startsWith('-') ? `${command} ${subcommand}` : command;
  const help: Record<string, string> = {
    capabilities: `Usage:
  bazhuayu capabilities [--json]

Purpose:
  Print machine-readable CLI capabilities for automation and agent workflows.
  The response includes supported commands, auth requirements, output formats,
  error codes, browser modes, and recommended task-creation recipes.

Agent notes:
  Agents should inspect this command before planning multi-step workflows such
  as creating a scraping task from a URL. For that workflow, follow
  machineContract.recipes.createTaskFromUrlWithAgent instead of guessing detect
  flags from human help text.
  bazhuayu-cli is the npm package name; bazhuayu is the installed binary.

Authentication:
  Does not require login. Functional commands do.
`,
  auth: `Usage:
  bazhuayu auth login [--oauth] [--no-open] [--json]
  bazhuayu auth login --api-key <apiKey> [--api-base-url <url>] [--json]
  bazhuayu auth login <apiKey> [--api-base-url <url>] [--json]
  bazhuayu auth login [--stdin] [--no-open] [--api-base-url <url>] [--json]
  bazhuayu auth status [--json]
  bazhuayu auth info [--json]
  bazhuayu auth logout [--json]

Login methods:
  Interactive login lets you choose OAuth or API key.
  OAuth opens the browser and stores an access/refresh token locally.
  Create an API key at ${API_KEYS_URL}
  API key login opens this page automatically, then verifies and stores the key.
  If the browser does not open, copy the URL above and open it manually.

Agent notes:
  Use "auth login --oauth" to force browser-based OAuth.
  Use "auth login <apiKey>" to verify and save a copied key directly.
  Use "auth login --stdin" for non-interactive setup.
  login verifies the API key before saving; invalid keys are not stored.
  ${API_KEY_ENV} overrides stored credentials.
  ${ACCESS_TOKEN_ENV} can provide a bearer access token for CI.
  Functional commands require configured credentials, including local task-file and OTD runs.
`,
    env: `Usage:
  bazhuayu env prod [--json]
  bazhuayu env online [--json]
  bazhuayu env status [--json]

Purpose:
  Switch API environment. Internal command.
`,
    task: `Usage:
  bazhuayu task list [--page <n>] [--page-size <n>] [--limit <n>] [--keyword <text>] [--task-group <groupId>] [--template-id <id>] [--template-version-id <id>] [--json]
  bazhuayu task show <taskId> [--json]
  bazhuayu task copy <taskId> [--task-group <groupId>] [--json]
  bazhuayu task rename <taskId> --name <name> --yes [--json]
  bazhuayu task move <taskId> --task-group <groupId> --yes [--json]
  bazhuayu task delete <taskId> --yes [--json]
  bazhuayu task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  bazhuayu task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]

Notes:
  rename/move/delete modify remote tasks and require --yes.
  When --task-file is used, <taskId> provides a fallback ID if the file does not contain one.
`,
    'task list': `Usage:
  bazhuayu task list [--page <n>] [--page-size <n>] [--limit <n>] [--keyword <text>] [--task-group <groupId>] [--template-id <id>] [--template-version-id <id>] [--json]

Options:
  --page <n>                    Page number to fetch. Defaults to 1.
  --page-size <n>               Number of tasks per page. Defaults to 20.
  --limit <n>                   Alias for --page-size.
  --keyword <text>              Filter tasks by keyword.
  --task-group <groupId>        Filter tasks by task group.
  --status <value>              Filter tasks by platform status.
  --task-type <value>           Filter tasks by platform task type.
  --scheduled <true|false>      Filter scheduled or unscheduled tasks.
  --template-id <id>            Filter tasks created from a template.
  --template-version-id <id>    Filter tasks by template version.
  --json                        Print a machine-readable JSON envelope.

Examples:
  bazhuayu task list
  bazhuayu task list --page 2 --page-size 20
  bazhuayu task list --keyword news --page 2 --page-size 10
  bazhuayu task list --template-id template-123 --json
`,
    'task inspect': `Usage:
  bazhuayu task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]

Notes:
  When --task-file is used, <taskId> provides a fallback ID if the file does not contain one.
`,
    'task validate': `Usage:
  bazhuayu task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]

Notes:
  When --task-file is used, <taskId> provides a fallback ID if the file does not contain one.
`,
    'task-group': `Usage:
  bazhuayu task-group list [--json]
  bazhuayu task-group create <name> [--json]
  bazhuayu task-group update <groupId> --name <name> --yes [--json]
  bazhuayu task-group delete <groupId> --yes [--json]
  bazhuayu task-group set-default <groupId> --yes [--json]

Notes:
  update/delete/set-default modify remote task group state and require --yes.
`,
    template: `Usage:
  bazhuayu template search <keyword> [--page <n>] [--page-size <n>] [--sort <n>] [--json]
  bazhuayu template view <templateId> [--json]
  bazhuayu template version <templateId> [--json]

Notes:
  Requires configured credentials. Run "bazhuayu auth login" first.
  Template search uses the same catalog and default ranking as the Bazhuayu website.
`,
    'template search': `Usage:
  bazhuayu template search <keyword> [--page <n>] [--page-size <n>] [--sort <n>] [--kind-id <id>] [--free true|false] [--run-on <n>] [--scope <n>] [--json]

Notes:
  Requires configured credentials. Run "bazhuayu auth login" first.
  Uses the same template catalog and default ranking as the Bazhuayu website.
`,
    'template view': `Usage:
  bazhuayu template view <templateId> [--json]

JSON output includes normalized parameters, parameterExample, parameterSource,
and createExamples for agent/template-task creation workflows.

Notes:
  Requires configured credentials. Run "bazhuayu auth login" first.
`,
    'template version': `Usage:
  bazhuayu template version <templateId> [--json]

Notes:
  Requires configured credentials. Run "bazhuayu auth login" first.
`,
    'template-task': `Usage:
  bazhuayu template-task create <templateId> [--name <taskName>] [--task-group <groupId>] [--param key=value]... [--params <json>|--params-file <file>] [--dry-run] [--json]
  bazhuayu template-task update <taskId> [--params <json>|--params-file <file>] --yes [--json]

Notes:
  Prefer --param key=value for simple template creation when template view
  returns normalized parameters.
  --params must be the domestic template userInputParameters JSON object.
  --dry-run builds and prints the request without creating a task.
  update modifies remote template task mapping and requires --yes.
`,
    schedule: `Usage:
  bazhuayu schedule cloud get <taskId> [--json]
  bazhuayu schedule cloud update <taskId> --type <type> --date <value> --time <value> [--month <value>] [--enabled true|false] --yes [--json]
  bazhuayu schedule cloud start <taskId> --yes [--json]
  bazhuayu schedule cloud stop <taskId> --yes [--json]
  bazhuayu schedule cloud next --type <type> --date <value> --time <value> [--month <value>] [--json]

Schedule types:
  1=date/once, 2=weekly, 3=monthly, 4=interval-minute, 5=every-hour, 6=daily.

Notes:
  cloud update/start/stop modify remote schedule state and require --yes.
  cloud next uses the domestic nextexecutiontime API and returns nextExecutionTimes.
  Local schedules are managed in the Bazhuayu desktop app and are not available in the CLI.
`,
    'schedule cloud': `Usage:
  bazhuayu schedule cloud get <taskId> [--json]
  bazhuayu schedule cloud update <taskId> --type <type> --date <value> --time <value> [--month <value>] [--enabled true|false] --yes [--json]
  bazhuayu schedule cloud start <taskId> --yes [--json]
  bazhuayu schedule cloud stop <taskId> --yes [--json]
  bazhuayu schedule cloud next --type <type> --date <value> --time <value> [--month <value>] [--json]

Schedule types:
  1=date/once, 2=weekly, 3=monthly, 4=interval-minute, 5=every-hour, 6=daily.
`,
    browser: `Usage:
  bazhuayu browser use independent|user [--browser-id chrome|edge] [--profile <name>] [--json]
  bazhuayu browser use status [--json]
  bazhuayu browser status [--browser-id chrome|edge] [--profile <name>] [--json]
  bazhuayu browser install [--browser-id chrome|edge] [--profile <name>] [--force-close] [--json]
  bazhuayu browser close [--browser-id chrome|edge] [--profile <name>] [--json]
  bazhuayu browser profiles [--browser-id chrome|edge] [--json]

Purpose:
  Choose the default browser for run/detect, and manage the permanently installed
  Octopus extension used by user-browser mode.

Browser modes:
  independent  Chrome for Testing (temporary profile + unpacked extension). Built-in default.
  user         System Chrome/Edge + permanently installed extension (Windows/macOS).

Examples:
  bazhuayu browser status --browser-id chrome --json
  bazhuayu browser profiles --browser-id chrome --json
  bazhuayu browser install --browser-id chrome --profile "Default" --force-close --json
  # Reopen Chrome once and confirm the extension is enabled, then verify status.
  bazhuayu browser status --browser-id chrome --profile "Default" --json
  bazhuayu browser use user --browser-id chrome --profile "Default" --json
  bazhuayu browser use user                 # default run/detect to user browser
  bazhuayu browser use user --profile "Profile 1"
  bazhuayu browser use independent          # switch back to Chrome for Testing
  bazhuayu browser use status               # show saved default

Notes:
  Recommended order: status -> profiles -> install -> reopen/enable -> status -> use user.
  In --json mode, follow data.nextActions (or error.details.nextActions) until
  status reports readyForUserBrowserRun=true; only then persist user mode.
  Selection priority: --browser > OCTOPUS_BROWSER > saved browser use setting > independent.
  Saved default lives in ~/.octopus/config.json and applies to both run and detect.
  Override once with: bazhuayu run|detect ... --browser independent|user
  Env override: OCTOPUS_BROWSER=user|independent (optional OCTOPUS_BROWSER_ID / OCTOPUS_BROWSER_PROFILE)
  User browser mode reuses your real Chrome/Edge profile (cookies/login state).
  Installing the extension requires the browser to be fully closed.
  Use --force-close to let the CLI close a running browser before install.
  Pass --profile to install the extension for the same profile selected by use/run/detect.
  Supported platforms for user mode: Windows and macOS. Linux uses independent Chrome.
  After install, reopen the browser once and confirm the extension is enabled.
`,
    run: `Usage:
  bazhuayu run <taskId> [options]

Purpose:
  Run a Bazhuayu task locally.

Task and output:
  --task-file <file.json|file.xml|file.otd>
      Load a local task definition instead of fetching <taskId>.
      <taskId> is used as a fallback when the file does not contain one.
  --output <dir>            Store run artifacts under this directory.
  --max-rows <n>            Stop after saving n rows.

Execution:
  --detach                  Start in the background. Foreground is the default.
  --timeout-ms <ms>         Set the foreground run timeout. Default: 600000.
  --headless                Run the independent browser without a visible window.
  --json                    Print one machine-readable result.
  --jsonl                   Stream foreground run events as JSON Lines.

Browser:
  --browser independent|user
                            Choose a browser mode for this run.
  --browser-id chrome|edge  Select Chrome or Edge for user mode.
  --profile <name>          Select a Chromium profile for user mode.
  --chrome-path <path>      Override the Chrome executable for independent mode.
  --force-close-browser     Allow the CLI to close the selected user browser if needed.

Browser modes:
  independent  Chrome for Testing with a temporary profile.
  user         System Chrome/Edge with existing cookies and login state.
  User mode is supported on Windows and macOS and does not support --headless.
  See bazhuayu browser --help for browser selection priority and setup.

Examples:
  bazhuayu run task-123
  bazhuayu run task-123 --max-rows 100 --json
  bazhuayu run task-123 --detach
  bazhuayu run local-task --task-file task.json --browser user --profile "Default"

Notes:
  Requires configured credentials, including runs from local task files.
  --jsonl includes row, log, captcha, proxy, download, and lifecycle events.
  This command starts local collection only. Export results with
  bazhuayu data export <taskId> --lot-id <lotId>.
  Browser-based local execution supports macOS x64/arm64, Windows x64, and Linux x64.
  Linux arm64 browser-based execution is not supported because Chrome for Testing
  has no Linux arm64 package.
  Agents using user mode should follow browserRuntime.modes.user.setupRecipe from
  bazhuayu capabilities --json.
`,
    detect: `Usage:
  bazhuayu detect <url> --auto [--goal <text>] [--output task.json] [--llm-rank] [--no-dismiss-popups] [--json]
  bazhuayu detect <url> --manual [--goal <text>] [--output task.json] [--llm-rank] [--no-dismiss-popups]
  bazhuayu detect <url> --agent --agent-command <cmd> [--goal <text>] [--output task.json] [--run-sample <n>] [--json]

Agent workflow:
  bazhuayu detect <url> --prepare-agent --json [--goal <text>] [--output context.json]
  bazhuayu detect --preview-agent-plan plan.json --agent-context context.json [--json]
  bazhuayu detect --apply-agent-plan plan.json --agent-context context.json --output task.json [--json]

Purpose:
  Create a local collection task by inspecting a web page and identifying its
  primary data region, fields, and pagination.

Modes:
  --auto    Choose the best detected region and generate a task automatically.
  --manual  Open a guided browser flow to choose the region and handle login or popups.
  --agent   Let a trusted external agent review the page context and generate a task plan.

Browser:
  Use --browser independent|user, with optional --browser-id chrome|edge and
  --profile <name>. See bazhuayu browser --help for selection priority and setup.
  independent uses a temporary Chrome for Testing profile.
  user reuses system Chrome/Edge and its signed-in profile on Windows or macOS.
  Configure user mode with bazhuayu browser install and bazhuayu browser use.
  User mode opens a dedicated session window and does not require closing an
  already-open browser. Agents should follow browserRuntime.modes.user.setupRecipe
  and JSON nextActions. Use --force-close-browser only when explicitly needed.

Search and login:
  Use --query <keyword> or --input <name=value> to search before detecting data.
  Manual mode can pause for login, captcha, or paywall handling. Use --save-session
  to reuse supported same-site cookies in later local runs.

Output:
  If --output is omitted, detect creates detected_<host>.json.
  --run-sample <n> generates the task, runs up to n local rows, and returns the
  task and sample result in one JSON response.

Examples:
  bazhuayu detect https://example.com/products --auto --output products.json
  bazhuayu detect 'https://example.com/search?q=laptop' --manual --save-session
  bazhuayu detect https://example.com/products --browser user --auto
  bazhuayu detect https://example.com/products --agent --agent-command "my-agent" --run-sample 5 --json

Notes:
  Requires configured credentials. Run "bazhuayu auth login" first.
  Quote URLs containing '&', '?' or other shell metacharacters.
  Safe login, cookie, and ad overlays are dismissed automatically; use
  --no-dismiss-popups to leave them unchanged.
  Detect uses Bazhuayu's protected detector by default. Use --legacy-detector
  only when troubleshooting the previous detector.
  Independent local detection supports macOS x64/arm64, Windows x64, and Linux x64.
  Linux arm64 is not supported. On headless Linux x64, auto and agent modes can
  use Xvfb when installed; manual mode requires a visible desktop or VNC display.
  Agents should use --agent or the prepare/preview/apply workflow, not --auto;
  --auto is for direct CLI automatic selection.
  Agent tools should inspect bazhuayu capabilities --json and follow
  machineContract.recipes.createTaskFromUrlWithAgent. Only pass a trusted command
  to --agent-command. The runner uses OCTOPUS_AGENT_CONTEXT and OCTOPUS_AGENT_PLAN.
  Use --confirm-agent-plan for interactive confirmation and --keep-agent-files
  to retain context and plan files for audit.
`,
    cloud: `Usage:
  bazhuayu cloud start <taskId> [--json]
  bazhuayu cloud stop <taskId> [--json]
  bazhuayu cloud status <taskId> [--json]
  bazhuayu cloud history <taskId> [--json]

Notes:
  Cloud collection only supports start/stop. There is no cloud pause/resume.
`,
    local: `Usage:
  bazhuayu local status <taskId> [--output <dir>] [--json]
  bazhuayu local pause <taskId> [--json]
  bazhuayu local resume <taskId> [--json]
  bazhuayu local stop <taskId> [--json]
  bazhuayu local history <taskId> [--output <dir>] [--json]
  bazhuayu local export <taskId> [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
  bazhuayu local cleanup [--json]

Notes:
  For exports, prefer bazhuayu data export <taskId> --source local.
  local export remains available for compatibility.
`,
    data: `Usage:
  bazhuayu data history <taskId> [--source local|cloud] [--output <dir>] [--json]
  bazhuayu data count <taskId> [--source local|cloud] [--unexported] [--json]
  bazhuayu data preview <taskId> [--source local|cloud] [--limit <n>] [--offset <n>] [--unexported] [--json]
  bazhuayu data export <taskId> [--source local|cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--unexported] [--json]

Defaults:
  --source local. --local and --cloud are supported aliases.
  data preview returns the latest rows unless --offset is provided.
  --unexported reads cloud unexported rows but does not mark them as exported.
  --format xlsx, unless inferred from --file extension.
  If --file is omitted, the CLI creates task-name.<format> and avoids overwriting existing files.
`,
    'data history': `Usage:
  bazhuayu data history <taskId> [--source local|cloud] [--output <dir>] [--json]
`,
    'data count': `Usage:
  bazhuayu data count <taskId> [--source local|cloud] [--unexported] [--json]
`,
    'data preview': `Usage:
  bazhuayu data preview <taskId> [--source local|cloud] [--limit <n>] [--offset <n>] [--unexported] [--json]
`,
    'data export': `Usage:
  bazhuayu data export <taskId> [--source local|cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--unexported] [--json]

Notes:
  --source defaults to local. --local and --cloud are supported aliases.
  --unexported reads cloud unexported rows but does not mark them as exported.
`,
    runs: `Usage:
  bazhuayu runs list [--output <dir>] [--json]
  bazhuayu runs status <runId> [--output <dir>] [--json]
  bazhuayu runs logs <runId> [--output <dir>] [--limit 100] [--json]
  bazhuayu runs data <runId> [--output <dir>] [--limit 100] [--json]
  bazhuayu runs cleanup [--output <dir>] [--json]

Purpose:
  Internal local artifact inspection. User workflows should use taskId/lotId commands:
  bazhuayu data history <taskId> --source local
  bazhuayu data export <taskId> --source local --lot-id <lotId>
  cleanup removes stale control files whose local control socket is gone.
`,
    doctor: `Usage:
  bazhuayu doctor [--chrome-path <path>] [--output <runsDir>] [--api-base-url <url>] [--json]

Purpose:
  Check the full local CLI environment: Node.js, bundled engine files, protected
  native module, Chrome resolution and launch, Linux display/Xvfb readiness,
  authentication/API reachability, local run directory write access, and
  optional user-browser extension readiness on Windows/macOS.
`
  };

  console.log(help[key] ?? help[command] ?? '使用 bazhuayu --help 查看可用命令');
}

export function printRootHelp(version: string): void {
  console.log([
    `bazhuayu ${version}`,
    '',
    'Run and manage Bazhuayu collection tasks from the command line.',
    '',
    `Run ${commandName('bazhuayu auth login')} to sign in.`,
    '',
    'Create:',
    commandLine('detect', 'Create a local task from a URL'),
    commandLine('template', 'Search and inspect task templates'),
    '',
    'Run:',
    commandLine('run', 'Run a task locally (shortcut)'),
    commandLine('cloud', 'Manage cloud runs (start / stop / status / history)'),
    commandLine('local', 'Manage local runs (status / pause / resume / stop / history / cleanup)'),
    '',
    'Manage:',
    commandLine('task', 'List, inspect, copy, rename, move, or delete tasks'),
    commandLine('schedule', 'View and update cloud schedules'),
    '',
    'Data:',
    commandLine('data', 'Preview, count, and export collected data'),
    '',
    'Config:',
    commandLine('auth', 'Log in, show account status, or log out'),
    commandLine('browser', 'Choose independent or signed-in browser mode'),
    commandLine('doctor', 'Check your local environment and API access'),
    '',
    `Run ${commandName('bazhuayu <command> --help')} for details on any command.`,
    `Run ${commandName('bazhuayu capabilities --json')} for machine-readable automation metadata.`,
    '',
    'Authentication:',
    '  OAuth or API key credentials are required for functional commands.',
    `  API key page: ${API_KEYS_URL}`,
    `  ${API_KEY_ENV} overrides stored credentials.`,
    `  ${ACCESS_TOKEN_ENV} uses a bearer access token for CI.`,
    `  ${API_BASE_URL_ENV} overrides the domestic production API base URL.`
  ].join('\n'));
}
