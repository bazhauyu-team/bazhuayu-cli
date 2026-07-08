import { readFile } from 'node:fs/promises';
import { firstPositionalArg, hasFlag, parsePositiveInt, valueAfter } from '../cli/args.js';
import { requireExplicitYes } from '../cli/guardrails.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import {
  ApiRequestError,
  createTemplateTaskMapping,
  fetchTaskInfo,
  fetchTemplateDetail,
  fetchTemplateList,
  fetchTemplateTaskMapping,
  fetchUserDefaultTaskGroupId,
  updateTemplateTaskMapping,
  type RemoteTaskInfo,
  type TemplateTaskMappingBody
} from '../runtime/api-client.js';
import { resolveAuth } from '../runtime/auth.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';
import { printAuthRequired } from './auth.js';

export async function templateCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'search') return templateSearch(args);
  if (subcommand === 'view' || subcommand === 'show') return templateView(args);
  if (subcommand === 'version') return templateVersion(args);

  return printUsageError(
    json,
    '错误: template 子命令无效',
    '用法: octopus template <search|view|version> [--json]'
  );
}

export async function templateTaskCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'create') return templateTaskCreate(args);
  if (subcommand === 'update') return templateTaskUpdate(args);

  return printUsageError(
    json,
    '错误: template-task 子命令无效',
    '用法: octopus template-task <create|update> [--json]'
  );
}

async function templateSearch(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const keyword = valueAfter(args, '--keyword') ?? firstPositionalArg(args, templateSearchValueFlags()) ?? '';
  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await fetchTemplateList({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      pageIndex: parsePositiveInt(valueAfter(args, '--page'), 1),
      pageSize: parsePositiveInt(valueAfter(args, '--page-size') ?? valueAfter(args, '--limit'), 20),
      keyword,
      kindId: valueAfter(args, '--kind-id'),
      free: parseOptionalBoolean(valueAfter(args, '--free')),
      sort: valueAfter(args, '--sort'),
      accountLimits: valueAfter(args, '--account-limits'),
      runOn: valueAfter(args, '--run-on'),
      languages: valueAfter(args, '--languages') ?? valueAfter(args, '--language'),
      templateLanguages: valueAfter(args, '--template-languages') ?? valueAfter(args, '--template-language'),
      scope: valueAfter(args, '--scope')
    });
    if (json) {
      printEnvelope(true, result);
    } else if (!result.templates.length) {
      console.log('暂无模板');
    } else {
      console.log(`Templates: ${result.currentTotal || result.templates.length}/${result.total}  page=${result.pageIndex} pageSize=${result.pageSize}`);
      for (const template of result.templates) console.log(formatTemplateLine(template));
    }
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '搜索模板失败', error, 'TEMPLATE_SEARCH_FAILED');
  }
}

async function templateView(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const templateRegistrationId = firstPositionalArg(args, ['--api-base-url']);
  if (!templateRegistrationId) {
    return printUsageError(json, '错误: 缺少 templateRegistrationId', '用法: octopus template view <templateRegistrationId> [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await fetchTemplateDetail({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      templateRegistrationId
    });
    if (json) printEnvelope(true, result);
    else console.log(JSON.stringify(result.data, null, 2));
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '获取模板详情失败', error, 'TEMPLATE_VIEW_FAILED');
  }
}

async function templateVersion(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const templateRegistrationId = firstPositionalArg(args, ['--api-base-url']);
  if (!templateRegistrationId) {
    return printUsageError(json, '错误: 缺少 templateRegistrationId', '用法: octopus template version <templateRegistrationId> [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const detail = await fetchTemplateDetail({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      templateRegistrationId
    });
    const data = detail.data;
    const result = {
      templateRegistrationId: data.templateRegistrationId ?? templateRegistrationId,
      templateVersionId: data.id ?? data.templateId,
      version: data.version,
      currentTemplateVersion: data.currentTemplateVersion,
      name: data.name,
      status: data.status,
      raw: data
    };
    if (json) printEnvelope(true, result);
    else console.log(JSON.stringify(result, null, 2));
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '获取模板版本失败', error, 'TEMPLATE_VERSION_FAILED');
  }
}

