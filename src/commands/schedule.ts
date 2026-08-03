import { readFile } from 'node:fs/promises';
import { firstPositionalArg, hasFlag, valueAfter } from '../cli/args.js';
import { requireExplicitYes } from '../cli/guardrails.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import {
  ApiRequestError,
  fetchCloudSchedule,
  fetchCloudScheduleNextTimes,
  startCloudSchedule,
  stopCloudSchedule,
  updateCloudSchedule,
  type TaskScheduleBody
} from '../runtime/api-client.js';
import { resolveAuth } from '../runtime/auth.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';
import { printAuthRequired } from './auth.js';

type ScheduleAction = 'get' | 'update' | 'start' | 'stop' | 'next';

export async function scheduleCommand(domain: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([domain ?? '', ...args], '--json');
  if (domain === 'cloud') return cloudScheduleCommand(args);
  if (domain === 'local') {
    return printError(
      json,
      'UNSUPPORTED_OPERATION',
      '本地定时任务由八爪鱼桌面客户端管理，CLI 不提供此功能。'
    );
  }

  return printUsageError(
    json,
    '错误: schedule 子命令无效',
    '用法: bazhuayu schedule cloud <get|update|start|stop|next> [--json]'
  );
}

async function cloudScheduleCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args as [ScheduleAction | undefined, ...string[]];
  const json = hasFlag(args, '--json');
  if (action === 'get') return cloudScheduleGet(rest);
  if (action === 'update') return cloudScheduleUpdate(rest);
  if (action === 'start') return cloudScheduleStart(rest);
  if (action === 'stop') return cloudScheduleStop(rest);
  if (action === 'next') return cloudScheduleNext(rest);

  return printUsageError(
    json,
    '错误: schedule cloud 子命令无效',
    '用法: bazhuayu schedule cloud <get|update|start|stop|next> [--json]'
  );
}

async function cloudScheduleGet(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const taskId = firstPositionalArg(args, scheduleValueFlags());
  if (!taskId) {
    return printUsageError(json, '错误: 缺少 taskId', '用法: bazhuayu schedule cloud get <taskId> [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await fetchCloudSchedule({ auth: auth.credential, taskId, baseUrl: valueAfter(args, '--api-base-url') });
    if (json) printEnvelope(true, { taskId, ...result });
    else console.log(JSON.stringify(result.data, null, 2));
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '获取云定时配置失败', error, 'SCHEDULE_CLOUD_GET_FAILED');
  }
}

async function cloudScheduleUpdate(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const taskId = firstPositionalArg(args, scheduleValueFlags());
  if (!taskId) {
    return printUsageError(
      json,
      '错误: 缺少 taskId',
      '用法: bazhuayu schedule cloud update <taskId> --type <type> --date <value> --time <value> --yes [--json]'
    );
  }
  const guard = requireExplicitYes(args, json, '更新云定时配置', `taskId=${taskId}`);
  if (guard !== null) return guard;

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const baseUrl = valueAfter(args, '--api-base-url');
    const current = await fetchCloudSchedule({ auth: auth.credential, taskId, baseUrl });
    const bodyResult = await buildTaskScheduleBody(args, json, { ...current.data, taskId });
    if (typeof bodyResult === 'number') return bodyResult;
    const body = bodyResult;
    const validation = validateScheduleBody(body, json, 'bazhuayu schedule cloud update <taskId> --type <type> --date <value> --time <value> --yes [--json]');
    if (validation !== null) return validation;

    const result = await updateCloudSchedule({
      auth: auth.credential,
      baseUrl,
      body,
      timezoneOffset: timezoneOffset(args)
    });
    const enabledAction = await maybeApplyCloudEnabled(args, json, auth.credential, taskId, baseUrl);
    if (typeof enabledAction === 'number') return enabledAction;
    if (json) printEnvelope(true, { action: 'update', taskId, request: body, enabledAction, ...result });
    else console.log(`Updated cloud schedule: ${taskId}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '更新云定时配置失败', error, 'SCHEDULE_CLOUD_UPDATE_FAILED');
  }
}

async function cloudScheduleStart(args: string[]): Promise<number> {
  return cloudScheduleStateChange('start', args);
}

async function cloudScheduleStop(args: string[]): Promise<number> {
  return cloudScheduleStateChange('stop', args);
}

async function cloudScheduleStateChange(action: 'start' | 'stop', args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const taskId = firstPositionalArg(args, scheduleValueFlags());
  if (!taskId) {
    return printUsageError(json, '错误: 缺少 taskId', `用法: bazhuayu schedule cloud ${action} <taskId> --yes [--json]`);
  }
  const guard = requireExplicitYes(args, json, `${action === 'start' ? '启动' : '停止'}云定时`, `taskId=${taskId}`);
  if (guard !== null) return guard;

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const baseUrl = valueAfter(args, '--api-base-url');
    const result = action === 'start'
      ? await startCloudSchedule({ auth: auth.credential, taskId, baseUrl })
      : await stopCloudSchedule({ auth: auth.credential, taskId, baseUrl });
    if (json) printEnvelope(true, { action, taskId, ...result });
    else console.log(`${action === 'start' ? 'Started' : 'Stopped'} cloud schedule: ${taskId}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, `${action === 'start' ? '启动' : '停止'}云定时失败`, error, action === 'start' ? 'SCHEDULE_CLOUD_START_FAILED' : 'SCHEDULE_CLOUD_STOP_FAILED');
  }
}

