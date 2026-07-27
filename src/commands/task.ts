import { firstPositionalArg, hasFlag, parseCsv, parsePositiveInt, valueAfter } from '../cli/args.js';
import { requireExplicitYes } from '../cli/guardrails.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { ApiRequestError, copyTask, deleteTask, fetchTaskInfo, fetchTaskList, moveTask, renameTask } from '../runtime/api-client.js';
import { API_KEY_ENV, resolveAuth } from '../runtime/auth.js';
import { inspectTask, TaskDefinitionProvider } from '../runtime/task-definition-provider.js';
import { EXIT_OK, EXIT_OPERATION_FAILED, EXIT_UNSUPPORTED_TASK } from '../types.js';
import { printAuthRequired } from './auth.js';

export async function taskList(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) {
    const message = `Authentication required. Run "bazhuayu auth login" or set ${API_KEY_ENV}.`;
    if (json) printEnvelope(false, undefined, 'AUTH_REQUIRED', message);
    else console.error(`认证失败: ${message}`);
    return EXIT_OPERATION_FAILED;
  }

  try {
    const result = await fetchTaskList({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      pageIndex: parsePositiveInt(valueAfter(args, '--page'), 1),
      pageSize: parsePositiveInt(valueAfter(args, '--page-size') ?? valueAfter(args, '--limit'), 20),
      keyword: valueAfter(args, '--keyword'),
      taskIds: parseCsv(valueAfter(args, '--task-ids') ?? valueAfter(args, '--task-id')),
      taskGroup: valueAfter(args, '--task-group'),
      status: valueAfter(args, '--status'),
      taskType: valueAfter(args, '--task-type'),
      isScheduled: valueAfter(args, '--scheduled'),
      templateRegistrationId: valueAfter(args, '--template-registration-id') ?? valueAfter(args, '--template-id'),
      templateVersionId: valueAfter(args, '--template-version-id')
    });

    if (json) {
      printEnvelope(true, result);
      return EXIT_OK;
    }

    console.log(`Tasks: ${result.currentTotal || result.tasks.length}/${result.total}  page=${result.pageIndex} pageSize=${result.pageSize}`);
    console.log(`API: ${result.baseUrl}${result.endpoint}`);
    if (!result.tasks.length) {
      console.log('暂无任务');
      return EXIT_OK;
    }

    for (const task of result.tasks) {
      console.log(formatTaskListLine(task));
    }
    return EXIT_OK;
  } catch (error) {
    const code = error instanceof ApiRequestError ? error.code : 'TASK_LIST_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      printEnvelope(false, undefined, code, message);
    } else {
      console.error(`${code === 'AUTH_INVALID' ? '认证失败' : '获取任务列表失败'}: ${message}`);
      if (error instanceof ApiRequestError && error.body && code !== 'AUTH_INVALID') {
        console.error(`响应: ${error.body}`);
      }
    }
    return EXIT_OPERATION_FAILED;
  }
}

export async function taskShow(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--api-base-url']);
  const json = hasFlag(args, '--json');
  if (!taskId) {
    return printUsageError(json, '错误: 缺少 taskId', '用法: bazhuayu task show <taskId> [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const task = await fetchTaskInfo({ auth: auth.credential, taskId, baseUrl: valueAfter(args, '--api-base-url') });
    if (json) {
      printEnvelope(true, { taskId, task });
    } else {
      console.log(JSON.stringify(task, null, 2));
    }
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '获取任务详情失败', error, 'TASK_SHOW_FAILED');
  }
}