async function templateTaskCreate(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const templateRegistrationId = firstPositionalArg(args, templateTaskCreateValueFlags());
  if (!templateRegistrationId) {
    return printUsageError(
      json,
      '错误: 缺少 templateRegistrationId',
      '用法: octopus template-task create <templateRegistrationId> [--name <taskName>] [--task-group <groupId>] [--params <json>] [--json]'
    );
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  const userInputParameters = await readUserInputParameters(args, json);
  if (typeof userInputParameters === 'number') return userInputParameters;

  try {
    const baseUrl = valueAfter(args, '--api-base-url');
    const detail = await fetchTemplateDetail({ auth: auth.credential, baseUrl, templateRegistrationId });
    const defaultGroupId = await fetchUserDefaultTaskGroupId({ auth: auth.credential, baseUrl }).catch(() => undefined);
    const body = buildCreateTemplateTaskBody(args, templateRegistrationId, detail.data, defaultGroupId, userInputParameters);
    const result = await createTemplateTaskMapping({ auth: auth.credential, baseUrl, body });
    if (json) printEnvelope(true, { action: 'create', templateRegistrationId, request: body, ...result });
    else console.log(`Created template task from templateRegistrationId=${templateRegistrationId}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '创建模板任务失败', error, 'TEMPLATE_TASK_CREATE_FAILED');
  }
}

async function templateTaskUpdate(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const taskId = firstPositionalArg(args, templateTaskUpdateValueFlags());
  if (!taskId) {
    return printUsageError(
      json,
      '错误: 缺少 taskId',
      '用法: octopus template-task update <taskId> [--params <json>] --yes [--json]'
    );
  }
  const guard = requireExplicitYes(args, json, '更新模板任务参数', `taskId=${taskId}`);
  if (guard !== null) return guard;

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  const userInputParameters = await readUserInputParameters(args, json);
  if (typeof userInputParameters === 'number') return userInputParameters;

  try {
    const baseUrl = valueAfter(args, '--api-base-url');
    const current = await fetchTemplateTaskMapping({ auth: auth.credential, baseUrl, taskId });
    const task = await fetchTaskInfo({ auth: auth.credential, baseUrl, taskId }).catch(() => ({} as RemoteTaskInfo));
    const body = buildUpdateTemplateTaskBody(args, taskId, current.data, task, userInputParameters);
    if (!numericValue(body.taskGroupId)) {
      return printUsageError(
        json,
        '错误: 无法确定任务组，请传 --task-group <groupId>',
        '用法: octopus template-task update <taskId> [--task-group <groupId>] [--params <json>] --yes [--json]'
      );
    }
    const result = await updateTemplateTaskMapping({ auth: auth.credential, baseUrl, taskId, body });
    if (json) printEnvelope(true, { action: 'update', taskId, request: body, ...result });
    else console.log(`Updated template task: ${taskId}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '更新模板任务失败', error, 'TEMPLATE_TASK_UPDATE_FAILED');
  }
}

function buildCreateTemplateTaskBody(
  args: string[],
  templateRegistrationId: string,
  detail: Record<string, unknown>,
  defaultGroupId: number | undefined,
  userInputParameters: string
): TemplateTaskMappingBody {
  const taskGroupId = numericValue(valueAfter(args, '--task-group') ?? valueAfter(args, '--group-id')) ?? defaultGroupId ?? 0;
  const templateVersionId = numericValue(valueAfter(args, '--template-version-id')) ?? numericValue(detail.id) ?? numericValue(detail.templateId) ?? '';
  return {
    taskGroupId,
    taskId: valueAfter(args, '--task-id') ?? '',
    taskName: valueAfter(args, '--name') ?? stringValue(detail.name) ?? `Template ${templateRegistrationId}`,
    templateId: numericValue(templateRegistrationId) ?? templateRegistrationId,
    templateType: numericValue(valueAfter(args, '--template-type')) ?? numericValue(detail.type) ?? 0,
    templateVersion: numericValue(valueAfter(args, '--template-version')) ?? numericValue(detail.currentTemplateVersion) ?? numericValue(detail.version) ?? 0,
    templateVersionId,
    templateRegistrationId: numericValue(templateRegistrationId) ?? templateRegistrationId,
    userInputParameters,
    urlSourceTaskId: valueAfter(args, '--url-source-task-id') ?? '',
    urlSourceTaskField: valueAfter(args, '--url-source-task-field') ?? ''
  };
}

function buildUpdateTemplateTaskBody(
  args: string[],
  taskId: string,
  current: Record<string, unknown>,
  task: RemoteTaskInfo,
  userInputParameters: string
): TemplateTaskMappingBody {
  const body: TemplateTaskMappingBody = { ...current };
  body.taskId = taskId;
  body.taskGroupId =
    numericValue(valueAfter(args, '--task-group') ?? valueAfter(args, '--group-id'))
    ?? numericValue(body.taskGroupId)
    ?? numericValue(body.TaskGroupId)
    ?? numericValue(body.groupId)
    ?? numericValue(task.taskGroupId)
    ?? numericValue(task.TaskGroupId);
  body.taskName = valueAfter(args, '--name') ?? stringValue(body.taskName) ?? stringValue(body.TaskName) ?? stringValue(task.taskName) ?? stringValue(task.TaskName) ?? '';
  body.templateId = numericValue(valueAfter(args, '--template-registration-id')) ?? numericValue(body.templateId) ?? numericValue(body.templateRegistrationId) ?? numericValue(task.templateId) ?? '';
  body.templateRegistrationId = numericValue(valueAfter(args, '--template-registration-id')) ?? numericValue(body.templateRegistrationId) ?? numericValue(body.templateId) ?? numericValue(task.templateId) ?? '';
  body.templateType = numericValue(valueAfter(args, '--template-type')) ?? numericValue(body.templateType) ?? 0;
  body.templateVersion = numericValue(valueAfter(args, '--template-version')) ?? numericValue(body.templateVersion) ?? numericValue(body.TemplateVersion) ?? 0;
  body.templateVersionId = numericValue(valueAfter(args, '--template-version-id')) ?? numericValue(body.templateVersionId) ?? numericValue(body.TemplateVersionId) ?? numericValue(task.templateVersionId) ?? numericValue(task.TemplateVersionId) ?? '';
  body.userInputParameters = userInputParameters || stringValue(body.userInputParameters) || '';
  body.urlSourceTaskId = valueAfter(args, '--url-source-task-id') ?? stringValue(body.urlSourceTaskId) ?? '';
  body.urlSourceTaskField = valueAfter(args, '--url-source-task-field') ?? stringValue(body.urlSourceTaskField) ?? '';
  return body;
}

async function readUserInputParameters(args: string[], json: boolean): Promise<string | number> {
  const params = valueAfter(args, '--params');
  const paramsFile = valueAfter(args, '--params-file');
  if (params && paramsFile) {
    return printUsageError(json, '错误: --params 和 --params-file 不能同时使用');
  }
  if (!params && !paramsFile) return '';
  const raw = paramsFile ? await readFile(paramsFile, 'utf8') : params;
  if (raw === undefined || raw.startsWith('-')) {
    return printUsageError(json, '错误: 缺少模板参数 JSON', '用法: --params \'{"UIParameters":[]}\'');
  }
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return printUsageError(json, '错误: 模板参数不是合法 JSON', '用法: --params \'{"UIParameters":[]}\'');
  }
}

function templateSearchValueFlags(): string[] {
  return ['--api-base-url', '--page', '--page-size', '--limit', '--keyword', '--kind-id', '--free', '--sort', '--account-limits', '--run-on', '--languages', '--language', '--template-languages', '--template-language', '--scope'];
}

function templateTaskCreateValueFlags(): string[] {
  return ['--api-base-url', '--name', '--task-group', '--group-id', '--task-id', '--template-version-id', '--template-version', '--template-type', '--params', '--params-file', '--url-source-task-id', '--url-source-task-field'];
}

function templateTaskUpdateValueFlags(): string[] {
  return ['--api-base-url', '--name', '--task-group', '--group-id', '--template-registration-id', '--template-version-id', '--template-version', '--template-type', '--params', '--params-file', '--url-source-task-id', '--url-source-task-field'];
}

function formatTemplateLine(template: unknown): string {
  const item = template && typeof template === 'object' ? template as Record<string, unknown> : {};
  const id = item.templateRegistrationId ?? item.id ?? '';
  const name = item.name ?? '';
  const status = item.status === undefined ? '' : ` status=${item.status}`;
  return `  ${id}  ${name}${status}`;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  return undefined;
}

function numericValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
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
