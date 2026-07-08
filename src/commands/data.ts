import { join, resolve } from 'node:path';
import { firstPositionalArg, hasFlag, parsePositiveInt, valueAfter } from '../cli/args.js';
import { printEnvelope, printUsageError } from '../cli/output.js';
import { cloudHistory } from './cloud.js';
import { printAuthRequired } from './auth.js';
import { ApiRequestError, fetchCloudDataCount, fetchCloudUnexportedDataCount, fetchTaskInfo } from '../runtime/api-client.js';
import { resolveAuth } from '../runtime/auth.js';
import { fetchCloudRows, fetchCloudRowsBatch } from '../runtime/cloud-data.js';
import { exportRowsToFile, normalizeDataExportFormat } from '../runtime/data-exporter.js';
import { listRuns } from '../runtime/artifacts.js';
import { countRunRows, defaultRunsDir, listActiveRuns, readJsonLines } from '../runtime/local-runs.js';
import { defaultExportFileName } from '../runtime/naming.js';
import { EXIT_OK, EXIT_OPERATION_FAILED, type RunSummary } from '../types.js';

export async function localHistory(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--output']);
  const json = hasFlag(args, '--json');
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  if (!taskId) {
    return printUsageError(json, '错误: 缺少 taskId', '用法: octopus local history <taskId> [--output <dir>] [--json]');
  }

  const lots = await listLocalLots(outputDir, taskId);
  if (json) {
    printEnvelope(true, lots.map(localLotToPublic));
    return EXIT_OK;
  }

  if (!lots.length) {
    console.log(`暂无本地采集批次: ${taskId}`);
    return EXIT_OK;
  }

  console.log(`本地采集批次: ${taskId}\n`);
  for (const lot of lots) {
    console.log(`  ${lot.lotId}  ${lot.status}  rows=${lot.total}  ${lot.startedAt}`);
  }
  return EXIT_OK;
}

export async function localExport(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--file', '--lot-id', '--lot', '--output', '--format']);
  const json = hasFlag(args, '--json');
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  const lotId = valueAfter(args, '--lot-id') ?? valueAfter(args, '--lot');
  const targetFile = valueAfter(args, '--file');

  if (!taskId) {
    return printUsageError(
      json,
      '错误: 缺少 taskId',
      '用法: octopus local export <taskId> [--file <result.xlsx>] [--lot-id <lotId>] [--output <dir>] [--format xlsx|csv|html|json|xml] [--json]'
    );
  }

  const format = normalizeDataExportFormat(valueAfter(args, '--format'), targetFile);
  if (!format) {
    return printUsageError(json, '--format 目前支持 xlsx、csv、html、json、xml', undefined, 'UNSUPPORTED_EXPORT_FORMAT');
  }

  const lot = await findLocalLot(outputDir, taskId, lotId);
  if (!lot) {
    const message = lotId
      ? `找不到本地采集批次: taskId=${taskId}, lotId=${lotId}`
      : `找不到任务 ${taskId} 的本地采集历史`;
    if (json) printEnvelope(false, undefined, 'LOCAL_LOT_NOT_FOUND', message);
    else console.error(message);
    return EXIT_OPERATION_FAILED;
  }

  const runDir = join(outputDir, lot.runId);
  const rows = await readJsonLines(join(runDir, 'rows.jsonl'), Number.MAX_SAFE_INTEGER) as Record<string, unknown>[];
  const taskName = lot.taskName ?? await resolveTaskName(taskId);
  const exportFile = targetFile ?? defaultExportFileName(taskName, format);
  const exported = await exportRowsToFile(rows, exportFile, format);
  const result = {
    taskId,
    taskName,
    lotId: lot.lotId,
    rows: exported.rows,
    file: exported.file,
    format: exported.format
  };

  if (json) {
    printEnvelope(true, result);
  } else {
    console.log(`Exported ${result.rows} rows -> ${result.file}`);
    console.log(`Task: ${result.taskId}`);
    console.log(`Lot: ${result.lotId}`);
    console.log(`Format: ${result.format}`);
  }
  return EXIT_OK;
}