export async function taskCopy(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--api-base-url', '--task-group', '--group-id']);
  const json = hasFlag(args, '--json');
  const groupId = valueAfter(args, '--task-group') ?? valueAfter(args, '--group-id');
  if (!taskId) {
    return printUsageError(json, '错误: 缺少 taskId', '用法: bazhuayu task copy <taskId> [--task-group <groupId>] [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await copyTask({ auth: auth.credential, taskId, groupId, baseUrl: valueAfter(args, '--api-base-url') });
    if (json) printEnvelope(true, { taskId, action: 'copy', ...result });
    else console.log(`Copied task: ${taskId}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '复制任务失败', error, 'TASK_COPY_FAILED');
  }
}

export async function taskRename(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--api-base-url', '--name']);
  const json = hasFlag(args, '--json');
  const name = valueAfter(args, '--name');
  if (!taskId || !name) {
    return printUsageError(json, '错误: 缺少 taskId 或 --name', '用法: bazhuayu task rename <taskId> --name <name> --yes [--json]');
  }
  const guard = requireExplicitYes(args, json, '重命名任务', `taskId=${taskId}`);
  if (guard !== null) return guard;

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await renameTask({ auth: auth.credential, taskId, name, baseUrl: valueAfter(args, '--api-base-url') });
    if (json) printEnvelope(true, { taskId, name, action: 'rename', ...result });
    else console.log(`Renamed task: ${taskId}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '重命名任务失败', error, 'TASK_RENAME_FAILED');
  }
}

export async function taskMove(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--api-base-url', '--task-group', '--group-id']);
  const json = hasFlag(args, '--json');
  const groupId = valueAfter(args, '--task-group') ?? valueAfter(args, '--group-id');
  if (!taskId || !groupId) {
    return printUsageError(json, '错误: 缺少 taskId 或 --task-group', '用法: bazhuayu task move <taskId> --task-group <groupId> --yes [--json]');
  }
  const guard = requireExplicitYes(args, json, '移动任务', `taskId=${taskId}, groupId=${groupId}`);
  if (guard !== null) return guard;

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await moveTask({ auth: auth.credential, taskId, groupId, baseUrl: valueAfter(args, '--api-base-url') });
    if (json) printEnvelope(true, { taskId, groupId, action: 'move', ...result });
    else console.log(`Moved task: ${taskId} -> group ${groupId}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '移动任务失败', error, 'TASK_MOVE_FAILED');
  }
}

export async function taskDelete(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--api-base-url']);
  const json = hasFlag(args, '--json');
  if (!taskId) {
    return printUsageError(json, '错误: 缺少 taskId', '用法: bazhuayu task delete <taskId> --yes [--json]');
  }
  const guard = requireExplicitYes(args, json, '删除任务', `taskId=${taskId}`);
  if (guard !== null) return guard;

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await deleteTask({ auth: auth.credential, taskId, baseUrl: valueAfter(args, '--api-base-url') });
    if (json) printEnvelope(true, { taskId, action: 'delete', ...result });
    else console.log(`Deleted task: ${taskId}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '删除任务失败', error, 'TASK_DELETE_FAILED');
  }
}

export function formatTaskListLine(task: unknown): string {
  const item = task && typeof task === 'object' ? task as Record<string, unknown> : {};
  const taskId = String(item.taskId ?? item.id ?? '');
  const taskName = String(item.taskName ?? item.name ?? '');
  return `  ${taskId}  ${taskName}`;
}

export async function taskInspect(command: string, args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--task-file']);
  const json = hasFlag(args, '--json');
  const taskFile = valueAfter(args, '--task-file');

  if (!taskId) {
    return printUsageError(
      json,
      '错误: 缺少 taskId',
      `用法: bazhuayu task ${command} <taskId> [--task-file <file.json|file.xml|file.otd>] [--json]`
    );
  }

  try {
    const provider = new TaskDefinitionProvider();
    const task = await provider.getTask(taskId, taskFile);
    const inspection = inspectTask(task);

    if (json) {
      printEnvelope(true, inspection);
    } else {
      console.log(`Task: ${inspection.taskId}`);
      console.log(`Name: ${inspection.taskName}`);
      console.log(`Mode: ${inspection.mode}`);
      console.log(`Actions: ${inspection.actionCount} (${inspection.actionTypes.join(', ') || 'none'})`);
      console.log(`Fields: ${inspection.fields.join(', ') || 'none'}`);
      console.log(`Kernel browser: ${inspection.usesKernelBrowser ? 'yes' : 'no'}`);
      console.log(command === 'validate' ? 'Validation: ok' : 'Task file is runnable by standalone engine v1.');
    }
    return EXIT_OK;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) {
      printEnvelope(false, undefined, 'TASK_INVALID', message);
    } else {
      console.error(`任务定义无效: ${message}`);
    }
    return EXIT_UNSUPPORTED_TASK;
  }
}

function printApiError(json: boolean, label: string, error: unknown, fallbackCode: string): number {
  const code = error instanceof ApiRequestError ? error.code : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    printEnvelope(false, undefined, code, message);
  } else {
    console.error(`${label}: ${message}`);
    if (error instanceof ApiRequestError && error.body && code !== 'AUTH_INVALID') {
      console.error(`响应: ${error.body}`);
    }
  }
  return EXIT_OPERATION_FAILED;
}
