import { API_BASE_URL_ENV } from '../runtime/api-client.js';
import { ACCESS_TOKEN_ENV, API_KEY_ENV } from '../runtime/auth.js';
import { API_KEYS_URL } from '../commands/auth.js';

export function printCommandHelp(command: string, subcommand?: string): void {
  const key = subcommand && !subcommand.startsWith('-') ? `${command} ${subcommand}` : command;
  const help: Record<string, string> = {
    capabilities: `Usage:
  octopus capabilities [--json]

Purpose:
  Print machine-readable CLI capabilities for agents.
  Agents should call this before planning multi-step workflows such as creating
  a scraping task from a URL. The response includes machineContract.recipes with
  the recommended detect/plan/preview/apply/validate sequence.
  For user requests like "use bazhuayu-cli to create a task for this URL",
  LLM/agent tools should choose machineContract.recipes.createTaskFromUrlWithAgent
  and run the CLI workflow themselves.
  Agent task creation context includes the user goal and a full-page screenshot
  by default.
  bazhuayu-cli is the npm package name; octopus is the installed binary.
  If a user says "use bazhuayu-cli to create a task for this URL", agents should
  inspect this command and then execute the recipe without asking the user to
  explain internal detect flags.

Authentication:
  Does not require login. Functional commands do.
`,
  auth: `Usage:
  octopus auth login [--oauth] [--no-open] [--json]
  octopus auth login --api-key <apiKey> [--api-base-url <url>] [--json]
  octopus auth login <apiKey> [--api-base-url <url>] [--json]
  octopus auth login [--stdin] [--no-open] [--api-base-url <url>] [--json]
  octopus auth status [--json]
  octopus auth info [--json]
  octopus auth logout [--json]

Login methods:
  Interactive login lets you choose OAuth or API key.
  OAuth opens the browser and stores an access/refresh token locally.
  Create one at ${API_KEYS_URL}
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
  octopus env prod [--json]
  octopus env online [--json]
  octopus env status [--json]

Purpose:
  Hidden internal command for switching API environment.
`,
    task: `Usage:
  octopus task list [--page <n>] [--page-size <n>] [--limit <n>] [--keyword <text>] [--task-group <groupId>] [--template-id <id>] [--template-version-id <id>] [--json]
  octopus task show <taskId> [--json]
  octopus task copy <taskId> [--task-group <groupId>] [--json]
  octopus task rename <taskId> --name <name> --yes [--json]
  octopus task move <taskId> --task-group <groupId> --yes [--json]
  octopus task delete <taskId> --yes [--json]
  octopus task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octopus task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]

Notes:
  rename/move/delete modify remote tasks and require --yes.
`,
    'task list': `Usage:
  octopus task list [--page <n>] [--page-size <n>] [--limit <n>] [--keyword <text>] [--task-group <groupId>] [--template-id <id>] [--template-version-id <id>] [--json]

Options:
  --page <n>                    Page number to fetch. Defaults to 1.
  --page-size <n>               Number of tasks per page. Defaults to 20.
  --limit <n>                   Alias for --page-size.
  --keyword <text>              Filter tasks by keyword.
  --task-group <groupId>        Filter tasks by task group.
  --status <value>              Filter tasks by platform status.
  --task-type <value>           Filter tasks by platform task type.
  --scheduled <true|false>      Filter scheduled or unscheduled tasks.
  --template-id <id>            Filter tasks created from a template registration.
  --template-registration-id <id>
                                Alias for --template-id.
  --template-version-id <id>    Filter tasks by template version.
  --json                        Print a machine-readable JSON envelope.

Examples:
  octopus task list
  octopus task list --page 2 --page-size 20
  octopus task list --keyword news --page 2 --page-size 10
  octopus task list --template-id template-123 --json
`,
    'task inspect': `Usage:
  octopus task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    'task validate': `Usage:
  octopus task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
`,
    'task-group': `Usage:
  octopus task-group list [--json]
  octopus task-group create <name> [--json]
  octopus task-group update <groupId> --name <name> --yes [--json]
  octopus task-group delete <groupId> --yes [--json]
  octopus task-group set-default <groupId> --yes [--json]

Notes:
  update/delete/set-default modify remote task group state and require --yes.
`,
    template: `Usage:
  octopus template search <keyword> [--page <n>] [--page-size <n>] [--json]
  octopus template view <templateRegistrationId> [--json]
  octopus template version <templateRegistrationId> [--json]

Notes:
  Domestic template APIs use templateRegistrationId for catalog detail lookup.
`,
    'template search': `Usage:
  octopus template search <keyword> [--page <n>] [--page-size <n>] [--kind-id <id>] [--free true|false] [--run-on <n>] [--scope <n>] [--json]
`,
    'template view': `Usage:
  octopus template view <templateRegistrationId> [--json]

JSON output includes normalized parameters, parameterExample, parameterSource, and
createExamples for agent/template-task creation workflows.
`,
    'template version': `Usage:
  octopus template version <templateRegistrationId> [--json]
`,
    'template-task': `Usage:
  octopus template-task create <templateRegistrationId> [--name <taskName>] [--task-group <groupId>] [--param key=value]... [--params <json>|--params-file <file>] [--dry-run] [--json]
  octopus template-task update <taskId> [--params <json>|--params-file <file>] --yes [--json]

Notes:
  Prefer --param key=value for agent-friendly template creation when template view
  returns normalized parameters.
  --params must be the domestic template userInputParameters JSON object.
  --dry-run builds and prints the request without creating a task.
  update modifies remote template task mapping and requires --yes.
`,
    schedule: `Usage:
  octopus schedule cloud get <taskId> [--json]
  octopus schedule cloud update <taskId> --type <type> --date <value> --time <value> [--month <value>] [--enabled true|false] --yes [--json]
  octopus schedule cloud start <taskId> --yes [--json]
  octopus schedule cloud stop <taskId> --yes [--json]
  octopus schedule cloud next --type <type> --date <value> --time <value> [--month <value>] [--json]

Schedule types:
  1=date/once, 2=weekly, 3=monthly, 4=interval-minute, 5=every-hour, 6=daily.

Notes:
  cloud update/start/stop modify remote schedule state and require --yes.
  cloud next uses the domestic nextexecutiontime API and returns nextExecutionTimes.
  Local schedule is not exposed in the CLI because it depends on the desktop client's
  local SQLite/node-schedule queue.
`,
    'schedule cloud': `Usage:
  octopus schedule cloud get <taskId> [--json]
  octopus schedule cloud update <taskId> --type <type> --date <value> --time <value> [--month <value>] [--enabled true|false] --yes [--json]
  octopus schedule cloud start <taskId> --yes [--json]
  octopus schedule cloud stop <taskId> --yes [--json]
  octopus schedule cloud next --type <type> --date <value> --time <value> [--month <value>] [--json]

Schedule types:
  1=date/once, 2=weekly, 3=monthly, 4=interval-minute, 5=every-hour, 6=daily.
`,
    browser: `Usage:
  octopus browser use independent|user [--browser-id chrome|edge] [--profile <name>] [--json]
  octopus browser use status [--json]
  octopus browser status [--browser-id chrome|edge] [--profile <name>] [--json]
  octopus browser install [--browser-id chrome|edge] [--profile <name>] [--force-close] [--json]
  octopus browser close [--browser-id chrome|edge] [--profile <name>] [--json]
  octopus browser profiles [--browser-id chrome|edge] [--json]

Purpose:
  Choose the default browser for run/detect, and manage the permanently installed
  Octopus extension used by user-browser mode.

Browser modes:
  independent  Chrome for Testing (temporary profile + unpacked extension). Built-in default.
  user         System Chrome/Edge + permanently installed extension (Windows/macOS).

Examples:
  octopus browser status --browser-id chrome --json
  octopus browser profiles --browser-id chrome --json
  octopus browser install --browser-id chrome --profile "Default" --force-close --json
  # Reopen Chrome once and confirm the extension is enabled, then verify status.
  octopus browser status --browser-id chrome --profile "Default" --json
  octopus browser use user --browser-id chrome --profile "Default" --json
  octopus browser use user                 # default run/detect to user browser
  octopus browser use user --profile "Profile 1"
  octopus browser use independent          # switch back to Chrome for Testing
  octopus browser use status               # show saved default

Notes:
  Recommended order: status -> profiles -> install -> reopen/enable -> status -> use user.
  In --json mode, follow data.nextActions (or error.details.nextActions) until
  status reports readyForUserBrowserRun=true; only then persist user mode.
  Saved default lives in ~/.octopus/config.json and applies to both run and detect.
  Override once with: octopus run|detect ... --browser independent|user
  Env override: OCTOPUS_BROWSER=user|independent (optional OCTOPUS_BROWSER_ID / OCTOPUS_BROWSER_PROFILE)
  User browser mode reuses your real Chrome/Edge profile (cookies/login state).
  Installing the extension requires the browser to be fully closed.
  Use --force-close to let the CLI close a running browser before install.
  Pass --profile to install the extension for the same profile selected by use/run/detect.
  Supported platforms for user mode: Windows and macOS. Linux uses independent Chrome.
  After install, reopen the browser once and confirm the extension is enabled.
`,
    run: `Usage:
  octopus run <taskId> [--task-file <file.json|file.xml|file.otd>] [--output <dir>] [--browser independent|user] [--browser-id chrome|edge] [--profile <name>] [--chrome-path <path>] [--headless] [--max-rows <n>] [--detach] [--json|--jsonl]

Agent notes:
  Requires configured credentials even when --task-file points to a local JSON, XML, or OTD file.
  Use --detach for background local collection.
  Use --max-rows <n> to stop automatically after saving n rows.
  Use --jsonl for foreground event streams.
  JSONL now includes captcha and proxy request events when the runtime asks for them.
  run only starts local collection. Use data export <taskId> --lot-id <lotId> for files.
  Local Chrome execution supports macOS x64/arm64, Windows x64, and Linux x64.
  Linux arm64 is not supported because Chrome for Testing has no Linux arm64 browser package.
  Browser selection (priority): --browser flag > OCTOPUS_BROWSER env > octopus browser use > independent.
  Set default once: octopus browser use user|independent
  --browser independent launches a temporary Chrome for Testing profile.
  --browser user reuses system Chrome/Edge with the permanently installed extension.
  User browser setup includes: octopus browser install (full verified flow: octopus browser --help)
  Agents should follow browserRuntime.modes.user.setupRecipe from capabilities --json.
  User browser mode does not support --headless.
`,
    detect: `Usage:
  octopus detect <url> --prepare-agent --json [--goal <text>] [--output context.json]
  octopus detect --preview-agent-plan plan.json --agent-context context.json [--json]
  octopus detect --apply-agent-plan plan.json --agent-context context.json --output task.json [--json]
  octopus detect <url> --agent --agent-command <cmd> [--goal <text>] [--output task.json] [--run-sample <n>]
  octopus detect <url> --auto [--goal <text>] [--output task.json] [--llm-rank] [--no-dismiss-popups] [--json]
  octopus detect <url> --manual [--goal <text>] [--llm-rank] [--no-dismiss-popups]
  octopus detect <url> --browser independent|user [--browser-id chrome|edge] [--profile <name>] [--force-close-browser] --auto|--manual|--agent ...

Purpose:
  Open the Octopus extension browser, inspect the page, and list candidate data regions
  such as tables, repeated cards, search results, link collections, and forms.

Notes:
  Quote URLs that contain '&', '?' or other shell metacharacters, for example:
  octopus detect 'https://example.com/page?a=1&b=2' --manual
  The first pass is deterministic and does not require an LLM. For direct
  CLI-only use, --auto chooses the best candidate and generates a task.
  --manual opens a guided flow for login,
  popup handling, choosing the highlighted data region, optional session save,
  and task-file generation.
  Browser selection matches run: --browser flag > OCTOPUS_BROWSER env >
  octopus browser use default > independent.
  Set default once: octopus browser use user|independent
  --browser independent launches temporary Chrome for Testing.
  --browser user reuses system Chrome/Edge + permanently installed extension
  (Windows/macOS). Setup includes octopus browser install; see: octopus browser --help
  Agents should follow browserRuntime.modes.user.setupRecipe and JSON nextActions.
  User-browser detect/run does not require closing an already-open Chrome;
  it opens a dedicated session window and closes only that window when finished.
  Only browser install needs the browser closed (or --force-close).
  On Linux servers without DISPLAY/WAYLAND_DISPLAY, non-manual detection
  automatically uses Xvfb when installed. Manual detection needs a visible
  desktop/VNC display because the user must interact with the browser overlay.
  Use --query <keyword> or --input <name=value> to search first, then detect
  and generate a task from the result page. Generated tasks preserve the search
  input XPath and submit action before extracting results.
  If a search page opens a login/captcha/paywall gate, detect pauses in
  interactive/manual mode so the user can complete login in the browser. Use
  --save-session to store same-site cookies; generated tasks inject that session
  before replaying the search.
  detect uses the protected SmartProxy runtime by default. It requires a
  bundled private @octopus/octopus-protect native module. Protected Smart resources are
  fetched encrypted, decrypted in memory, and never written to task files.
  Use --legacy-detector only for debugging the previous heuristic detector.
  If --output is omitted when generating a task, a detected_<host>.json file is created automatically.
  Login/cookie/ad overlays are dismissed automatically when a safe close control is found.
  Use --no-dismiss-popups to inspect the page without this cleanup.
  The manual session-save option stores same-site cookies locally and writes only
  a session reference in generated task files; later local runs load that session automatically.
  Cookie sessions do not cover every site, especially pages that require localStorage,
  device binding, or fresh verification.
  Agents should discover this workflow via "octopus capabilities --json" and
  machineContract.recipes.createTaskFromUrlWithAgent; users should not need to
  explain the prepare/plan/preview/apply sequence manually.
  If an LLM/agent is helping the user create a scraping task, prefer that recipe
  over handwritten task JSON. For the shortest path, use --agent with a trusted
  --agent-command; add --run-sample <n> to generate the task and immediately run
  a small local sample in the same JSON response. For audit or repair, use the
  low-level prepare/preview/apply commands. Agents must open
  context.visualArtifacts.annotatedScreenshotPath or context.screenshot.path
  before writing the plan and include visualReview evidence/checks when a
  screenshot is present.
  Before choosing a candidate, infer the primary task target from the user goal
  and live visible page structure. Honor explicit goals; when the goal is vague
  or absent, use page structure. Do not default to details or the largest list.
  Prefer selection.fields entries such as {"elementId":"<context.visualElements id>","as":"title"}
  when context.visualElements is available; fall back to existing field names
  or source/as pairs when no elementId is available.
  context.visualElements includes source=detected_field and extra source=visible_dom
  entries from candidate rows. Screenshots may show V* labels that match
  visualElements[].annotationLabel. Use visible_dom ids when detector fields miss
  visible titles/prices/images/links/metrics; set kind="href" or kind="src" when
  the selected element should extract a URL or image source.
  If the correct visible region is not present in context.candidates, use
  context.pageVisualElements to write selection.customCandidate with xpath/itemXPath
  and fieldElementIds; the CLI previews that synthetic candidate before applying it.
  Do not treat --auto examples as the default LLM/agent workflow; --auto skips
  agent planning and is only for direct CLI automatic selection.
  Agent workflows generate a full-page screenshot, an annotated screenshot, and
  top candidate crop screenshots when boxes are available. Paths are exposed in
  context.screenshot, context.visualArtifacts, and context.decisionSummary. Pass
  the user request through --goal so the agent can judge candidates against both
  the natural-language intent and the screenshot.
  Local Chrome execution supports macOS x64/arm64, Windows x64, and Linux x64.
  Linux arm64 is not supported because Chrome for Testing has no Linux arm64 browser package.
  --agent is a one-shot wrapper for external LLM/agent tools. The CLI writes a
  temporary context JSON, runs --agent-command (or OCTOPUS_AGENT_COMMAND), expects
  a plan JSON at OCTOPUS_AGENT_PLAN or stdout, previews risk, then generates the
  task when preview passes. Use --confirm-agent-plan to ask before writing the
  task. --agent-command executes a local
  shell command; only pass a trusted agent runner. --yes is accepted for
  backward compatibility but is no longer required. --run-sample <n> runs the
  generated task with --max-rows <n> and embeds the run envelope in the detect
  JSON response without printing a second top-level JSON document. Use
  --keep-agent-files to retain the context/plan for audit. Low-level --prepare-agent/--preview-agent-plan/
  --apply-agent-plan commands remain available for automation and debugging.
  Plans generated from a context with screenshot.path must include
  visualReview.reviewed=true, visualReview.evidence, and preferably
  visualReview.checks; preview fails when the agent has not recorded visual
  verification.
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
  octopus local status <taskId> [--output <dir>] [--json]
  octopus local pause <taskId> [--json]
  octopus local resume <taskId> [--json]
  octopus local stop <taskId> [--json]
  octopus local history <taskId> [--output <dir>] [--json]
  octopus local export <taskId> [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
  octopus local cleanup [--json]
`,
    data: `Usage:
  octopus data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
  octopus data count <taskId> [--source local|cloud|--local|--cloud] [--unexported] [--json]
  octopus data preview <taskId> [--source local|cloud|--local|--cloud] [--limit <n>] [--offset <n>] [--unexported] [--json]
  octopus data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--unexported] [--json]

Defaults:
  --source local
  data preview returns the latest rows unless --offset is provided.
  --unexported reads cloud unexported rows but does not mark them as exported.
  --format xlsx, unless inferred from --file extension
  --file task-name.<format>, with Windows-style duplicate suffixes
`,
    'data history': `Usage:
  octopus data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
`,
    'data count': `Usage:
  octopus data count <taskId> [--source local|cloud|--local|--cloud] [--unexported] [--json]
`,
    'data preview': `Usage:
  octopus data preview <taskId> [--source local|cloud|--local|--cloud] [--limit <n>] [--offset <n>] [--unexported] [--json]
`,
    'data export': `Usage:
  octopus data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--unexported] [--json]

Notes:
  --unexported reads cloud unexported rows but does not mark them as exported.
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
  octopus doctor [--chrome-path <path>] [--output <runsDir>] [--api-base-url <url>] [--json]

Purpose:
  Check the full local CLI environment: Node.js, bundled engine files, protected
  native module, Chrome resolution and launch, Linux display/Xvfb readiness,
  authentication/API reachability, local run directory write access, and
  optional user-browser extension readiness on Windows/macOS.
`
  };

  console.log(help[key] ?? help[command] ?? '使用 octopus --help 查看可用命令');
}

export function printRootHelp(version: string): void {
  console.log(`octopus ${version}

Standalone Octoparse engine CLI.

Usage:
  octopus capabilities [--json]
  octopus doctor [--chrome-path <path>] [--output <runsDir>] [--api-base-url <url>] [--json]
  octopus browser use independent|user [--browser-id chrome|edge] [--profile <name>] [--json]
  octopus browser status|install|close|profiles [--browser-id chrome|edge] [--profile <name>] [--json]
  octopus auth login <apiKey> [--api-base-url <url>] [--json]
  octopus auth login [--stdin] [--no-open] [--api-base-url <url>] [--json]
  octopus auth status [--json]
  octopus auth info [--json]
  octopus auth logout [--json]
  octopus task list [--page <n>] [--page-size <n>] [--limit <n>] [--keyword <text>] [--task-group <groupId>] [--template-id <id>] [--template-version-id <id>] [--json]
  octopus task show <taskId> [--json]
  octopus task copy <taskId> [--task-group <groupId>] [--json]
  octopus task rename <taskId> --name <name> --yes [--json]
  octopus task move <taskId> --task-group <groupId> --yes [--json]
  octopus task delete <taskId> --yes [--json]
  octopus task inspect <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octopus task validate <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]
  octopus task-group list/create/update/delete/set-default [--json]
  octopus template search/view/version [--json]
  octopus template-task create/update [--json]
  octopus schedule cloud get/update/start/stop/next [--json]
  octopus detect URL --prepare-agent --json --goal <text> --output context.json
  octopus detect --preview-agent-plan plan.json --agent-context context.json [--json]
  octopus detect --apply-agent-plan plan.json --agent-context context.json --output task.json
  octopus detect URL --agent --agent-command <cmd> [--output task.json] [--run-sample <n>]
  octopus detect URL --auto [--goal <text>] [--output task.json] [--llm-rank] [--no-dismiss-popups] [--json]
  octopus detect URL --manual [--goal <text>] [--llm-rank] [--no-dismiss-popups]
  octopus detect URL --browser user [--profile <name>] --auto|--manual|--agent ...
  octopus run <taskId> [--task-file <file.json|file.xml|file.otd>] [--output <dir>] [--browser independent|user] [--browser-id chrome|edge] [--profile <name>] [--chrome-path <path>] [--headless] [--max-rows <n>] [--detach] [--json|--jsonl]
  octopus cloud start <taskId> [--json]
  octopus cloud stop <taskId> [--json]
  octopus cloud status <taskId> [--json]
  octopus cloud history <taskId> [--json]
  octopus local status <taskId> [--output <dir>] [--json]
  octopus local pause <taskId> [--json]
  octopus local resume <taskId> [--json]
  octopus local stop <taskId> [--json]
  octopus local history <taskId> [--output <dir>] [--json]
  octopus local export <taskId> [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]
  octopus local cleanup [--json]
  octopus data history <taskId> [--source local|cloud|--local|--cloud] [--output <dir>] [--json]
  octopus data count <taskId> [--source local|cloud|--local|--cloud] [--unexported] [--json]
  octopus data preview <taskId> [--source local|cloud|--local|--cloud] [--limit <n>] [--offset <n>] [--unexported] [--json]
  octopus data export <taskId> [--source local|cloud|--local|--cloud] [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--unexported] [--json]

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
  - Runs embedded @octopus/browser-runtime directly.
  - Default local mode uses independent Chrome for Testing (override with octopus browser use user).
  - Optional --browser user reuses system Chrome/Edge + permanently installed extension (Windows/macOS).
  - Supports local Chrome execution on macOS x64/arm64, Windows x64, and Linux x64.
  - Does not support Linux arm64 local execution because Chrome for Testing has no Linux arm64 browser package.
  - Does not require the Electron client.
  - Cloud collection is controlled through backend APIs; local collection is controlled by the local engine.
  - Does not support kernel browser or legacy workflow in v1.

