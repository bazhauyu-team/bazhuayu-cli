import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import prompts from 'prompts';
import { firstPositionalArg, hasFlag, parsePositiveInt, valueAfter } from '../../cli/args.js';
import { printEnvelope, printUsageError } from '../../cli/output.js';
import { createChromeProgressReporter } from '../../runtime/chrome-progress.js';
import { buildAgentContext, recommendedCandidate } from '../../runtime/detector/agent-context.js';
import { buildTaskFromApiListCandidate } from '../../runtime/detector/api-list-detector.js';
import { DetectionLoginRequiredError, detectPage } from '../../runtime/detector/page-detector.js';
import type { PageDetectionResult } from '../../runtime/detector/types.js';
import { buildTaskFromCandidate } from '../../runtime/detector/xml.js';
import { LINUX_ARM64_UNSUPPORTED_CODE, LINUX_ARM64_UNSUPPORTED_MESSAGE, isLocalChromeRuntimeSupported } from '../../runtime/platform-support.js';
import { EXIT_OK, EXIT_OPERATION_FAILED, EXIT_RUNTIME_FAILED } from '../../types.js';
import {
  defaultDetectedTaskName,
  parseDetectInput,
  resolveAgentScreenshotPath,
  resolveAvailableDetectedTaskFile,
  validateRunSample
} from './args.js';
import { applyAgentPlanCommand, previewAgentPlanCommand } from './agent-plan-command.js';
import { runInlineAgentDetect } from './agent-runner.js';
import { detailModeLabel, printDetectHuman } from './format.js';
import { persistGeneratedTask } from './persist.js';

