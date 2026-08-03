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

type TemplateParameterSource = 'UIParameters' | 'TemplateParameters' | 'collectParam' | 'mixed' | 'none' | 'unknown';

interface NormalizedTemplateParameter {
  id: string;
  name: string;
  label: string;
  type: string;
  required: boolean;
  defaultValue: unknown;
  description: string;
  options: unknown[];
  source: 'UIParameters' | 'TemplateParameters' | 'collectParam' | 'unknown';
}

interface InternalTemplateParameter extends NormalizedTemplateParameter {
  rawKey: string;
  raw: Record<string, unknown>;
}

interface NormalizedTemplateParameters {
  parameterSource: TemplateParameterSource;
  parameters: InternalTemplateParameter[];
  parameterExample: Record<string, unknown>;
}

export async function templateCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'search') return templateSearch(args);
  if (subcommand === 'view' || subcommand === 'show') return templateView(args);
  if (subcommand === 'version') return templateVersion(args);

  return printUsageError(
    json,
    '错误: template 子命令无效',
    '用法: bazhuayu template <search|view|version> [--json]'
  );
}

export async function templateTaskCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'create') return templateTaskCreate(args);
  if (subcommand === 'update') return templateTaskUpdate(args);

  return printUsageError(
    json,
    '错误: template-task 子命令无效',
    '用法: bazhuayu template-task <create|update> [--json]'
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
  const templateId = firstPositionalArg(args, ['--api-base-url']);
  if (!templateId) {
    return printUsageError(json, '错误: 缺少 templateId', '用法: bazhuayu template view <templateId> [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await fetchTemplateDetail({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      templateRegistrationId: templateId
    });
    const normalized = normalizeTemplateParameters(result.data);
    if (json) {
      printEnvelope(true, {
        ...result,
        templateId: result.data.templateRegistrationId ?? templateId,
        templateVersionId: result.data.id ?? result.data.templateId,
        name: result.data.name,
        version: result.data.version,
        currentTemplateVersion: result.data.currentTemplateVersion,
        parameters: publicTemplateParameters(normalized.parameters),
        parameterExample: normalized.parameterExample,
        parameterSource: normalized.parameterSource,
        createExamples: buildTemplateCreateExamples(templateId, normalized)
      });
    }
    else console.log(JSON.stringify(result.data, null, 2));
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '获取模板详情失败', error, 'TEMPLATE_VIEW_FAILED');
  }
}