export async function dataHistory(args: string[]): Promise<number> {
  const source = parseDataSource(args);
  return source === 'cloud' ? cloudHistory(args) : localHistory(args);
}

export async function dataCount(args: string[]): Promise<number> {
  const source = parseDataSource(args);
  return source === 'cloud' ? cloudDataCount(args) : localDataCount(args);
}

export async function dataPreview(args: string[]): Promise<number> {
  const source = parseDataSource(args);
  return source === 'cloud' ? cloudDataPreview(args) : localDataPreview(args);
}

export async function dataExport(args: string[]): Promise<number> {
  const source = parseDataSource(args);
  return source === 'cloud' ? cloudDataExport(args) : localExport(args);
}

async function cloudDataExport(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--source', '--file', '--lot-id', '--lot', '--format', '--api-base-url', '--batch-size']);
  const json = hasFlag(args, '--json');
  const lotId = valueAfter(args, '--lot-id') ?? valueAfter(args, '--lot');
  const targetFile = valueAfter(args, '--file');
  const unexported = hasFlag(args, '--unexported');

  if (!taskId) {
    return printUsageError(
      json,
      '错误: 缺少 taskId',
      '用法: octopus data export <taskId> --source cloud [--file <result.xlsx>] [--lot-id <lotId>] [--format xlsx|csv|html|json|xml] [--unexported] [--json]'
    );
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) {
    return printAuthRequired(json);
  }

  const format = normalizeDataExportFormat(valueAfter(args, '--format'), targetFile);
  if (!format) {
    return printUsageError(json, '--format 目前支持 xlsx、csv、html、json、xml', undefined, 'UNSUPPORTED_EXPORT_FORMAT');
  }

  try {
    const rows = await fetchCloudRows({
      auth: auth.credential,
      taskId,
      lotId,
      baseUrl: valueAfter(args, '--api-base-url'),
      batchSize: parsePositiveInt(valueAfter(args, '--batch-size'), 100),
      unexported
    });
    const taskName = await resolveTaskName(taskId);
    const exportFile = targetFile ?? defaultExportFileName(taskName, format);
    const exported = await exportRowsToFile(rows, exportFile, format);
    const result = {
      taskId,
      taskName,
      source: 'cloud',
      lotId,
      unexported,
      rows: exported.rows,
      file: exported.file,
      format: exported.format
    };

    if (json) {
      printEnvelope(true, result);
    } else {
      console.log(`Exported ${result.rows} cloud rows -> ${result.file}`);
      console.log(`Task: ${result.taskId}`);
      if (result.lotId) console.log(`Lot: ${result.lotId}`);
      console.log(`Format: ${result.format}`);
    }
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '云采集数据导出失败', error);
  }
}

async function localDataCount(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--source', '--output', '--lot-id', '--lot']);
  const json = hasFlag(args, '--json');
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  const lotId = valueAfter(args, '--lot-id') ?? valueAfter(args, '--lot');

  if (!taskId) {
    return printUsageError(json, '错误: 缺少 taskId', '用法: octopus data count <taskId> [--source local|cloud] [--json]');
  }

  const lot = await findLocalLot(outputDir, taskId, lotId);
  if (!lot) {
    const message = lotId
      ? `找不到本地采集批次: taskId=${taskId}, lotId=${lotId}`
      : `找不到任务 ${taskId} 的本地采集历史`;
    if (json) printEnvelope(false, undefined, 'LOCAL_LOT_NOT_FOUND', message);
    else console.error(message);
    return EXIT_OPERATION_FAILED;
  }

  const result = {
    taskId,
    taskName: lot.taskName,
    source: 'local',
    lotId: lot.lotId,
    total: lot.total
  };
  if (json) printEnvelope(true, result);
  else console.log(`Rows: ${result.total}\nTask: ${taskId}\nLot: ${lot.lotId}`);
  return EXIT_OK;
}

