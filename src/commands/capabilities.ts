import { homedir } from 'node:os';
import { join } from 'node:path';
import { printEnvelope } from '../cli/output.js';
import { API_BASE_URL_ENV } from '../runtime/api-client.js';
import { ACCESS_TOKEN_ENV, API_KEY_ENV } from '../runtime/auth.js';
import { EXIT_OK } from '../types.js';

export async function capabilitiesCommand(version: string, json: boolean): Promise<number> {
  const data = {
    name: 'octopus',
    packageName: 'bazhuayu-cli',
    primaryBinary: 'octopus',
    invocation: {
      installed: 'octopus',
      npmExec: 'npx bazhuayu-cli',
      note: 'bazhuayu-cli is the npm package name; octopus is the CLI binary exposed by the package.'
    },
    version,
    agentContractVersion: 1,
    authentication: {
      requiredForUse: true,
      methods: ['oauth', 'apiKey'],
      loginVerifiesKeyBeforeSaving: true,
      loginSupportsOAuthBrowserFlow: true,
      setupCommandsWithoutAuth: ['auth login', 'auth status', 'auth info', 'auth logout', 'env status', 'env prod', 'env online'],
      diagnosticCommandsWithoutAuth: ['--help', '--version', 'capabilities', 'doctor', 'browser doctor'],
      env: API_KEY_ENV,
      accessTokenEnv: ACCESS_TOKEN_ENV,
      file: join(homedir(), '.octopus', 'credentials.json')
    },
    output: {
      jsonEnvelope: { success: { ok: true, data: {} }, failure: { ok: false, error: { code: 'ERROR_CODE', message: 'message' } } },
      jsonlEvents: ['warning', 'billing.warning', 'billing.error', 'run.started', 'row', 'log', 'captcha', 'proxy', 'download.started', 'download.succeeded', 'download.failed', 'run.paused', 'run.resumed', 'run.stopping', 'run.stopped', 'run.failed'],
      detachedBootstrap: ['bootstrap.json', 'stdout.log', 'stderr.log'],
      stdout: 'machine data only in --json/--jsonl mode',
      stderr: 'human diagnostics and failures'
    },
    machineContract: {
      stable: true,
      defaultOutput: 'human',
      agentEntrypoint: {
        firstCommand: 'octopus capabilities --json',
        packageFirstCommand: 'npx bazhuayu-cli capabilities --json',
        rule: 'When a user asks an LLM/agent to use bazhuayu-cli or octopus for a scraping task, inspect this capabilities payload first and follow machineContract.recipes instead of asking the user to describe CLI flags.',
        agentInvocationPolicy: {
          shouldUseCliForUserTaskCreationRequests: true,
          preferredRecipe: 'machineContract.recipes.createTaskFromUrlWithAgent',
          doNotFallbackToHandwrittenTaskJson: true,
          doNotAskUserForInternalFlags: true,
          routingRule: 'If the user asks an LLM/agent to create, build, generate, or validate a scraping/collection task from a URL using bazhuayu-cli/octopus, call capabilities --json, then run the preferred recipe. Use manual recognize only when the user explicitly asks to choose elements themselves or when login/verification requires user action.'
        },
        intentAliases: [
          'create scraping task from url',
          'generate collection task',
          'build octopus task',
          '用 bazhuayu-cli 创建采集任务',
          '用八爪鱼 CLI 创建采集任务',
          '让 Agent/LLM 用 octopus 生成任务'
        ],
        acceptedUserRequestExamples: [
          '请用 bazhuayu-cli 给这个网页创建一个采集任务: <url>',
          'Use octopus to create a scraping task for <url>',
          'Create and validate a local task file from this page with bazhuayu-cli: <url>'
        ]
      },
      schemas: {
        capabilities: 'schemas/capabilities-v1.schema.json',
        jsonEnvelope: 'schemas/json-envelope-v1.schema.json',
        runEvent: 'schemas/run-event-v1.schema.json',
        detachedBootstrap: 'schemas/detached-bootstrap-v1.schema.json'
      },
      json: {
        flag: '--json',
        envelope: {
          successRequiredFields: ['ok', 'data'],
          failureRequiredFields: ['ok', 'error.code', 'error.message']
        },
        usageErrorsUseEnvelope: true,
        commonErrorCodes: [
          'AUTH_REQUIRED',
          'AUTH_INVALID',
          'USAGE_ERROR',
          'UNKNOWN_COMMAND',
          'TASK_INVALID',
          'TEMPLATE_BALANCE_NOT_ENOUGH',
          'TEMPLATE_NOT_ALLOWED',
          'PROXY_BALANCE_LOW',
          'CAPTCHA_BALANCE_LOW',
          'CAPTCHA_ACCOUNT_EXPIRED',
          'CAPTCHA_BALANCE_NOT_ENOUGH',
          'CAPTCHA_DAILY_LIMIT_REACHED',
          'CAPTCHA_SERVICE_ERROR',
          'CAPTCHA_SERVICE_FAILED',
          'PROXY_BALANCE_NOT_ENOUGH',
          'PROXY_USER_NOT_ALLOWED',
          'PROXY_LIMIT_REACHED',
          'PROXY_SERVICE_UNAVAILABLE',
          'PROXY_SERVICE_FAILED',
          'CLOUD_BALANCE_NOT_ENOUGH',
          'CLOUD_PROXY_BALANCE_NOT_ENOUGH',
          'CLOUD_FEATURE_UNAVAILABLE',
          'CLOUD_TASK_ALREADY_RUNNING',
          'CLOUD_TASK_NOT_COMPLETED',
          'CLOUD_APP_TASK_LIMIT',
          'CLOUD_SERVER_ERROR',
          'CLOUD_START_FAILED',
          'TEMPLATE_START_LIMIT_REACHED',
          'TEMPLATE_DAILY_LIMIT_REACHED',
          'RUN_FORMAT_UNSUPPORTED',
          'DETACHED_RUN_FAILED',
          'ENGINE_RUN_FAILED',
          'LOCAL_RUN_ALREADY_RUNNING',
          'LOCAL_RUN_CONTROL_FAILED',
          'RUN_CONTROL_FAILED',
          'LOGIN_SESSION_REQUIRED',
          'RECOGNIZE_FAILED',
          'RECOGNIZE_SELECT_REQUIRED',
          'RECOGNIZE_OUTPUT_REQUIRED',
          'RECOGNIZE_CANDIDATE_NOT_FOUND',
          'RECOGNIZE_CANDIDATE_UNSUPPORTED',
          'RUN_NOT_FOUND',
          'LOCAL_LOT_NOT_FOUND',
          'UNSUPPORTED_EXPORT_FORMAT'
        ]
      },
      jsonl: {
        flag: '--jsonl',
        command: 'run <taskId>',
        eventField: 'event',
        stableEvents: ['warning', 'billing.warning', 'billing.error', 'run.started', 'row', 'log', 'captcha', 'proxy', 'download.started', 'download.succeeded', 'download.failed', 'run.paused', 'run.resumed', 'run.stopping', 'run.stopped', 'run.failed'],
        rowLimitFlag: '--max-rows'
      },
      artifacts: {
        localRunDir: ['meta.json', 'control.json', 'events.jsonl', 'logs.jsonl', 'rows.jsonl', 'downloads.jsonl'],
        detachedBootstrapDir: ['bootstrap.json', 'stdout.log', 'stderr.log']
      },
      lifecycle: {
        detachModel: 'child-process',
        daemonRequired: false,
        activeRunIdentity: 'taskId',
        artifactRunIdentity: 'runId',
        accountLocalRunLimit: false,
        localRunResourceWarning: {
          code: 'LOCAL_RUN_RESOURCE_WARNING',
          threshold: 4,
          strongThreshold: 6,
          blocking: false
        },
        maxActiveLocalRunsPerTaskId: 1,
        orphanDetection: true,
        cleanupCommands: ['local cleanup', 'runs cleanup']
      },
      recipes: {
        createTaskFromUrlWithAgent: {
          intent: 'When the user asks an LLM/agent to create a scraping or collection task from a URL with bazhuayu-cli/octopus, use this workflow unless the user explicitly asks for manual selection.',
          summary: 'Use protected SmartProxy recognition to emit deterministic candidates, write an agent plan, preview it, apply it, then validate the task.',
          agentShouldChooseThisRecipeWhen: [
            'The user asks the assistant/agent to create, build, generate, or validate a task from a URL.',
            'The user mentions bazhuayu-cli, octopus, 八爪鱼 CLI, scraping task, collection task, or local task file.',
            'The user provides a URL plus a target goal such as search results, list data, detail pages, titles, prices, articles, or links.'
          ],
          searchWorkflow: {
            trigger: 'If the user asks to search/query/find a keyword on an entry page, pass --query <keyword> or --input <name=value> to recognize before preparing/applying a task.',
            examples: [
              'octopus recognize https://www.baidu.com/ --auto --query 李小龙 --output task.json',
              'octopus recognize https://www.baidu.com/ --prepare-agent --query 李小龙 --json --goal "搜索李小龙并采集结果标题和链接" --output context.json'
            ],
            taskBehavior: 'Generated tasks preserve the recognized search input XPath and submit action before extracting the result page.'
          },
          loginWorkflow: {
            trigger: 'If recognize returns LOGIN_SESSION_REQUIRED or detects a login/captcha/paywall page, ask the user to run manual recognize, complete login in the browser, and save a session.',
            command: 'octopus recognize <url> --manual --query <keyword> --save-session --session-name <name> --output <task.json>',
            note: 'The generated task stores both recognition.session and recognition.search so local runs inject cookies before opening the search entry page.'
          },
          agentResponsibilities: [
            'Do not ask the user to explain --prepare-agent, --preview-agent-plan, or --apply-agent-plan.',
            'Do not ask the user to hand-write JSON. The agent writes plan.json after reading context.json.',
            'Pass the user natural-language task description through --goal so context.goal captures the real intent.',
            'Use context.decisionPolicy and context.screenshot.path as mandatory judging inputs for candidates, layout, sidebars, ads, and pagination.',
            'Use context.resultValidationPolicy after running data: isolated missing fields in ads/topic cards/heterogeneous rows are normal partial data and must not trigger task recreation loops.',
            'If the user intent includes search/query/keyword, extract the keyword and pass it through --query or --input instead of recognizing the blank search homepage.',
            'Use the URL and optional user goal as the task intent, then inspect candidates and sample rows before choosing fields.',
            'Show the user the generated task file path and validation result after applying the plan.'
          ],
          preferredWorkflow: [
            {
              step: 'recognize',
              command: 'octopus recognize <url> --prepare-agent --json --goal <user task description> --output <context.json>',
              output: 'agent context JSON containing recommendedCandidateId, decisionPolicy, resultValidationPolicy, candidates, fields, sampleRows, XPath, diagnostics, pagination, goal, and full-page screenshot metadata. A full-page screenshot is generated by default for agent workflows.'
            },
            {
              step: 'writePlan',
              action: 'Read context.json, choose the primary candidate, select/rename fields, and write plan.json using schema octopus.recognize.agent-plan.v1.',
              guidance: [
                'Follow context.decisionPolicy: use context.goal and context.screenshot.path together with candidate bounding boxes, sampleRows, fields, pagination, and diagnostics; do not rely on text samples alone.',
                'Prefer context.recommendedCandidateId unless diagnostics/sampleRows show it is sidebar, navigation, ads, or wrong for the user goal.',
                'Use existing field names through strings or { "source": "<field>", "as": "<newName>" }; do not invent XPath when an existing field works.',
                'If using details, set selection.detail.mode=list_with_detail, urlField, and detail.fields.',
                'Set selection.pagination to the candidate pagination, null/false to disable pagination, or omit to keep the candidate default.'
              ],
              minimalPlan: {
                schemaVersion: 'octopus.recognize.agent-plan.v1',
                contextFile: '<context.json>',
                selection: {
                  candidateId: '<candidate id>',
                  fields: ['<field name>', { source: '<field name>', as: '<new name>' }],
                  pagination: null
                }
              }
            },
            {
              step: 'preview',
              command: 'octopus recognize --preview-agent-plan <plan.json> --agent-context <context.json> --json',
              requiredAction: 'If ok=false or data.pass=false, revise plan fields before applying unless the user explicitly accepts risk.'
            },
            {
              step: 'apply',
              command: 'octopus recognize --apply-agent-plan <plan.json> --agent-context <context.json> --output <task.json> --json',
              output: 'task JSON file'
            },
            {
              step: 'validate',
              command: 'octopus task validate <taskId> --task-file <task.json> --json',
              postRunJudgment: [
                'After running sample data, follow context.resultValidationPolicy before deciding whether to revise the task.',
                'Do not recreate a task just because one row or a small minority of rows has missing optional fields.',
                'Treat sparse ad/topic/promoted/heterogeneous cards as normal partial data when the main list rows match the user goal.',
                'Automatically recreate at most once, and only for systematic structural failures such as wrong region, wrong search result page, wrong pagination, or core fields missing for most representative rows.'
              ]
            }
          ],
          oneShotWrapper: {
            command: 'octopus recognize <url> --agent --agent-command <cmd> --output <task.json>',
            note: 'Use this only when a trusted agent runner command is available. --agent-command executes a local shell command. The runner receives OCTOPUS_AGENT_CONTEXT and must write OCTOPUS_AGENT_PLAN.'
          },
          nonGoals: [
            'Do not ask the user to hand-write plan.json.',
            'Do not directly write full task JSON unless applying a previewed plan through the CLI.',
            'Do not use --legacy-recognizer unless debugging the old heuristic detector.'
          ]
        }
      }
    },
    exitCodes: {
      0: 'success',
      1: 'operation failed',
      2: 'runtime/environment failure',
      3: 'unsupported task definition'
    },
    commands: [
      { command: 'doctor', risk: 'low', json: true, authRequired: false },
      { command: 'auth login/status/info/logout', risk: 'medium', json: true, authRequired: false },
      { command: 'env prod/online/status', risk: 'medium', json: true, hidden: true, authRequired: false },
      { command: 'task list', risk: 'low', json: true, authRequired: true },
      { command: 'task inspect/validate', risk: 'low', json: true, authRequired: true },
      { command: 'recognize <url>', risk: 'medium', json: true, authRequired: true, agentWorkflow: 'machineContract.recipes.createTaskFromUrlWithAgent' },
      { command: 'run-url <url>', risk: 'medium', json: true, jsonl: true, authRequired: true },
      { command: 'run <taskId>', risk: 'medium', json: true, jsonl: true, authRequired: true },
      { command: 'cloud start/stop <taskId>', risk: 'medium', json: true, authRequired: true },
      { command: 'cloud status/history <taskId>', risk: 'low', json: true, authRequired: true },
      { command: 'local status/history <taskId>', risk: 'low', json: true, authRequired: true },
      { command: 'local cleanup', risk: 'low', json: true, authRequired: true },
      { command: 'local export <taskId>', risk: 'medium', json: true, authRequired: true },
      { command: 'local pause/resume/stop <taskId>', risk: 'medium', json: true, authRequired: true },
      { command: 'data history <taskId>', risk: 'low', json: true, authRequired: true },
      { command: 'data export <taskId>', risk: 'medium', json: true, authRequired: true },
      { command: 'runs list/status/logs/data', risk: 'low', json: true, internal: true, authRequired: true },
      { command: 'runs cleanup', risk: 'low', json: true, internal: true, authRequired: true }
    ],
    dataSources: ['local', 'cloud'],
    exportFormats: ['xlsx', 'csv', 'html', 'json', 'xml'],
    env: {
      apiKey: API_KEY_ENV,
      accessToken: ACCESS_TOKEN_ENV,
      apiBaseUrl: API_BASE_URL_ENV
    }
  };

  if (json) printEnvelope(true, data);
  else console.log(JSON.stringify(data, null, 2));
  return EXIT_OK;
}
