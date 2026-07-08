import { firstPositionalArg, hasFlag, valueAfter } from '../cli/args.js';
import { requireExplicitYes } from '../cli/guardrails.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { ApiRequestError, createTaskGroup, deleteTaskGroup, fetchTaskGroups, setDefaultTaskGroup, updateTaskGroup } from '../runtime/api-client.js';
import { resolveAuth } from '../runtime/auth.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';
import { printAuthRequired } from './auth.js';

export async function taskGroupCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'list') return taskGroupList(args);
  if (subcommand === 'create') return taskGroupCreate(args);
  if (subcommand === 'update' || subcommand === 'rename') return taskGroupUpdate(args);
  if (subcommand === 'delete') return taskGroupDelete(args);
  if (subcommand === 'set-default') return taskGroupSetDefault(args);

  return printUsageError(
    json,
    '错误: task-group 子命令无效',
    '用法: octopus task-group <list|create|update|delete|set-default> [--json]'
  );
}

async function taskGroupList(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await fetchTaskGroups({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      userId: valueAfter(args, '--user-id')
    });
    if (json) {
      printEnvelope(true, result);
    } else if (!result.data.length) {
      console.log('暂无任务组');
    } else {
      for (const group of result.data) {
        const marker = group.isDefault ? ' *' : '';
        console.log(`  ${group.taskGroupId ?? ''}  ${group.taskGroupName ?? ''}${marker}`);
      }
    }
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '获取任务组失败', error);
  }
}

async function taskGroupCreate(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const name = valueAfter(args, '--name') ?? firstPositionalArg(args, ['--api-base-url']);
  if (!name) {
    return printUsageError(json, '错误: 缺少任务组名称', '用法: octopus task-group create <name> [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await createTaskGroup({ auth: auth.credential, baseUrl: valueAfter(args, '--api-base-url'), name });
    if (json) printEnvelope(true, { name, ...result });
    else console.log(`Created task group: ${name}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '创建任务组失败', error);
  }
}

async function taskGroupUpdate(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const groupId = firstPositionalArg(args, ['--api-base-url', '--name']);
  const name = valueAfter(args, '--name');
  if (!groupId || !name) {
    return printUsageError(json, '错误: 缺少 groupId 或 --name', '用法: octopus task-group update <groupId> --name <name> --yes [--json]');
  }
  const guard = requireExplicitYes(args, json, '更新任务组', `groupId=${groupId}`);
  if (guard !== null) return guard;

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await updateTaskGroup({ auth: auth.credential, baseUrl: valueAfter(args, '--api-base-url'), groupId, name });
    if (json) printEnvelope(true, { groupId, name, ...result });
    else console.log(`Updated task group: ${groupId}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '更新任务组失败', error);
  }
}

async function taskGroupDelete(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const groupId = firstPositionalArg(args, ['--api-base-url']);
  if (!groupId) {
    return printUsageError(json, '错误: 缺少 groupId', '用法: octopus task-group delete <groupId> --yes [--json]');
  }
  const guard = requireExplicitYes(args, json, '删除任务组', `groupId=${groupId}`);
  if (guard !== null) return guard;

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await deleteTaskGroup({ auth: auth.credential, baseUrl: valueAfter(args, '--api-base-url'), groupId });
    if (json) printEnvelope(true, { groupId, ...result });
    else console.log(`Deleted task group: ${groupId}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '删除任务组失败', error);
  }
}

async function taskGroupSetDefault(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const groupId = firstPositionalArg(args, ['--api-base-url']);
  if (!groupId) {
    return printUsageError(json, '错误: 缺少 groupId', '用法: octopus task-group set-default <groupId> --yes [--json]');
  }
  const guard = requireExplicitYes(args, json, '设置默认任务组', `groupId=${groupId}`);
  if (guard !== null) return guard;

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await setDefaultTaskGroup({ auth: auth.credential, baseUrl: valueAfter(args, '--api-base-url'), groupId });
    if (json) printEnvelope(true, { groupId, ...result });
    else console.log(`Default task group: ${groupId}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '设置默认任务组失败', error);
  }
}

function printApiError(json: boolean, label: string, error: unknown): number {
  const code = error instanceof ApiRequestError ? error.code : 'TASK_GROUP_FAILED';
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
