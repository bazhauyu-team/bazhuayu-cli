import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasFlag, valueAfter } from '../../cli/args.js';
import { printUsageError } from '../../cli/output.js';
import { LINUX_ARM64_UNSUPPORTED_CODE, LINUX_ARM64_UNSUPPORTED_MESSAGE, isLocalChromeRuntimeSupported } from '../../runtime/platform-support.js';
import { EXIT_OK } from '../../types.js';
import { runTask } from '../run.js';
import { splitRunUrlArgs } from './args.js';
import { detectCommand } from './command.js';
import { SKIP_DETECT_CLOUD_SAVE_ENV } from './persist.js';

export async function detectUrlCommand(url: string | undefined, args: string[]): Promise<number> {
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
      '先运行: octopus detect <url>',
      'DETECT_SELECT_REQUIRED'
    );
  }

  const outputDir = await mkdtemp(join(tmpdir(), 'octopus-detected-task-'));
  const taskFile = join(outputDir, 'task.json');
  const splitArgs = splitRunUrlArgs(args);
  const detectArgs = [
    url,
    ...splitArgs.detectArgs,
    ...(json ? ['--json'] : []),
    '--quiet',
    '--output',
    taskFile
  ];
  const previousSkipCloudSave = process.env[SKIP_DETECT_CLOUD_SAVE_ENV];
  process.env[SKIP_DETECT_CLOUD_SAVE_ENV] = '1';
  let detectExit: number;
  try {
    detectExit = await detectCommand(detectArgs);
  } finally {
    if (previousSkipCloudSave === undefined) delete process.env[SKIP_DETECT_CLOUD_SAVE_ENV];
    else process.env[SKIP_DETECT_CLOUD_SAVE_ENV] = previousSkipCloudSave;
  }
  if (detectExit !== EXIT_OK) return detectExit;

  const task = JSON.parse(await readFile(taskFile, 'utf8')) as { taskId: string };
  return runTask(task.taskId, ['--task-file', taskFile, ...splitArgs.runArgs]);
}
