import { readFile } from 'node:fs/promises';
import { firstPositionalArg, hasFlag, parsePositiveInt, valueAfter } from '../cli/args.js';
import { requireExplicitYes } from '../cli/guardrails.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import {
  ApiRequestError,
  fetchUserConfig,
  removeUserConfig,
  saveUserConfig,
  searchUserConfigs,
  type UserConfigInfo
} from '../runtime/api-client.js';
import { resolveAuth } from '../runtime/auth.js';
import { EXIT_OK, EXIT_OPERATION_FAILED } from '../types.js';
import { printAuthRequired } from './auth.js';

type JsonParseResult = { ok: true; value: unknown } | { ok: false; exitCode: number };
export async function userConfigCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'get' || subcommand === 'show') return userConfigGet(args);
  if (subcommand === 'search' || subcommand === 'list') return userConfigSearch(args);
  if (subcommand === 'set' || subcommand === 'save') return userConfigSet(args);
  if (subcommand === 'delete' || subcommand === 'remove') return userConfigDelete(args);

  return printUsageError(
    json,
    '错误: user-config 子命令无效',
    '用法: octopus user-config <get|search|set|delete> [--json]'
  );
}

export async function acquisitionSettingsCommand(subcommand: string | undefined, args: string[]): Promise<number> {
  const json = hasFlag([subcommand ?? '', ...args], '--json');
  if (subcommand === 'get' || subcommand === 'show' || subcommand === 'update' || subcommand === 'set') {
    const message = 'CLI 暂不支持采集消费限额。国内客户端接口在当前 CLI 认证/API 上下文下返回 405，避免发布不可用的账号级设置能力。请使用桌面客户端设置采集消费限额。';
    if (json) printEnvelope(false, undefined, 'UNSUPPORTED_OPERATION', message);
    else console.error(message);
    return EXIT_OPERATION_FAILED;
  }

  return printUsageError(
    json,
    '错误: acquisition-settings 子命令无效',
    '用法: octopus acquisition-settings <get|update> [--json]'
  );
}

async function userConfigGet(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const configType = valueAfter(args, '--type') ?? valueAfter(args, '--config-type');
  const configName = valueAfter(args, '--name') ?? firstPositionalArg(args, userConfigGetValueFlags());
  if (!configType || !configName) {
    return printUsageError(
      json,
      '错误: 缺少 --type 或 configName',
      '用法: octopus user-config get <configName> --type <configType> [--json]'
    );
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await fetchUserConfig({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      configType,
      configName
    });
    if (json) printEnvelope(true, result);
    else console.log(JSON.stringify(result.data, null, 2));
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '获取用户配置失败', error, 'USER_CONFIG_GET_FAILED');
  }
}

async function userConfigSearch(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const configType = valueAfter(args, '--type') ?? valueAfter(args, '--config-type');
  if (!configType) {
    return printUsageError(
      json,
      '错误: 缺少 --type',
      '用法: octopus user-config search --type <configType> [--keyword <text>] [--json]'
    );
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await searchUserConfigs({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      configType,
      keyword: valueAfter(args, '--keyword') ?? firstPositionalArg(args, userConfigSearchValueFlags()) ?? '',
      pageIndex: parsePositiveInt(valueAfter(args, '--page'), 1),
      pageSize: parsePositiveInt(valueAfter(args, '--page-size') ?? valueAfter(args, '--limit'), 20),
      relativeId: valueAfter(args, '--relative-id'),
      sortBy: valueAfter(args, '--sort-by'),
      sortType: valueAfter(args, '--sort-type'),
      dbType: valueAfter(args, '--db-type'),
      isOpen: valueAfter(args, '--is-open')
    });
    if (json) {
      printEnvelope(true, result);
    } else if (!result.configs.length) {
      console.log('暂无用户配置');
    } else {
      console.log(`User configs: ${result.currentTotal || result.configs.length}/${result.total}  page=${result.pageIndex} pageSize=${result.pageSize}`);
      for (const config of result.configs) console.log(formatUserConfigLine(config));
    }
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '搜索用户配置失败', error, 'USER_CONFIG_SEARCH_FAILED');
  }
}