async function cloudScheduleNext(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const bodyResult = await buildTaskScheduleBody(args, json, {});
    if (typeof bodyResult === 'number') return bodyResult;
    const validation = validateScheduleBody(bodyResult, json, 'bazhuayu schedule cloud next --type <type> --date <value> --time <value> [--json]');
    if (validation !== null) return validation;
    const result = await fetchCloudScheduleNextTimes({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      body: bodyResult,
      timezoneOffset: timezoneOffset(args)
    });
    if (json) printEnvelope(true, { request: bodyResult, ...result });
    else console.log(JSON.stringify(result.data, null, 2));
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '计算云定时下次运行时间失败', error, 'SCHEDULE_CLOUD_NEXT_FAILED');
  }
}

async function buildTaskScheduleBody(args: string[], json: boolean, current: Record<string, unknown>): Promise<TaskScheduleBody | number> {
  const bodyRecord = await readBodyRecord(args, json);
  if (typeof bodyRecord === 'number') return bodyRecord;
  const body: TaskScheduleBody = { ...current, ...bodyRecord };
  body.taskId = stringValue(body.taskId) ?? firstPositionalArg(args, scheduleValueFlags());
  return applyScheduleFields(body, args, json);
}

async function readBodyRecord(args: string[], json: boolean): Promise<Record<string, unknown> | number> {
  const body = valueAfter(args, '--body');
  const bodyFile = valueAfter(args, '--body-file');
  if (body && bodyFile) {
    return printUsageError(json, '错误: --body 和 --body-file 不能同时使用');
  }
  if (!body && !bodyFile) return {};
  const raw = bodyFile ? await readFile(bodyFile, 'utf8') : body;
  if (raw === undefined || raw.startsWith('-')) {
    return printUsageError(json, '错误: 缺少 JSON body', '用法: --body \'{"scheduleType":5,"scheduleDate":"1","scheduleTime":"10"}\'');
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = getRecord(parsed);
    if (!record) {
      return printUsageError(json, '错误: JSON body 必须是对象');
    }
    return record;
  } catch {
    return printUsageError(json, '错误: JSON body 不是合法 JSON');
  }
}

