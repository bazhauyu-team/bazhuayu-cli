import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import prompts from 'prompts';
import { firstPositionalArg, hasFlag, parsePositiveInt, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { RecognitionLoginRequiredError, recognizePage } from '../runtime/recognizer/page-recognizer.js';
import { buildTaskFromCandidate } from '../runtime/recognizer/xml.js';
import { createChromeProgressReporter } from '../runtime/chrome-progress.js';
import { LINUX_ARM64_UNSUPPORTED_CODE, LINUX_ARM64_UNSUPPORTED_MESSAGE, isLocalChromeRuntimeSupported } from '../runtime/platform-support.js';
import type { PageRecognitionResult, RecognizedAgentScreenshot, RecognizedCandidate, RecognizedDetailPlan, RecognizedField, RecognizedFieldDiagnostics, RecognizedPagination, RecognizedSearchPlan } from '../runtime/recognizer/types.js';
import { safeFileName } from '../runtime/naming.js';
import { EXIT_OK, EXIT_OPERATION_FAILED, EXIT_RUNTIME_FAILED } from '../types.js';
import { runTask } from './run.js';

type AgentFieldPlan = string | {
  source?: string;
  name?: string;
  as?: string;
  kind?: RecognizedField['kind'];
  selector?: string;
  xpath?: string;
  relativeXPath?: string;
  samples?: string[];
  operations?: RecognizedField['operations'];
};

interface RecognizeAgentContext {
  schemaVersion: 'octopus.recognize.agent-context.v1';
  instruction: string;
  decisionPolicy: {
    requiredInputs: string[];
    rankingRule: string;
    recommendedCandidateRule: string;
    paginationRule: string;
    searchRule: string;
  };
  resultValidationPolicy: {
    normalPartialDataRule: string;
    doNotRecreateTaskWhen: string[];
    recreateTaskOnlyWhen: string[];
    maxAutomaticRecreateAttempts: number;
    afterRepairBudgetRule: string;
  };
  url: string;
  finalUrl: string;
  title: string;
  capturedAt: string;
  goal?: string;
  recommendedCandidateId?: string;
  screenshot?: RecognizedAgentScreenshot;
  candidates: RecognizedCandidate[];
  searchPlan?: RecognizedSearchPlan;
  popupDismissals?: PageRecognitionResult['popupDismissals'];
  savedSession?: PageRecognitionResult['savedSession'];
}

interface AgentPlan {
  schemaVersion?: string;
  context?: RecognizeAgentContext;
  contextFile?: string;
  candidateId?: string;
  selection?: {
    candidateId?: string;
    fields?: AgentFieldPlan[];
    pagination?: RecognizedPagination | null | false;
    detail?: AgentDetailPlan | null | false;
  };
  fields?: AgentFieldPlan[];
  pagination?: RecognizedPagination | null | false;
  detail?: AgentDetailPlan | null | false;
  taskId?: string;
  taskName?: string;
}

interface AgentPlanPreview {
  schemaVersion: 'octopus.recognize.agent-preview.v1';
  pass: boolean;
  candidateId: string;
  candidate: {
    id: string;
    type: RecognizedCandidate['type'];
    title: string;
    confidence: number;
    itemCount: number;
    diagnostics?: RecognizedCandidate['diagnostics'];
  };
  fields: AgentPreviewField[];
  detail?: {
    mode: RecognizedDetailPlan['mode'];
    urlField: string;
    sampleUrls: string[];
    fields: AgentPreviewField[];
  };
  pagination?: RecognizedPagination;
  warnings: string[];
  recommendedFixes: string[];
}

interface AgentPreviewField {
  name: string;
  sourceName?: string;
  kind: RecognizedField['kind'];
  xpath: string;
  samples: string[];
  diagnostics?: RecognizedFieldDiagnostics;
  warnings: string[];
}

interface AgentDetailPlan {
  mode?: RecognizedDetailPlan['mode'];
  urlField?: string;
  sampleUrls?: string[];
  fields?: AgentFieldPlan[];
}

export async function recognizeCommand(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const quiet = hasFlag(args, '--quiet');
  if (hasFlag(args, '--screenshot') || hasFlag(args, '--agent-screenshot')) {
    return printUsageError(
      json,
      'recognize 已默认为 Agent/LLM 工作流生成全页长截图，不再支持 --screenshot 或 --agent-screenshot。',
      '用法: octopus recognize URL --prepare-agent --json --goal "采集目标" --output context.json',
      'USAGE_ERROR'
    );
  }
  if (valueAfter(args, '--preview-agent-plan')) {
    return previewAgentPlanCommand(args, json, quiet);
  }
  if (valueAfter(args, '--apply-agent-plan')) {
    return applyAgentPlanCommand(args, json, quiet);
  }
  const url = firstPositionalArg(args, [
    '--chrome-path',
    '--wait-ms',
    '--scrolls',
    '--timeout-ms',
    '--max-candidates',
    '--select',
    '--output',
    '--task-id',
    '--task-name',
    '--goal',
    '--session-name',
    '--input',
    '--query',
    '--submit',
    '--agent-context',
    '--agent-command',
    '--apply-agent-plan',
    '--preview-agent-plan',
    '--api-base-url'
  ]);
  if (!url) {
    return printUsageError(
      json,
      '错误: 缺少 URL',
      '用法: octopus recognize URL --auto|--manual [--goal "列表"] [--output task.json] [--json]',
      'USAGE_ERROR'
    );
  }
  if (!isLocalChromeRuntimeSupported()) {
    return printUsageError(json, LINUX_ARM64_UNSUPPORTED_MESSAGE, undefined, LINUX_ARM64_UNSUPPORTED_CODE);
  }
  if (hasFlag(args, '--auto') && hasFlag(args, '--manual')) {
    return printUsageError(
      json,
      'recognize 只能选择一种模式：--auto 全自动，--manual 全手动。',
      '用法: octopus recognize URL --auto|--manual [--goal "列表"]',
      'USAGE_ERROR'
    );
  }
  if (hasFlag(args, '--agent') && !valueAfter(args, '--agent-command') && !process.env.OCTOPUS_AGENT_COMMAND) {
    return printUsageError(
      json,
      '缺少 Agent 命令：请传 --agent-command，或设置 OCTOPUS_AGENT_COMMAND。',
      '示例: octopus recognize URL --agent --agent-command "node make-plan.mjs" --output task.json',
      'USAGE_ERROR'
    );
  }
  try {
    const agentScreenshotPath = resolveAgentScreenshotPath(args, url);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const chromeProgress = createChromeProgressReporter({
      enabled: !json && !quiet && !valueAfter(args, '--chrome-path'),
      write: (message) => originalStderrWrite(message)
    });
    const result = await recognizePage({
      url,
      input: parseRecognizeInput(args),
      submit: valueAfter(args, '--submit'),
      goal: valueAfter(args, '--goal'),
      chromePath: valueAfter(args, '--chrome-path'),
      manual: hasFlag(args, '--manual'),
      interactive: hasFlag(args, '--interactive') || hasFlag(args, '--manual'),
      waitMs: parsePositiveInt(valueAfter(args, '--wait-ms'), 1500),
      scrolls: parsePositiveInt(valueAfter(args, '--scrolls'), 10),
      timeoutMs: parsePositiveInt(valueAfter(args, '--timeout-ms'), 45_000),
      maxCandidates: parsePositiveInt(valueAfter(args, '--max-candidates'), 8),
      llmRank: hasFlag(args, '--llm-rank'),
      legacyRecognizer: hasFlag(args, '--legacy-recognizer') || process.env.OCTOPUS_LEGACY_RECOGNIZER === '1',
      apiBaseUrl: valueAfter(args, '--api-base-url'),
      dismissPopups: !hasFlag(args, '--no-dismiss-popups'),
      saveSession: hasFlag(args, '--save-session'),
      sessionName: valueAfter(args, '--session-name'),
      agentScreenshotPath,
      onChromeStatus: chromeProgress?.onStatus
    });

    if (hasFlag(args, '--agent')) {
      return runInlineAgentRecognize({ args, result, json, quiet });
    }

    if (hasFlag(args, '--prepare-agent')) {
      const context = buildAgentContext(result, valueAfter(args, '--goal'));
      const outputFile = valueAfter(args, '--output');
      if (outputFile) await writeFile(resolve(outputFile), `${JSON.stringify(context, null, 2)}\n`, 'utf8');
      if (json && !quiet) printEnvelope(true, outputFile ? { file: resolve(outputFile), agentContext: context } : context);
      else if (!quiet) {
        if (outputFile) console.log(`Agent context: ${resolve(outputFile)}`);
        else console.log(JSON.stringify(context, null, 2));
      }
      return EXIT_OK;
    }

    const interactiveSelectedIds = result.selectedCandidateIds?.length ? result.selectedCandidateIds : result.selectedCandidateId ? [result.selectedCandidateId] : [];
    const manualTaskChoice = hasFlag(args, '--manual') && !json && !quiet
      ? await chooseManualTaskOutput(result, valueAfter(args, '--output'))
      : undefined;
    const selectedId = valueAfter(args, '--select') ?? interactiveSelectedIds[0] ?? (hasFlag(args, '--auto') ? recommendedCandidate(result.candidates)?.id : undefined);
    const outputFile = manualTaskChoice?.outputFile ?? valueAfter(args, '--output');
    const shouldGenerateTask = manualTaskChoice ? manualTaskChoice.generate : Boolean(selectedId || outputFile);
    if (shouldGenerateTask) {
      if (!selectedId) {
        const message = hasFlag(args, '--interactive') || hasFlag(args, '--manual')
          ? '没有选中采集对象：请在浏览器里点击一个高亮数据组后继续。'
          : '生成任务文件需要 --select candidateId 或 --auto。';
        return printUsageError(json, message, '示例: octopus recognize https://example.com --manual', 'RECOGNIZE_SELECT_REQUIRED');
      }
      const candidate = result.candidates.find((item) => item.id === selectedId);
      if (!candidate) {
        const message = `找不到候选区: ${selectedId}`;
        if (json) printEnvelope(false, undefined, 'RECOGNIZE_CANDIDATE_NOT_FOUND', message);
        else console.error(message);
        return EXIT_OPERATION_FAILED;
      }
      if (candidate.type === 'form') {
        const message = '表单候选区只是搜索/输入入口，不能直接生成采集任务；请打开提交后的结果页，或后续使用 --goal/--input 生成搜索流程。';
        if (json) printEnvelope(false, undefined, 'RECOGNIZE_CANDIDATE_UNSUPPORTED', message);
        else console.error(message);
        return EXIT_OPERATION_FAILED;
      }
      const taskId = valueAfter(args, '--task-id') ?? `recognized_${safeFileName(new URL(result.finalUrl).hostname || 'site')}`;
      const taskName = valueAfter(args, '--task-name') ?? `Recognized ${new URL(result.finalUrl).hostname || result.finalUrl}`;
      const task = buildTaskFromCandidate({ url: result.finalUrl, taskId, taskName, candidate, popupDismissals: result.popupDismissals, session: result.savedSession, searchPlan: result.searchPlan });
      const file = outputFile ? resolve(outputFile) : resolveAvailableRecognizedTaskFile(taskId);
      await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
      const data = { ...result, generatedTask: { file, taskId, taskName, candidateId: candidate.id, fieldNames: task.fieldNames, pagination: candidate.pagination, session: task.recognition.session } };
      if (json && !quiet) printEnvelope(true, data);
      else if (!quiet) {
        printRecognizeHuman(result);
        console.log('');
        console.log(`Generated task: ${file}`);
        if (task.recognition.session) {
          console.log(`Saved session: ${task.recognition.session.name} (${task.recognition.session.cookieCount} cookies, cookies-only)`);
        }
        if (task.recognition.detailPlan) {
          console.log(`Detail plan: ${detailModeLabel(task.recognition.detailPlan.mode)} (${task.recognition.detailPlan.fields.map((field) => field.name).join(', ') || 'no fields'})`);
        }
        console.log(`Validate: octopus task validate ${taskId} --task-file ${file}`);
        console.log(`Run: octopus run ${taskId} --task-file ${file}`);
      }
      return EXIT_OK;
    }

    if (json && !quiet) printEnvelope(true, { ...result, recommendedCandidateId: recommendedCandidate(result.candidates)?.id });
    else if (!quiet) printRecognizeHuman(result);
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof RecognitionLoginRequiredError ? 'LOGIN_SESSION_REQUIRED' : 'RECOGNIZE_FAILED';
    if (json) printEnvelope(false, undefined, code, message);
    else console.error(`识别失败: ${message}`);
    return EXIT_RUNTIME_FAILED;
  }
}

export async function runInlineAgentRecognizeForTesting(options: {
  args: string[];
  result: PageRecognitionResult;
  json?: boolean;
  quiet?: boolean;
}): Promise<number> {
  return runInlineAgentRecognize({
    args: options.args,
    result: options.result,
    json: options.json ?? false,
    quiet: options.quiet ?? false
  });
}

async function runInlineAgentRecognize(options: {
  args: string[];
  result: PageRecognitionResult;
  json: boolean;
  quiet: boolean;
}): Promise<number> {
  const command = valueAfter(options.args, '--agent-command') ?? process.env.OCTOPUS_AGENT_COMMAND;
  if (!command) {
    return printUsageError(
      options.json,
      '缺少 Agent 命令：请传 --agent-command，或设置 OCTOPUS_AGENT_COMMAND。',
      '示例: octopus recognize URL --agent --agent-command "node make-plan.mjs" --output task.json',
      'USAGE_ERROR'
    );
  }

  let workDir: string | undefined;
  try {
    const context = buildAgentContext(options.result, valueAfter(options.args, '--goal'));
    workDir = await mkdtemp(join(tmpdir(), 'octopus-agent-'));
    const contextFile = join(workDir, 'context.json');
    const planFile = join(workDir, 'plan.json');
    await writeFile(contextFile, `${JSON.stringify(context, null, 2)}\n`, 'utf8');

    const agent = await runAgentCommand({
      command,
      contextFile,
      planFile,
      goal: valueAfter(options.args, '--goal')
    });
    const plan = agent.plan;
    const preview = previewAgentPlan({ context, plan });

    if (!preview.pass && !hasFlag(options.args, '--allow-agent-risk')) {
      if (options.json) {
        printEnvelope(false, undefined, 'AGENT_PLAN_RISK', 'Agent plan 预览未通过；使用 --allow-agent-risk 才能强制生成。');
      } else {
        if (!options.quiet) printAgentPlanPreview(preview, context.screenshot);
        console.error('Agent plan 预览未通过；使用 --allow-agent-risk 才能强制生成。');
      }
      return EXIT_OPERATION_FAILED;
    }

    if (!hasFlag(options.args, '--yes') && !await confirmAgentPreview(preview, context.screenshot, options.quiet)) {
      if (options.json) printEnvelope(false, undefined, 'AGENT_PLAN_NOT_CONFIRMED', 'Agent plan 未确认，已取消生成任务。');
      else if (!options.quiet) console.log('已取消生成任务。');
      return EXIT_OPERATION_FAILED;
    }

    const taskId = valueAfter(options.args, '--task-id') ?? plan.taskId ?? `recognized_${safeFileName(new URL(context.finalUrl).hostname || 'site')}`;
    const taskName = valueAfter(options.args, '--task-name') ?? plan.taskName ?? `Recognized ${new URL(context.finalUrl).hostname || context.finalUrl}`;
    const task = buildTaskFromAgentPlan({ context, plan, taskId, taskName });
    const outputFile = valueAfter(options.args, '--output');
    const file = outputFile ? resolve(outputFile) : resolveAvailableRecognizedTaskFile(taskId);
    await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8');

    const data = {
      generatedTask: {
        file,
        taskId,
        taskName,
        candidateId: task.recognition.candidateId,
        fieldNames: task.fieldNames,
        selectionSource: 'inline_agent'
      },
      preview,
      agentFiles: agentFiles(options.args, contextFile, planFile)
    };
    if (options.json && !options.quiet) printEnvelope(true, data);
    else if (!options.quiet) {
      console.log(`Generated task: ${file}`);
      console.log(`Validate: octopus task validate ${taskId} --task-file ${file}`);
      console.log(`Run: octopus run ${taskId} --task-file ${file}`);
      if (hasFlag(options.args, '--keep-agent-files')) {
        console.log(`Agent context: ${contextFile}`);
        console.log(`Agent plan: ${planFile}`);
      }
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.json) printEnvelope(false, undefined, 'INLINE_AGENT_FAILED', message);
    else console.error(`Agent 生成任务失败: ${message}`);
    return EXIT_OPERATION_FAILED;
  } finally {
    if (workDir && !hasFlag(options.args, '--keep-agent-files')) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

async function applyAgentPlanCommand(args: string[], json: boolean, quiet: boolean): Promise<number> {
  const planFile = valueAfter(args, '--apply-agent-plan');
  if (!planFile) return printUsageError(json, '缺少 Agent plan 文件。', '用法: octopus recognize --apply-agent-plan plan.json --agent-context context.json --output task.json', 'USAGE_ERROR');
  try {
    const planPath = resolve(planFile);
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as AgentPlan;
    const context = await resolveAgentContext(plan, valueAfter(args, '--agent-context'), dirname(planPath));
    const taskId = valueAfter(args, '--task-id') ?? plan.taskId ?? `recognized_${safeFileName(new URL(context.finalUrl).hostname || 'site')}`;
    const taskName = valueAfter(args, '--task-name') ?? plan.taskName ?? `Recognized ${new URL(context.finalUrl).hostname || context.finalUrl}`;
    const task = buildTaskFromAgentPlan({ context, plan, taskId, taskName });
    const outputFile = valueAfter(args, '--output');
    const file = outputFile ? resolve(outputFile) : resolveAvailableRecognizedTaskFile(taskId);
    await writeFile(file, `${JSON.stringify(task, null, 2)}\n`, 'utf8');
    const data = {
      generatedTask: {
        file,
        taskId,
        taskName,
        candidateId: task.recognition.candidateId,
        fieldNames: task.fieldNames,
        selectionSource: 'external_ai'
      }
    };
    if (json && !quiet) printEnvelope(true, data);
    else if (!quiet) {
      console.log(`Generated task: ${file}`);
      console.log(`Agent plan: ${planPath}`);
      console.log(`Validate: octopus task validate ${taskId} --task-file ${file}`);
      console.log(`Run: octopus run ${taskId} --task-file ${file}`);
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printEnvelope(false, undefined, 'AGENT_PLAN_FAILED', message);
    else console.error(`应用 Agent plan 失败: ${message}`);
    return EXIT_OPERATION_FAILED;
  }
}

async function runAgentCommand(options: {
  command: string;
  contextFile: string;
  planFile: string;
  goal?: string;
}): Promise<{ plan: AgentPlan; stdout: string }> {
  const child = spawn(options.command, {
    shell: true,
    env: {
      ...process.env,
      OCTOPUS_AGENT_CONTEXT: options.contextFile,
      OCTOPUS_AGENT_PLAN: options.planFile,
      ...(options.goal ? { OCTOPUS_AGENT_GOAL: options.goal } : {})
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  if (code !== 0) {
    throw new Error(`Agent command failed with exit code ${code ?? 'unknown'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`);
  }

  const rawPlan = existsSync(options.planFile)
    ? await readFile(options.planFile, 'utf8')
    : stdout;
  if (!rawPlan.trim()) {
    throw new Error('Agent command did not write a plan to OCTOPUS_AGENT_PLAN or stdout.');
  }
  const plan = JSON.parse(rawPlan) as AgentPlan;
  if (!existsSync(options.planFile)) await writeFile(options.planFile, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  return { plan, stdout };
}

async function confirmAgentPreview(preview: AgentPlanPreview, screenshot: RecognizedAgentScreenshot | undefined, quiet: boolean): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (!quiet) {
    printAgentPlanPreview(preview, screenshot);
    console.log('');
  }
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: '是否按 Agent plan 生成采集任务？',
    choices: [
      { title: '生成任务', value: 'apply' },
      { title: '取消', value: 'cancel' }
    ],
    initial: 0
  });
  return response.action === 'apply';
}

function agentFiles(args: string[], contextFile: string, planFile: string): { contextFile?: string; planFile?: string } | undefined {
  if (!hasFlag(args, '--keep-agent-files')) return undefined;
  return { contextFile, planFile };
}

async function previewAgentPlanCommand(args: string[], json: boolean, quiet: boolean): Promise<number> {
  const planFile = valueAfter(args, '--preview-agent-plan');
  if (!planFile) return printUsageError(json, '缺少 Agent plan 文件。', '用法: octopus recognize --preview-agent-plan plan.json --agent-context context.json --json', 'USAGE_ERROR');
  try {
    const planPath = resolve(planFile);
    const plan = JSON.parse(await readFile(planPath, 'utf8')) as AgentPlan;
    const context = await resolveAgentContext(plan, valueAfter(args, '--agent-context'), dirname(planPath));
    const preview = previewAgentPlan({ context, plan });
    if (json && !quiet) printEnvelope(true, preview);
    else if (!quiet) printAgentPlanPreview(preview, context.screenshot);
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) printEnvelope(false, undefined, 'AGENT_PLAN_PREVIEW_FAILED', message);
    else console.error(`预览 Agent plan 失败: ${message}`);
    return EXIT_OPERATION_FAILED;
  }
}

async function resolveAgentContext(plan: AgentPlan, contextFile: string | undefined, planDir: string): Promise<RecognizeAgentContext> {
  if (plan.context) return assertAgentContext(plan.context);
  const file = contextFile ?? plan.contextFile;
  if (!file) throw new Error('Agent plan 没有内嵌 context；请传 --agent-context context.json，或在 plan.context 中内嵌上下文。');
  const resolved = resolve(planDir, file);
  return assertAgentContext(JSON.parse(await readFile(resolved, 'utf8')) as RecognizeAgentContext);
}

function assertAgentContext(value: RecognizeAgentContext): RecognizeAgentContext {
  if (value?.schemaVersion !== 'octopus.recognize.agent-context.v1') throw new Error('无效的 Agent context schemaVersion。');
  if (!Array.isArray(value.candidates)) throw new Error('无效的 Agent context：缺少 candidates。');
  return value;
}

export function buildAgentContextForTesting(result: PageRecognitionResult, goal?: string): RecognizeAgentContext {
  return buildAgentContext(result, goal);
}

export function previewAgentPlanForTesting(options: { context: RecognizeAgentContext; plan: AgentPlan }): AgentPlanPreview {
  return previewAgentPlan(options);
}

function buildAgentContext(result: PageRecognitionResult, goal?: string): RecognizeAgentContext {
  const recommended = recommendedCandidate(result.candidates);
  return {
    schemaVersion: 'octopus.recognize.agent-context.v1',
    instruction: [
      'You are choosing a web scraping task plan from deterministic candidates.',
      'Select candidateId for the primary data region. Optionally filter or rename fields.',
      'For detail scraping, return detail.mode=list_with_detail or detail_only, urlField, and detail fields.',
      'Always use the user goal, full-page screenshot, candidate bounding boxes, diagnostics, and sample rows together when judging candidates.',
      'Use diagnostics.matchCount, textLength, paragraphCount, hasStyleNoise, boundingBox, sampleRows, and screenshot to avoid narrow, noisy, or sidebar XPath.',
      'Before applying a task, run --preview-agent-plan and revise fields whose warnings say content is short, CSS noise exists, or XPath matches multiple elements.',
      'Do not invent XPath when an existing candidate field can be reused. Ignore ads, sidebars, navigation, and boilerplate.'
    ].join(' '),
    decisionPolicy: {
      requiredInputs: [
        'context.goal',
        'context.screenshot.path',
        'candidate.boundingBox or candidate.layout.boundingBox',
        'candidate.sampleRows',
        'candidate.fields',
        'candidate.diagnostics',
        'candidate.pagination'
      ],
      rankingRule: 'Choose the candidate that best matches the user goal and the visible main content in the full-page screenshot. Text samples alone are insufficient when layout, sidebars, ads, or pagination are ambiguous.',
      recommendedCandidateRule: 'recommendedCandidateId is a deterministic hint, not a final answer. Override it when screenshot/layout/diagnostics/sampleRows show a better match for the user goal.',
      paginationRule: 'Only keep pagination when the candidate has explicit pagination evidence that matches the visible page controls or a real scroll-loading behavior; disable pagination when the screenshot shows a footer pager or no continuation control for the selected region.',
      searchRule: 'When the user goal describes a search/query keyword, use searchPlan and recognized submit controls from context instead of treating the blank search homepage as the extraction target.'
    },
    resultValidationPolicy: {
      normalPartialDataRule: 'Real list pages often contain heterogeneous records, ads, sponsored cards, topic blocks, recommendation modules, or rows where optional fields are legitimately absent. Isolated missing values are normal partial data, not task failure.',
      doNotRecreateTaskWhen: [
        'Only an isolated row or small minority of rows is missing optional fields while the main rows extract correctly.',
        'The sparse rows visually correspond to ads, promoted content, topic cards, recommendation blocks, separators, or other non-primary records.',
        'The selected candidate, search action, pagination behavior, and core fields still match the user goal.',
        'A rerun would only try to force every heterogeneous page item into one uniform schema.'
      ],
      recreateTaskOnlyWhen: [
        'Core fields required by the user goal are missing for most representative rows that should contain them.',
        'Extracted rows clearly come from the wrong region such as navigation, sidebar, footer, ads, or an unrelated list.',
        'Search, login dismissal, or pagination is structurally wrong and prevents reaching the target data.',
        'Preview warnings plus run evidence show a systematic selector issue, not natural per-row sparsity.'
      ],
      maxAutomaticRecreateAttempts: 1,
      afterRepairBudgetRule: 'After one structural repair attempt, stop recreating tasks automatically. Report partial-data evidence and ask for user direction only if a different target or stricter completeness requirement is needed.'
    },
    url: result.url,
    finalUrl: result.finalUrl,
    title: result.title,
    capturedAt: result.capturedAt,
    ...(goal ? { goal } : {}),
    ...(recommended ? { recommendedCandidateId: recommended.id } : {}),
    ...(result.agentScreenshot ? { screenshot: result.agentScreenshot } : {}),
    ...(result.searchPlan ? { searchPlan: result.searchPlan } : {}),
    candidates: result.candidates,
    ...(result.popupDismissals?.length ? { popupDismissals: result.popupDismissals } : {}),
    ...(result.savedSession ? { savedSession: result.savedSession } : {})
  };
}

function previewAgentPlan(options: { context: RecognizeAgentContext; plan: AgentPlan }): AgentPlanPreview {
  const candidateId = options.plan.selection?.candidateId ?? options.plan.candidateId;
  if (!candidateId) throw new Error('Agent plan 缺少 selection.candidateId。');
  const base = options.context.candidates.find((candidate) => candidate.id === candidateId);
  if (!base) throw new Error(`Agent plan 指定的候选区不存在: ${candidateId}`);
  if (base.type === 'form') throw new Error('表单候选区不能直接生成采集任务。');
  const candidate = applyAgentPlanToCandidate(base, options.plan);
  const warnings: string[] = [];
  const recommendedFixes: string[] = [];
  const fields = previewFields(candidate.fields, base.fields);
  const detailFields = candidate.detailPlan ? previewFields(candidate.detailPlan.fields, base.detailPlan?.fields ?? []) : [];
  collectAgentPreviewWarnings(warnings, recommendedFixes, candidate, fields, detailFields);
  return {
    schemaVersion: 'octopus.recognize.agent-preview.v1',
    candidateId: candidate.id,
    candidate: {
      id: candidate.id,
      type: candidate.type,
      title: candidate.title,
      confidence: candidate.confidence,
      itemCount: candidate.itemCount,
      ...(candidate.diagnostics ? { diagnostics: candidate.diagnostics } : {})
    },
    fields,
    ...(candidate.detailPlan ? {
      detail: {
        mode: candidate.detailPlan.mode,
        urlField: candidate.detailPlan.urlField,
        sampleUrls: candidate.detailPlan.sampleUrls,
        fields: detailFields
      }
    } : {}),
    ...(candidate.pagination ? { pagination: candidate.pagination } : {}),
    warnings: Array.from(new Set(warnings)),
    recommendedFixes: Array.from(new Set(recommendedFixes)),
    pass: !hasBlockingAgentPreviewRisk(fields, detailFields)
  };
}

function previewFields(fields: RecognizedField[], sourceFields: RecognizedField[]): AgentPreviewField[] {
  return fields.map((field) => {
    const source = sourceFields.find((item) => item === field || item.name === field.name || item.xpath === field.xpath);
    const diagnostics = field.diagnostics ?? source?.diagnostics;
    return {
      name: field.name,
      ...(source && source.name !== field.name ? { sourceName: source.name } : {}),
      kind: field.kind,
      xpath: field.xpath,
      samples: field.samples.slice(0, 3),
      ...(diagnostics ? { diagnostics } : {}),
      warnings: diagnostics?.warnings ?? []
    };
  });
}

function collectAgentPreviewWarnings(
  warnings: string[],
  recommendedFixes: string[],
  candidate: RecognizedCandidate,
  fields: AgentPreviewField[],
  detailFields: AgentPreviewField[]
): void {
  if (candidate.diagnostics?.warnings.length) warnings.push(...candidate.diagnostics.warnings.map((item) => `candidate: ${item}`));
  for (const field of [...fields, ...detailFields]) {
    const prefix = detailFields.includes(field) ? `detail.${field.name}` : field.name;
    for (const warning of field.warnings) warnings.push(`${prefix}: ${warning}`);
    if (field.diagnostics?.hasStyleNoise) {
      recommendedFixes.push(`${prefix}: 当前 XPath 可能选到了 style/css 容器，改选正文可见容器。`);
    }
    if (isContentPreviewField(field) && (field.diagnostics?.textLength ?? maxSampleLength(field.samples)) < 300) {
      recommendedFixes.push(`${prefix}: 正文长度偏短，优先选择 article/main 下包含多段 <p> 的父容器。`);
    }
    if (isContentPreviewField(field) && (field.diagnostics?.paragraphCount ?? 2) <= 1) {
      recommendedFixes.push(`${prefix}: 正文段落数偏少，可能只选中了单段正文，需要改成完整正文容器。`);
    }
    if ((field.diagnostics?.matchCount ?? 1) > 1) {
      recommendedFixes.push(`${prefix}: XPath 命中多个元素，若运行时只取第一个，应改成父容器 XPath 或明确合并多段文本。`);
    }
  }
  if (!candidate.detailPlan && fields.some((field) => field.kind === 'href' || field.name === 'url')) {
    warnings.push('plan has list URL fields but no detail plan');
    recommendedFixes.push('如果目标包含详情正文，请添加 detail.mode=list_with_detail、urlField=url 和 detail.fields。');
  }
}

function hasBlockingAgentPreviewRisk(fields: AgentPreviewField[], detailFields: AgentPreviewField[]): boolean {
  return [...fields, ...detailFields].some((field) => {
    if (!isContentPreviewField(field)) return false;
    const diagnostics = field.diagnostics;
    const textLength = diagnostics?.textLength ?? maxSampleLength(field.samples);
    const paragraphCount = diagnostics?.paragraphCount ?? 2;
    return diagnostics?.hasStyleNoise || textLength < 300 || paragraphCount <= 1;
  });
}

function isContentPreviewField(field: AgentPreviewField): boolean {
  return /(^|_)(content|body|article|正文)(_|$)/i.test(field.name)
    || /(^|_)(content|body|article|正文)(_|$)/i.test(field.sourceName ?? '');
}

function maxSampleLength(samples: string[]): number {
  return samples.reduce((max, sample) => Math.max(max, String(sample ?? '').length), 0);
}

export function buildTaskFromAgentPlan(options: {
  context: RecognizeAgentContext;
  plan: AgentPlan;
  taskId: string;
  taskName: string;
}) {
  const candidateId = options.plan.selection?.candidateId ?? options.plan.candidateId;
  if (!candidateId) throw new Error('Agent plan 缺少 selection.candidateId。');
  const base = options.context.candidates.find((candidate) => candidate.id === candidateId);
  if (!base) throw new Error(`Agent plan 指定的候选区不存在: ${candidateId}`);
  if (base.type === 'form') throw new Error('表单候选区不能直接生成采集任务。');
  const candidate = applyAgentPlanToCandidate(base, options.plan);
  return buildTaskFromCandidate({
    url: options.context.finalUrl,
    taskId: options.taskId,
    taskName: options.taskName,
    candidate,
    popupDismissals: options.context.popupDismissals,
    session: options.context.savedSession,
    searchPlan: options.context.searchPlan
  });
}

function applyAgentPlanToCandidate(candidate: RecognizedCandidate, plan: AgentPlan): RecognizedCandidate {
  const selection = plan.selection ?? {};
  const fieldsPlan = selection.fields ?? plan.fields;
  const detailPlan = selection.detail !== undefined ? selection.detail : plan.detail;
  const paginationPlan = selection.pagination !== undefined ? selection.pagination : plan.pagination;
  return {
    ...candidate,
    fields: fieldsPlan ? applyAgentFieldPlan(candidate.fields, fieldsPlan, 'field') : candidate.fields,
    ...(paginationPlan !== undefined ? { pagination: normalizeAgentPagination(paginationPlan) } : {}),
    ...(detailPlan !== undefined ? { detailPlan: normalizeAgentDetailPlan(candidate, detailPlan) } : {})
  };
}

function applyAgentFieldPlan(fields: RecognizedField[], plan: AgentFieldPlan[], fallbackPrefix: string): RecognizedField[] {
  return plan.map((item, index) => {
    if (typeof item === 'string') {
      const field = fields.find((candidate) => candidate.name === item);
      if (!field) throw new Error(`Agent plan 引用了不存在的字段: ${item}`);
      return field;
    }
    const source = item.source ?? item.name;
    const sourceField = source ? fields.find((field) => field.name === source) : undefined;
    if (!sourceField && !item.xpath) throw new Error(`Agent plan 字段缺少 source 或 xpath: ${item.as ?? item.name ?? `${fallbackPrefix}_${index + 1}`}`);
    return {
      ...(sourceField ?? {
        kind: item.kind ?? 'text',
        selector: item.selector ?? '',
        xpath: item.xpath ?? '',
        samples: item.samples ?? []
      }),
      name: item.as ?? item.name ?? sourceField?.name ?? `${fallbackPrefix}_${index + 1}`,
      ...(item.kind ? { kind: item.kind } : {}),
      ...(item.selector ? { selector: item.selector } : {}),
      ...(item.xpath ? { xpath: item.xpath } : {}),
      ...(item.relativeXPath ? { relativeXPath: item.relativeXPath } : {}),
      ...(item.samples ? { samples: item.samples } : {}),
      ...(item.operations ? { operations: item.operations } : {})
    };
  });
}

function normalizeAgentPagination(value: RecognizedPagination | null | false | undefined): RecognizedPagination | undefined {
  if (!value) return undefined;
  return {
    type: value.type,
    xpath: value.xpath ?? '',
    text: value.text ?? '',
    confidence: value.confidence ?? 0.9,
    isAjax: value.isAjax ?? value.type !== 'next_page',
    scope: value.scope ?? 'global',
    ...(value.revealByScroll ? { revealByScroll: true } : {}),
    reasons: value.reasons?.length ? value.reasons : ['selected by external agent plan']
  };
}

function normalizeAgentDetailPlan(candidate: RecognizedCandidate, value: AgentDetailPlan | null | false | undefined): RecognizedDetailPlan | undefined {
  if (!value || value.mode === 'list_only') return undefined;
  const existing = candidate.detailPlan;
  const mode = value.mode ?? existing?.mode ?? 'list_with_detail';
  const existingFields = existing?.fields ?? [];
  const fields = value.fields
    ? applyAgentFieldPlan(existingFields, value.fields, 'detail_field')
    : existingFields;
  if (!fields.length) throw new Error('Agent plan 要求采详情页，但没有提供 detail.fields，也没有可复用的详情字段。');
  return {
    mode,
    urlField: value.urlField ?? existing?.urlField ?? 'url',
    sampleUrls: value.sampleUrls ?? existing?.sampleUrls ?? sampleUrlsForCandidate(candidate),
    fields,
    sampleRows: [Object.fromEntries(fields.map((field) => [field.name, field.samples[0] ?? '']))],
    templateCount: fields.length ? 1 : 0,
    status: 'planned',
    reasons: ['selected by external agent plan']
  };
}

function sampleUrlsForCandidate(candidate: RecognizedCandidate): string[] {
  const urlField = candidate.fields.find((field) => field.name === 'url' && field.kind === 'href')
    ?? candidate.fields.find((field) => field.kind === 'href');
  return Array.from(new Set([
    ...candidate.sampleRows.map((row) => typeof row.url === 'string' ? row.url : ''),
    ...(urlField?.samples ?? [])
  ].filter((value) => /^https?:\/\//i.test(value)))).slice(0, 3);
}

async function chooseManualTaskOutput(
  result: Awaited<ReturnType<typeof recognizePage>>,
  providedOutputFile: string | undefined
): Promise<{ generate: boolean; outputFile?: string } | undefined> {
  const selected = result.selectedCandidateIds?.length || result.selectedCandidateId;
  if (!selected || !process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: '是否生成采集任务文件？',
    choices: [
      { title: providedOutputFile ? `生成到 ${providedOutputFile}` : '生成到默认文件 recognized_<host>.json', value: 'default' },
      { title: '输入文件名', value: 'custom' },
      { title: '只查看候选，不生成任务', value: 'preview' }
    ],
    initial: 0
  });
  if (response.action === 'preview') return { generate: false };
  if (response.action === 'custom') {
    const file = await prompts({
      type: 'text',
      name: 'file',
      message: '任务文件名',
      initial: providedOutputFile || 'task.json'
    });
    return file.file ? { generate: true, outputFile: String(file.file) } : { generate: false };
  }
  return { generate: true, outputFile: providedOutputFile };
}

export async function runUrlCommand(url: string | undefined, args: string[]): Promise<number> {
  const allArgs = [url ?? '', ...args].filter(Boolean);
  const json = hasFlag(allArgs, '--json') || hasFlag(allArgs, '--jsonl');
  if (hasFlag(args, '--screenshot') || hasFlag(args, '--agent-screenshot')) {
    return printUsageError(
      json,
      'run-url 已默认为 Agent/LLM 工作流生成全页长截图，不再支持 --screenshot 或 --agent-screenshot。',
      '用法: octopus run-url <url> --auto|--select <candidateId> [--goal <text>] [--input <name=value>] [--max-rows <n>]',
      'USAGE_ERROR'
    );
  }
  if (!url || url.startsWith('-')) {
    return printUsageError(
      json,
      '错误: 缺少 URL',
      '用法: octopus run-url <url> --goal <text>|--auto [--input <name=value>] [--max-rows <n>] [--json|--jsonl]',
      'USAGE_ERROR'
    );
  }
  if (!isLocalChromeRuntimeSupported()) {
    return printUsageError(json, LINUX_ARM64_UNSUPPORTED_MESSAGE, undefined, LINUX_ARM64_UNSUPPORTED_CODE);
  }

  if (!hasFlag(args, '--auto') && !valueAfter(args, '--select')) {
    return printUsageError(
      json,
      'run-url 需要 --auto 或 --select <candidateId>，避免猜错采集目标。',
      '先运行: octopus recognize <url>',
      'RECOGNIZE_SELECT_REQUIRED'
    );
  }

  const outputDir = await mkdtemp(join(tmpdir(), 'octopus-recognized-task-'));
  const taskFile = join(outputDir, 'task.json');
  const splitArgs = splitRunUrlArgs(args);
  const recognizeArgs = [
    url,
    ...splitArgs.recognizeArgs,
    ...(json ? ['--json'] : []),
    '--quiet',
    '--output',
    taskFile
  ];
  const recognizeExit = await recognizeCommand(recognizeArgs);
  if (recognizeExit !== EXIT_OK) return recognizeExit;

  const task = JSON.parse(await readFile(taskFile, 'utf8')) as { taskId: string };
  return runTask(task.taskId, ['--task-file', taskFile, ...splitArgs.runArgs]);
}

function parseRecognizeInput(args: string[]): Record<string, string> | undefined {
  const input: Record<string, string> = {};
  const query = valueAfter(args, '--query');
  if (query) input.q = query;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--input') continue;
    const raw = args[index + 1];
    if (!raw || raw.startsWith('-')) continue;
    const eq = raw.indexOf('=');
    if (eq === -1) input.q = raw;
    else input[raw.slice(0, eq)] = raw.slice(eq + 1);
  }
  return Object.keys(input).length ? input : undefined;
}

function resolveAgentScreenshotPath(args: string[], url: string): string | undefined {
  if (!hasFlag(args, '--prepare-agent') && !hasFlag(args, '--agent')) return undefined;
  const output = valueAfter(args, '--output');
  if (output) {
    const resolvedOutput = resolve(output);
    const ext = extname(resolvedOutput);
    const base = ext ? resolvedOutput.slice(0, -ext.length) : resolvedOutput;
    return `${base}.fullpage.png`;
  }
  let host = 'page';
  try {
    host = safeFileName(new URL(url).hostname || 'page');
  } catch {
    host = safeFileName(url || 'page');
  }
  return resolve(`recognized_${host}.fullpage.png`);
}

export function resolveAgentScreenshotPathForTesting(args: string[], url: string): string | undefined {
  return resolveAgentScreenshotPath(args, url);
}

export function resolveAvailableRecognizedTaskFile(taskId: string): string {
  const base = resolve(`${safeFileName(taskId)}.json`);
  if (!existsSync(base)) return base;
  const dir = dirname(base);
  const ext = extname(base);
  const name = basename(base, ext);
  for (let index = 1; index < Number.MAX_SAFE_INTEGER; index += 1) {
    const candidate = join(dir, `${name}-${index}${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return base;
}

export function splitRunUrlArgs(args: string[]): { recognizeArgs: string[]; runArgs: string[] } {
  const recognizeValueFlags = new Set([
    '--goal',
    '--input',
    '--query',
    '--submit',
    '--select',
    '--wait-ms',
    '--scrolls',
    '--max-candidates',
    '--task-id',
    '--task-name',
    '--session-name',
    '--agent-command',
    '--api-base-url'
  ]);
  const recognizeBooleanFlags = new Set([
    '--auto',
    '--agent',
    '--yes',
    '--keep-agent-files',
    '--allow-agent-risk',
    '--manual',
    '--interactive',
    '--llm-rank',
    '--no-dismiss-popups',
    '--save-session'
  ]);
  const runValueFlags = new Set(['--output', '--max-rows', '--extension-timeout-ms']);
  const runBooleanFlags = new Set(['--headless', '--disable-image', '--disable-ad', '--debug-bridge', '--detach', '--json', '--jsonl']);
  const sharedValueFlags = new Set(['--chrome-path', '--timeout-ms']);
  const recognizeArgs: string[] = [];
  const runArgs: string[] = [];

  const pushValue = (target: string[], flag: string, value: string | undefined) => {
    target.push(flag);
    if (value !== undefined) target.push(value);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (sharedValueFlags.has(arg)) {
      pushValue(recognizeArgs, arg, value);
      pushValue(runArgs, arg, value);
      index += 1;
      continue;
    }
    if (recognizeValueFlags.has(arg)) {
      pushValue(recognizeArgs, arg, value);
      index += 1;
      continue;
    }
    if (runValueFlags.has(arg)) {
      pushValue(runArgs, arg, value);
      index += 1;
      continue;
    }
    if (recognizeBooleanFlags.has(arg)) {
      recognizeArgs.push(arg);
      continue;
    }
    if (runBooleanFlags.has(arg)) {
      runArgs.push(arg);
      continue;
    }
    runArgs.push(arg);
  }
  return { recognizeArgs, runArgs };
}

function recommendedCandidate(candidates: Awaited<ReturnType<typeof recognizePage>>['candidates']) {
  const usable = candidates.filter((candidate) => candidate.type !== 'form');
  const ranked = usable.length ? usable : candidates;
  return ranked
    .slice()
    .sort((a, b) => (b.goalScore ?? b.confidence) - (a.goalScore ?? a.confidence))[0];
}

function printRecognizeHuman(result: Awaited<ReturnType<typeof recognizePage>>): void {
  console.log(`URL: ${result.finalUrl}`);
  console.log(`Title: ${result.title || '(untitled)'}`);
  console.log('');
  if (!result.candidates.length) {
    console.log('没有识别到可采集候选区。可以尝试增加 --scrolls，或打开搜索/列表结果页后重试。');
    return;
  }
  const selectedIds = result.selectedCandidateIds?.length
    ? result.selectedCandidateIds
    : result.selectedCandidateId ? [result.selectedCandidateId] : [];
  const selectedSet = new Set(selectedIds);
  const visibleCandidates = selectedSet.size
    ? result.candidates.filter((candidate) => selectedSet.has(candidate.id))
    : result.candidates;
  const recommended = selectedSet.size
    ? visibleCandidates[0] ?? recommendedCandidate(result.candidates)
    : recommendedCandidate(result.candidates);
  if (selectedSet.size) {
    console.log(`已选择 ${visibleCandidates.length} 个候选区: ${visibleCandidates.map((candidate) => candidate.id).join(', ')}`);
  } else {
    console.log(`识别到 ${result.candidates.length} 个候选区。候选区不是最终任务，先选你想采的数据。`);
  }
  if (result.popupDismissals?.length) {
    console.log(`已处理弹窗: ${result.popupDismissals.map((item) => `${popupTypeLabel(item.type)}/${item.action}`).join(', ')}`);
  }
  console.log('');
  console.log('建议：');
  if (recommended.type === 'form') {
    console.log('  这个页面主要是搜索/输入入口。先在浏览器打开搜索结果页，再对结果页运行 recognize。');
  } else {
    console.log(`  优先看 [${recommended.id}] ${candidateTypeLabel(recommended.type)}。`);
    console.log(`  生成任务: octopus recognize ${shellArg(result.finalUrl)} --select ${recommended.id} --output task.json`);
    console.log('  注意: task.json 是实际文件名，不要输入尖括号。');
  }
  for (const candidate of visibleCandidates) {
    console.log('');
    const scoreText = candidate.goalScore !== undefined
      ? `匹配度=${formatConfidence(candidate.goalScore)}  置信度=${formatConfidence(candidate.confidence)}`
      : `置信度=${formatConfidence(candidate.confidence)}`;
    console.log(`[${candidate.id}] ${candidateTypeLabel(candidate.type)}  ${scoreText}`);
    console.log(`    ${candidateHint(candidate)}`);
    if (candidate.layout) {
      console.log(`    区域=${candidateLayoutLabel(candidate.layout.role)} 主内容=${formatConfidence(candidate.layout.mainScore)} 链接密度=${formatConfidence(candidate.layout.linkDensity)}`);
    }
    if (candidate.pagination) {
      const paginationMode = candidate.pagination.revealByScroll ? '，先滚动揭露' : '';
      console.log(`    翻页=${paginationLabel(candidate.pagination.type)}${paginationMode} ${candidate.pagination.text ? `(${truncate(candidate.pagination.text, 40)})` : ''}  置信度=${formatConfidence(candidate.pagination.confidence)}`);
    }
    console.log(`    数量=${candidate.itemCount} 字段=${candidate.fields.map((field) => field.name).join(', ')}`);
    const sample = candidate.sampleRows[0];
    if (sample) console.log(`    样例=${formatSample(sample)}`);
    if (candidate.type === 'form') {
      console.log('    下一步: octopus recognize <url> --input wd=关键词');
    } else {
      console.log(`    生成: octopus recognize ${shellArg(result.finalUrl)} --select ${candidate.id} --output task.json`);
    }
  }
}

function printAgentPlanPreview(preview: AgentPlanPreview, screenshot: RecognizedAgentScreenshot | undefined): void {
  console.log(`Agent plan preview: ${preview.candidateId}`);
  console.log(`检查结果: ${preview.pass ? '通过' : '不建议生成任务，需先修正字段'}`);
  console.log(`候选区: ${candidateTypeLabel(preview.candidate.type)}  数量=${preview.candidate.itemCount}  置信度=${formatConfidence(preview.candidate.confidence)}`);
  if (screenshot) console.log(`长截图: ${screenshot.path}`);
  console.log(`列表字段: ${preview.fields.map((field) => field.name).join(', ') || '(none)'}`);
  if (preview.detail) {
    console.log(`详情页: ${detailModeLabel(preview.detail.mode)}  urlField=${preview.detail.urlField}`);
    console.log(`详情字段: ${preview.detail.fields.map((field) => field.name).join(', ') || '(none)'}`);
  }
  if (preview.warnings.length) {
    console.log('');
    console.log('风险:');
    for (const warning of preview.warnings) console.log(`  - ${warning}`);
  }
  if (preview.recommendedFixes.length) {
    console.log('');
    console.log('建议修改:');
    for (const fix of preview.recommendedFixes) console.log(`  - ${fix}`);
  }
}

function paginationLabel(type: string): string {
  if (type === 'next_page') return '点击下一页';
  if (type === 'load_more') return '点击加载更多';
  if (type === 'scroll') return '滚动加载';
  return type;
}

function detailModeLabel(mode: string): string {
  if (mode === 'list_with_detail') return '列表 + 详情页';
  if (mode === 'detail_only') return '只采详情页';
  return '只采列表';
}

function candidateTypeLabel(type: string): string {
  if (type === 'table') return '表格';
  if (type === 'search_results') return '带链接列表/结果列表';
  if (type === 'repeated_card') return '重复卡片/列表';
  if (type === 'link_collection') return '链接集合';
  if (type === 'form') return '搜索/输入框';
  if (type === 'detail') return '详情页';
  return type;
}

function candidateLayoutLabel(role: string): string {
  if (role === 'main') return '主内容';
  if (role === 'sidebar') return '侧边栏';
  if (role === 'header') return '页头';
  if (role === 'footer') return '页脚';
  if (role === 'nav') return '导航';
  if (role === 'ad') return '广告';
  return '未知';
}

function popupTypeLabel(type: string): string {
  if (type === 'login') return '登录';
  if (type === 'cookie') return 'Cookie';
  if (type === 'newsletter') return '订阅';
  if (type === 'ad') return '广告';
  if (type === 'captcha') return '验证码';
  if (type === 'paywall') return '付费墙';
  return '未知';
}

function candidateHint(candidate: Awaited<ReturnType<typeof recognizePage>>['candidates'][number]): string {
  if (candidate.type === 'form') return '这是入口，不是数据列表；适合后续生成“输入关键词并搜索”的流程。';
  if (candidate.type === 'link_collection') return '这通常是导航/分类/相关链接；只有想采链接列表时才选它。';
  if (candidate.type === 'table') return '适合采集表格行数据。';
  if (candidate.type === 'search_results') return '适合采集带链接的文章、商品、搜索结果或信息流列表。';
  if (candidate.type === 'repeated_card') return '适合采集重复出现的卡片、文章、商品或列表项。';
  return candidate.title;
}

function formatConfidence(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatSample(sample: Record<string, string>): string {
  const compact: Record<string, string> = {};
  for (const [key, value] of Object.entries(sample)) {
    compact[key] = truncate(value, 90);
  }
  return JSON.stringify(compact);
}

function truncate(value: string, max: number): string {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1)}...` : normalized;
}

function shellArg(value: string): string {
  if (/^[\w\-./:?=%#]+$/.test(value) && value.length < 140) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