async function userConfigSet(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const configType = valueAfter(args, '--type') ?? valueAfter(args, '--config-type');
  const configName = valueAfter(args, '--name') ?? firstPositionalArg(args, userConfigSetValueFlags());
  if (!configType || !configName) {
    return printUsageError(
      json,
      '错误: 缺少 --type 或 configName',
      '用法: octopus user-config set <configName> --type <configType> (--config <text>|--config-json <json>|--config-file <file>) --yes [--json]'
    );
  }
  const guard = requireExplicitYes(args, json, '保存用户配置', `type=${configType}, configName=${configName}`);
  if (guard !== null) return guard;

  try {
    const config = await readConfigValue(args, json);
    if (typeof config === 'number') return config;

    const auth = await resolveAuth();
    if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

    const body: UserConfigInfo = {
      configType: numericOrString(configType),
      configName,
      config,
      relativeId: valueAfter(args, '--relative-id') ?? ''
    };
    const result = await saveUserConfig({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      body
    });
    if (json) printEnvelope(true, { action: 'set', request: body, ...result });
    else console.log(`Saved user config: type=${configType} name=${configName}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '保存用户配置失败', error, 'USER_CONFIG_SET_FAILED');
  }
}

async function userConfigDelete(args: string[]): Promise<number> {
  const json = hasFlag(args, '--json');
  const configType = valueAfter(args, '--type') ?? valueAfter(args, '--config-type');
  const configName = valueAfter(args, '--name') ?? firstPositionalArg(args, userConfigDeleteValueFlags());
  if (!configType || !configName) {
    return printUsageError(
      json,
      '错误: 缺少 --type 或 configName',
      '用法: octopus user-config delete <configName> --type <configType> --yes [--json]'
    );
  }
  const guard = requireExplicitYes(args, json, '删除用户配置', `type=${configType}, configName=${configName}`);
  if (guard !== null) return guard;

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) return printAuthRequired(json);

  try {
    const result = await removeUserConfig({
      auth: auth.credential,
      baseUrl: valueAfter(args, '--api-base-url'),
      configType,
      configName
    });
    if (json) printEnvelope(true, { action: 'delete', configType, configName, ...result });
    else console.log(`Deleted user config: type=${configType} name=${configName}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '删除用户配置失败', error, 'USER_CONFIG_DELETE_FAILED');
  }
}

async function readConfigValue(args: string[], json: boolean): Promise<string | number> {
  const config = valueAfter(args, '--config');
  const configJson = valueAfter(args, '--config-json');
  const configFile = valueAfter(args, '--config-file');
  const sources = [config, configJson, configFile].filter((value) => value !== undefined).length;
  if (sources !== 1) {
    return printUsageError(json, '错误: --config、--config-json、--config-file 必须且只能提供一个');
  }
  if (config !== undefined) {
    if (config.startsWith('-')) return printUsageError(json, '错误: --config 缺少参数值');
    return config;
  }
  if (configJson !== undefined) {
    if (configJson.startsWith('-')) return printUsageError(json, '错误: --config-json 缺少参数值');
    return normalizeJsonString(configJson, json);
  }
  if (configFile !== undefined) {
    if (configFile.startsWith('-')) return printUsageError(json, '错误: --config-file 缺少参数值');
    return normalizeJsonString(await readFile(configFile, 'utf8'), json);
  }
  return '';
}

function normalizeJsonString(raw: string, json: boolean): string | number {
  const parsed = parseJsonValue(raw, json);
  if (!parsed.ok) return parsed.exitCode;
  return JSON.stringify(parsed.value);
}

function parseJsonValue(raw: string, json: boolean): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, exitCode: printUsageError(json, '错误: JSON 格式不合法') };
  }
}

function userConfigGetValueFlags(): string[] {
  return ['--api-base-url', '--type', '--config-type', '--name'];
}

function userConfigSearchValueFlags(): string[] {
  return ['--api-base-url', '--type', '--config-type', '--keyword', '--page', '--page-size', '--limit', '--relative-id', '--sort-by', '--sort-type', '--db-type', '--is-open'];
}

function userConfigSetValueFlags(): string[] {
  return ['--api-base-url', '--type', '--config-type', '--name', '--config', '--config-json', '--config-file', '--relative-id'];
}

function userConfigDeleteValueFlags(): string[] {
  return ['--api-base-url', '--type', '--config-type', '--name'];
}

function numericOrString(value: string): string | number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function formatUserConfigLine(config: UserConfigInfo): string {
  return `  ${config.configType ?? ''}  ${config.configName ?? config.id ?? ''}  relativeId=${config.relativeId ?? ''}`;
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