Authentication:
  OAuth or API key credentials are required for all functional commands, including local --task-file and .otd runs.
  Only setup/diagnostic commands can run without it: --help, --version, capabilities, doctor, browser, auth, env.
  API key page:                   ${API_KEYS_URL}
  octopus auth login --oauth   open browser OAuth login and store tokens
  octopus auth login <key>     verify and store a copied API key directly
  octopus auth login          choose OAuth or API key interactively
  octopus auth login --stdin  read API key from stdin, verify it, then store it
  octopus auth login --no-open do not open the browser during interactive login
  ${API_KEY_ENV}                  overrides stored credentials
  ${ACCESS_TOKEN_ENV}             uses a bearer access token instead of stored credentials
  ${API_BASE_URL_ENV}             overrides API base URL; default is the production API

Run diagnostics:
  --timeout-ms <ms>            overall foreground run timeout, default 600000
  --extension-timeout-ms <ms>  runtime extension registration timeout, default 15000
  --max-rows <n>               stop local collection after saving n rows
  --browser independent|user   browser launch mode (default: saved preference or independent)
  --browser-id chrome|edge     target browser for --browser user
  --profile <name>             Chromium profile directory for --browser user
  --force-close-browser        optional: force-close user browser before user-mode launch (not required; default reuses running browser)
  octopus browser use ...      set default browser for run/detect (saved in ~/.octopus/config.json)
  --debug-bridge              include extension bridge command/response logs

Agent contract:
  For LLM/agent task creation, run capabilities --json. Prefer detect --agent
  with a trusted --agent-command for the shortest create-task path; add
  --run-sample <n> when the user wants immediate sample rows. Use prepare,
  preview, apply, and validate as the lower-level auditable workflow. Agents
  must open context.screenshot.path and record visualReview evidence before
  writing plan.json.
  Before choosing a candidate, first judge the live page primary target from the
  user goal, title, first viewport, active tab/navigation, semantic purpose, and
  main content prominence; do not default to details or the largest list.
  If candidates miss the visible target, use context.pageVisualElements with
  selection.customCandidate instead of forcing the wrong candidate.
  Do not treat --auto examples as the default LLM/agent workflow; --auto is only for
  direct CLI automatic selection.
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