export async function detectCommand(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const quiet = hasFlag(args, '--quiet');
  if (hasFlag(args, '--screenshot') || hasFlag(args, '--agent-screenshot')) {
    return printUsageError(
      json,
      'detect 已默认为 Agent/LLM 工作流生成全页长截图，不再支持 --screenshot 或 --agent-screenshot。',
      '用法: octopus detect URL --prepare-agent --json --goal "采集目标" --output context.json',
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
    '--run-sample',
    '--run-output',
    '--api-base-url'
  ]);
  if (!url) {
    return printUsageError(
      json,
      '错误: 缺少 URL',
      '用法: octopus detect URL --auto|--manual [--goal "列表"] [--output task.json] [--json]',
      'USAGE_ERROR'
    );
  }
  if (!isLocalChromeRuntimeSupported()) {
    return printUsageError(json, LINUX_ARM64_UNSUPPORTED_MESSAGE, undefined, LINUX_ARM64_UNSUPPORTED_CODE);
  }
  if (hasFlag(args, '--auto') && hasFlag(args, '--manual')) {
    return printUsageError(
      json,
      'detect 只能选择一种模式：--auto 全自动，--manual 全手动。',
      '用法: octopus detect URL --auto|--manual [--goal "列表"]',
      'USAGE_ERROR'
    );
  }
  if (hasFlag(args, '--agent') && !valueAfter(args, '--agent-command') && !process.env.OCTOPUS_AGENT_COMMAND) {
    return printUsageError(
      json,
      '缺少 Agent 命令：请传 --agent-command，或设置 OCTOPUS_AGENT_COMMAND。',
      '示例: octopus detect URL --agent --agent-command "node make-plan.mjs" --output task.json',
      'USAGE_ERROR'
    );
  }
  if (hasFlag(args, '--run-sample') && !hasFlag(args, '--agent')) {
    return printUsageError(
      json,
      '--run-sample 只支持 detect --agent 工作流。',
      '示例: octopus detect URL --agent --agent-command "node make-plan.mjs" --run-sample 5 --json',
      'USAGE_ERROR'
    );
  }
  const runSampleError = validateRunSample(args);
  if (runSampleError) {
    return printUsageError(
      json,
      runSampleError,
      '用法: octopus detect URL --agent --agent-command <cmd> --run-sample <正整数> [--json]',
      'RUN_SAMPLE_INVALID'
    );
  }
  try {
    const result = await runPageDetection(args, url, json, quiet);

    if (hasFlag(args, '--agent')) {
      return runInlineAgentDetect({ args, result, json, quiet });
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

    return handleDirectDetectResult({ args, result, json, quiet });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof DetectionLoginRequiredError ? 'LOGIN_SESSION_REQUIRED' : 'DETECT_FAILED';
    if (json) printEnvelope(false, undefined, code, message);
    else console.error(`检测失败: ${message}`);
    return EXIT_RUNTIME_FAILED;
  }
}

async function runPageDetection(args: string[], url: string, json: boolean, quiet: boolean): Promise<PageDetectionResult> {
  const agentScreenshotPath = resolveAgentScreenshotPath(args, url);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const chromeProgress = createChromeProgressReporter({
    enabled: !json && !quiet && !valueAfter(args, '--chrome-path'),
    write: (message) => originalStderrWrite(message)
  });
  return detectPage({
    url,
    input: parseDetectInput(args),
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
    legacyDetector: hasFlag(args, '--legacy-detector') || process.env.OCTOPUS_LEGACY_DETECTOR === '1',
    apiBaseUrl: valueAfter(args, '--api-base-url'),
    dismissPopups: !hasFlag(args, '--no-dismiss-popups'),
    saveSession: hasFlag(args, '--save-session'),
    sessionName: valueAfter(args, '--session-name'),
    agentScreenshotPath,
    onChromeStatus: chromeProgress?.onStatus
  });
}

async function handleDirectDetectResult(options: {
  args: string[];
  result: PageDetectionResult;
  json: boolean;
  quiet: boolean;
}): Promise<number> {
  const { args, result, json, quiet } = options;
  const interactiveSelectedIds = result.selectedCandidateIds?.length ? result.selectedCandidateIds : result.selectedCandidateId ? [result.selectedCandidateId] : [];
  const manualTaskChoice = hasFlag(args, '--manual') && !json && !quiet
    ? await chooseManualTaskOutput(result, valueAfter(args, '--output'))
    : undefined;
  const recommendedApi = hasFlag(args, '--auto') ? recommendedApiCandidate(result) : undefined;
  const selectedId = valueAfter(args, '--select') ?? interactiveSelectedIds[0] ?? recommendedApi?.id ?? (hasFlag(args, '--auto') ? recommendedCandidate(result.candidates)?.id : undefined);
  const outputFile = manualTaskChoice?.outputFile ?? valueAfter(args, '--output');
  const shouldGenerateTask = manualTaskChoice ? manualTaskChoice.generate : Boolean(selectedId || outputFile);
  if (shouldGenerateTask) {
    return generateDirectTask({ args, result, selectedId, outputFile, json, quiet });
  }

  if (json && !quiet) printEnvelope(true, { ...result, recommendedCandidateId: recommendedCandidate(result.candidates)?.id });
  else if (!quiet) printDetectHuman(result);
  return EXIT_OK;
}

async function generateDirectTask(options: {
  args: string[];
  result: PageDetectionResult;
  selectedId: string | undefined;
  outputFile: string | undefined;
  json: boolean;
  quiet: boolean;
}): Promise<number> {
  const { args, result, selectedId, outputFile, json, quiet } = options;
  if (!selectedId) {
    const message = hasFlag(args, '--interactive') || hasFlag(args, '--manual')
      ? '没有选中采集对象：请在浏览器里点击一个高亮数据组后继续。'
      : '生成任务文件需要 --select candidateId 或 --auto。';
    return printUsageError(json, message, '示例: octopus detect https://example.com --manual', 'DETECT_SELECT_REQUIRED');
  }
  const apiCandidate = result.apiCandidates?.find((item) => item.id === selectedId);
  if (apiCandidate) {
    const taskId = valueAfter(args, '--task-id') ?? randomUUID();
    const taskName = valueAfter(args, '--task-name') ?? defaultDetectedTaskName(result.finalUrl);
    const task = buildTaskFromApiListCandidate({ url: result.finalUrl, taskId, taskName, candidate: apiCandidate });
    const file = outputFile ? resolve(outputFile) : resolveAvailableDetectedTaskFile(taskId);
    await persistGeneratedTask({ task, file, args, saveToCloud: false });
    const data = { ...result, generatedTask: { file, taskId, taskName, candidateId: apiCandidate.id, fieldNames: task.fieldNames, mode: 'api_list', localOnly: true } };
    if (json && !quiet) printEnvelope(true, data);
    else if (!quiet) {
      printDetectHuman(result);
      console.log('');
      console.log(`Generated API task: ${file}`);
      console.log('Mode: api_list (local run only)');
      console.log(`Validate: octopus task validate ${taskId} --task-file ${file}`);
      console.log(`Run: octopus run ${taskId} --task-file ${file}`);
    }
    return EXIT_OK;
  }
  const candidate = result.candidates.find((item) => item.id === selectedId);
  if (!candidate) {
    const message = `找不到候选区: ${selectedId}`;
    if (json) printEnvelope(false, undefined, 'DETECT_CANDIDATE_NOT_FOUND', message);
    else console.error(message);
    return EXIT_OPERATION_FAILED;
  }
  if (candidate.type === 'form') {
    const message = '表单候选区只是搜索/输入入口，不能直接生成采集任务；请打开提交后的结果页，或后续使用 --goal/--input 生成搜索流程。';
    if (json) printEnvelope(false, undefined, 'DETECT_CANDIDATE_UNSUPPORTED', message);
    else console.error(message);
    return EXIT_OPERATION_FAILED;
  }
  const taskId = valueAfter(args, '--task-id') ?? randomUUID();
  const taskName = valueAfter(args, '--task-name') ?? defaultDetectedTaskName(result.finalUrl);
  const task = buildTaskFromCandidate({ url: result.finalUrl, taskId, taskName, candidate, popupDismissals: result.popupDismissals, session: result.savedSession, searchPlan: result.searchPlan });
  const file = outputFile ? resolve(outputFile) : resolveAvailableDetectedTaskFile(taskId);
  await persistGeneratedTask({ task, file, args });
  const data = { ...result, generatedTask: { file, taskId, taskName, candidateId: candidate.id, fieldNames: task.fieldNames, pagination: candidate.pagination, session: task.detection.session } };
  if (json && !quiet) printEnvelope(true, data);
  else if (!quiet) {
    printDetectHuman(result);
    console.log('');
    console.log(`Generated task: ${file}`);
    if (task.detection.session) {
      console.log(`Saved session: ${task.detection.session.name} (${task.detection.session.cookieCount} cookies, cookies-only)`);
    }
    if (task.detection.detailPlan) {
      console.log(`Detail plan: ${detailModeLabel(task.detection.detailPlan.mode)} (${task.detection.detailPlan.fields.map((field) => field.name).join(', ') || 'no fields'})`);
    }
    console.log(`Validate: octopus task validate ${taskId} --task-file ${file}`);
    console.log(`Run: octopus run ${taskId} --task-file ${file}`);
  }
  return EXIT_OK;
}

function recommendedApiCandidate(result: PageDetectionResult) {
  const api = [...(result.apiCandidates ?? [])].sort((a, b) => b.confidence - a.confidence)[0];
  const dom = recommendedCandidate(result.candidates);
  if (!api) return undefined;
  if (!dom) return api;
  return isWeakDomCandidate(dom) && api.confidence >= 0.72 ? api : undefined;
}

function isWeakDomCandidate(candidate: NonNullable<ReturnType<typeof recommendedCandidate>>): boolean {
  const fieldCount = candidate.fields.filter((field) => field.samples.some((sample) => sample.trim())).length;
  const sampleRowCount = candidate.sampleRows.length;
  const warningCount = candidate.diagnostics?.warnings.length ?? 0;
  const visualCoverage = candidate.diagnostics?.visualCoverage ?? candidate.layout?.visualCoverage ?? 1;
  return candidate.confidence < 0.45
    || fieldCount < 2
    || sampleRowCount < 2
    || visualCoverage < 0.08
    || warningCount >= 3;
}

async function chooseManualTaskOutput(
  result: PageDetectionResult,
  providedOutputFile: string | undefined
): Promise<{ generate: boolean; outputFile?: string } | undefined> {
  const selected = result.selectedCandidateIds?.length || result.selectedCandidateId;
  if (!selected || !process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  const response = await prompts({
    type: 'select',
    name: 'action',
    message: '是否生成采集任务文件？',
    choices: [
      { title: providedOutputFile ? `生成到 ${providedOutputFile}` : '生成到默认文件 detected_<host>.json', value: 'default' },
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

export const recommendedApiCandidateForTesting = recommendedApiCandidate;