function applyScheduleFields<T extends TaskScheduleBody>(body: T, args: string[], json: boolean): T | number {
  const scheduleType = valueAfter(args, '--schedule-type') ?? valueAfter(args, '--type');
  if (scheduleType !== undefined) {
    const parsed = parseScheduleType(scheduleType);
    if (parsed === undefined) {
      return printUsageError(json, `错误: 不支持的 schedule type: ${scheduleType}`, scheduleTypeUsage());
    }
    body.scheduleType = parsed;
  } else if (typeof body.scheduleType === 'string') {
    const parsed = parseScheduleType(body.scheduleType);
    if (parsed === undefined) {
      return printUsageError(json, `错误: 不支持的 schedule type: ${body.scheduleType}`, scheduleTypeUsage());
    }
    body.scheduleType = parsed;
  }
  setStringField(body, 'scheduleDate', valueAfter(args, '--schedule-date') ?? valueAfter(args, '--date'));
  setStringField(body, 'scheduleTime', valueAfter(args, '--schedule-time') ?? valueAfter(args, '--time'));
  setStringField(body, 'scheduleMonth', valueAfter(args, '--schedule-month') ?? valueAfter(args, '--month'));
  setNumberField(body, 'status', valueAfter(args, '--status'));
  setNumberField(body, 'taskStatus', valueAfter(args, '--task-status'));
  setNumberField(body, 'scheduleStatus', valueAfter(args, '--schedule-status'));
  if (body.scheduleStatus === undefined && body.status !== undefined) body.scheduleStatus = body.status;

  const speedMode = parseBooleanFlag(args, '--speed-mode', json);
  if (typeof speedMode === 'number') return speedMode;
  if (speedMode !== undefined) body.isSpeedMode = speedMode;

  const downloadEnabled = parseBooleanFlag(args, '--download-enabled', json);
  if (typeof downloadEnabled === 'number') return downloadEnabled;
  if (downloadEnabled !== undefined) body.isDownloadEnabled = downloadEnabled;

  const autoClose = parseBooleanFlag(args, '--auto-close', json);
  if (typeof autoClose === 'number') return autoClose;
  if (autoClose !== undefined) body.isAutoClose = autoClose;

  if (body.scheduleMonth === undefined || body.scheduleMonth === '') body.scheduleMonth = '1';
  return body;
}

function validateScheduleBody(body: TaskScheduleBody, json: boolean, usage: string): number | null {
  if (body.scheduleType === undefined || body.scheduleDate === undefined || body.scheduleTime === undefined) {
    return printUsageError(json, '错误: 缺少 scheduleType、scheduleDate 或 scheduleTime', `用法: ${usage}\n${scheduleTypeUsage()}`);
  }
  return null;
}

async function maybeApplyCloudEnabled(
  args: string[],
  json: boolean,
  auth: { type: 'apiKey' | 'bearer'; value: string },
  taskId: string,
  baseUrl: string | undefined
): Promise<Record<string, unknown> | undefined | number> {
  const enabled = parseBooleanFlag(args, '--enabled', json);
  if (typeof enabled === 'number') return enabled;
  if (enabled === undefined) return undefined;
  const result = enabled
    ? await startCloudSchedule({ auth, taskId, baseUrl })
    : await stopCloudSchedule({ auth, taskId, baseUrl });
  return {
    enabled,
    action: enabled ? 'start' : 'stop',
    endpoint: result.endpoint,
    data: result.data,
    raw: result.raw
  };
}

function timezoneOffset(args: string[]): string {
  return valueAfter(args, '--timezone-offset') ?? String(new Date().getTimezoneOffset() * -1);
}

function parseScheduleType(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  const parsed = Number(normalized);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 6) return parsed;
  const aliases: Record<string, number> = {
    once: 1,
    date: 1,
    weekly: 2,
    week: 2,
    'every-week': 2,
    monthly: 3,
    month: 3,
    'every-month': 3,
    'interval-minute': 4,
    'every-minute': 4,
    minute: 4,
    hourly: 5,
    hour: 5,
    'every-hour': 5,
    daily: 6,
    day: 6
  };
  return aliases[normalized];
}

function scheduleTypeUsage(): string {
  return 'scheduleType: 1=date/once, 2=weekly, 3=monthly, 4=interval-minute, 5=every-hour, 6=daily';
}

function parseBooleanFlag(args: string[], flag: string, json: boolean): boolean | undefined | number {
  const value = valueAfter(args, flag);
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return printUsageError(json, `错误: ${flag} 必须是 true 或 false`);
}

function setStringField(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value !== undefined) target[key] = value;
}

function setNumberField(target: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value === undefined) return;
  const parsed = Number(value);
  target[key] = Number.isFinite(parsed) ? parsed : value;
}

function scheduleValueFlags(): string[] {
  return [
    '--api-base-url',
    '--type',
    '--schedule-type',
    '--date',
    '--schedule-date',
    '--time',
    '--schedule-time',
    '--month',
    '--schedule-month',
    '--status',
    '--task-status',
    '--schedule-status',
    '--timezone-offset',
    '--enabled',
    '--body',
    '--body-file',
    '--name',
    '--id',
    '--speed-mode',
    '--download-enabled',
    '--auto-close'
  ];
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function printError(json: boolean, code: string, message: string): number {
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