async function cloudDataCount(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--source', '--api-base-url']);
  const json = hasFlag(args, '--json');
  const unexported = hasFlag(args, '--unexported');

  if (!taskId) {
    return printUsageError(json, '错误: 缺少 taskId', '用法: octopus data count <taskId> --source cloud [--unexported] [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) {
    return printAuthRequired(json);
  }

  try {
    const result = unexported
      ? await fetchCloudUnexportedDataCount({ auth: auth.credential, taskId, baseUrl: valueAfter(args, '--api-base-url') })
      : await fetchCloudDataCount({ auth: auth.credential, taskId, baseUrl: valueAfter(args, '--api-base-url') });
    const data = {
      taskId,
      source: 'cloud',
      unexported,
      total: result.data,
      baseUrl: result.baseUrl,
      endpoint: result.endpoint
    };
    if (json) printEnvelope(true, data);
    else console.log(`${unexported ? 'Unexported rows' : 'Rows'}: ${data.total}`);
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '获取云采集数据量失败', error);
  }
}

async function localDataPreview(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--source', '--output', '--lot-id', '--lot', '--limit', '--offset']);
  const json = hasFlag(args, '--json');
  const outputDir = resolve(valueAfter(args, '--output') ?? defaultRunsDir());
  const lotId = valueAfter(args, '--lot-id') ?? valueAfter(args, '--lot');
  const limit = parsePositiveInt(valueAfter(args, '--limit'), 20);
  const offsetArg = valueAfter(args, '--offset');

  if (!taskId) {
    return printUsageError(json, '错误: 缺少 taskId', '用法: octopus data preview <taskId> [--source local|cloud] [--limit <n>] [--json]');
  }

  const lot = await findLocalLot(outputDir, taskId, lotId);
  if (!lot) {
    const message = lotId
      ? `找不到本地采集批次: taskId=${taskId}, lotId=${lotId}`
      : `找不到任务 ${taskId} 的本地采集历史`;
    if (json) printEnvelope(false, undefined, 'LOCAL_LOT_NOT_FOUND', message);
    else console.error(message);
    return EXIT_OPERATION_FAILED;
  }

  const rows = await readJsonLines(join(outputDir, lot.runId, 'rows.jsonl'), Number.MAX_SAFE_INTEGER) as Record<string, unknown>[];
  const offset = offsetArg === undefined ? Math.max(rows.length - limit, 0) : parseNonNegativeInt(offsetArg, 0);
  const result = {
    taskId,
    taskName: lot.taskName,
    source: 'local',
    lotId: lot.lotId,
    offset,
    limit,
    total: rows.length,
    rows: rows.slice(offset, offset + limit)
  };
  if (json) printEnvelope(true, result);
  else console.log(JSON.stringify(result.rows, null, 2));
  return EXIT_OK;
}

async function cloudDataPreview(args: string[]): Promise<number> {
  const taskId = firstPositionalArg(args, ['--source', '--api-base-url', '--lot-id', '--lot', '--limit', '--offset']);
  const json = hasFlag(args, '--json');
  const lotId = valueAfter(args, '--lot-id') ?? valueAfter(args, '--lot');
  const limit = parsePositiveInt(valueAfter(args, '--limit'), 20);
  const unexported = hasFlag(args, '--unexported');
  const offsetArg = valueAfter(args, '--offset');

  if (!taskId) {
    return printUsageError(json, '错误: 缺少 taskId', '用法: octopus data preview <taskId> --source cloud [--limit <n>] [--json]');
  }

  const auth = await resolveAuth();
  if (!auth.authenticated || !auth.credential) {
    return printAuthRequired(json);
  }

  try {
    let offset = parseNonNegativeInt(offsetArg, 0);
    let total: number | undefined;
    if (offsetArg === undefined && !lotId) {
      const count = unexported
        ? await fetchCloudUnexportedDataCount({ auth: auth.credential, taskId, baseUrl: valueAfter(args, '--api-base-url') })
        : await fetchCloudDataCount({ auth: auth.credential, taskId, baseUrl: valueAfter(args, '--api-base-url') });
      total = count.data;
      offset = Math.max(total - limit, 0);
    }

    const batch = await fetchCloudRowsBatch({
      auth: auth.credential,
      taskId,
      lotId,
      baseUrl: valueAfter(args, '--api-base-url'),
      offset,
      size: limit,
      unexported
    });
    const result = {
      taskId,
      source: 'cloud',
      lotId,
      unexported,
      offset,
      limit,
      total: total ?? batch.total,
      nextOffset: batch.nextOffset,
      restTotal: batch.restTotal,
      rows: batch.rows
    };
    if (json) printEnvelope(true, result);
    else console.log(JSON.stringify(result.rows, null, 2));
    return EXIT_OK;
  } catch (error) {
    return printApiError(json, '预览云采集数据失败', error);
  }
}

