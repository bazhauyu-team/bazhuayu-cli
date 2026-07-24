import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { access, chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { mock, test } from 'node:test';
import { promisify } from 'node:util';
import { authCommand, createWindowsUrlLauncherFile } from '../dist/commands/auth.js';
import { doctorCommand } from '../dist/commands/doctor.js';
import { cloudCommand, cloudHistory } from '../dist/commands/cloud.js';
import { dataCount, dataExport, dataPreview } from '../dist/commands/data.js';
import { scheduleCommand } from '../dist/commands/schedule.js';
import { taskGroupCommand } from '../dist/commands/task-group.js';
import { taskCopy, taskDelete, taskList, taskMove, taskRename } from '../dist/commands/task.js';
import { templateCommand, templateTaskCommand } from '../dist/commands/template.js';
import { ApiRequestError, fetchAccountInfo, fetchUserDefaultTaskGroupId, saveTaskInfo, validateApiKey } from '../dist/runtime/api-client.js';
import { DEFAULT_OAUTH_REDIRECT_URI, exchangeCodeForToken, runOAuthLogin } from '../dist/runtime/oauth.js';
import { injectGlobalCookie, localDataExportCommand, runTask, setEngineHostFactoryForTesting } from '../dist/commands/run.js';
import { EngineHost } from '../dist/runtime/engine-host.js';
import { BillingRuntimeError } from '../dist/runtime/run-services.js';
import { formatTaskListLine } from '../dist/commands/task.js';
import { TaskDefinitionProvider } from '../dist/runtime/task-definition-provider.js';

const execFileAsync = promisify(execFile);
const cli = resolve('dist/index.js');

async function runCli(args, options = {}) {
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: options.home ?? await mkdtemp(join(tmpdir(), 'octopus-home-')),
        ...(options.apiKey ? { OCTOPUS_API_KEY: options.apiKey } : {}),
        ...(options.apiBaseUrl ? { OCTOPUS_API_BASE_URL: options.apiBaseUrl } : {})
      },
      timeout: options.timeout ?? 20_000
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? ''
    };
  }
}