async function templateVersion(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const templateId = firstPositionalArg(args, ['--api-base-url']);
  if (!templateId) {
    return printUsageError(json, '错误: 缺少 templateId', '用法: bazhuayu template version <templateId> [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const detail = await fetchTemplateDetail({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      templateRegistrationId: templateId
    });
    const data = detail.data;
    const result = {
      templateId: data.templateRegistrationId ?? templateId,
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
  const templateId = firstPositionalArg(args, templateTaskCreateValueFlags());
  if (!templateId) {
    return printUsageError(
      json,
      '错误: 缺少 templateId',
      '用法: bazhuayu template-task create <templateId> [--name <taskName>] [--task-group <groupId>] [--param key=value]... [--params <json>|--params-file <file>] [--dry-run] [--json]'
    );
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const baseUrl = valueAfter(args, '--api-base-url');
    const detail = await fetchTemplateDetail({ auth: auth.credential, baseUrl, templateRegistrationId: templateId });
    const userInputParameters = await readCreateUserInputParameters(args, json, detail.data);
    if (typeof userInputParameters === 'number') return userInputParameters;
    const defaultGroupId = await fetchUserDefaultTaskGroupId({ auth: auth.credential, baseUrl }).catch(() => undefined);
    const body = buildCreateTemplateTaskBody(args, templateId, detail.data, defaultGroupId, userInputParameters);
    const normalized = normalizeTemplateParameters(detail.data);
    const normalizedParams = normalizeParamArgs(args);
    if (typeof normalizedParams === 'number') return normalizedParams;
    if (hasFlag(args, '--dry-run')) {
      if (json) {
        printEnvelope(true, {
          action: 'create',
          dryRun: true,
          templateId,
          request: body,
          normalizedParams,
          parameters: publicTemplateParameters(normalized.parameters),
          parameterSource: normalized.parameterSource
        });
      } else {
        console.log(JSON.stringify(body, null, 2));
      }
      return EXIT_OK;
    }
    const result = await createTemplateTaskMapping({ auth: auth.credential, baseUrl, body });
    if (json) printEnvelope(true, { action: 'create', templateId, request: body, parameters: publicTemplateParameters(normalized.parameters), parameterSource: normalized.parameterSource, ...result });
    else console.log(`Created template task from templateId=${templateId}`);
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
      '用法: bazhuayu template-task update <taskId> [--params <json>] --yes [--json]'
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
        '用法: bazhuayu template-task update <taskId> [--task-group <groupId>] [--params <json>] --yes [--json]'
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
  templateId: string,
  detail: Record<string, unknown>,
  defaultGroupId: number | undefined,
  userInputParameters: string
): TemplateTaskMappingBody {
  const taskGroupId = numericValue(valueAfter(args, '--task-group') ?? valueAfter(args, '--group-id')) ?? defaultGroupId ?? 0;
  const templateVersionId = numericValue(valueAfter(args, '--template-version-id')) ?? numericValue(detail.id) ?? numericValue(detail.templateId) ?? '';
  return {
    taskGroupId,
    taskId: valueAfter(args, '--task-id') ?? '',
    taskName: valueAfter(args, '--name') ?? stringValue(detail.name) ?? `Template ${templateId}`,
    templateId: numericValue(templateId) ?? templateId,
    templateType: numericValue(valueAfter(args, '--template-type')) ?? numericValue(detail.type) ?? 0,
    templateVersion: numericValue(valueAfter(args, '--template-version')) ?? numericValue(detail.currentTemplateVersion) ?? numericValue(detail.version) ?? 0,
    templateVersionId,
    templateRegistrationId: numericValue(templateId) ?? templateId,
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
  const templateId = numericValue(valueAfter(args, '--template-id') ?? valueAfter(args, '--template-registration-id'));
  body.templateId = templateId ?? numericValue(body.templateId) ?? numericValue(body.templateRegistrationId) ?? numericValue(task.templateId) ?? '';
  body.templateRegistrationId = templateId ?? numericValue(body.templateRegistrationId) ?? numericValue(body.templateId) ?? numericValue(task.templateId) ?? '';
  body.templateType = numericValue(valueAfter(args, '--template-type')) ?? numericValue(body.templateType) ?? 0;
  body.templateVersion = numericValue(valueAfter(args, '--template-version')) ?? numericValue(body.templateVersion) ?? numericValue(body.TemplateVersion) ?? 0;
  body.templateVersionId = numericValue(valueAfter(args, '--template-version-id')) ?? numericValue(body.templateVersionId) ?? numericValue(body.TemplateVersionId) ?? numericValue(task.templateVersionId) ?? numericValue(task.TemplateVersionId) ?? '';
  body.userInputParameters = userInputParameters || stringValue(body.userInputParameters) || '';
  body.urlSourceTaskId = valueAfter(args, '--url-source-task-id') ?? stringValue(body.urlSourceTaskId) ?? '';
  body.urlSourceTaskField = valueAfter(args, '--url-source-task-field') ?? stringValue(body.urlSourceTaskField) ?? '';
  return body;
}

async function readUserInputParameters(args: string[], json: boolean): Promise<string | number> {
  const hasParams = hasFlag(args, '--params');
  const hasParamsFile = hasFlag(args, '--params-file');
  const params = valueAfter(args, '--params');
  const paramsFile = valueAfter(args, '--params-file');
  if (hasParams && hasParamsFile) {
    return printUsageError(json, '错误: --params 和 --params-file 不能同时使用');
  }
  if (!hasParams && !hasParamsFile) return '';
  if (hasParamsFile && (!paramsFile || paramsFile.startsWith('-'))) {
    return printUsageError(json, '错误: 缺少模板参数 JSON', '用法: --params \'{"UIParameters":[]}\'');
  }
  const raw = hasParamsFile ? await readFile(paramsFile as string, 'utf8') : params;
  if (raw === undefined || raw.startsWith('-')) {
    return printUsageError(json, '错误: 缺少模板参数 JSON', '用法: --params \'{"UIParameters":[]}\'');
  }
  try {
    return JSON.stringify(JSON.parse(raw));
  } catch {
    return printUsageError(json, '错误: 模板参数不是合法 JSON', '用法: --params \'{"UIParameters":[]}\'');
  }
}

async function readCreateUserInputParameters(args: string[], json: boolean, detail: Record<string, unknown>): Promise<string | number> {
  const usesParam = hasFlag(args, '--param');
  if (usesParam && (hasFlag(args, '--params') || hasFlag(args, '--params-file'))) {
    return printUsageError(json, '错误: --param 不能和 --params/--params-file 同时使用');
  }
  if (!usesParam) return readUserInputParameters(args, json);

  const parsedParams = normalizeParamArgs(args);
  if (typeof parsedParams === 'number') return parsedParams;
  const normalized = normalizeTemplateParameters(detail);
  if (!normalized.parameters.length || normalized.parameterSource === 'none' || normalized.parameterSource === 'unknown' || normalized.parameterSource === 'collectParam') {
    return printTemplateParameterError(
      json,
      'TEMPLATE_PARAMS_UNSUPPORTED',
      '无法从模板详情中识别可用参数结构，请改用 --params-file 传入原始 userInputParameters JSON'
    );
  }

  const matched = new Map<InternalTemplateParameter, unknown>();
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(parsedParams)) {
    const parameter = findTemplateParameter(normalized.parameters, key);
    if (!parameter) {
      unknown.push(key);
      continue;
    }
    matched.set(parameter, value);
  }
  if (unknown.length) {
    return printTemplateParameterError(json, 'TEMPLATE_PARAM_UNKNOWN', `模板参数不存在: ${unknown.join(', ')}`);
  }

  const missing = normalized.parameters
    .filter((parameter) => {
      if (!parameter.required) return false;
      if (matched.has(parameter)) return isEmptyParameterValue(matched.get(parameter));
      return isEmptyParameterValue(parameter.defaultValue);
    })
    .map((parameter) => parameter.name);
  if (missing.length) {
    return printTemplateParameterError(json, 'TEMPLATE_PARAMS_REQUIRED', `缺少必填模板参数: ${missing.join(', ')}`);
  }

  return JSON.stringify(buildUserInputParameters(normalized.parameters, matched));
}

function templateSearchValueFlags(): string[] {
  return ['--api-base-url', '--page', '--page-size', '--limit', '--keyword', '--kind-id', '--free', '--sort', '--account-limits', '--run-on', '--languages', '--language', '--template-languages', '--template-language', '--scope'];
}

function templateTaskCreateValueFlags(): string[] {
  return ['--api-base-url', '--name', '--task-group', '--group-id', '--task-id', '--template-version-id', '--template-version', '--template-type', '--params', '--params-file', '--param', '--url-source-task-id', '--url-source-task-field'];
}

function templateTaskUpdateValueFlags(): string[] {
  return ['--api-base-url', '--name', '--task-group', '--group-id', '--template-id', '--template-registration-id', '--template-version-id', '--template-version', '--template-type', '--params', '--params-file', '--url-source-task-id', '--url-source-task-field'];
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

function normalizeTemplateParameters(detail: Record<string, unknown>): NormalizedTemplateParameters {
  const parsed = parseUserInputParameterObject(detail);
  const parameters = [
    ...normalizeParameterArray(normalizeArray(parsed?.UIParameters ?? detail.UIParameters), 'UIParameters'),
    ...normalizeParameterArray(normalizeArray(parsed?.TemplateParameters ?? detail.TemplateParameters), 'TemplateParameters')
  ];
  const collectParams = normalizeParameterArray(normalizeArray(detail.collectParam), 'collectParam');
  const effectiveParameters = parameters.length ? parameters : collectParams;
  return {
    parameterSource: parameterSource(effectiveParameters),
    parameters: effectiveParameters,
    parameterExample: buildParameterExample(effectiveParameters)
  };
}

function parseUserInputParameterObject(detail: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw = detail.userInputParameters ?? detail.UserInputParameters ?? detail.parameters ?? detail.Parameters;
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
    } catch {
      return undefined;
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

function normalizeParameterArray(items: unknown[], source: InternalTemplateParameter['source']): InternalTemplateParameter[] {
  return items.flatMap((item, index) => {
    const record = toRecord(item);
    const rawKey = source === 'TemplateParameters'
      ? stringValue(record.ParamName) ?? stringValue(record.paramName) ?? ''
      : stringValue(record.Id) ?? stringValue(record.id) ?? '';
    const id = rawKey
      || stringValue(record.name)
      || stringValue(record.Name)
      || stringValue(record.key)
      || `param${index + 1}`;
    const name = stringValue(record.name)
      ?? stringValue(record.Name)
      ?? stringValue(record.ParamName)
      ?? stringValue(record.paramName)
      ?? stringValue(record.Id)
      ?? stringValue(record.id)
      ?? id;
    const label = stringValue(record.label)
      ?? stringValue(record.Label)
      ?? stringValue(record.displayName)
      ?? stringValue(record.DisplayName)
      ?? stringValue(record.title)
      ?? stringValue(record.Title)
      ?? name;
    return [{
      id,
      name,
      label,
      type: inferParameterType(record),
      required: booleanValue(record.required ?? record.Required ?? record.isRequired ?? record.IsRequired) ?? false,
      defaultValue: record.Value ?? record.value ?? record.defaultValue ?? record.DefaultValue ?? '',
      description: stringValue(record.description) ?? stringValue(record.Description) ?? '',
      options: normalizeArray(record.options ?? record.Options ?? record.items ?? record.Items),
      source,
      rawKey: rawKey || id,
      raw: record
    }];
  });
}

function publicTemplateParameters(parameters: InternalTemplateParameter[]): NormalizedTemplateParameter[] {
  return parameters.map(({ rawKey: _rawKey, raw: _raw, ...parameter }) => parameter);
}

function parameterSource(parameters: InternalTemplateParameter[]): TemplateParameterSource {
  if (!parameters.length) return 'none';
  const sources = new Set(parameters.map((parameter) => parameter.source));
  if (sources.size === 1) return parameters[0].source;
  if (sources.has('unknown')) return 'unknown';
  return 'mixed';
}

function buildParameterExample(parameters: InternalTemplateParameter[]): Record<string, unknown> {
  const example: Record<string, unknown> = {};
  for (const parameter of parameters) {
    example[parameter.name] = isEmptyParameterValue(parameter.defaultValue)
      ? exampleValueForType(parameter.type)
      : parameter.defaultValue;
  }
  return example;
}

function buildTemplateCreateExamples(templateId: string, normalized: NormalizedTemplateParameters): Record<string, string> {
  const firstRequired = normalized.parameters.find((parameter) => parameter.required) ?? normalized.parameters[0];
  const simple = firstRequired
    ? `bazhuayu template-task create ${templateId} --param ${firstRequired.name}=${shellExampleValue(firstRequired)} --json`
    : `bazhuayu template-task create ${templateId} --json`;
  return {
    simple,
    file: `bazhuayu template-task create ${templateId} --params-file params.json --json`,
    dryRun: firstRequired
      ? `bazhuayu template-task create ${templateId} --param ${firstRequired.name}=${shellExampleValue(firstRequired)} --dry-run --json`
      : `bazhuayu template-task create ${templateId} --dry-run --json`
  };
}

function buildUserInputParameters(parameters: InternalTemplateParameter[], values: Map<InternalTemplateParameter, unknown>): Record<string, unknown> {
  const result: { UIParameters?: Array<Record<string, unknown>>; TemplateParameters?: Array<Record<string, unknown>> } = {};
  for (const parameter of parameters) {
    if (parameter.source === 'collectParam' || parameter.source === 'unknown') continue;
    const value = values.has(parameter) ? values.get(parameter) : parameter.defaultValue;
    if (parameter.source === 'UIParameters') {
      result.UIParameters ??= [];
      result.UIParameters.push({ Id: parameter.rawKey, Value: value });
    } else if (parameter.source === 'TemplateParameters') {
      result.TemplateParameters ??= [];
      result.TemplateParameters.push({ ParamName: parameter.rawKey, Value: value });
    }
  }
  return result;
}

function normalizeParamArgs(args: string[]): Record<string, unknown> | number {
  const result: Record<string, unknown> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--param') continue;
    const raw = args[index + 1];
    if (!raw || raw.startsWith('-') || !raw.includes('=')) {
      return printUsageError(hasFlag(args, '--json'), '错误: --param 必须使用 key=value 格式', '用法: --param keyword=phone');
    }
    const [key, ...valueParts] = raw.split('=');
    const name = key.trim();
    if (!name) return printUsageError(hasFlag(args, '--json'), '错误: --param 缺少参数名', '用法: --param keyword=phone');
    result[name] = parseParameterValue(valueParts.join('='));
  }
  return result;
}

function parseParameterValue(raw: string): unknown {
  const value = raw.trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return raw;
    }
  }
  return raw;
}

function findTemplateParameter(parameters: InternalTemplateParameter[], key: string): InternalTemplateParameter | undefined {
  const normalizedKey = normalizeParameterKey(key);
  return parameters.find((parameter) => [
    parameter.id,
    parameter.name,
    parameter.label,
    parameter.rawKey
  ].some((candidate) => normalizeParameterKey(candidate) === normalizedKey));
}

function inferParameterType(record: Record<string, unknown>): string {
  const explicit = stringValue(record.type) ?? stringValue(record.Type) ?? stringValue(record.valueType) ?? stringValue(record.ValueType);
  if (explicit) return explicit;
  const value = record.Value ?? record.value ?? record.defaultValue ?? record.DefaultValue;
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value)) return 'array';
  return 'string';
}

function exampleValueForType(type: string): unknown {
  if (/bool/i.test(type)) return true;
  if (/num|int|float|double|decimal/i.test(type)) return 1;
  if (/array|list|multi/i.test(type)) return [];
  return 'value';
}

function shellExampleValue(parameter: InternalTemplateParameter): string {
  const value = isEmptyParameterValue(parameter.defaultValue)
    ? exampleValueForType(parameter.type)
    : parameter.defaultValue;
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (Array.isArray(value) || (value && typeof value === 'object')) return JSON.stringify(value);
  return String(value || 'value').replace(/\s+/g, '_');
}

function isEmptyParameterValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function normalizeParameterKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function normalizeArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return [];
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return undefined;
}

function printTemplateParameterError(json: boolean, code: string, message: string): number {
  if (json) printEnvelope(false, undefined, code, message);
  else console.error(message);
  return EXIT_OPERATION_FAILED;
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