function parseDataSource(args: string[]): 'local' | 'cloud' {
  if (hasFlag(args, '--cloud')) return 'cloud';
  if (hasFlag(args, '--local')) return 'local';
  const source = valueAfter(args, '--source');
  return source === 'cloud' ? 'cloud' : 'local';
}

function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function listLocalLots(outputDir: string, taskId: string): Promise<RunSummary[]> {
  const runs = await listRuns(outputDir);
  const activeRuns = await listActiveRuns(outputDir);
  const byRunId = new Map<string, RunSummary>();
  for (const run of runs) byRunId.set(run.runId, withLotId(run));
  for (const run of activeRuns) byRunId.set(run.runId, withLotId(run));
  const matched = [...byRunId.values()]
    .filter((run) => run.taskId === taskId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return Promise.all(matched.map((run) => withActualRowCount(outputDir, run)));
}

async function findLocalLot(outputDir: string, taskId: string, lotId?: string): Promise<RunSummary | null> {
  const lots = await listLocalLots(outputDir, taskId);
  if (!lots.length) return null;
  if (!lotId) return lots[0];
  return lots.find((lot) => lot.lotId === lotId) ?? null;
}

function withLotId(summary: RunSummary): RunSummary {
  return summary.lotId ? summary : { ...summary, lotId: deriveLotId(summary.runId) };
}

async function withActualRowCount(outputDir: string, summary: RunSummary): Promise<RunSummary> {
  const total = await countRunRows(outputDir, summary.runId);
  return total === summary.total ? summary : { ...summary, total };
}

function localLotToPublic(summary: RunSummary) {
  return {
    taskId: summary.taskId,
    taskName: summary.taskName,
    lotId: summary.lotId,
    status: summary.status,
    total: summary.total,
    startedAt: summary.startedAt,
    stoppedAt: summary.stoppedAt
  };
}

function deriveLotId(runId: string): string {
  const stamp = runId.match(/_(\d{14})$/)?.[1];
  return stamp ? `lot_${stamp}` : runId;
}

async function resolveTaskName(taskId: string): Promise<string> {
  const auth = await resolveAuth();
  if (!auth.credential) return taskId;
  try {
    const info = await fetchTaskInfo({ auth: auth.credential, taskId });
    return String(info.taskName ?? info.TaskName ?? taskId).trim() || taskId;
  } catch {
    return taskId;
  }
}

function printApiError(json: boolean, prefix: string, error: unknown): number {
  const code = error instanceof ApiRequestError ? error.code : 'API_REQUEST_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    printEnvelope(false, undefined, code, message);
  } else {
    console.error(`${code === 'AUTH_INVALID' ? '认证失败' : prefix}: ${message}`);
    if (error instanceof ApiRequestError && error.body && code !== 'AUTH_INVALID') {
      console.error(`响应: ${error.body}`);
    }
  }
  return EXIT_OPERATION_FAILED;
}