async function runCliWithStdin(args, input, options = {}) {
  return await new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: options.home ?? '',
        ...(options.apiBaseUrl ? { OCTOPUS_API_BASE_URL: options.apiBaseUrl } : {})
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolveResult({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function parseJson(stdout) {
  return JSON.parse(stdout);
}

function assertJsonEnvelope(result) {
  assert.doesNotThrow(() => parseJson(result.stdout), result.stdout || result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
}

function formatCliResult(result, args = []) {
  const command = args.length ? ` args=${args.join(' ')}` : '';
  return `${command} code=${result.code} stdout=${result.stdout} stderr=${result.stderr}`;
}

function assertJsonFailure(result, code, exitCode = 1, args = []) {
  assert.equal(result.code, exitCode, formatCliResult(result, args));
  assertJsonEnvelope(result);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, code);
  return payload;
}

function assertJsonSuccess(result, args = []) {
  assert.equal(result.code, 0, formatCliResult(result, args));
  assertJsonEnvelope(result);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  return payload;
}

async function fakeHealthyChrome() {
  const root = await mkdtemp(join(tmpdir(), 'octo-fake-chrome-'));
  const fakeChrome = join(root, 'fake-chrome');
  await writeFile(fakeChrome, "#!/bin/sh\nsleep 10\n");
  await chmod(fakeChrome, 0o755);
  return fakeChrome;
}

function assertDetectHelpPrefersAgentWorkflow(stdout) {
  const prepareMatch = stdout.match(/octopus detect (?:URL|<url>) --prepare-agent/);
  const autoMatch = stdout.match(/octopus detect (?:URL|<url>) --auto/);
  const prepareIndex = prepareMatch?.index ?? -1;
  const autoIndex = autoMatch?.index ?? -1;
  assert.ok(prepareIndex >= 0, stdout);
  assert.ok(autoIndex >= 0, stdout);
  assert.ok(prepareIndex < autoIndex, stdout);
  assert.match(stdout, /Do not treat --auto examples as the default\s+LLM\/agent workflow/);
}

test('run supports apiList task files with page pagination', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octopus-api-list-run-'));
  const taskFile = join(dir, 'api-task.json');
  const output = join(dir, 'runs');
  const lines = [];
  const originalFetch = globalThis.fetch;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  await writeFile(taskFile, JSON.stringify({
    taskId: 'api-list-test',
    taskName: 'API list test',
    xml: '',
    xoml: '',
    fieldNames: ['id', 'title', 'url', 'price'],
    apiList: {
      kind: 'api_list',
      request: {
        url: 'https://example.invalid/search',
        query: { pageSize: 2 }
      },
      pagination: {
        type: 'page',
        param: 'page',
        start: 0,
        step: 1,
        pageSizeParam: 'pageSize',
        pageSize: 2
      },
      itemsPath: '$.items',
      fields: [
        { name: 'id', path: '$.id', type: 'number' },
        { name: 'title', path: '$.title' },
        { name: 'url', path: '$.link', type: 'url', valuePrefix: 'https://example.com' },
        { name: 'price', path: '$.price', type: 'number' }
      ]
    }
  }, null, 2));

  try {
    globalThis.fetch = mock.fn(async (url) => {
      const parsed = new URL(String(url));
      const page = Number(parsed.searchParams.get('page') || 0);
      const pageSize = Number(parsed.searchParams.get('pageSize') || 2);
      const start = page * pageSize;
      const items = Array.from({ length: pageSize }, (_value, index) => {
        const id = start + index + 1;
        return { id, title: `Item ${id}`, link: `/items/${id}`, price: id * 10 };
      });
      return new Response(JSON.stringify({ items }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    });
    process.stdout.write = ((chunk) => {
      lines.push(String(chunk).trimEnd());
      return true;
    });
    process.stderr.write = ((chunk) => {
      lines.push(String(chunk).trimEnd());
      return true;
    });
    const code = await runTask('api-list-test', [
      '--task-file',
      taskFile,
      '--output',
      output,
      '--max-rows',
      '5',
      '--json'
    ]);
    assert.equal(code, 0);
    const payload = JSON.parse(lines.find((line) => line.startsWith('{')) ?? '{}');
    assert.equal(payload.ok, true);
    assert.equal(payload.data.total, 5);
    assert.equal(payload.data.stopReason, 'max_rows');
    const rows = (await readFile(join(payload.data.outputDir, 'rows.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.id), [1, 2, 3, 4, 5]);
    assert.equal(rows[0].url, 'https://example.com/items/1');
    const jsonRows = JSON.parse(await readFile(join(payload.data.outputDir, 'rows.json'), 'utf8'));
    assert.equal(jsonRows.length, 5);
    const csv = await readFile(join(payload.data.outputDir, 'rows.csv'), 'utf8');
    assert.match(csv, /^id,title,url,price\n/);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});

test('run sends JSON body and content type for POST apiList task files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octopus-api-list-post-run-'));
  const taskFile = join(dir, 'api-task.json');
  const output = join(dir, 'runs');
  const calls = [];
  const lines = [];
  const originalFetch = globalThis.fetch;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  await writeFile(taskFile, JSON.stringify({
    taskId: 'api-list-post-test',
    taskName: 'API list POST test',
    xml: '',
    xoml: '',
    fieldNames: ['name'],
    apiList: {
      kind: 'api_list',
      request: {
        url: 'https://example.invalid/search',
        method: 'POST',
        body: { q: 'makeup' }
      },
      itemsPath: '$.items',
      fields: [{ name: 'name', path: '$.name' }]
    }
  }, null, 2));

  try {
    globalThis.fetch = mock.fn(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ items: [{ name: 'Lipstick' }] }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    });
    process.stdout.write = ((chunk) => {
      lines.push(String(chunk).trimEnd());
      return true;
    });
    process.stderr.write = ((chunk) => {
      lines.push(String(chunk).trimEnd());
      return true;
    });
    const code = await runTask('api-list-post-test', [
      '--task-file',
      taskFile,
      '--output',
      output,
      '--max-rows',
      '1',
      '--json'
    ]);
    assert.equal(code, 0);
    const apiCall = calls.find((call) => call.url.startsWith('https://example.invalid/search'));
    assert.ok(apiCall);
    assert.equal(apiCall.init.method, 'POST');
    assert.equal(apiCall.init.headers['Content-Type'], 'application/json');
    assert.equal(apiCall.init.body, JSON.stringify({ q: 'makeup' }));
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});

test('run fetches non-paginated apiList task files only once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'octopus-api-list-single-run-'));
  const taskFile = join(dir, 'api-task.json');
  const output = join(dir, 'runs');
  const calls = [];
  const lines = [];
  const originalFetch = globalThis.fetch;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  await writeFile(taskFile, JSON.stringify({
    taskId: 'api-list-single-test',
    taskName: 'API list single test',
    xml: '',
    xoml: '',
    fieldNames: ['name'],
    apiList: {
      kind: 'api_list',
      request: { url: 'https://example.invalid/items' },
      itemsPath: '$.items',
      fields: [{ name: 'name', path: '$.name' }]
    }
  }, null, 2));

  try {
    globalThis.fetch = mock.fn(async (url) => {
      if (String(url).startsWith('https://example.invalid/items')) calls.push(String(url));
      return new Response(JSON.stringify({ items: [{ name: 'A' }, { name: 'B' }] }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    });
    process.stdout.write = ((chunk) => {
      lines.push(String(chunk).trimEnd());
      return true;
    });
    process.stderr.write = ((chunk) => {
      lines.push(String(chunk).trimEnd());
      return true;
    });
    const code = await runTask('api-list-single-test', [
      '--task-file',
      taskFile,
      '--output',
      output,
      '--json'
    ]);
    assert.equal(code, 0);
    assert.equal(calls.length, 1);
    const payload = JSON.parse(lines.find((line) => line.startsWith('{')) ?? '{}');
    assert.equal(payload.data.total, 2);
  } finally {
    globalThis.fetch = originalFetch;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
});

test('functional commands require API key even for local task files', async () => {
  const result = await runCli([
    'task',
    'validate',
    'minimal',
    '--task-file',
    'examples/minimal-task.json',
    '--json'
  ]);
  assert.equal(result.code, 1);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'AUTH_REQUIRED');
  assert.match(payload.error.message, /bazhuayu\.com\/console\/account-center\/api-keys/);
  assert.match(payload.error.message, /octopus auth login/);
});

test('capabilities is available before authentication and documents API key contract', async () => {
  const result = await runCli(['capabilities', '--json']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.authentication.requiredForUse, true);
  assert.equal(payload.data.authentication.loginVerifiesKeyBeforeSaving, true);
  assert.equal(payload.data.authentication.env, 'OCTOPUS_API_KEY');
  assert.ok(payload.data.authentication.diagnosticCommandsWithoutAuth.includes('capabilities'));
  assert.equal(payload.data.packageName, 'bazhuayu-cli');
  assert.equal(payload.data.primaryBinary, 'octopus');
  assert.equal(payload.data.machineContract.agentEntrypoint.firstCommand, 'octopus capabilities --json');
  assert.match(payload.data.machineContract.agentEntrypoint.rule, /bazhuayu-cli/);
  assert.equal(payload.data.machineContract.agentEntrypoint.agentInvocationPolicy.shouldUseCliForUserTaskCreationRequests, true);
  assert.equal(payload.data.machineContract.agentEntrypoint.agentInvocationPolicy.preferredRecipe, 'machineContract.recipes.createTaskFromUrlWithAgent');
  assert.equal(payload.data.machineContract.agentEntrypoint.agentInvocationPolicy.defaultTaskCreationModeForAgents, 'inline-agent-plan-preview-apply');
  assert.equal(payload.data.machineContract.agentEntrypoint.agentInvocationPolicy.fastestTaskCreationModeForAgents, 'detect-agent-run-sample');
  assert.equal(payload.data.machineContract.agentEntrypoint.agentInvocationPolicy.doNotUseAutoForAgentTaskCreationRequests, true);
  assert.equal(payload.data.machineContract.agentEntrypoint.agentInvocationPolicy.doNotFallbackToHandwrittenTaskJson, true);
  assert.match(payload.data.machineContract.agentEntrypoint.agentInvocationPolicy.routingRule, /Do not use detect --auto as the default agent path/);
  assert.match(payload.data.machineContract.agentEntrypoint.agentInvocationPolicy.routingRule, /browserRuntime\.modes\.user\.setupRecipe/);
  const browserSetup = payload.data.browserRuntime.modes.user.setupRecipe;
  assert.equal(browserSetup.steps[0].step, 'inspect');
  assert.equal(browserSetup.steps.at(-1).step, 'persist');
  assert.ok(browserSetup.steps.some((step) => step.requiresHuman));
  assert.match(browserSetup.switchBackCommand, /browser use independent/);
  assert.ok(payload.data.machineContract.agentEntrypoint.intentAliases.some((item) => /采集任务/.test(item)));
  assert.ok(payload.data.commands.find((item) => item.command === 'run <taskId>')?.authRequired);
  assert.ok(payload.data.commands.find((item) => item.command === 'task rename/move/delete <taskId>')?.requiresConfirmation);
  assert.ok(payload.data.commands.find((item) => item.command === 'task-group update/delete/set-default')?.requiresConfirmation);
  assert.equal(payload.data.commands.some((item) => item.command.includes('task-url')), false);
  assert.ok(payload.data.commands.find((item) => item.command === 'template search/view/version')?.authRequired);
  assert.ok(payload.data.commands.find((item) => item.command === 'template-task update <taskId>')?.requiresConfirmation);
  assert.ok(payload.data.commands.find((item) => item.command === 'schedule cloud update/start/stop <taskId>')?.requiresConfirmation);
  assert.equal(payload.data.commands.some((item) => item.command.includes('schedule local')), false);
  assert.equal(payload.data.commands.some((item) => item.command.includes('user-config')), false);
  assert.equal(payload.data.commands.some((item) => item.command.includes('acquisition-settings')), false);
  assert.ok(payload.data.commands.find((item) => item.command === 'data count/preview <taskId>')?.authRequired);
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('CONFIRMATION_REQUIRED'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('TEMPLATE_TASK_CREATE_FAILED'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('TEMPLATE_PARAM_UNKNOWN'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('TEMPLATE_PARAMS_REQUIRED'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('TEMPLATE_PARAMS_UNSUPPORTED'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('SCHEDULE_CLOUD_UPDATE_FAILED'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('UNSUPPORTED_OPERATION'));
  assert.equal(payload.data.machineContract.json.commonErrorCodes.includes('USER_CONFIG_SET_FAILED'), false);
  assert.equal(payload.data.commands.some((item) => item.command.includes('run-url')), false);
  assert.equal(payload.data.browserRuntime.linuxArm64.affectedCommands.includes('run-url'), false);
  assert.equal(payload.data.machineContract.stable, true);
  assert.equal(payload.data.machineContract.json.usageErrorsUseEnvelope, true);
  assert.equal(payload.data.commands.find((item) => item.command === 'detect <url>')?.agentWorkflow, 'machineContract.recipes.createTaskFromUrlWithAgent');
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.intent, /LLM\/agent/);
  assert.ok(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.agentShouldChooseThisRecipeWhen.some((item) => /URL/.test(item)));
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.agentResponsibilities.join(' '), /--goal/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.agentResponsibilities.join(' '), /screenshot/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.agentResponsibilities.join(' '), /visualReview/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.agentResponsibilities.join(' '), /decisionSummary/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.agentResponsibilities.join(' '), /visualArtifacts/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.agentResponsibilities.join(' '), /decisionPolicy/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.agentResponsibilities.join(' '), /resultValidationPolicy/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.agentResponsibilities.join(' '), /--run-sample/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.agentResponsibilities.join(' '), /Do not use detect --auto/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.agentResponsibilities[0], /Do not ask the user/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.quickWorkflow.command, /--agent/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.quickWorkflow.command, /--run-sample 5/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.quickWorkflow.output, /sampleRun/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.quickWorkflow.notes.join(' '), /sampleRun\.summary/);
  assert.doesNotMatch(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.searchWorkflow.examples.join('\n'), /--auto/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[0].command, /--prepare-agent/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[0].command, /--goal/);
  assert.doesNotMatch(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[0].command, /--screenshot/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[0].output, /decisionSummary/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[0].output, /annotated screenshots/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[0].output, /candidate crops/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[0].output, /resultValidationPolicy/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[1].guidance.join(' '), /decisionSummary/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[1].guidance.join(' '), /decisionPolicy/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[1].guidance.join(' '), /visualReview/);
  assert.equal(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[1].minimalPlan.visualReview.reviewed, true);
  assert.equal(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[1].minimalPlan.visualReview.checks.mainRegionVerified, true);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[4].postRunJudgment.join(' '), /small minority/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[4].postRunJudgment.join(' '), /Automatically recreate at most once/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[2].command, /--preview-agent-plan/);
  assert.match(payload.data.machineContract.recipes.createTaskFromUrlWithAgent.preferredWorkflow[3].command, /--apply-agent-plan/);
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('AUTH_REQUIRED'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('AUTH_INVALID'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('CAPTCHA_BALANCE_NOT_ENOUGH'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('CLOUD_BALANCE_NOT_ENOUGH'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('CLOUD_PROXY_BALANCE_NOT_ENOUGH'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('DETECT_INPUT_REQUIRED'));
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('DETECT_NO_EXTRACTABLE_DATA'));
  assert.equal(payload.data.machineContract.json.commonErrorCodes.includes('LOCAL_RUN_LIMIT_EXCEEDED'), false);
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('warning'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('billing.warning'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('billing.error'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('captcha'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('proxy'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('run.failed'));
  assert.ok(payload.data.machineContract.jsonl.stableEvents.includes('run.stopped'));
  assert.equal(payload.data.machineContract.lifecycle.daemonRequired, false);
  assert.equal(payload.data.machineContract.lifecycle.accountLocalRunLimit, false);
  assert.equal(payload.data.machineContract.lifecycle.localRunResourceWarning.code, 'LOCAL_RUN_RESOURCE_WARNING');
  assert.equal(payload.data.machineContract.lifecycle.localRunResourceWarning.blocking, false);
  assert.ok(payload.data.machineContract.lifecycle.cleanupCommands.includes('local cleanup'));
  const schemas = payload.data.machineContract.schemas;
  assert.deepEqual(Object.keys(schemas).sort(), [
    'capabilities',
    'detachedBootstrap',
    'detectAgentPlan',
    'jsonEnvelope',
    'runEvent'
  ]);
  for (const schemaPath of Object.values(schemas)) {
    const schema = JSON.parse(await readFile(resolve(schemaPath), 'utf8'));
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.$id, /^https:\/\/octopus\.local\/schemas\//);
  }
});

test('auth login verifies API key before saving', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octo-auth-invalid-'));
  const result = await runCliWithStdin(
    ['auth', 'login', '--stdin', '--json', '--api-base-url', 'http://127.0.0.1:9'],
    'bad-key\n',
    { home }
  );
  assertJsonFailure(result, 'AUTH_LOGIN_FAILED');
  await assert.rejects(access(join(home, '.octopus', 'credentials.json')));
});

test('auth status fails when no API key is configured', async () => {
  const result = await runCli(['auth', 'status', '--json']);
  const payload = assertJsonFailure(result, 'AUTH_REQUIRED');
  assert.match(payload.error.message, /octopus auth login/);
});

test('auth status fails when configured API key is invalid', async () => {
  const result = await runCli(['auth', 'status', '--json'], {
    apiKey: 'bad-key',
    apiBaseUrl: 'http://127.0.0.1:9'
  });
  assertJsonFailure(result, 'AUTH_STATUS_FAILED');
});

test('auth status verifies configured API key before reporting success', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalBaseUrl = process.env.OCTOPUS_API_BASE_URL;
  const originalLog = console.log;
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'test-key';
  process.env.OCTOPUS_API_BASE_URL = 'https://example.invalid';
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://example.invalid/api/account/getAccount');
    assert.equal(init?.headers['x-api-key'], 'test-key');
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_status',
        email: 'status@example.com',
        currentAccountLevel: 120,
        accountBalance: 88.5
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const code = await authCommand('status', ['--json']);
    assert.equal(code, 0);
    assert.equal(lines.length, 1);
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.authenticated, true);
    assert.equal(payload.data.source, 'env');
    assert.equal(payload.data.verified, true);
    assert.equal(payload.data.apiBaseUrl, 'https://example.invalid');
    assert.equal(payload.data.currentAccountLevel, 120);
    assert.equal(payload.data.currentAccountLevelName, '团队版');
    assert.equal(payload.data.accountBalance, 88.5);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.OCTOPUS_API_BASE_URL;
    else process.env.OCTOPUS_API_BASE_URL = originalBaseUrl;
  }
});

test('auth status verifies configured OAuth access token before reporting success', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalAccessToken = process.env.OCTOPUS_ACCESS_TOKEN;
  const originalBaseUrl = process.env.OCTOPUS_API_BASE_URL;
  const originalLog = console.log;
  const lines = [];
  process.env.OCTOPUS_ACCESS_TOKEN = 'access-token-123';
  delete process.env.OCTOPUS_API_KEY;
  process.env.OCTOPUS_API_BASE_URL = 'https://example.invalid';
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://example.invalid/api/account/getAccount');
    assert.equal(init?.headers.Authorization, 'Bearer access-token-123');
    assert.equal(init?.headers['x-api-key'], undefined);
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_oauth',
        email: 'oauth@example.com',
        currentAccountLevel: 130,
        accountBalance: 12
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const code = await authCommand('status', ['--json']);
    assert.equal(code, 0);
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.authenticated, true);
    assert.equal(payload.data.source, 'env');
    assert.equal(payload.data.method, 'oauth');
    assert.equal(payload.data.verified, true);
    assert.equal(payload.data.currentAccountLevel, 130);
    assert.equal(payload.data.currentAccountLevelName, '企业版');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
    if (originalAccessToken === undefined) delete process.env.OCTOPUS_ACCESS_TOKEN;
    else process.env.OCTOPUS_ACCESS_TOKEN = originalAccessToken;
    if (originalBaseUrl === undefined) delete process.env.OCTOPUS_API_BASE_URL;
    else process.env.OCTOPUS_API_BASE_URL = originalBaseUrl;
  }
});

test('auth login accepts API key as a positional argument', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octo-auth-arg-'));
  const originalHome = process.env.HOME;
  const seen = [];
  const lines = [];
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  process.env.HOME = home;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_arg',
        email: 'arg@example.com',
        currentAccountLevel: 120,
        accountBalance: 12.3
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };
  try {
    const code = await authCommand('login', [
      'arg-key-123',
      '--json',
      '--api-base-url',
      'https://example.invalid'
    ]);
    assert.equal(code, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://example.invalid/api/account/getAccount');
    assert.equal(seen[0].headers['x-api-key'], 'arg-key-123');
    const payload = JSON.parse(lines[0]);
    assert.equal(payload.data.currentAccountLevel, 120);
    assert.equal(payload.data.currentAccountLevelName, '团队版');
    assert.equal(payload.data.accountBalance, 12.3);
    const credentials = JSON.parse(await readFile(join(home, '.octopus', 'credentials.json'), 'utf8'));
    assert.equal(credentials.apiKey, 'arg-key-123');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('auth login prints readable account plan in text output', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octo-auth-plan-'));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const lines = [];
  process.env.HOME = home;
  globalThis.fetch = async () => new Response(JSON.stringify({
    isSuccess: true,
    data: {
      userId: 'u_plan',
      email: 'plan@example.com',
      currentAccountLevel: 120,
      accountBalance: 66
    }
  }), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' }
  });
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const code = await authCommand('login', [
      'plan-key-123',
      '--api-base-url',
      'https://example.invalid'
    ]);
    assert.equal(code, 0);
    assert.match(lines.join('\n'), /Account plan: 团队版/);
    assert.match(lines.join('\n'), /Account balance: 66/);
    assert.doesNotMatch(lines.join('\n'), /Account plan: 团队版 \(120\)/);
    assert.doesNotMatch(lines.join('\n'), /Current account level: 120/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('auth login falls back to user balances endpoint when account has no balance field', async () => {
  const home = await mkdtemp(join(tmpdir(), 'octo-auth-balance-'));
  const originalHome = process.env.HOME;
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.HOME = home;
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname);
    if (parsed.pathname === '/api/account/getAccount') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          userId: 'u_balance',
          email: 'balance@example.com',
          currentAccountLevel: 120
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/user/balances') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          balance: 7.5,
          totalBalance: 18.75
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const code = await authCommand('login', [
      'balance-key-123',
      '--api-base-url',
      'https://example.invalid'
    ]);
    assert.equal(code, 0);
    assert.deepEqual(seen, ['/api/account/getAccount', '/api/user/balances']);
    assert.match(lines.join('\n'), /Account balance: 18\.75/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('auth info shows current account details', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalBaseUrl = process.env.OCTOPUS_API_BASE_URL;
  const originalLog = console.log;
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'info-key';
  process.env.OCTOPUS_API_BASE_URL = 'https://example.invalid';
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'https://example.invalid/api/account/getAccount');
    assert.equal(init?.headers['x-api-key'], 'info-key');
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_info',
        email: 'info@example.com',
        userName: 'Info User',
        currentAccountLevel: 120,
        accountBalance: 99.9,
        effectiveDate: '2026-12-31T00:00:00Z'
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => {
    lines.push(args.map((value) => String(value)).join(' '));
  };

  try {
    const code = await authCommand('info', []);
    assert.equal(code, 0);
    const output = lines.join('\n');
    assert.match(output, /User name: Info User/);
    assert.match(output, /Email: info@example\.com/);
    assert.match(output, /Account plan: 团队版/);
    assert.match(output, /Account balance: 99\.9/);
    assert.doesNotMatch(output, /团队版 \(120\)/);
    assert.doesNotMatch(output, /Verified:/);
    assert.doesNotMatch(output, /API: https:\/\/example\.invalid/);
    assert.doesNotMatch(output, /Credentials:/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
    if (originalBaseUrl === undefined) delete process.env.OCTOPUS_API_BASE_URL;
    else process.env.OCTOPUS_API_BASE_URL = originalBaseUrl;
  }
});

test('invalid API key maps to friendly auth error', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: 'unauthorized',
    error_Description: 'An error occurred during API Key verification.'
  }), {
    status: 401,
    statusText: 'Unauthorized',
    headers: { 'content-type': 'application/json' }
  });
  try {
    await assert.rejects(
      validateApiKey({ apiKey: 'bad-key', baseUrl: 'https://example.invalid' }),
      (error) => {
        assert.equal(error instanceof ApiRequestError, true);
        assert.equal(error.code, 'AUTH_INVALID');
        assert.equal(error.status, 401);
        assert.match(error.message, /Authentication is invalid/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('account info uses electron getAccount endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_1',
        email: 'user@example.com',
        userName: 'Example User',
        type: 2,
        currentAccountLevel: 2,
        effectiveDate: '2026-12-31T00:00:00Z'
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const result = await fetchAccountInfo({ apiKey: 'test-key', baseUrl: 'https://example.invalid' });
    assert.equal(result.endpoint, '/api/account/getAccount');
    assert.equal(result.data.userId, 'u_1');
    assert.equal(result.data.email, 'user@example.com');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://example.invalid/api/account/getAccount');
    assert.equal(seen[0].headers['x-api-key'], 'test-key');
    assert.equal(seen[0].headers['x-client-id'], 'cli');
    assert.match(seen[0].headers['x-client-version'], /^\d+\.\d+\.\d+/);
    assert.equal(seen[0].headers['x-client'], undefined);
    assert.equal(seen[0].headers['x-client-verison'], undefined);

    const validation = await validateApiKey({ apiKey: 'test-key', baseUrl: 'https://example.invalid' });
    assert.equal(validation.endpoint, '/api/account/getAccount');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('account info accepts OAuth bearer credential', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        userId: 'u_bearer',
        email: 'bearer@example.com'
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  try {
    const result = await fetchAccountInfo({
      auth: { type: 'bearer', value: 'oauth-token' },
      baseUrl: 'https://example.invalid'
    });
    assert.equal(result.data.userId, 'u_bearer');
    assert.equal(seen[0].headers.Authorization, 'Bearer oauth-token');
    assert.equal(seen[0].headers['x-api-key'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('saveTaskInfo posts generated tasks with API key authentication', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: 1,
      taskCount: 12,
      taskCountLimit: 100
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const result = await saveTaskInfo({
      auth: { type: 'apiKey', value: 'save-key' },
      baseUrl: 'https://example.invalid',
      taskInfo: {
        taskId: 'detected_save',
        taskName: 'Detected Save',
        xoml: 'compressed'
      }
    });
    assert.equal(result.status, 1);
    assert.equal(result.taskCount, 12);
    assert.equal(result.taskCountLimit, 100);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://example.invalid/api/task/saveTaskInfo');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.headers['x-api-key'], 'save-key');
    assert.equal(seen[0].init.headers.Authorization, undefined);
    assert.equal(JSON.parse(seen[0].init.body).taskId, 'detected_save');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchUserDefaultTaskGroupId reads the client default group endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: 23
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const result = await fetchUserDefaultTaskGroupId({
      auth: { type: 'apiKey', value: 'group-key' },
      baseUrl: 'https://example.invalid'
    });
    assert.equal(result, 23);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://example.invalid/api/TaskGroup/Default');
    assert.equal(seen[0].init.method, 'GET');
    assert.equal(seen[0].init.headers['x-api-key'], 'group-key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('task-group create uses the domestic TaskGroup API and json envelope', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'group-key';
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: 88
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    const code = await taskGroupCommand('create', ['运营组', '--api-base-url', 'https://example.invalid', '--json']);
    assert.equal(code, 0);
    const payload = parseJson(lines[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.name, '运营组');
    assert.equal(payload.data.data, 88);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://example.invalid/api/TaskGroup');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].init.headers['x-api-key'], 'group-key');
    assert.deepEqual(JSON.parse(seen[0].init.body), {
      taskGroupId: '',
      taskGroupName: '运营组'
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('task list forwards template filters to the domestic search API', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'task-list-key';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    seen.push({ url: String(url), init, search: parsed.searchParams });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: {
        total: 1,
        currentTotal: 1,
        dataList: [{ taskId: 'task-1', taskName: 'Template Task' }]
      }
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    const code = await taskList([
      '--template-id',
      'template-registration-1',
      '--template-version-id',
      'template-version-2',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]);
    assert.equal(code, 0);
    const payload = parseJson(lines[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.tasks[0].taskId, 'task-1');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url.startsWith('https://example.invalid/api/task/searchTaskListV3?'), true);
    assert.equal(seen[0].search.get('templateId'), 'template-registration-1');
    assert.equal(seen[0].search.get('templateVersionId'), 'template-version-2');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('task-group list and mutations use domestic task group APIs', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'group-key';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    seen.push({ url: String(url), init, path: parsed.pathname, search: parsed.searchParams });
    if (parsed.pathname === '/api/taskGroup/getTaskGroupList') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: [{ taskGroupId: 7, taskGroupName: '默认组', isDefault: true }]
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: true, data: true }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    assert.equal(await taskGroupCommand('list', ['--api-base-url', 'https://example.invalid', '--json']), 0);
    assert.equal(await taskGroupCommand('update', ['7', '--name', '新组', '--yes', '--api-base-url', 'https://example.invalid', '--json']), 0);
    assert.equal(await taskGroupCommand('delete', ['7', '--yes', '--api-base-url', 'https://example.invalid', '--json']), 0);
    assert.equal(await taskGroupCommand('set-default', ['7', '--yes', '--api-base-url', 'https://example.invalid', '--json']), 0);

    assert.equal(parseJson(lines[0]).data.data[0].taskGroupId, 7);
    assert.equal(seen[0].path, '/api/taskGroup/getTaskGroupList');
    assert.equal(seen[0].init.method, 'GET');
    assert.equal(seen[1].path, '/api/taskGroup');
    assert.equal(seen[1].init.method, 'PUT');
    assert.deepEqual(JSON.parse(seen[1].init.body), {
      taskGroupId: '7',
      taskGroupName: '新组'
    });
    assert.equal(seen[2].path, '/api/taskGroup');
    assert.equal(seen[2].init.method, 'DELETE');
    assert.equal(seen[2].search.get('taskGroupId'), '7');
    assert.equal(seen[3].path, '/api/TaskGroup/Default');
    assert.equal(seen[3].init.method, 'PUT');
    assert.equal(seen[3].search.get('groupId'), '7');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('dangerous task-group and task commands require explicit confirmation', async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    assert.equal(await taskGroupCommand('delete', ['23', '--json']), 1);
    assert.equal(await taskDelete(['task-1', '--json']), 1);
    const payloads = lines.map((line) => parseJson(line));
    assert.equal(payloads[0].ok, false);
    assert.equal(payloads[0].error.code, 'CONFIRMATION_REQUIRED');
    assert.match(payloads[0].error.message, /--yes/);
    assert.equal(payloads[1].ok, false);
    assert.equal(payloads[1].error.code, 'CONFIRMATION_REQUIRED');
  } finally {
    console.log = originalLog;
  }
});

test('task copy, move, and delete use domestic task management APIs', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'task-key';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    seen.push({ url: String(url), init, path: parsed.pathname, search: parsed.searchParams });
    return new Response(JSON.stringify({ isSuccess: true, data: true }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    assert.equal(await taskCopy(['task-1', '--task-group', '8', '--api-base-url', 'https://example.invalid', '--json']), 0);
    assert.equal(await taskMove(['task-1', '--task-group', '8', '--yes', '--api-base-url', 'https://example.invalid', '--json']), 0);
    assert.equal(await taskDelete(['task-1', '--yes', '--api-base-url', 'https://example.invalid', '--json']), 0);

    assert.equal(lines.map((line) => parseJson(line).ok).every(Boolean), true);
    assert.equal(seen[0].path, '/api/task/copyTask');
    assert.equal(seen[0].init.method, 'POST');
    assert.equal(seen[0].search.get('taskId'), 'task-1');
    assert.equal(seen[0].search.get('groupId'), '8');
    assert.equal(seen[0].search.get('returnId'), 'true');
    assert.equal(seen[1].path, '/api/task/updateTaskGroup');
    assert.equal(seen[1].init.method, 'POST');
    assert.equal(seen[1].search.get('taskId'), 'task-1');
    assert.equal(seen[1].search.get('groupId'), '8');
    assert.equal(seen[2].path, '/api/task/deleteTask');
    assert.equal(seen[2].init.method, 'POST');
    assert.equal(seen[2].search.get('taskId'), 'task-1');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('template catalog commands use domestic simpletemplate APIs', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'template-key';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    seen.push({ url: String(url), init, path: parsed.pathname, search: parsed.searchParams });
    if (parsed.pathname === '/api/simpletemplate/templateRegistration/templates') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          total: 1,
          currentTotal: 1,
          items: [{ id: 101, name: '电商模板', status: 1 }]
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/simpletemplate/templateRegistration/101/currentTemplate') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          templateRegistrationId: 101,
          id: 202,
          name: '电商模板',
          version: 3,
          currentTemplateVersion: 3,
          status: 1,
          userInputParameters: JSON.stringify({
            UIParameters: [
              { Id: 'q', name: 'keyword', label: '关键词', Value: '', required: true },
              { Id: 'city', name: 'city', label: '城市', Value: '上海' }
            ]
          })
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    assert.equal(await templateCommand('search', ['电商', '--page-size', '5', '--api-base-url', 'https://example.invalid', '--json']), 0);
    assert.equal(await templateCommand('view', ['101', '--api-base-url', 'https://example.invalid', '--json']), 0);
    assert.equal(await templateCommand('version', ['101', '--api-base-url', 'https://example.invalid', '--json']), 0);
    const searchPayload = parseJson(lines[0]);
    const viewPayload = parseJson(lines[1]);
    const versionPayload = parseJson(lines[2]);
    assert.equal(searchPayload.ok, true);
    assert.equal(searchPayload.data.templates[0].id, 101);
    assert.equal(viewPayload.data.data.name, '电商模板');
    assert.equal(viewPayload.data.templateRegistrationId, 101);
    assert.equal(viewPayload.data.parameterSource, 'UIParameters');
    assert.deepEqual(viewPayload.data.parameters.map((item) => item.name), ['keyword', 'city']);
    assert.equal(viewPayload.data.parameters[0].required, true);
    assert.equal(viewPayload.data.parameterExample.city, '上海');
    assert.match(viewPayload.data.createExamples.simple, /template-task create 101 --param keyword=value --json/);
    assert.equal(versionPayload.data.templateVersionId, 202);
    assert.equal(versionPayload.data.currentTemplateVersion, 3);
    assert.equal(seen[0].path, '/api/simpletemplate/templateRegistration/templates');
    assert.equal(seen[0].search.get('keyword'), '电商');
    assert.equal(seen[0].search.get('pageSize'), '5');
    assert.equal(seen[1].path, '/api/simpletemplate/templateRegistration/101/currentTemplate');
    assert.equal(seen[2].path, '/api/simpletemplate/templateRegistration/101/currentTemplate');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('template-task create builds domestic TemplateConfig request body', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'template-key';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    seen.push({ url: String(url), init, path: parsed.pathname });
    if (parsed.pathname === '/api/simpletemplate/templateRegistration/101/currentTemplate') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          templateRegistrationId: 101,
          id: 202,
          name: '电商模板',
          type: 1,
          currentTemplateVersion: 3
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/TaskGroup/Default') {
      return new Response(JSON.stringify({ isSuccess: true, data: 9 }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/tasks/templateMapping') {
      return new Response(JSON.stringify({ isSuccess: true, data: { taskId: 'task-template-1' } }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    const code = await templateTaskCommand('create', [
      '101',
      '--name',
      '新模板任务',
      '--params',
      '{"UIParameters":[{"Id":"q","Value":"phone"}]}',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]);
    assert.equal(code, 0);
    const payload = parseJson(lines[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.data.taskId, 'task-template-1');
    assert.equal(seen[0].path, '/api/simpletemplate/templateRegistration/101/currentTemplate');
    assert.equal(seen[1].path, '/api/TaskGroup/Default');
    assert.equal(seen[2].path, '/api/tasks/templateMapping');
    const body = JSON.parse(seen[2].init.body);
    assert.deepEqual(body, {
      taskGroupId: 9,
      taskId: '',
      taskName: '新模板任务',
      templateId: 101,
      templateType: 1,
      templateVersion: 3,
      templateVersionId: 202,
      templateRegistrationId: 101,
      userInputParameters: '{"UIParameters":[{"Id":"q","Value":"phone"}]}',
      urlSourceTaskId: '',
      urlSourceTaskField: ''
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('template-task create accepts normalized --param values and supports dry-run', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'template-key';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    seen.push({ url: String(url), init, path: parsed.pathname });
    if (parsed.pathname === '/api/simpletemplate/templateRegistration/101/currentTemplate') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          templateRegistrationId: 101,
          id: 202,
          name: '电商模板',
          type: 1,
          currentTemplateVersion: 3,
          userInputParameters: JSON.stringify({
            UIParameters: [
              { Id: 'q', name: 'keyword', label: '关键词', Value: '', required: true },
              { Id: 'city', name: 'city', label: '城市', Value: '上海' }
            ]
          })
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/simpletemplate/templateRegistration/102/currentTemplate') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          templateRegistrationId: 102,
          id: 203,
          name: '模板参数模板',
          type: 1,
          currentTemplateVersion: 1,
          userInputParameters: JSON.stringify({
            TemplateParameters: [
              { ParamName: 'q', name: 'keyword', Value: '', required: true }
            ]
          })
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/simpletemplate/templateRegistration/103/currentTemplate') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          templateRegistrationId: 103,
          id: 204,
          name: '采集配置模板',
          type: 1,
          currentTemplateVersion: 1,
          collectParam: [
            { Id: 'q', name: 'keyword', Value: '', required: true }
          ]
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/TaskGroup/Default') {
      return new Response(JSON.stringify({ isSuccess: true, data: 9 }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/tasks/templateMapping') {
      return new Response(JSON.stringify({ isSuccess: true, data: { taskId: 'task-template-param' } }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    assert.equal(await templateTaskCommand('create', [
      '101',
      '--name',
      '参数模板任务',
      '--param',
      'keyword=phone',
      '--param',
      'city=New York',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]), 0);
    assert.equal(await templateTaskCommand('create', [
      '101',
      '--param',
      'keyword=laptop',
      '--dry-run',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]), 0);
    assert.equal(await templateTaskCommand('create', [
      '101',
      '--param',
      'missing=value',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]), 1);
    assert.equal(await templateTaskCommand('create', [
      '101',
      '--api-base-url',
      'https://example.invalid',
      '--json',
      '--param'
    ]), 1);
    assert.equal(await templateTaskCommand('create', [
      '101',
      '--param',
      'keyword=',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]), 1);
    assert.equal(await templateTaskCommand('create', [
      '101',
      '--param',
      'keyword=phone',
      '--params',
      '{"UIParameters":[]}',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]), 1);
    assert.equal(await templateTaskCommand('create', [
      '101',
      '--param',
      'city=杭州',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]), 1);
    assert.equal(await templateTaskCommand('create', [
      '102',
      '--param',
      'keyword=book',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]), 0);
    assert.equal(await templateTaskCommand('create', [
      '103',
      '--param',
      'keyword=book',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]), 1);

    const createdPayload = parseJson(lines[0]);
    const dryRunPayload = parseJson(lines[1]);
    const missingPayload = parseJson(lines[2]);
    const missingValuePayload = parseJson(lines[3]);
    const emptyRequiredPayload = parseJson(lines[4]);
    const conflictPayload = parseJson(lines[5]);
    const missingRequiredPayload = parseJson(lines[6]);
    const templateParametersPayload = parseJson(lines[7]);
    const unsupportedPayload = parseJson(lines[8]);
    assert.equal(createdPayload.data.data.taskId, 'task-template-param');
    assert.equal(dryRunPayload.data.dryRun, true);
    assert.equal(missingPayload.error.code, 'TEMPLATE_PARAM_UNKNOWN');
    assert.equal(missingValuePayload.error.code, 'USAGE_ERROR');
    assert.equal(emptyRequiredPayload.error.code, 'TEMPLATE_PARAMS_REQUIRED');
    assert.equal(conflictPayload.error.code, 'USAGE_ERROR');
    assert.equal(missingRequiredPayload.error.code, 'TEMPLATE_PARAMS_REQUIRED');
    assert.equal(templateParametersPayload.data.parameterSource, 'TemplateParameters');
    assert.equal(unsupportedPayload.error.code, 'TEMPLATE_PARAMS_UNSUPPORTED');
    const mappingCalls = seen.filter((item) => item.path === '/api/tasks/templateMapping');
    assert.equal(mappingCalls.length, 2);

    const createBody = JSON.parse(mappingCalls[0].init.body);
    assert.equal(createBody.userInputParameters, '{"UIParameters":[{"Id":"q","Value":"phone"},{"Id":"city","Value":"New York"}]}');
    assert.equal(dryRunPayload.data.request.userInputParameters, '{"UIParameters":[{"Id":"q","Value":"laptop"},{"Id":"city","Value":"上海"}]}');
    const templateParametersBody = JSON.parse(mappingCalls[1].init.body);
    assert.equal(templateParametersBody.userInputParameters, '{"TemplateParameters":[{"ParamName":"q","Value":"book"}]}');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('template-task update requires confirmation and merges existing mapping', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'template-key';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    seen.push({ url: String(url), init, path: parsed.pathname });
    if (parsed.pathname === '/api/tasks/task-1/templateMapping' && init.method === 'GET') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          taskId: 'task-1',
          templateId: 101,
          templateType: 1,
          templateVersion: 2,
          templateVersionId: 202,
          templateRegistrationId: 101,
          userInputParameters: '{}',
          urlSourceTaskId: '',
          urlSourceTaskField: ''
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/task/getTask') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          taskId: 'task-1',
          taskGroupId: 7,
          taskName: '旧模板任务',
          templateId: 101,
          templateVersionId: 202
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/tasks/task-1/templateMapping' && init.method === 'POST') {
      return new Response(JSON.stringify({ isSuccess: true, data: true }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    assert.equal(await templateTaskCommand('update', ['task-1', '--params', '{"TemplateParameters":[{"ParamName":"q","Value":"phone"}]}', '--json']), 1);
    assert.equal(parseJson(lines[0]).error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(await templateTaskCommand('update', [
      'task-1',
      '--name',
      '新名称',
      '--params',
      '{"TemplateParameters":[{"ParamName":"q","Value":"phone"}]}',
      '--yes',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]), 0);
    const payload = parseJson(lines[1]);
    assert.equal(payload.ok, true);
    assert.equal(seen[0].path, '/api/tasks/task-1/templateMapping');
    assert.equal(seen[0].init.method, 'GET');
    assert.equal(seen[1].path, '/api/task/getTask');
    assert.equal(seen[2].path, '/api/tasks/task-1/templateMapping');
    assert.equal(seen[2].init.method, 'POST');
    const body = JSON.parse(seen[2].init.body);
    assert.equal(body.taskGroupId, 7);
    assert.equal(body.taskName, '新名称');
    assert.equal(body.templateId, 101);
    assert.equal(body.templateVersionId, 202);
    assert.equal(body.userInputParameters, '{"TemplateParameters":[{"ParamName":"q","Value":"phone"}]}');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('cloud schedule commands use domestic schedule APIs and guard mutations', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'schedule-key';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    seen.push({ url: String(url), init, path: parsed.pathname, search: parsed.searchParams });
    if (parsed.pathname === '/api/task/getTaskSchedule') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          taskId: 'task-1',
          scheduleType: 5,
          scheduleDate: '1',
          scheduleTime: '10',
          scheduleMonth: '1',
          status: 0
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/task/nextexecutiontime') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: { nextExecutionTimes: ['2026-07-07T10:00:00+08:00'] }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/task/updateSchedule') {
      return new Response(JSON.stringify({ isSuccess: true, data: true }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/task/startScheduleWithNextTimeReturn') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: { taskId: 'task-1', isSuccess: true, nextTime: '2026-07-07T10:00:00+08:00' }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/task/stopSchedule') {
      return new Response(JSON.stringify({ isSuccess: true, data: true }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    assert.equal(await scheduleCommand('cloud', ['update', 'task-1', '--type', 'daily', '--date', '0,1,2,3,4,5,6', '--time', '10.00', '--json']), 1);
    assert.equal(parseJson(lines[0]).error.code, 'CONFIRMATION_REQUIRED');
    assert.equal(seen.length, 0);

    assert.equal(await scheduleCommand('cloud', ['get', 'task-1', '--api-base-url', 'https://example.invalid', '--json']), 0);
    assert.equal(await scheduleCommand('cloud', ['next', '--type', 'daily', '--date', '0,1,2,3,4,5,6', '--time', '10.00', '--timezone-offset', '480', '--api-base-url', 'https://example.invalid', '--json']), 0);
    assert.equal(await scheduleCommand('cloud', ['update', 'task-1', '--type', 'daily', '--date', '0,1,2,3,4,5,6', '--time', '10.00', '--enabled', 'true', '--timezone-offset', '480', '--yes', '--api-base-url', 'https://example.invalid', '--json']), 0);
    assert.equal(await scheduleCommand('cloud', ['stop', 'task-1', '--yes', '--api-base-url', 'https://example.invalid', '--json']), 0);

    assert.equal(parseJson(lines[1]).data.data.scheduleType, 5);
    assert.deepEqual(parseJson(lines[2]).data.data.nextExecutionTimes, ['2026-07-07T10:00:00+08:00']);
    assert.equal(parseJson(lines[3]).data.enabledAction.action, 'start');
    assert.equal(parseJson(lines[4]).data.action, 'stop');
    assert.equal(seen[0].path, '/api/task/getTaskSchedule');
    assert.equal(seen[0].search.get('taskId'), 'task-1');
    assert.equal(seen[1].path, '/api/task/nextexecutiontime');
    assert.equal(seen[1].search.get('timezoneOffset'), '480');
    assert.deepEqual(JSON.parse(seen[1].init.body), {
      scheduleType: 6,
      scheduleDate: '0,1,2,3,4,5,6',
      scheduleTime: '10.00',
      scheduleMonth: '1'
    });
    assert.equal(seen[2].path, '/api/task/getTaskSchedule');
    assert.equal(seen[3].path, '/api/task/updateSchedule');
    assert.equal(seen[3].search.get('timezoneOffset'), '480');
    assert.deepEqual(JSON.parse(seen[3].init.body), {
      taskId: 'task-1',
      scheduleType: 6,
      scheduleDate: '0,1,2,3,4,5,6',
      scheduleTime: '10.00',
      scheduleMonth: '1',
      status: 0,
      scheduleStatus: 0
    });
    assert.equal(seen[4].path, '/api/task/startScheduleWithNextTimeReturn');
    assert.equal(seen[4].search.get('taskId'), 'task-1');
    assert.equal(seen[5].path, '/api/task/stopSchedule');
    assert.equal(seen[5].search.get('taskId'), 'task-1');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('local schedule is not exposed because it requires the desktop local scheduler', async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    assert.equal(await scheduleCommand('local', ['get', 'task-local', '--json']), 1);
    const payload = parseJson(lines[0]);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'UNSUPPORTED_OPERATION');
    assert.match(payload.error.message, /node-schedule/);
  } finally {
    console.log = originalLog;
  }
});

test('task rename uses the domestic updateTaskName API after confirmation', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'task-key';
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({
      isSuccess: true,
      data: 1
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    const code = await taskRename(['task-1', '--name', '新名称', '--yes', '--api-base-url', 'https://example.invalid', '--json']);
    assert.equal(code, 0);
    const payload = parseJson(lines[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.taskId, 'task-1');
    assert.equal(payload.data.name, '新名称');
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://example.invalid/api/task/updateTaskName');
    assert.equal(seen[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(seen[0].init.body), {
      taskId: 'task-1',
      taskName: '新名称'
    });
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('data count and preview read local run artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octopus-data-preview-'));
  const output = join(root, 'runs');
  const runDir = join(output, 'run-1');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'meta.json'), JSON.stringify({
    runId: 'run-1',
    lotId: 'lot-1',
    taskId: 'task-local',
    taskName: 'Local Task',
    status: 'completed',
    total: 0,
    outputDir: output,
    startedAt: '2026-01-01T00:00:00.000Z'
  }));
  await writeFile(join(runDir, 'rows.jsonl'), [
    JSON.stringify({ id: 1 }),
    JSON.stringify({ id: 2 }),
    JSON.stringify({ id: 3 })
  ].join('\n') + '\n');

  const originalLog = console.log;
  const lines = [];
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    assert.equal(await dataCount(['task-local', '--output', output, '--json']), 0);
    assert.equal(await dataPreview(['task-local', '--output', output, '--limit', '2', '--json']), 0);
    const countPayload = parseJson(lines[0]);
    const previewPayload = parseJson(lines[1]);
    assert.equal(countPayload.ok, true);
    assert.equal(countPayload.data.total, 3);
    assert.equal(previewPayload.ok, true);
    assert.equal(previewPayload.data.offset, 1);
    assert.deepEqual(previewPayload.data.rows, [{ id: 2 }, { id: 3 }]);
  } finally {
    console.log = originalLog;
  }
});

test('cloud data count and preview use count plus offset batch endpoints', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'data-key';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    seen.push({ url: String(url), init, path: parsed.pathname, search: parsed.searchParams });
    if (parsed.pathname === '/api/taskData/getAllDataCount') {
      return new Response(JSON.stringify({ isSuccess: true, data: 42 }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/taskData/getByOffset') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          offset: 42,
          restTotal: 0,
          total: 42,
          rows: [{ id: 40 }, { id: 41 }, { id: 42 }]
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    assert.equal(await dataCount(['task-cloud', '--source', 'cloud', '--api-base-url', 'https://example.invalid', '--json']), 0);
    assert.equal(await dataPreview(['task-cloud', '--source', 'cloud', '--api-base-url', 'https://example.invalid', '--limit', '3', '--json']), 0);
    const countPayload = parseJson(lines[0]);
    const previewPayload = parseJson(lines[1]);
    assert.equal(countPayload.ok, true);
    assert.equal(countPayload.data.total, 42);
    assert.equal(previewPayload.ok, true);
    assert.equal(previewPayload.data.offset, 39);
    assert.deepEqual(previewPayload.data.rows, [{ id: 40 }, { id: 41 }, { id: 42 }]);
    assert.equal(seen[0].path, '/api/taskData/getAllDataCount');
    assert.equal(seen[1].path, '/api/taskData/getAllDataCount');
    assert.equal(seen[2].path, '/api/taskData/getByOffset');
    assert.equal(seen[2].search.get('offset'), '39');
    assert.equal(seen[2].search.get('size'), '3');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('cloud unexported data export reads unexported rows without marking them exported', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octopus-cloud-unexported-export-'));
  const file = join(root, 'rows.json');
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const seen = [];
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'data-key';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    seen.push({ url: String(url), init, path: parsed.pathname, search: parsed.searchParams });
    if (parsed.pathname === '/api/taskData/getUnexportedByOffset') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          offset: 2,
          restTotal: 0,
          total: 2,
          rows: [{ id: 1 }, { id: 2 }]
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/task/getTask') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          taskId: 'task-cloud',
          taskName: 'Cloud Task'
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => { lines.push(String(line)); };

  try {
    const code = await dataExport([
      'task-cloud',
      '--source',
      'cloud',
      '--unexported',
      '--batch-size',
      '2',
      '--format',
      'json',
      '--file',
      file,
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]);
    assert.equal(code, 0);
    const payload = parseJson(lines[0]);
    assert.equal(payload.ok, true);
    assert.equal(payload.data.unexported, true);
    assert.equal(payload.data.rows, 2);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), [{ id: 1 }, { id: 2 }]);
    assert.equal(seen[0].path, '/api/taskData/getUnexportedByOffset');
    assert.equal(seen[0].search.get('taskId'), 'task-cloud');
    assert.equal(seen[0].search.get('offset'), '0');
    assert.equal(seen[0].search.get('size'), '2');
    assert.equal(seen[1].path, '/api/task/getTask');
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('OAuth authorization code exchange maps token response', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: String(init.body), headers: init.headers });
    return new Response(JSON.stringify({
      access_token: 'access-token',
      refresh_token: 'refresh-token',
      id_token: 'id-token',
      token_type: 'Bearer',
      scope: 'openid profile offline_access',
      expires_in: 3600
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  const token = await exchangeCodeForToken('code-123', {
    authority: 'https://identity.example',
    clientId: 'bazhuayu-cli',
    clientSecret: '*',
    redirectUri: 'http://localhost:18784/login-callback',
    scope: 'openid profile offline_access'
  }, fetchImpl);
  assert.equal(seen[0].url, 'https://identity.example/connect/token');
  assert.match(seen[0].body, /grant_type=authorization_code/);
  assert.match(seen[0].body, /client_id=bazhuayu-cli/);
  assert.match(seen[0].body, /client_secret=*/);
  assert.match(seen[0].body, /code=code-123/);
  assert.equal(token.accessToken, 'access-token');
  assert.equal(token.refreshToken, 'refresh-token');
  assert.equal(token.idToken, 'id-token');
  assert.ok(token.expiresAtMs > Date.now());
});

test('OAuth token exchange treats Bazhuayu expires_in as milliseconds', async () => {
  const now = Date.now();
  const fetchImpl = async () => new Response(JSON.stringify({
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_in: 86_400_000
  }), {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' }
  });
  const token = await exchangeCodeForToken('code-ms', {
    authority: 'https://identity.example',
    clientId: 'bazhuayu-cli',
    clientSecret: '*',
    redirectUri: 'http://localhost:18784/login-callback',
    scope: 'openid profile offline_access'
  }, fetchImpl);
  assert.ok(token.expiresAtMs >= now + 86_399_000);
  assert.ok(token.expiresAtMs <= now + 86_401_000);
});

test('Windows OAuth URL launcher stores the complete long URL in a local HTML file', async () => {
  const longState = 'state-'.padEnd(9000, 'x');
  const longUrl = `https://identity.example/connect/authorize?client_id=bazhuayu-cli&redirect_uri=http%3A%2F%2Flocalhost%3A18784%2Flogin-callback&state=${longState}`;
  const filePath = await createWindowsUrlLauncherFile(longUrl);
  const html = await readFile(filePath, 'utf8');
  assert.match(filePath, /login\.html$/);
  assert.ok(filePath.length < longUrl.length);
  assert.match(html, /location\.replace/);
  assert.ok(html.includes(JSON.stringify(longUrl)));
  assert.ok(html.includes('client_id=bazhuayu-cli&amp;redirect_uri='));
  assert.ok(html.includes(longState));
});

test('OAuth login falls back to the next registered callback port', async (context) => {
  const blocker = createServer((_request, response) => response.end('busy'));
  const blocked = await new Promise((resolveListen) => {
    blocker.once('error', rejectListen);
    function rejectListen(error) {
      resolveListen(error);
    }
    blocker.listen(18784, 'localhost', () => resolveListen(null));
  });
  if (blocked) {
    context.skip(`local listen unavailable: ${blocked.code ?? blocked.message}`);
    return;
  }
  const seen = [];
  try {
    const resultPromise = runOAuthLogin({
      config: {
        authority: 'https://identity.example',
        clientId: 'bazhuayu-cli',
        clientSecret: '*',
        redirectUri: DEFAULT_OAUTH_REDIRECT_URI,
        scope: 'openid profile offline_access'
      },
      openBrowser: async (url) => {
        const parsed = new URL(url);
        const redirectUri = parsed.searchParams.get('redirect_uri');
        seen.push({ authorizeUrl: url, redirectUri });
        const callback = new URL(redirectUri);
        callback.searchParams.set('code', 'code-456');
        callback.searchParams.set('state', parsed.searchParams.get('state'));
        const response = await fetch(callback);
        await response.text();
      },
      fetchImpl: async (url, init) => {
        seen.push({ tokenUrl: String(url), body: String(init.body) });
        return new Response(JSON.stringify({
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600
        }), {
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' }
        });
      }
    });
    const result = await resultPromise;
    assert.equal(seen[0].redirectUri, 'http://localhost:18785/login-callback');
    assert.match(seen[1].body, /redirect_uri=http%3A%2F%2Flocalhost%3A18785%2Flogin-callback/);
    assert.equal(result.config.redirectUri, 'http://localhost:18785/login-callback');
    assert.equal(result.token.accessToken, 'access-token');
  } finally {
    await new Promise((resolveClose) => blocker.close(resolveClose));
  }
});

test('remote task not found suggests a nearby listed task id', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  process.env.OCTOPUS_API_KEY = 'dummy';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/task/getTask') {
      return new Response(JSON.stringify({ isSuccess: true, data: null }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/task/searchTaskListV3') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          total: 1,
          currentTotal: 1,
          dataList: [{
            taskId: '2dca8f7d-c689-c5dd-a0d4-6aeabf8f73ef',
            taskName: '博客园 - 开发者的网上家园'
          }]
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    await assert.rejects(
      new TaskDefinitionProvider().getTask('2dca8f7d-c689-c5dd-a0d4-6eaabf8f73ef'),
      (error) => {
        assert.match(error.message, /你是不是想运行/);
        assert.match(error.message, /6aeabf8f73ef/);
        assert.match(error.message, /octopus run 2dca8f7d-c689-c5dd-a0d4-6aeabf8f73ef/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('cloud history enriches lots with exportable unique row counts', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  process.env.OCTOPUS_API_KEY = 'dummy';
  const lines = [];
  const seen = [];
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname);
    if (parsed.pathname === '/api/progress/task/task-cloud-history') {
      return new Response(JSON.stringify({
        data: [{
          lot: 'lot_1',
          status: 4,
          startTime: '2026-04-15T15:18:44+08:00',
          dataCnt: 14,
          extCnt: 14
        }],
        error: 'success'
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/taskData/task-cloud-history/lot/lot_1/exportData') {
      return new Response(JSON.stringify({
        data: {
          offset: 1,
          total: 12,
          restTotal: 11,
          duplicate: 2,
          files: [{ fileBody: '' }]
        },
        error: 'success'
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => {
    lines.push(String(line));
  };

  try {
    const code = await cloudHistory(['task-cloud-history', '--api-base-url', 'https://example.invalid']);
    assert.equal(code, 0);
    assert.ok(seen.includes('/api/progress/task/task-cloud-history'));
    assert.ok(seen.includes('/api/taskData/task-cloud-history/lot/lot_1/exportData'));
    assert.match(lines.join('\n'), /rows=14  uniqueRows=12  duplicateRows=2/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('cloud start maps balance and proxy failures to stable json errors', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const lines = [];
  process.env.OCTOPUS_API_KEY = 'dummy';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    const taskId = parsed.searchParams.get('taskId');
    const status = taskId === 'cloud-balance-low' ? 12 : taskId === 'cloud-proxy-low' ? 8 : 1;
    return new Response(JSON.stringify({
      isSuccess: true,
      data: status
    }), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (line = '') => {
    lines.push(String(line));
  };

  try {
    const balanceCode = await cloudCommand('start', [
      'cloud-balance-low',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]);
    const proxyCode = await cloudCommand('start', [
      'cloud-proxy-low',
      '--api-base-url',
      'https://example.invalid',
      '--json'
    ]);
    assert.equal(balanceCode, 1);
    assert.equal(proxyCode, 1);
    const payloads = lines.map((line) => parseJson(line));
    assert.equal(payloads[0].ok, false);
    assert.equal(payloads[0].error.code, 'CLOUD_BALANCE_NOT_ENOUGH');
    assert.match(payloads[0].error.message, /云采集余额不足/);
    assert.equal(payloads[1].ok, false);
    assert.equal(payloads[1].error.code, 'CLOUD_PROXY_BALANCE_NOT_ENOUGH');
    assert.match(payloads[1].error.message, /代理 IP 余额不足/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('root and run help clearly state authentication requirement', async () => {
  const root = await runCli(['--help']);
  assert.equal(root.code, 0);
  assert.match(root.stdout, /OAuth or API key credentials are required for all functional commands/);
  assert.match(root.stdout, /bazhuayu\.com\/console\/account-center\/api-keys/);
  assert.doesNotMatch(root.stdout, /run-url/);
  assertDetectHelpPrefersAgentWorkflow(root.stdout);

  const auth = await runCli(['auth', '--help']);
  assert.equal(auth.code, 0);
  assert.match(auth.stdout, /Interactive login lets you choose OAuth or API key/);
  assert.match(auth.stdout, /--oauth/);
  assert.match(auth.stdout, /--no-open/);

  const run = await runCli(['run', '--help']);
  assert.equal(run.code, 0);
  assert.match(run.stdout, /Requires configured credentials/);
  assert.match(run.stdout, /run only starts local collection/);
  assert.match(run.stdout, /data export <taskId> --lot-id <lotId>/);
  assert.match(root.stdout, /--llm-rank/);
  assert.match(root.stdout, /--no-dismiss-popups/);

  const detect = await runCli(['detect', '--help']);
  assert.equal(detect.code, 0);
  assertDetectHelpPrefersAgentWorkflow(detect.stdout);
});

test('usage failures honor --json envelopes', async () => {
  const run = await runCli(['run', '--json'], { apiKey: 'dummy' });
  const runPayload = assertJsonFailure(run, 'USAGE_ERROR');
  assert.match(runPayload.error.message, /缺少 taskId/);

  const unknown = await runCli(['nope', '--json']);
  assertJsonFailure(unknown, 'UNKNOWN_COMMAND');

  const taskUrl = await runCli(['task-url', 'list', 'task-1', '--json']);
  assertJsonFailure(taskUrl, 'UNKNOWN_COMMAND');
});

test('capabilities documents Linux arm64 local runtime unsupported', async () => {
  const result = await runCli(['capabilities', '--json']);
  const payload = assertJsonSuccess(result);

  assert.deepEqual(payload.data.browserRuntime.unsupportedPlatforms, ['linux-arm64']);
  assert.equal(payload.data.browserRuntime.linuxArm64.supported, false);
  assert.equal(payload.data.browserRuntime.linuxArm64.errorCode, 'LINUX_ARM64_UNSUPPORTED');
  assert.ok(payload.data.machineContract.json.commonErrorCodes.includes('LINUX_ARM64_UNSUPPORTED'));
});

test('local Chrome commands reject Linux arm64 before runtime download', async () => {
  const platform = mock.property(process, 'platform', 'linux');
  const arch = mock.property(process, 'arch', 'arm64');
  const previousLog = console.log;
  const previousError = console.error;
  const stdout = [];
  const stderr = [];
  console.log = (message = '') => { stdout.push(String(message)); };
  console.error = (message = '') => { stderr.push(String(message)); };

  try {
    assert.equal(await doctorCommand(['--json']), 2);
    const doctorPayload = parseJson(stdout.pop());
    assert.equal(doctorPayload.ok, false);
    assert.equal(doctorPayload.error.code, 'LINUX_ARM64_UNSUPPORTED');

    assert.equal(await runTask('task-1', ['--json']), 2);
    const runPayload = parseJson(stdout.pop());
    assert.equal(runPayload.ok, false);
    assert.equal(runPayload.error.code, 'LINUX_ARM64_UNSUPPORTED');
    assert.match(runPayload.error.message, /Chrome for Testing/);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    platform.mock.restore();
    arch.mock.restore();
  }
});

test('doctor verifies that the Chrome executable can actually launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-browser-doctor-'));
  const fakeChrome = join(root, 'fake-chrome');
  await writeFile(fakeChrome, "#!/bin/sh\necho 'libnspr4.so: cannot open shared object file' >&2\nexit 127\n");
  await chmod(fakeChrome, 0o755);

  const result = await runCli(['doctor', '--chrome-path', fakeChrome, '--json']);
  const payload = assertJsonFailure(result, 'CHROME_LAUNCH_FAILED', 2);
  assert.match(payload.error.message, /Chrome failed to launch/);
  assert.match(payload.error.message, /libnspr4\.so/);
  assert.match(payload.error.message, /apt-get install -y libnss3 libnspr4/);
  assert.equal(payload.data.ok, false);
  assert.ok(payload.data.checks.some((check) => check.name === 'chrome' && check.severity === 'error'));
});

test('agent-facing commands expose json envelopes for key contract paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-contract-'));
  const output = join(root, 'runs');
  const apiKey = 'dummy';

  assertJsonSuccess(await runCli(['doctor', '--chrome-path', await fakeHealthyChrome(), '--json']));

  const successCases = [
    ['env', 'status', '--json'],
    ['local', 'cleanup', '--json'],
    ['local', 'status', 'missing-task', '--json'],
    ['local', 'history', 'missing-task', '--output', output, '--json'],
    ['data', 'history', 'missing-task', '--source', 'local', '--output', output, '--json'],
    ['runs', 'list', '--output', output, '--json'],
    ['runs', 'cleanup', '--output', output, '--json']
  ];
  for (const args of successCases) {
    assertJsonSuccess(await runCli(args, { apiKey }), args);
  }

  const failureCases = [
    { args: ['task', 'inspect', '--task-file', 'examples/minimal-task.json', '--json'], code: 'USAGE_ERROR' },
    { args: ['cloud', 'pause', 'task-1', '--json'], code: 'USAGE_ERROR' },
    { args: ['cloud', 'status', '--api-base-url', 'http://127.0.0.1:9', '--json'], code: 'USAGE_ERROR' },
    { args: ['local', 'status', '--json'], code: 'USAGE_ERROR' },
    { args: ['local', 'stop', 'missing-task', '--json'], code: 'LOCAL_RUN_CONTROL_FAILED' },
    { args: ['local', 'export', 'missing-task', '--output', output, '--json'], code: 'LOCAL_LOT_NOT_FOUND' },
    { args: ['data', 'history', '--source', 'cloud', '--json'], code: 'USAGE_ERROR' },
    { args: ['data', 'export', '--source', 'cloud', '--json'], code: 'USAGE_ERROR' },
    { args: ['data', 'export', 'missing-task', '--source', 'local', '--format', 'bad', '--json'], code: 'UNSUPPORTED_EXPORT_FORMAT' },
    { args: ['user-config', 'get', '--type', '20', '--json'], code: 'UNKNOWN_COMMAND' },
    { args: ['acquisition-settings', 'get', '--json'], code: 'UNKNOWN_COMMAND' },
    { args: ['runs', 'status', '--output', output, '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'status', 'missing-run', '--output', output, '--json'], code: 'RUN_NOT_FOUND' },
    { args: ['runs', 'logs', '--output', output, '--limit', '1', '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'data', '--output', output, '--limit', '1', '--json'], code: 'USAGE_ERROR' },
    { args: ['run', 'export', 'missing-task', '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'export', 'missing-run', '--file', join(root, 'result.csv'), '--format', 'bad', '--json'], code: 'USAGE_ERROR' },
    { args: ['runs', 'export', '--output', output, '--file', join(root, 'result.csv'), '--json'], code: 'USAGE_ERROR' }
  ];
  for (const item of failureCases) {
    assertJsonFailure(await runCli(item.args, { apiKey }), item.code, 1, item.args);
  }
});

test('cleanup commands remove orphaned local control state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octopus-cleanup-'));
  const home = join(root, 'home');
  const output = join(root, 'runs');
  const activeDir = join(home, '.octopus', 'active-local');
  const runDir = join(output, 'run_stale');
  await mkdir(activeDir, { recursive: true });
  await mkdir(runDir, { recursive: true });

  const staleState = {
    runId: 'run_stale',
    lotId: 'lot_stale',
    taskId: 'stale-task',
    pid: 999999,
    socketPath: join(root, 'missing.sock'),
    status: 'running',
    outputDir: output,
    updatedAt: new Date().toISOString()
  };
  const activeFile = join(activeDir, 'stale-task.json');
  const controlFile = join(runDir, 'control.json');
  const metaFile = join(runDir, 'meta.json');
  await writeFile(activeFile, `${JSON.stringify(staleState, null, 2)}\n`);
  await writeFile(controlFile, `${JSON.stringify(staleState, null, 2)}\n`);
  await writeFile(join(runDir, 'rows.jsonl'), '{"a":1}\n{"a":2}\n');

  const localStatus = await runCli(['local', 'status', 'stale-task', '--json'], { apiKey: 'dummy', home });
  const statusPayload = assertJsonSuccess(localStatus);
  assert.equal(statusPayload.data.status, 'not_running');
  assert.equal(statusPayload.data.active, false);
  assert.equal(statusPayload.data.currentRun, null);
  assert.equal(statusPayload.data.cleanedStaleState, true);
  assert.equal(statusPayload.data.lastRun.status, 'stopped');
  assert.equal(statusPayload.data.lastRun.total, 2);
  await assert.rejects(access(controlFile));
  await assert.rejects(access(activeFile));
  const preserved = JSON.parse(await readFile(metaFile, 'utf8'));
  assert.equal(preserved.status, 'stopped');
  assert.equal(preserved.total, 2);

  await writeFile(activeFile, `${JSON.stringify(staleState, null, 2)}\n`);
  await writeFile(controlFile, `${JSON.stringify(staleState, null, 2)}\n`);

  const runsCleanup = await runCli(['runs', 'cleanup', '--output', output, '--json'], { apiKey: 'dummy', home });
  const runsPayload = assertJsonSuccess(runsCleanup);
  assert.equal(runsPayload.data.checked, 1);
  assert.equal(runsPayload.data.removed, 1);
  await assert.rejects(access(controlFile));
  await assert.rejects(access(activeFile));

  await writeFile(activeFile, `${JSON.stringify(staleState, null, 2)}\n`);
  const localCleanup = await runCli(['local', 'cleanup', '--json'], { apiKey: 'dummy', home });
  const localPayload = assertJsonSuccess(localCleanup);
  assert.equal(localPayload.data.checked, 1);
  assert.equal(localPayload.data.removed, 1);
  await assert.rejects(access(activeFile));
});

test('local status reports idle with last run summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-local-status-last-'));
  const output = join(root, 'runs');
  const runDir = join(output, 'run_status_last_20260429010101');
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, 'meta.json'), `${JSON.stringify({
    runId: 'run_status_last_20260429010101',
    lotId: 'lot_20260429010101',
    taskId: 'status-last-task',
    taskName: 'Status Last Task',
    status: 'stopped',
    total: 2,
    outputDir: runDir,
    startedAt: '2026-04-29T01:01:01.000Z',
    stoppedAt: '2026-04-29T01:02:01.000Z'
  }, null, 2)}\n`);

  const jsonResult = await runCli([
    'local',
    'status',
    'status-last-task',
    '--output',
    output,
    '--json'
  ], { apiKey: 'dummy' });
  const payload = assertJsonSuccess(jsonResult);
  assert.equal(payload.data.status, 'not_running');
  assert.equal(payload.data.active, false);
  assert.equal(payload.data.currentRun, null);
  assert.equal(payload.data.lastRun.status, 'stopped');
  assert.equal(payload.data.lastRun.lotId, 'lot_20260429010101');

  const humanResult = await runCli([
    'local',
    'status',
    'status-last-task',
    '--output',
    output
  ], { apiKey: 'dummy' });
  assert.equal(humanResult.code, 0, formatCliResult(humanResult));
  assert.match(humanResult.stdout, /status-last-task  idle/);
  assert.match(humanResult.stdout, /Last run: stopped  rows=2  lot=lot_20260429010101/);
});

test('local status reports starting for live detached bootstrap before control channel is ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-local-status-detach-'));
  const home = join(root, 'home');
  const output = join(root, 'runs');
  const bootstrapDir = join(output, '.detach_detach-starting-task_20260429010101');
  await mkdir(bootstrapDir, { recursive: true });
  await writeFile(join(bootstrapDir, 'bootstrap.json'), `${JSON.stringify({
    taskId: 'detach-starting-task',
    pid: process.pid,
    status: 'starting',
    stdout: join(bootstrapDir, 'stdout.log'),
    stderr: join(bootstrapDir, 'stderr.log'),
    updatedAt: '2026-04-29T01:01:01.000Z'
  }, null, 2)}\n`);

  const jsonResult = await runCli([
    'local',
    'status',
    'detach-starting-task',
    '--output',
    output,
    '--json'
  ], { apiKey: 'dummy', home });
  const payload = assertJsonSuccess(jsonResult);
  assert.equal(payload.data.status, 'starting');
  assert.equal(payload.data.active, true);
  assert.equal(payload.data.detached, true);
  assert.equal(payload.data.pid, process.pid);
  assert.equal(payload.data.bootstrapDir, bootstrapDir);

  const humanResult = await runCli([
    'local',
    'status',
    'detach-starting-task',
    '--output',
    output
  ], { apiKey: 'dummy', home });
  assert.equal(humanResult.code, 0, formatCliResult(humanResult));
  assert.match(humanResult.stdout, /detach-starting-task  starting/);
  assert.match(humanResult.stdout, /Bootstrap:/);
});

test('local history reports row count from rows artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-history-rows-'));
  const output = join(root, 'runs');
  const runDir = join(output, 'run_task_rows_20260429010101');
  const staleRunDir = join(output, 'run_task_rows_20260429010202');
  await mkdir(runDir, { recursive: true });
  await mkdir(staleRunDir, { recursive: true });
  await writeFile(join(runDir, 'meta.json'), `${JSON.stringify({
    runId: 'run_task_rows_20260429010101',
    lotId: 'lot_20260429010101',
    taskId: 'task-rows',
    taskName: 'Rows Task',
    status: 'stopped',
    total: 0,
    outputDir: runDir,
    startedAt: '2026-04-29T01:01:01.000Z',
    stoppedAt: '2026-04-29T01:02:01.000Z'
  }, null, 2)}\n`);
  await writeFile(join(runDir, 'rows.jsonl'), '{"a":1}\n{"a":2}\n');
  await writeFile(join(staleRunDir, 'control.json'), `${JSON.stringify({
    runId: 'run_task_rows_20260429010202',
    lotId: 'lot_20260429010202',
    taskId: 'task-rows',
    pid: 999999,
    socketPath: join(root, 'missing.sock'),
    status: 'running',
    outputDir: output,
    updatedAt: '2026-04-29T01:02:02.000Z'
  }, null, 2)}\n`);
  await writeFile(join(staleRunDir, 'rows.jsonl'), '{"a":3}\n{"a":4}\n{"a":5}\n');

  const result = await runCli(['data', 'history', 'task-rows', '--source', 'local', '--output', output, '--json'], { apiKey: 'dummy' });
  const payload = assertJsonSuccess(result);
  assert.equal(payload.data.length, 2);
  assert.equal(payload.data[0].lotId, 'lot_20260429010202');
  assert.equal(payload.data[0].status, 'stopped');
  assert.equal(payload.data[0].total, 3);
  assert.equal(payload.data[1].total, 2);
});

test('minimal example validates with API key', async () => {
  const result = await runCli([
    'task',
    'validate',
    'minimal',
    '--task-file',
    'examples/minimal-task.json',
    '--json'
  ], { apiKey: 'dummy' });
  assert.equal(result.code, 0);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.actionCount, 1);
  assert.deepEqual(payload.data.actionTypes, ['NavigateAction']);
});

test('run rejects --format and points users to data export', async () => {
  const result = await runCli(['run', 'minimal', '--format', 'csv', '--json'], { apiKey: 'dummy' });
  assert.equal(result.code, 1);
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'RUN_FORMAT_UNSUPPORTED');
  assert.match(payload.error.message, /data export --format/);

  const jsonl = await runCli(['run', 'minimal', '--format', 'csv', '--jsonl'], { apiKey: 'dummy' });
  assert.equal(jsonl.code, 1);
  assert.equal(jsonl.stdout.trim().split('\n').length, 1);
  const jsonlPayload = parseJson(jsonl.stdout);
  assert.equal(jsonlPayload.ok, false);
  assert.equal(jsonlPayload.error.code, 'RUN_FORMAT_UNSUPPORTED');
});

test('run validates max rows as a positive integer', async () => {
  const result = await runCli(['run', 'minimal', '--max-rows', '0', '--json'], { apiKey: 'dummy' });
  assertJsonFailure(result, 'RUN_MAX_ROWS_INVALID');
  assert.match(parseJson(result.stdout).error.message, /--max-rows/);
});

test('run preflight blocks paid template when balance is below charging granularity', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const dir = await mkdtemp(join(tmpdir(), 'octopus-paid-template-task-'));
  const taskFile = join(dir, 'paid-template-task.json');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'paid-template-low-balance',
    taskName: 'Paid Template Low Balance',
    isTemplate: true,
    workFlowType: 10,
    template: {
      permission: { allowCrossAccountLevelPricing: true },
      prices: { standard: 1 },
      pricePerData: 1
    }
  }));
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/templatecharging/user/canStartTemplateTask/paid-template-low-balance') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          canUse: true,
          balance: 0,
          balanceLowThreshold: 20,
          chargingGranularity: 1
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const code = await runTask('paid-template-low-balance', ['--task-file', taskFile, '--json']);
    assert.equal(code, 2);
    const payload = lines.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).find((item) => item?.ok === false);
    assert.equal(payload.ok, false);
    assert.equal(payload.error.code, 'TEMPLATE_BALANCE_NOT_ENOUGH');
    assert.match(payload.error.message, /付费模板余额不足/);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('run preflight skips template billing for non-template task files', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const seen = [];
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname);
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 500,
      statusText: 'Server Error',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const result = await runWithFakeRuntimeEvent('preflight-ok', {
      taskFile: 'examples/minimal-task.json',
      fetch: globalThis.fetch
    });
    assert.equal(result.code, 0);
    assert.equal(seen.includes('/api/templatecharging/user/canStartTemplateTask/minimal'), false);
    const templateWarning = result.jsonl.find((item) => item?.code === 'TEMPLATE_BALANCE_LOW');
    assert.equal(templateWarning, undefined);
    assert.ok(result.events.some((item) => item.event === 'run.stopped'));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('run preflight emits jsonl warning for low paid template balance', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const dir = await mkdtemp(join(tmpdir(), 'octopus-paid-template-warning-'));
  const taskFile = join(dir, 'paid-template-warning.json');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'paid-template-warning',
    taskName: 'Paid Template Warning',
    isTemplate: true,
    workFlowType: 10,
    template: {
      permission: { allowCrossAccountLevelPricing: true },
      prices: { standard: 1 },
      pricePerData: 1
    }
  }));
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/templatecharging/user/canStartTemplateTask/paid-template-warning') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          canUse: true,
          balance: 5,
          balanceLowThreshold: 20,
          chargingGranularity: 1
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const result = await runWithFakeRuntimeEvent('paid-template-warning', {
      taskFile,
      fetch: globalThis.fetch
    });
    assert.equal(result.code, 0);
    const warning = result.jsonl.find((item) => item?.event === 'billing.warning');
    assert.equal(warning?.code, 'TEMPLATE_BALANCE_LOW');
    assert.equal(warning?.balance, 5);
    assert.ok(result.events.some((item) => item.event === 'billing.warning' && item.code === 'TEMPLATE_BALANCE_LOW'));
    assert.ok(result.events.some((item) => item.event === 'run.stopped'));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('run preflight ignores stored strong proxy settings when switch IP is disabled', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const seen = [];
  const dir = await mkdtemp(join(tmpdir(), 'octopus-proxy-task-'));
  const taskFile = join(dir, 'proxy-task.json');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'proxy-low-balance',
    taskName: 'Proxy Low Balance',
    brokerSettings: {
      ipProxySettings: {
        ipProxyFromType: 1
      }
    }
  }));
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname);
    if (parsed.pathname === '/api/user/balances') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: { balance: 3, totalBalance: 3 }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'not found' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const result = await runWithFakeRuntimeEvent('proxy-low-balance', {
      taskFile,
      fetch: globalThis.fetch
    });
    assert.equal(result.code, 0);
    assert.equal(seen.includes('/api/user/balances'), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('run preflight warns for strong proxy balance risk without blocking startup', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const seen = [];
  const dir = await mkdtemp(join(tmpdir(), 'octopus-proxy-task-'));
  const taskFile = join(dir, 'proxy-task.json');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'proxy-low-balance',
    taskName: 'Proxy Low Balance',
    xml: minimalTask.xml.replace('EnableSwitchIp="false"', 'EnableSwitchIp="true"').replace('IPType="None"', 'IPType="0"'),
    brokerSettings: {
      ipProxySettings: {
        ipProxyFromType: 1
      }
    }
  }));
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    seen.push(parsed.pathname);
    if (parsed.pathname === '/api/user/balances') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: { balance: 3, totalBalance: 3 }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'not found' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const result = await runWithFakeRuntimeEvent('proxy-low-balance', {
      taskFile,
      fetch: globalThis.fetch
    });
    assert.equal(result.code, 0);
    const warning = result.jsonl.find((item) => item?.code === 'PROXY_BALANCE_LOW');
    assert.equal(warning?.severity, 'warning');
    assert.match(warning?.message, /优质代理 IP 余额较低/);
    assert.ok(result.events.some((item) => item.event === 'billing.warning' && item.code === 'PROXY_BALANCE_LOW'));
    assert.equal(seen.includes('/api/HttpProxy/Balance'), false);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('run preflight warns for captcha balance risk without blocking startup', async () => {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const dir = await mkdtemp(join(tmpdir(), 'octopus-captcha-task-'));
  const taskFile = join(dir, 'captcha-task.json');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'captcha-low-balance',
    taskName: 'Captcha Low Balance',
    brokerSettings: {
      captchaSettings: {
        isAutoCloudflare: true
      }
    }
  }));
  process.env.OCTOPUS_API_KEY = 'billing-key';
  globalThis.fetch = async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/user/balances') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: { balance: 2, totalBalance: 2 }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/Captcha/GetCaptchaRemain') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: 0
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'not found' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  };
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });

  try {
    const result = await runWithFakeRuntimeEvent('captcha-low-balance', {
      taskFile,
      fetch: globalThis.fetch
    });
    assert.equal(result.code, 0);
    const warning = result.jsonl.find((item) => item?.event === 'billing.warning');
    assert.equal(warning?.code, 'CAPTCHA_BALANCE_LOW');
    assert.equal(warning?.balance, 2);
    assert.equal(warning?.captchaRemain, 0);
    assert.ok(result.events.some((item) => item.event === 'billing.warning' && item.code === 'CAPTCHA_BALANCE_LOW'));
    assert.ok(result.events.some((item) => item.event === 'run.stopped'));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
});

test('billing runtime errors expose stable codes and readable messages', () => {
  const captcha = new BillingRuntimeError('CAPTCHA_BALANCE_NOT_ENOUGH', '验证码余额不足，请充值后重试。', 3);
  const proxy = new BillingRuntimeError('PROXY_BALANCE_NOT_ENOUGH', '代理 IP 余额不足，请充值后重试。', 4);
  assert.equal(captcha.code, 'CAPTCHA_BALANCE_NOT_ENOUGH');
  assert.equal(captcha.status, 3);
  assert.match(captcha.message, /验证码余额不足/);
  assert.equal(proxy.code, 'PROXY_BALANCE_NOT_ENOUGH');
  assert.equal(proxy.status, 4);
  assert.match(proxy.message, /代理 IP 余额不足/);
});

test('runtime billing service failures are reported as events without forcing run stop', async () => {
  const result = await runWithFakeRuntimeEvent('captcha-no-balance');
  assert.equal(result.code, 0);
  assert.equal(result.workflowStopCalls, 0);
  assert.equal(result.workflowStopTaskCalls, 0);

  const captchaFailed = result.jsonl.find((item) => item.event === 'captcha' && item.phase === 'failed');
  assert.equal(captchaFailed?.code, 'CAPTCHA_BALANCE_NOT_ENOUGH');
  assert.equal(captchaFailed?.status, 3);
  const billingError = result.jsonl.find((item) => item.event === 'billing.error');
  assert.equal(billingError?.capability, 'captcha');
  assert.equal(billingError?.code, 'CAPTCHA_BALANCE_NOT_ENOUGH');
  assert.equal(billingError?.status, 3);
  assert.ok(result.events.some((item) => item.event === 'billing.error' && item.code === 'CAPTCHA_BALANCE_NOT_ENOUGH'));
  assert.ok(result.events.some((item) => item.event === 'run.stopped'));
});

test('runtime proxy billing failures are reported as events without forcing run stop', async () => {
  const result = await runWithFakeRuntimeEvent('proxy-no-balance');
  assert.equal(result.code, 0);
  assert.equal(result.workflowStopCalls, 0);
  assert.equal(result.workflowStopTaskCalls, 0);

  const proxyFailed = result.jsonl.find((item) => item.event === 'proxy' && item.phase === 'failed');
  assert.equal(proxyFailed?.code, 'PROXY_BALANCE_NOT_ENOUGH');
  assert.equal(proxyFailed?.status, 4);
  const billingError = result.jsonl.find((item) => item.event === 'billing.error');
  assert.equal(billingError?.capability, 'proxy');
  assert.equal(billingError?.code, 'PROXY_BALANCE_NOT_ENOUGH');
  assert.equal(billingError?.status, 4);
  assert.ok(result.events.some((item) => item.event === 'billing.error' && item.code === 'PROXY_BALANCE_NOT_ENOUGH'));
});

test('runtime captcha success is resolved and returned to the workflow', async () => {
  const result = await runWithFakeRuntimeEvent('captcha-success');
  assert.equal(result.code, 0);
  assert.equal(result.workflowStopCalls, 0);
  assert.equal(result.workflowStopTaskCalls, 0);
  assert.deepEqual(result.captchaTokens, [{ captchaType: 0, token: 'captcha-token' }]);

  const captchaResolved = result.jsonl.find((item) => item.event === 'captcha' && item.phase === 'resolved');
  assert.equal(captchaResolved?.numericCaptchaType, 0);
  assert.equal(result.jsonl.some((item) => item.event === 'billing.error'), false);
  assert.ok(result.events.some((item) => item.event === 'captcha' && item.phase === 'resolved'));
});

test('runtime captcha handler absence is reported as failed without a false resolved event', async () => {
  const result = await runWithFakeRuntimeEvent('captcha-missing-handler');
  assert.equal(result.code, 0);
  assert.deepEqual(result.captchaTokens, []);

  const captchaFailed = result.jsonl.find((item) => item.event === 'captcha' && item.phase === 'failed');
  assert.equal(captchaFailed?.code, 'RUNTIME_SERVICE_FAILED');
  assert.match(captchaFailed?.message ?? '', /capthcaToken/);
  assert.equal(result.jsonl.some((item) => item.event === 'captcha' && item.phase === 'resolved'), false);
  assert.equal(result.jsonl.some((item) => item.event === 'billing.error'), false);
});

test('runtime proxy success is resolved and returned to the workflow', async () => {
  const result = await runWithFakeRuntimeEvent('proxy-success');
  assert.equal(result.code, 0);
  assert.equal(result.workflowStopCalls, 0);
  assert.equal(result.workflowStopTaskCalls, 0);
  assert.equal(result.sentProxy.length, 1);
  assert.equal(result.sentProxy[0].proxyIp.ip, '127.0.0.1');
  assert.equal(result.sentProxy[0].proxyIp.port, 8080);

  assert.ok(result.jsonl.some((item) => item.event === 'proxy' && item.phase === 'resolved' && item.hasProxy === true));
  assert.ok(result.jsonl.some((item) => item.event === 'proxy' && item.phase === 'sent' && item.hasProxy === true));
  assert.equal(result.jsonl.some((item) => item.event === 'billing.error'), false);
  assert.ok(result.events.some((item) => item.event === 'proxy' && item.phase === 'sent'));
});

test('runtime proxy handler absence is reported as failed without a false sent event', async () => {
  const result = await runWithFakeRuntimeEvent('proxy-missing-handler');
  assert.equal(result.code, 0);
  assert.deepEqual(result.sentProxy, []);

  const proxyFailed = result.jsonl.find((item) => item.event === 'proxy' && item.phase === 'failed');
  assert.equal(proxyFailed?.code, 'RUNTIME_SERVICE_FAILED');
  assert.match(proxyFailed?.message ?? '', /sendProxy/);
  assert.ok(result.jsonl.some((item) => item.event === 'proxy' && item.phase === 'resolved'));
  assert.equal(result.jsonl.some((item) => item.event === 'proxy' && item.phase === 'sent'), false);
  assert.equal(result.jsonl.some((item) => item.event === 'billing.error'), false);
});

test('engine host forwards workflow control methods', async () => {
  const result = await runWithFakeRuntimeEvent('control-contract', { exerciseControls: true });
  assert.equal(result.code, 0);
  assert.equal(result.workflowStopCalls, 1);
  assert.equal(result.workflowStopTaskCalls, 1);
  assert.equal(result.workflowPauseTaskCalls, 1);
  assert.equal(result.workflowResumeTaskCalls, 1);
  assert.equal(result.workflowCloseCalls, 1);
});

test('local run records engine download events in artifacts and summary', async () => {
  const result = await runWithFakeRuntimeEvent('download-runtime', {
    downloadEvents: [
      {
        url: 'https://example.com/file.webp',
        filePath: '/tmp/octopus-downloads/task/字段1/file.webp',
        fileSize: 1234,
        status: 'downloading',
        fieldName: '字段1',
        rowUuid: 'row-1'
      },
      {
        url: 'https://example.com/file.webp',
        filePath: '/tmp/octopus-downloads/task/字段1/file.webp',
        fileSize: 1234,
        status: 'success',
        fieldName: '字段1',
        rowUuid: 'row-1'
      },
      {
        url: 'https://example.com/file-2.webp',
        filePath: '/tmp/octopus-downloads/task/字段2/file-2.webp',
        fileSize: 5678,
        status: 'downloading',
        fieldName: '字段2',
        rowUuid: 'row-2'
      },
      {
        url: 'https://example.com/file-2.webp',
        filePath: '/tmp/octopus-downloads/task/字段2/file-2.webp',
        fileSize: 5678,
        status: 'success',
        fieldName: '字段2',
        rowUuid: 'row-2'
      }
    ]
  });
  assert.equal(result.code, 0);
  assert.ok(result.events.find((event) => event.event === 'download.succeeded'));
  const stopped = result.events.find((event) => event.event === 'run.stopped');
  assert.equal(stopped.downloads.total, 2);
  assert.equal(stopped.downloads.succeeded, 2);
  assert.equal(stopped.downloads.outputDir, '/tmp/octopus-downloads/task');
  assert.equal(result.downloads.length, 4);
});

test('local run emits Chrome resolve progress as runtime log events', async () => {
  const result = await runWithFakeRuntimeEvent('chrome-progress-runtime', {
    chromeStatuses: [
      { state: 'checking', progress: 0 },
      { state: 'downloading', progress: 37.6 },
      { state: 'completed', progress: 100 }
    ]
  });

  assert.equal(result.code, 0);
  assert.ok(result.jsonl.some((event) =>
    event.event === 'log'
    && event.message === 'runtime.chrome.resolve Chrome downloading 38%'
  ));
  assert.ok(result.events.some((event) =>
    event.event === 'log'
    && event.message === 'runtime.chrome.resolve Chrome ready 100%'
  ));
});

test('run completion prints a copyable local data export command', () => {
  assert.equal(
    localDataExportCommand({ taskId: 'task-1', lotId: '1778123456789' }),
    'octopus data export task-1 --source local --lot-id 1778123456789'
  );
});

test('injectGlobalCookie enables task browser session cookies without exposing them in detection metadata', () => {
  const xml = '<ns0:RootAction globalCookie="" isSetGlobalCookie="false"><ns0:NavigateAction /></ns0:RootAction>';
  const injected = injectGlobalCookie(xml, 'sid=secret&value; theme=dark');
  assert.match(injected, /isSetGlobalCookie="true"/);
  assert.match(injected, /globalCookie="sid=secret&amp;value; theme=dark"/);
});

test('injectGlobalCookie inserts missing root cookie attributes', () => {
  const xml = '<ns0:RootAction xmlns:ns0="x"><ns0:NavigateAction /></ns0:RootAction>';
  const injected = injectGlobalCookie(xml, 'sid=secret');
  assert.match(injected, /<ns0:RootAction[^>]*globalCookie="sid=secret"/);
  assert.match(injected, /<ns0:RootAction[^>]*isSetGlobalCookie="true"/);
});

test('detected browser session cookies are injected into runtime task xml and xoml', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octopus-session-runtime-'));
  const home = join(root, 'home');
  const taskFile = join(root, 'task.json');
  const sessionDir = join(home, '.octopus', 'browser-sessions');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, 'example.com.json'), JSON.stringify({
    name: 'example.com',
    origin: 'https://example.com',
    savedAt: '2026-06-01T00:00:00.000Z',
    cookieCount: 1,
    kind: 'cookie',
    compatibility: 'cookies-only',
    cookies: [{ name: 'sid', value: 'secret&value', domain: 'example.com', path: '/' }]
  }));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'detected-session-runtime',
    taskName: 'Detected Session Runtime',
    xoml: '<?xml version="1.0"?><definitions><process id="stale" isExecutable="true"><userTask actionType="StaleAction" id="staleAction" /></process></definitions>',
    detection: {
      session: {
        name: 'example.com',
        origin: 'https://example.com',
        savedAt: '2026-06-01T00:00:00.000Z',
        cookieCount: 1,
        kind: 'cookie',
        compatibility: 'cookies-only'
      }
    }
  }));

  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const result = await runWithFakeRuntimeEvent('detected-session-runtime', { taskFile });
    assert.equal(result.code, 0);
    assert.match(result.workflowTask.xml, /globalCookie="sid=secret&amp;value"/);
    assert.match(result.workflowTask.xml, /isSetGlobalCookie="true"/);
    assert.doesNotMatch(result.workflowTask.xoml, /StaleAction/);
    assert.match(result.workflowTask.xoml, /actionType="NavigateAction"/);
    assert.doesNotMatch(JSON.stringify(result.workflowTask.detection ?? ''), /secret&value/);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('local run sanitizes URL-like task names before passing them to runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octopus-url-task-name-'));
  const taskFile = join(root, 'task.json');
  const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
  await writeFile(taskFile, JSON.stringify({
    ...minimalTask,
    taskId: 'url-task-name',
    taskName: 'https://www.gc-zb.com/search/index.html'
  }));

  const result = await runWithFakeRuntimeEvent('url-task-name', { taskFile });
  assert.equal(result.code, 0);
  assert.equal(result.workflowTask.taskName, 'www.gc-zb.com_search_index.html');
  assert.doesNotMatch(result.workflowTask.taskName, /[<>:"/\\|?*]/);
});

test('task list text output hides internal workflow metadata', () => {
  const line = formatTaskListLine({
    taskId: 'task-1',
    taskName: 'Demo Task',
    status: 1,
    workflowType: 1,
    workFlowType: 1
  });
  assert.equal(line, '  task-1  Demo Task');
  assert.doesNotMatch(line, /workflow=/);
  assert.doesNotMatch(line, /status=/);
});

test('detached startup failure writes bootstrap artifact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'octo-detach-'));
  const home = join(root, 'home');
  const output = join(root, 'runs');
  const taskFile = join(root, 'invalid-task.json');
  await writeFile(taskFile, JSON.stringify({
    taskId: 'invalid-detach',
    taskName: 'Invalid Detach',
    xml: '<Root />',
    xoml: '<?xml version="1.0"?><definitions><process id="p" isExecutable="true" /></definitions>',
    fieldNames: []
  }));

  const result = await runCli([
    'run',
    'invalid-detach',
    '--task-file',
    taskFile,
    '--output',
    output,
    '--detach',
    '--json'
  ], { apiKey: 'dummy', apiBaseUrl: 'http://127.0.0.1:9', home, timeout: 20_000 });

  assert.equal(result.code, 2, formatCliResult(result, [
    'run',
    'invalid-detach',
    '--task-file',
    taskFile,
    '--output',
    output,
    '--detach',
    '--json'
  ]));
  const payload = parseJson(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'DETACHED_RUN_FAILED');

  const bootstrapDir = payload.error.message.match(/bootstrap=(.+)$/)?.[1];
  assert.ok(bootstrapDir, payload.error.message);
  const bootstrap = JSON.parse(await readFile(join(bootstrapDir, 'bootstrap.json'), 'utf8'));
  assert.equal(bootstrap.status, 'failed');
  assert.match(bootstrap.error, /actionType|Nothing to execute|缺少可执行/);
  assert.equal(bootstrap.taskId, 'invalid-detach');
});

test('max rows completes when the runtime never settles its start promise after stop', async () => {
  const result = await runWithFakeRuntimeEvent('max-rows-never-settles', {
    rowData: { id: 1, title: 'first row' },
    maxRows: 1,
    neverStops: true,
    timeoutMs: 10_000
  });
  const stopped = result.jsonl.find((item) => item.event === 'run.stopped');

  assert.equal(result.code, 0);
  assert.equal(stopped?.status, 'stopped');
  assert.equal(stopped?.stopReason, 'max_rows');
  assert.equal(stopped?.maxRows, 1);
  assert.deepEqual(result.rows, [{ id: 1, title: 'first row' }]);
  assert.equal(result.workflowStopCalls, 1);
  assert.equal(result.workflowCloseCalls, 1);
  assert.equal(result.jsonl.some((item) => item.event === 'run.failed'), false);
});

async function runWithFakeRuntimeEvent(scenario, options = {}) {
  const originalFetch = globalThis.fetch;
  const originalApiKey = process.env.OCTOPUS_API_KEY;
  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const lines = [];
  const root = await mkdtemp(join(tmpdir(), `octopus-${scenario}-`));
  const output = join(root, 'runs');
  let taskFile = options.taskFile;
  if (!taskFile) {
    taskFile = join(root, 'task.json');
    const minimalTask = JSON.parse(await readFile('examples/minimal-task.json', 'utf8'));
    await writeFile(taskFile, JSON.stringify({
      ...minimalTask,
      taskId: scenario,
      taskName: scenario,
      ...(scenario === 'proxy-no-balance' || scenario === 'proxy-success' || scenario === 'proxy-missing-handler'
        ? {
            brokerSettings: {
              ipProxySettings: {
                ipProxyFromType: 1
              }
            }
          }
        : {})
    }));
  }
  process.env.OCTOPUS_API_KEY = 'runtime-key';

  let workflowInstance;
  let workflowTask;
  const workflowEvents = {
    ExtraData: 'extraData',
    Log: 'log',
    Stopped: 'stopped',
    Captcha: 'captcha',
    GetProxy: 'getProxy',
    DownloadFile: 'downloadFile',
    CollectProxyLog: 'collectProxyLog'
  };
  class FakeWorkflow extends EventEmitter {
    stopCalls = 0;
    stopTaskCalls = 0;
    pauseTaskCalls = 0;
    resumeTaskCalls = 0;
    closeCalls = 0;
    sentProxy = [];
    captchaTokens = [];

    constructor(task) {
      super();
      workflowTask = task;
      workflowInstance = this;
      if (scenario === 'captcha-missing-handler') this.capthcaToken = undefined;
      if (scenario === 'proxy-missing-handler') this.sendProxy = undefined;
    }

    async start() {
      setImmediate(() => {
        if (options.rowData) {
          this.emit(workflowEvents.ExtraData, {
            data: {
              total: 1,
              rowData: options.rowData
            }
          });
        }
        for (const event of options.downloadEvents ?? []) {
          this.emit(workflowEvents.DownloadFile, { data: event });
        }
        if (scenario === 'captcha-no-balance' || scenario === 'captcha-success' || scenario === 'captcha-missing-handler') {
          this.emit(workflowEvents.Captcha, {
            data: [{
              captchaType: 'image',
              image: 'base64-image',
              url: 'https://example.com'
            }]
          });
        } else if (scenario === 'proxy-no-balance' || scenario === 'proxy-success' || scenario === 'proxy-missing-handler') {
          this.emit(workflowEvents.GetProxy, {});
        }
        if (options.exerciseControls) {
          engineHost.pause();
          engineHost.resume();
          engineHost.stop();
        }
        if (!options.neverStops) {
          setTimeout(() => {
            this.emit(workflowEvents.Stopped, { data: { status: 'completed' } });
          }, 20);
        }
      });
    }

    capthcaToken(payload) {
      this.captchaTokens.push(payload);
    }

    sendProxy(payload) {
      this.sentProxy.push(payload);
    }

    stop() {
      this.stopCalls += 1;
    }

    stopTask() {
      this.stopTaskCalls += 1;
    }

    pauseTask() {
      this.pauseTaskCalls += 1;
    }

    resumeTask() {
      this.resumeTaskCalls += 1;
    }

    close() {
      this.closeCalls += 1;
    }
  }

  const fakeEngine = {
    default: FakeWorkflow,
    WorkflowEvents: workflowEvents,
    resolveChrome: async (resolveOptions) => {
      for (const status of options.chromeStatuses ?? []) {
        resolveOptions?.onStatus?.(status);
      }
      return { executablePath: process.execPath };
    }
  };
  const fakeBridgeFactory = () => new FakeBridgeHub();

  globalThis.fetch = options.fetch ?? (async (url) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === '/api/Captcha/DoCaptchaV2') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: {
          status: scenario === 'captcha-success' || scenario === 'captcha-missing-handler' ? 1 : 3,
          captcha: scenario === 'captcha-success' || scenario === 'captcha-missing-handler' ? 'captcha-token' : ''
        }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    if (parsed.pathname === '/api/HttpProxy') {
      return new Response(JSON.stringify({
        isSuccess: true,
        data: scenario === 'proxy-success' || scenario === 'proxy-missing-handler'
          ? {
              status: 0,
              ip: '127.0.0.1',
              port: 8080,
              protocol: 1
            }
          : {
              status: 4
            }
      }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ isSuccess: false, error: 'unexpected' }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'content-type': 'application/json' }
    });
  });
  console.log = (...args) => { lines.push(args.map(String).join(' ')); };
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  process.stdout.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  process.stderr.write = ((chunk) => {
    lines.push(String(chunk).trimEnd());
    return true;
  });
  let engineHost;
  setEngineHostFactoryForTesting(() => {
    engineHost = new EngineHost(fakeEngine, fakeBridgeFactory);
    return engineHost;
  });

  try {
    const runArgs = [
      '--task-file',
      taskFile,
      '--output',
      output,
      '--browser',
      'independent',
      '--jsonl',
      '--timeout-ms',
      String(options.timeoutMs ?? 2_000),
      ...(options.maxRows === undefined ? [] : ['--max-rows', String(options.maxRows)])
    ];
    const code = await runTask(scenario, runArgs);
    const jsonl = lines.flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    const stopped = jsonl.find((item) => item.event === 'run.stopped');
    const eventsPath = join(stopped.outputDir, 'events.jsonl');
    const events = (await readFile(eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const downloadsPath = join(stopped.outputDir, 'downloads.jsonl');
    let downloads = [];
    try {
      downloads = (await readFile(downloadsPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {}
    const rowsPath = join(stopped.outputDir, 'rows.jsonl');
    let rows = [];
    try {
      rows = (await readFile(rowsPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {}
    return {
      code,
      jsonl,
      events,
      downloads,
      rows,
      workflowStopCalls: workflowInstance?.stopCalls ?? 0,
      workflowStopTaskCalls: workflowInstance?.stopTaskCalls ?? 0,
      workflowPauseTaskCalls: workflowInstance?.pauseTaskCalls ?? 0,
      workflowResumeTaskCalls: workflowInstance?.resumeTaskCalls ?? 0,
      workflowCloseCalls: workflowInstance?.closeCalls ?? 0,
      workflowTask,
      sentProxy: workflowInstance?.sentProxy ?? [],
      captchaTokens: workflowInstance?.captchaTokens ?? []
    };
  } finally {
    setEngineHostFactoryForTesting(undefined);
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    if (originalApiKey === undefined) delete process.env.OCTOPUS_API_KEY;
    else process.env.OCTOPUS_API_KEY = originalApiKey;
  }
}

class FakeBridgeHub extends EventEmitter {
  async createSessionBridge() {
    return {};
  }

  async waitForSessionConnected() {}

  close() {}
}
